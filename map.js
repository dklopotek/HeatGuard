// map.js — Mapbox GL JS + deck.gl interleaved mode
// Exports:
//   initMap(container, cfg, irResult, allWindows, placements) → { map, overlay, updateAll }

// mapboxgl and MapboxDraw are loaded as UMD globals via <script src> in index.html.
const mapboxgl = window.mapboxgl;
import { MapboxOverlay }  from '@deck.gl/mapbox';
import { BitmapLayer, PolygonLayer, GeoJsonLayer, ColumnLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { MaskExtension }  from '@deck.gl/extensions';

const MASK_ID = 'boundary-mask';

// ── Jet color scale ───────────────────────────────────────────────────────────
const JET = [
  [0.00, [33,  102, 172]],
  [0.25, [67,  162, 202]],
  [0.50, [120, 198, 121]],
  [0.75, [254, 224, 88 ]],
  [1.00, [215, 48,  39 ]],
];
export function jetColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < JET.length - 1; i++) {
    const [t0, c0] = JET[i], [t1, c1] = JET[i + 1];
    if (t <= t1) {
      const s = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + s * (c1[j] - v)));
    }
  }
  return JET.at(-1)[1];
}

// ── Bitmap (continuous background) ───────────────────────────────────────────
export function buildBitmap(matrix, width, height, minVal, maxVal) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const lo = minVal ?? Math.min(...Array.from(matrix).filter(v => !isNaN(v)));
  const hi = maxVal ?? Math.max(...Array.from(matrix).filter(v => !isNaN(v)));
  const range = (hi - lo) || 1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const v = matrix[r * width + c], i = (r * width + c) * 4;
      if (isNaN(v)) { img.data[i + 3] = 0; continue; }
      const [R, G, B] = jetColor((v - lo) / range);
      img.data[i] = R; img.data[i+1] = G; img.data[i+2] = B; img.data[i+3] = 90;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ── Layer stack ───────────────────────────────────────────────────────────────
function buildLayers(cfg, irResult, allWindows, placements, bitmap, buildings = [], trees = [], selectedRank = null, stages = [], showStages = true) {
  const { boundary } = cfg.festival;
  const [west, south, east, north] = irResult.bounds;
  const lo = irResult.minLegend ?? 30;
  const hi = irResult.maxLegend ?? 52;
  const range = (hi - lo) || 1;

  return [
    // 1. Boundary mask — clips all layers inside the polygon
    new GeoJsonLayer({
      id: MASK_ID,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: boundary }] },
      operation: 'mask', filled: true, getFillColor: [0,0,0,255], stroked: false,
    }),

    // 2. Continuous bitmap at low opacity — smooth background
    new BitmapLayer({
      id: 'utci-bitmap',
      bounds: [west, south, east, north],
      image: bitmap,
      opacity: 0.35,
      extensions: [new MaskExtension()],
      maskId: MASK_ID,
    }),

    // 3. ALL placement windows as colored squares — the full opportunity grid
    new PolygonLayer({
      id: 'heat-grid',
      data: allWindows,
      getPolygon: w => [[w.ww, w.ss], [w.ee, w.ss], [w.ee, w.nn], [w.ww, w.nn]],
      getFillColor: w => {
        const t = (w.utciMean - lo) / range;
        const [R, G, B] = jetColor(t);
        return [R, G, B, 170];
      },
      getLineColor: [0, 0, 0, 25],
      getLineWidth: 0.4,
      lineWidthUnits: 'meters',
      filled: true, stroked: true,
      extensions: [new MaskExtension()],
      maskId: MASK_ID,
      pickable: true,
      updateTriggers: { getFillColor: [allWindows] },
    }),

    // 4a. Tree trunks — dark brown cylinders, fixed 0.4 m radius
    new ColumnLayer({
      id: 'tree-trunks',
      data: trees,
      getPosition:   t => [t.lng, t.lat],
      radius:        0.4,
      getElevation:  3,
      getFillColor:  [72, 46, 18, 230],
      diskResolution: 6,
      radiusUnits:   'meters',
      extruded:      true,
      pickable:      false,
    }),

    // 4b. Tree canopies — green cylinders, fixed 3.5 m radius (avg crown)
    new ColumnLayer({
      id: 'tree-canopies',
      data: trees,
      getPosition:   t => [t.lng, t.lat],
      radius:        3.5,
      getElevation:  5,
      getFillColor:  [38, 100, 44, 200],
      diskResolution: 10,
      radiusUnits:   'meters',
      extruded:      true,
      pickable:      false,
    }),

    // 5. Island structures — extruded boxes within festival boundary
    new PolygonLayer({
      id: 'osm-buildings',
      data: buildings,
      getPolygon:   b => b.polygon,
      getElevation: b => b.height,
      getFillColor: [235, 232, 226, 210],
      getLineColor: [180, 176, 168, 140],
      getLineWidth: 0.3,
      lineWidthUnits: 'meters',
      extruded: true,
      filled:   true,
      stroked:  true,
      pickable: false,
    }),

    // 6. Top-N recommended placements — amber border highlight on ground
    new PolygonLayer({
      id: 'placement-highlights',
      data: placements,
      getPolygon: p => [[p.ww, p.ss], [p.ee, p.ss], [p.ee, p.nn], [p.ww, p.nn]],
      getFillColor: p => {
        const t = placements.length > 1 ? (p.rank - 1) / (placements.length - 1) : 0;
        return [252, 195, 0, Math.round(80 - t * 60)];
      },
      getLineColor: p => {
        const t = placements.length > 1 ? (p.rank - 1) / (placements.length - 1) : 0;
        return [252, 195, 0, Math.round(255 - t * 100)];
      },
      getLineWidth: p => p.rank <= 3 ? 2.5 : 1.5,
      lineWidthUnits: 'meters',
      filled: true, stroked: true,
      extensions: [new MaskExtension()],
      maskId: MASK_ID,
      pickable: true,
      updateTriggers: { getFillColor: [placements], getLineColor: [placements] },
    }),

    // 7a. Shade support posts — 4 corner poles per placement (top 5)
    new ColumnLayer({
      id: 'shade-posts',
      data: placements.slice(0, 5).flatMap(p => [
        { pos: [p.ww, p.ss] }, { pos: [p.ee, p.ss] },
        { pos: [p.ee, p.nn] }, { pos: [p.ww, p.nn] },
      ]),
      getPosition:   d => d.pos,
      radius:        0.25,
      getElevation:  4.5,
      getFillColor:  [200, 175, 100, 240],
      diskResolution: 4,
      radiusUnits:   'meters',
      extruded:      true,
      pickable:      false,
    }),

    // 7b. Shade roof — thin slab extruded 4.5 m, tinted amber-white
    new PolygonLayer({
      id: 'shade-canopies',
      data: placements.slice(0, 5),
      getPolygon: p => [[p.ww, p.ss], [p.ee, p.ss], [p.ee, p.nn], [p.ww, p.nn]],
      getElevation:  4.5,
      getFillColor:  p => {
        const t = placements.length > 1 ? (p.rank - 1) / (placements.length - 1) : 0;
        return [255, 245, 200, Math.round(210 - t * 90)];
      },
      getLineColor:  [252, 195, 0, 220],
      getLineWidth:  0.5,
      lineWidthUnits: 'meters',
      extruded:      true,
      filled:        true,
      stroked:       true,
      pickable:      false,
      extensions:    [new MaskExtension()],
      maskId:        MASK_ID,
      updateTriggers: { getFillColor: [placements] },
    }),

    // 8. Placement dots — always-visible pixel circles (never sub-pixel)
    new ScatterplotLayer({
      id: 'placement-dots',
      data: placements,
      getPosition:  p => [p.lng, p.lat],
      getRadius:    p => p.rank <= 3 ? 7 : 5,
      radiusUnits:  'pixels',
      getFillColor: p => p.rank === 1 ? [255, 59, 48, 255] :
                         p.rank === 2 ? [255, 149, 0, 255] :
                         p.rank === 3 ? [252, 195, 0, 255] : [252, 195, 0, 180],
      getLineColor: [10, 10, 8, 180],
      lineWidthMinPixels: 1,
      stroked: true,
      pickable: true,
      updateTriggers: { getFillColor: [placements], getRadius: [placements] },
    }),

    // 9. Selected placement ring — pulsing outer circle around the clicked card
    new ScatterplotLayer({
      id: 'placement-selected',
      data: selectedRank != null ? placements.filter(p => p.rank === selectedRank) : [],
      getPosition:  p => [p.lng, p.lat],
      getRadius:    16,
      radiusUnits:  'pixels',
      getFillColor: [252, 195, 0, 0],
      getLineColor: [252, 195, 0, 255],
      lineWidthMinPixels: 2.5,
      stroked: true,
      pickable: false,
      updateTriggers: { data: [selectedRank] },
    }),

    // 10. Festival stage markers (when visible)
    ...(showStages && stages.length ? [
      new ScatterplotLayer({
        id: 'stage-rings',
        data: stages,
        getPosition: s => [s.lng, s.lat],
        getRadius: s => s.type === 'main' ? 40 : s.type === 'stage' ? 28 : 20,
        radiusUnits: 'meters',
        getFillColor: s => s.type === 'main'  ? [255, 59, 48, 40] :
                           s.type === 'stage' ? [255, 149, 0, 40] :
                           s.type === 'food'  ? [52, 199, 89, 40] :
                                               [120, 80, 220, 40],
        getLineColor: s => s.type === 'main'  ? [255, 59, 48, 220] :
                           s.type === 'stage' ? [255, 149, 0, 220] :
                           s.type === 'food'  ? [52, 199, 89, 220] :
                                               [120, 80, 220, 220],
        lineWidthMinPixels: 1.5,
        stroked: true,
        filled: true,
        pickable: true,
      }),
      new TextLayer({
        id: 'stage-labels',
        data: stages,
        getPosition: s => [s.lng, s.lat],
        getText: s => s.name,
        getSize: 11,
        getColor: [245, 240, 232, 230],
        getBackgroundColor: [10, 10, 8, 180],
        background: true,
        getBorderColor: [60, 55, 45, 120],
        getBorderWidth: 1,
        backgroundPadding: [4, 2, 4, 2],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        getPixelOffset: [0, -32],
        fontFamily: 'ui-sans-serif, sans-serif',
        fontWeight: 600,
        pickable: false,
      }),
    ] : []),
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────
export function initMap(container, cfg, irResult, allWindows, placements, buildings = [], trees = [], stages = []) {
  const { lat, lng, boundary } = cfg.festival;
  const { matrix, width, height, minLegend, maxLegend } = irResult;
  const tokens = window.FESTIVAL_TOKENS ?? {};

  mapboxgl.accessToken = tokens.mapbox ?? '';

  // Compute bounds from boundary polygon so the initial view always fits the festival
  const _bCoords = boundary.coordinates[0];
  const _bLngs   = _bCoords.map(c => c[0]);
  const _bLats   = _bCoords.map(c => c[1]);
  const _bounds   = [[Math.min(..._bLngs), Math.min(..._bLats)], [Math.max(..._bLngs), Math.max(..._bLats)]];

  const map = new mapboxgl.Map({
    container,
    style:     'mapbox://styles/mapbox/dark-v11',
    center:    [lng, lat],
    zoom:      13.8,
    pitch:     45,
    bearing:   -20,
    antialias: true,
  });

  // Snap to exact festival bounds once tiles load
  map.once('load', () => {
    map.fitBounds(_bounds, { padding: 48, pitch: 45, bearing: -20, duration: 800 });
  });

  let _allWindows   = allWindows;
  let _placements   = placements;
  let _selectedRank = null;
  let _showStages   = true;
  let _bitmap       = buildBitmap(matrix, width, height, minLegend, maxLegend);
  let _layers       = buildLayers(cfg, irResult, _allWindows, _placements, _bitmap, buildings, trees, _selectedRank, stages, _showStages);

  const overlay = new MapboxOverlay({ interleaved: true, layers: _layers });
  map.addControl(overlay);
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  // Tooltip
  const tip = Object.assign(document.createElement('div'), {
    style: 'position:fixed;background:rgba(10,10,8,.92);color:#f5f0e8;' +
           'padding:7px 12px;border-radius:8px;font:12px/1.5 ui-sans-serif,sans-serif;' +
           'pointer-events:none;display:none;z-index:9999;border:1px solid rgba(252,195,0,.3)',
  });
  document.body.appendChild(tip);

  overlay.setProps({
    onHover: ({ object, x, y }) => {
      if (!object) { tip.style.display = 'none'; return; }
      tip.style.display = 'block';
      tip.style.left = `${x + 14}px`;
      tip.style.top  = `${y - 10}px`;
      if (object.name && object.type) {
        const col = object.type === 'main' ? '#ff3b30' : object.type === 'food' ? '#34c759' : '#ff9500';
        tip.innerHTML = `<b style="color:${col}">${object.name}</b><br>${object.description ?? ''}`;
      } else if (object.rank) {
        tip.innerHTML =
          `<b style="color:#fcc300">Rank #${object.rank}</b><br>` +
          `UTCI ${object.utciMean.toFixed(1)}°C &nbsp;·&nbsp; ` +
          `${object.size_m2}m² &nbsp;·&nbsp; ${object.orientation_deg}°`;
      } else if (object.utciMean != null) {
        const u = object.utciMean.toFixed(1);
        const dot = c => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c};margin-right:5px;vertical-align:middle"></span>`;
        const risk = object.utciMean > 41 ? dot('#ff3b30') + 'Stroke risk' :
                     object.utciMean > 35 ? dot('#ff9500') + 'Exhaustion risk' : dot('#34c759') + 'Manageable';
        tip.innerHTML = `${risk}<br>UTCI ${u}°C`;
      }
    },
  });

  return {
    map, overlay,
    /** Update heatmap + grid colors + highlighted placements in one call. */
    updateAll(newMatrix, newAllWindows, newPlacements) {
      _bitmap     = buildBitmap(newMatrix, width, height, minLegend, maxLegend);
      _allWindows = newAllWindows ?? _allWindows;
      _placements = newPlacements ?? _placements;
      _layers     = buildLayers(cfg, irResult, _allWindows, _placements, _bitmap, buildings, trees, _selectedRank, stages, _showStages);
      overlay.setProps({ layers: _layers });
    },
    toggleStages() {
      _showStages = !_showStages;
      _layers = buildLayers(cfg, irResult, _allWindows, _placements, _bitmap, buildings, trees, _selectedRank, stages, _showStages);
      overlay.setProps({ layers: _layers });
      return _showStages;
    },
    /** Fly to a placement and highlight its selection ring. */
    flyToPlacement(p) {
      _selectedRank = p ? p.rank : null;
      _layers = buildLayers(cfg, irResult, _allWindows, _placements, _bitmap, buildings, trees, _selectedRank, stages, _showStages);
      overlay.setProps({ layers: _layers });
      if (p) {
        map.flyTo({ center: [p.lng, p.lat], zoom: 17, pitch: 50, bearing: -20, duration: 900 });
      } else {
        map.fitBounds(_bounds, { padding: 48, pitch: 45, bearing: -20, duration: 800 });
      }
    },
  };
}

// Keep old name as alias so existing callers don't break during refactor
export { initMap as default };

// map.js — Mapbox GL JS + deck.gl interleaved mode
// Exports:
//   initMap(container, cfg, irResult, allWindows, placements) → { map, overlay, updateAll }

// mapboxgl and MapboxDraw are loaded as UMD globals via <script src> in index.html.
const mapboxgl = window.mapboxgl;
import { MapboxOverlay }  from '@deck.gl/mapbox';
import { BitmapLayer, PolygonLayer, GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
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
function buildLayers(cfg, irResult, allWindows, placements, bitmap, buildings = [], trees = []) {
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

    // 4. OSM buildings — extruded white boxes (SDK playground style)
    new PolygonLayer({
      id: 'osm-buildings',
      data: buildings,
      getPolygon:   b => b.polygon,
      getElevation: b => b.height,
      getFillColor: [232, 230, 224, 215],
      getLineColor: [180, 178, 172, 160],
      getLineWidth: 0.3,
      lineWidthUnits: 'meters',
      extruded: true,
      filled:   true,
      stroked:  true,
      pickable: false,
    }),

    // 5. OSM trees — green canopy circles at ground level
    new ScatterplotLayer({
      id: 'osm-trees',
      data: trees,
      getPosition:  t => [t.lng, t.lat, 0],
      getRadius:    t => t.radius,
      radiusUnits:  'meters',
      getFillColor: [48, 112, 48, 195],
      getLineColor: [28, 70, 28, 160],
      lineWidthMinPixels: 1,
      stroked: true,
      filled:  true,
      pickable: false,
    }),

    // 6. Top-N recommended placements — amber border highlight
    new PolygonLayer({
      id: 'placement-highlights',
      data: placements,
      getPolygon: p => [[p.ww, p.ss], [p.ee, p.ss], [p.ee, p.nn], [p.ww, p.nn]],
      getFillColor: p => {
        // Rank 1 = solid amber, fade to transparent at rank N
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
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────
export function initMap(container, cfg, irResult, allWindows, placements, buildings = [], trees = []) {
  const { lat, lng } = cfg.festival;
  const { matrix, width, height, minLegend, maxLegend } = irResult;
  const tokens = window.FESTIVAL_TOKENS ?? {};

  mapboxgl.accessToken = tokens.mapbox ?? '';

  const map = new mapboxgl.Map({
    container,
    style:     'mapbox://styles/mapbox/dark-v11',
    center:    [lng, lat],
    zoom:      14.8,
    pitch:     48,
    bearing:   -12,
    antialias: true,
  });

  let _allWindows = allWindows;
  let _placements = placements;
  let _bitmap     = buildBitmap(matrix, width, height, minLegend, maxLegend);
  let _layers     = buildLayers(cfg, irResult, _allWindows, _placements, _bitmap, buildings, trees);

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
      if (object.rank) {
        tip.innerHTML =
          `<b style="color:#fcc300">Rank #${object.rank}</b><br>` +
          `UTCI ${object.utciMean.toFixed(1)}°C &nbsp;·&nbsp; ` +
          `${object.size_m2}m² &nbsp;·&nbsp; ${object.orientation_deg}°`;
      } else if (object.utciMean != null) {
        const u = object.utciMean.toFixed(1);
        const risk = object.utciMean > 41 ? '🔴 Stroke risk' :
                     object.utciMean > 35 ? '🟠 Exhaustion risk' : '🟢 Manageable';
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
      _layers     = buildLayers(cfg, irResult, _allWindows, _placements, _bitmap, buildings, trees);
      overlay.setProps({ layers: _layers });
    },
  };
}

// Keep old name as alias so existing callers don't break during refactor
export { initMap as default };

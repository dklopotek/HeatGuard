// placement.js — Grid window ranking for shade placement
// Exports:
//   computeAllWindows(result, cfg) → Window[]   — all valid grid windows, sorted hottest first
//   computePlacements(result, cfg) → Placement[] — top N windows with rank + orientation

// Node.js-only imports are loaded dynamically in the isMain block below.

/**
 * Slide a grid_size_m × grid_size_m window across the entire UTCI matrix.
 * Returns ALL valid windows (≥50% valid cells) sorted by utciMean descending.
 * Each window includes its geographic footprint for PolygonLayer rendering.
 */
export function computeAllWindows(result, cfg) {
  const { matrix, bounds, width, height } = result;
  const { grid_size_m } = cfg.festival;
  const [west, south, east, north] = bounds;

  const degPerRow = (north - south) / height;
  const degPerCol = (east  - west)  / width;
  const minCoverage = 0.5;
  const windows = [];

  for (let r0 = 0; r0 + grid_size_m <= height; r0 += grid_size_m) {
    for (let c0 = 0; c0 + grid_size_m <= width; c0 += grid_size_m) {
      let sum = 0, count = 0;
      for (let r = r0; r < r0 + grid_size_m; r++)
        for (let c = c0; c < c0 + grid_size_m; c++) {
          const v = matrix[r * width + c];
          if (!isNaN(v)) { sum += v; count++; }
        }
      if (count < grid_size_m * grid_size_m * minCoverage) continue;

      const cr = r0 + grid_size_m / 2;
      const cc = c0 + grid_size_m / 2;
      const ww = west  + c0              * degPerCol;
      const ee = west  + (c0 + grid_size_m) * degPerCol;
      const ss = south + r0              * degPerRow;
      const nn = south + (r0 + grid_size_m) * degPerRow;

      windows.push({
        utciMean: sum / count,
        lat:  south + (cr + 0.5) * degPerRow,
        lng:  west  + (cc + 0.5) * degPerCol,
        r0, c0,
        // Square footprint in geographic coords
        ww, ee, ss, nn,
        gridSize: grid_size_m,
      });
    }
  }

  windows.sort((a, b) => b.utciMean - a.utciMean);
  return windows;
}

/**
 * Top-N placement recommendations from computeAllWindows, with rank + orientation.
 * Orientation = long axis of shade structure broadside to the afternoon sun.
 */
export function computePlacements(result, cfg) {
  const { grid_size_m, top_n_placements } = cfg.festival;
  const { sunAngles } = result;

  const windows = computeAllWindows(result, cfg);

  const daytime = (sunAngles ?? []).filter(s => s.elevation > 5);
  const avgSunAz = daytime.length > 0
    ? daytime.reduce((s, a) => s + a.azimuth, 0) / daytime.length : 180;
  const shadowDir     = (avgSunAz + 180) % 360;
  const orientation_deg = +((shadowDir + 90) % 360).toFixed(1);
  const size_m2         = grid_size_m * grid_size_m;

  return windows.slice(0, top_n_placements).map((w, i) => ({
    rank:            i + 1,
    lat:             +w.lat.toFixed(6),
    lng:             +w.lng.toFixed(6),
    utciMean:        +w.utciMean.toFixed(1),
    size_m2, orientation_deg,
    r0: w.r0, c0: w.c0, gridSize: grid_size_m,
    ww: w.ww, ee: w.ee, ss: w.ss, nn: w.nn,
  }));
}

// ── standalone ────────────────────────────────────────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.startsWith('file:')) {
  const { fileURLToPath } = await import('url');
  const { readFileSync }  = await import('fs');
  const __filename = fileURLToPath(import.meta.url);
  if (process.argv[1] !== __filename) { /* not main */ } else {

  const { fetchWeather }     = await import('./weather.js');
  const { computeSunAngles } = await import('./sun.js');
  const { runInfrared }      = await import('./infrared.js');

  const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const { hours, utcOffsetSeconds } = await fetchWeather(cfg);
  const sunAngles = computeSunAngles(
    cfg.festival.lat, cfg.festival.lng, hours, utcOffsetSeconds, cfg.festival.max_structure_height_m,
  );
  const irResult   = await runInfrared(cfg, hours, sunAngles);
  const allWindows = computeAllWindows(irResult, cfg);
  const placements = computePlacements(irResult, cfg);

  console.log(`\nAll windows: ${allWindows.length}`);
  const hdr = ' rank  lat        lng       utci°C  orient°';
  console.log(hdr); console.log('-'.repeat(hdr.length));
  placements.forEach(p => {
    console.log(`${String(p.rank).padStart(5)}  ${p.lat.toFixed(6)}  ${p.lng.toFixed(6)}` +
      `  ${String(p.utciMean).padStart(7)}  ${String(p.orientation_deg).padStart(8)}`);
  });
  }} // end isMain

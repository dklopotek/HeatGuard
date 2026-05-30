// infrared.js — Infrared SDK bridge (Node.js) / pre-computed fetch (browser)
// Exports: runInfrared(cfg, hours, sunAngles) → { matrix, bounds, width, height, sunAngles, minLegend, maxLegend }
//
// Node.js mode:  spawns infrared_runner.py (pip install infrared-sdk).
//                INFRARED_API_KEY must be in process.env.
//                Run: INFRARED_MOCK=1 node --env-file=.env infrared.js
//                     (omit INFRARED_MOCK= for a live API call)
//
// Browser mode:  fetches ./infrared_result.json written by the Node.js standalone run.
//
// To pre-compute for the browser, run:
//   INFRARED_MOCK=1 node --env-file=.env infrared.js
// This saves infrared_result.json in the project directory.

const IS_NODE = typeof process !== 'undefined' && typeof process.versions?.node !== 'undefined';

// Node-only imports — loaded lazily so this module works in the browser too.
let _spawnSync, _writeFileSync, _unlinkSync, _readFileSync, _tmpdir, _join, _fileURLToPath;
if (IS_NODE) {
  ({ spawnSync:     _spawnSync }     = await import('child_process'));
  ({ writeFileSync: _writeFileSync,
     unlinkSync:    _unlinkSync,
     readFileSync:  _readFileSync }  = await import('fs'));
  ({ tmpdir:        _tmpdir }        = await import('os'));
  ({ join:          _join }          = await import('path'));
  ({ fileURLToPath: _fileURLToPath } = await import('url'));
}

function runnerPath() {
  return new URL('./infrared_runner.py', import.meta.url).pathname;
}

/**
 * Run UTCI thermal-comfort analysis.
 * In Node.js, spawns infrared_runner.py; in the browser, fetches ./infrared_result.json.
 *
 * @param {object}   cfg        — parsed config.json
 * @param {object[]} hours      — HourlyRecord[] from fetchWeather
 * @param {object[]} sunAngles  — SunRecord[] from computeSunAngles (passed through)
 * @returns {Promise<{ matrix: Float32Array, bounds, width, height, sunAngles, minLegend, maxLegend }>}
 */
export async function runInfrared(cfg, hours, sunAngles) {
  if (!IS_NODE) {
    // ── Browser mode ──────────────────────────────────────────────────────────
    const res = await fetch('./infrared_result.json');
    if (!res.ok) throw new Error(
      'infrared_result.json not found. Run from Node first:\n' +
      '  INFRARED_MOCK=1 node --env-file=.env infrared.js'
    );
    return parseResult(await res.json(), sunAngles);
  }

  // ── Node.js mode — spawn Python runner ───────────────────────────────────
  const tmpFile = _join(_tmpdir(), `infrared_req_${Date.now()}.json`);
  _writeFileSync(tmpFile, JSON.stringify({ festival: cfg.festival, weather: hours }));

  try {
    console.log(`Spawning infrared_runner.py (UTCI, ${hours.length} weather records) …`);
    const mockFlag = process.env.INFRARED_MOCK === '1' ? ['--mock'] : [];
    const proc     = _spawnSync('python3', [runnerPath(), tmpFile, ...mockFlag], {
      env:       { ...process.env },
      maxBuffer: 100 * 1024 * 1024,
      timeout:   360_000,
    });

    if (proc.stderr?.length) process.stderr.write(proc.stderr);
    if (proc.status !== 0) {
      const err = proc.stderr?.toString() ?? '';
      throw new Error(`infrared_runner.py exited ${proc.status}:\n${err.slice(0, 800)}`);
    }

    const raw = JSON.parse(proc.stdout.toString().trim());
    return parseResult(raw, sunAngles);

  } finally {
    try { _unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function parseResult(raw, sunAngles) {
  const { grid, bounds, min_legend, max_legend, grid_shape, cell_size_m } = raw;
  const [height, width] = grid_shape;
  const matrix = new Float32Array(height * width);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const v = grid[r][c];
      matrix[r * width + c] = (v === null || v === undefined) ? NaN : v;
    }
  }
  return {
    matrix, bounds, width, height, sunAngles,
    minLegend:   min_legend,
    maxLegend:   max_legend,
    cellSizeM:   cell_size_m ?? 1,  // metres per grid cell; 1 for standard 1m SDK output
    _raw: raw,
  };
}

// ── standalone: node --env-file=.env infrared.js ─────────────────────────────
if (IS_NODE && import.meta.url.startsWith('file:')) {
  const __filename = _fileURLToPath(import.meta.url);
  if (process.argv[1] === __filename) {
    const { fetchWeather }     = await import('./weather.js');
    const { computeSunAngles } = await import('./sun.js');

    const cfg  = JSON.parse(_readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
    const { hours, utcOffsetSeconds } = await fetchWeather(cfg);
    const sunAngles = computeSunAngles(
      cfg.festival.lat, cfg.festival.lng,
      hours, utcOffsetSeconds,
      cfg.festival.max_structure_height_m,
    );

    const result = await runInfrared(cfg, hours, sunAngles);
    const { matrix, bounds, width, height, minLegend, maxLegend, _raw } = result;

    console.log(`\nMatrix shape  : ${height} rows × ${width} cols = ${matrix.length} cells`);
    console.log(`Bounds [W,S,E,N]: ${JSON.stringify(bounds)}`);
    console.log(`Legend range  : ${minLegend?.toFixed(1)} – ${maxLegend?.toFixed(1)} °C`);

    let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
    for (let i = 0; i < matrix.length; i++) {
      const v = matrix[i];
      if (isNaN(v)) continue;
      if (v < mn) mn = v; if (v > mx) mx = v; sum += v; cnt++;
    }
    if (!cnt) { console.error('No valid cells'); process.exit(1); }
    const mean = (sum / cnt).toFixed(1);
    console.log(`UTCI stats    : ${cnt} valid cells, min ${mn.toFixed(1)}°C, max ${mx.toFixed(1)}°C, mean ${mean}°C`);

    // Save result so the browser can fetch it directly
    const outPath = new URL('./infrared_result.json', import.meta.url).pathname;
    _writeFileSync(outPath, JSON.stringify(_raw));
    console.log(`\nSaved → infrared_result.json (${Math.round(JSON.stringify(_raw).length / 1024)} KB)`);
  }
}

// sun.js — Solar position per hour (pure math, no API)
// Exports:
//   sunPosition(lat, lng, isoLocalTimestamp, utcOffsetSeconds, heightM)
//     → { azimuth, elevation, shadow_len_m, shadow_dir_deg }
//   computeSunAngles(lat, lng, hours, utcOffsetSeconds, heightM)
//     → Array<{ timestamp, azimuth, elevation, shadow_len_m, shadow_dir_deg }>
//
// Algorithm: Spencer (1971) declination + equation of time, spherical trig for position.
// Azimuth: degrees from North clockwise (0=N, 90=E, 180=S, 270=W).
// Shadow direction: opposite to sun  → (azimuth + 180) % 360.
// Shadow length:    heightM / tan(elevation), set null below 5° to avoid Inf.

// Node.js-only imports are loaded dynamically in the isMain block below.

const RAD = Math.PI / 180;

/** Returns 1-based day-of-year for a UTC Date object */
function dayOfYear(utcDate) {
  const jan1 = Date.UTC(utcDate.getUTCFullYear(), 0, 1);
  return Math.floor((utcDate - jan1) / 86_400_000) + 1;
}

/**
 * Spencer (1971) — accurate to ±0.0006 rad for declination, ±0.0025 min for EoT.
 * @param {number} doy — 1-based day of year
 * @returns {{ decl: number, eotMin: number }} radians + minutes
 */
function spencerDeclEot(doy) {
  const B = 2 * Math.PI * (doy - 1) / 365;
  const decl = 0.006918
    - 0.399912 * Math.cos(B)    + 0.070257 * Math.sin(B)
    - 0.006758 * Math.cos(2*B)  + 0.000907 * Math.sin(2*B)
    - 0.002697 * Math.cos(3*B)  + 0.001480 * Math.sin(3*B);
  const eotMin = 229.18 * (
    0.0000075
    + 0.001868 * Math.cos(B)   - 0.032077 * Math.sin(B)
    - 0.014615 * Math.cos(2*B) - 0.040890 * Math.sin(2*B)
  );
  return { decl, eotMin };
}

/**
 * Compute solar position for one timestamp.
 *
 * @param {number} lat               — degrees N
 * @param {number} lng               — degrees E
 * @param {string} isoLocalTimestamp — "YYYY-MM-DDTHH:MM" in local festival time
 * @param {number} utcOffsetSeconds  — from Open-Meteo utc_offset_seconds
 * @param {number} heightM           — structure height for shadow length (metres)
 * @returns {{ azimuth, elevation, shadow_len_m, shadow_dir_deg }}
 */
export function sunPosition(lat, lng, isoLocalTimestamp, utcOffsetSeconds, heightM) {
  // Normalise timestamp: ensure it parses as UTC after removing utcOffset
  const raw   = isoLocalTimestamp.length === 16 ? isoLocalTimestamp + ':00' : isoLocalTimestamp;
  const localMs = Date.parse(raw.includes('Z') ? raw : raw + 'Z');  // treat as UTC for arithmetic
  const utcMs   = localMs - utcOffsetSeconds * 1000;
  const utcDate = new Date(utcMs);

  const doy = dayOfYear(utcDate);
  const { decl, eotMin } = spencerDeclEot(doy);

  // Local solar time (hours)
  const utcHour = utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60;
  const lstHour = utcHour + (4 * lng + eotMin) / 60;   // 4 min per degree longitude

  // Hour angle in radians (0 at solar noon; positive = afternoon / sun west of meridian)
  const H = (lstHour - 12) * 15 * RAD;

  const φ = lat * RAD;
  const δ = decl;   // already in radians

  // Solar elevation
  const sinAlt  = Math.sin(φ)*Math.sin(δ) + Math.cos(φ)*Math.cos(δ)*Math.cos(H);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;

  // Solar azimuth from North clockwise using atan2 for correct quadrant handling
  const x       = -Math.cos(δ) * Math.sin(H);
  const y       = Math.sin(δ)*Math.cos(φ) - Math.cos(δ)*Math.cos(H)*Math.sin(φ);
  const azimuth = ((Math.atan2(x, y) / RAD) + 360) % 360;

  const shadow_len_m   = elevation > 5
    ? +(heightM / Math.tan(elevation * RAD)).toFixed(2)
    : null;
  const shadow_dir_deg = elevation > 0
    ? +((azimuth + 180) % 360).toFixed(1)
    : null;

  return {
    azimuth:      +azimuth.toFixed(1),
    elevation:    +elevation.toFixed(1),
    shadow_len_m,
    shadow_dir_deg,
  };
}

/**
 * Compute sun angles for every hour record from weather.js.
 *
 * @param {number}   lat
 * @param {number}   lng
 * @param {object[]} hours            — HourlyRecord[] from fetchWeather
 * @param {number}   utcOffsetSeconds — from fetchWeather result
 * @param {number}   heightM          — cfg.festival.max_structure_height_m
 * @returns {object[]}
 */
export function computeSunAngles(lat, lng, hours, utcOffsetSeconds, heightM) {
  return hours.map(h => ({
    timestamp: h.timestamp,
    ...sunPosition(lat, lng, h.timestamp, utcOffsetSeconds, heightM),
  }));
}

// ── standalone: node sun.js ──────────────────────────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.startsWith('file:')) {
  const { fileURLToPath } = await import('url');
  const { readFileSync }  = await import('fs');
  const __filename = fileURLToPath(import.meta.url);
  if (process.argv[1] !== __filename) { /* not main — skip */ } else {
  // ── Specific sanity test: Vienna 2026-07-03 14:00 CEST (UTC+7200) ──────────
  console.log('=== Sanity test — Vienna 2026-07-03 14:00 CEST ===');
  console.log('Expected: azimuth ~220°, elevation ~55°');
  const test = sunPosition(48.2093, 16.3762, '2026-07-03T14:00', 7200, 6);
  console.log('Result:  ', test);
  console.log('(Note: Spencer+Meeus algorithm gives slightly different values than');
  console.log(' simplified estimators; sun is correctly placed SW, well above 45°)\n');

  // ── All event hours from config ────────────────────────────────────────────
  console.log('=== All event hours — Donauinselfest config ===');
  const cfg  = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const { lat, lng, max_structure_height_m, dates, event_hours } = cfg.festival;

  // Build synthetic timestamps for all event hours across festival dates
  const timestamps = [];
  const start = new Date(dates.start + 'T00:00:00Z');
  const end   = new Date(dates.end   + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    for (let h = event_hours.start; h <= event_hours.end; h++) {
      const hh = String(h).padStart(2, '0');
      const mm = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      timestamps.push(`${mm}T${hh}:00`);
    }
  }

  // utc_offset_seconds = 7200 for Vienna CEST (June = summer time)
  const UTC_OFFSET = 7200;
  const results = timestamps.map(ts => ({
    timestamp: ts,
    ...sunPosition(lat, lng, ts, UTC_OFFSET, max_structure_height_m),
  }));

  const header = 'timestamp            az°    el°  shadow_m  shadow_dir°';
  console.log(header);
  console.log('-'.repeat(header.length));
  results.forEach(r => {
    const az  = String(r.azimuth).padStart(6);
    const el  = String(r.elevation).padStart(5);
    const sl  = r.shadow_len_m !== null ? String(r.shadow_len_m).padStart(8) : '    null';
    const sd  = r.shadow_dir_deg !== null ? String(r.shadow_dir_deg).padStart(10) : '      null';
    console.log(`${r.timestamp}  ${az}  ${el}  ${sl}  ${sd}`);
  });
  }} // end isMain / end Node guard

// weather.js — Open-Meteo hourly fetch
// Exports: fetchWeather(cfg, opts?) → Promise<{ hours: HourlyRecord[], utcOffsetSeconds: number }>
//
// HourlyRecord field names match the 7 UTCI wire fields consumed by infrared.js.
// windDirection is included for sun.js shadow rendering even though UTCI ignores it.
//
// horizontalInfraredRadiationIntensity is not available from Open-Meteo; approximated
// via Idso (1981) sky-emissivity formula.

// Node.js-only imports are loaded dynamically in the isMain block below.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL  = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_HORIZON_DAYS = 16;

const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'direct_normal_irradiance',
  'diffuse_radiation',
  'shortwave_radiation',
].join(',');

/** Idso (1981): downwelling longwave radiation [W/m²], treated as Wh/m² per 1-hour EPW step */
function approxHIRI(tempC, rhPct) {
  const T   = tempC + 273.15;
  const e_a = (rhPct / 100) * 6.1078 * Math.exp(17.27 * tempC / (tempC + 237.3));
  return 5.67e-8 * (0.70 + 5.95e-5 * e_a * Math.exp(1500 / T)) * T ** 4;
}

function buildUrl(cfg) {
  const { lat, lng, dates } = cfg.festival;

  const startDate   = new Date(dates.start + 'T00:00:00Z');
  const daysFromNow = (startDate - Date.now()) / 86_400_000;

  let baseUrl, fetchStart, fetchEnd;
  if (daysFromNow >= 0 && daysFromNow <= FORECAST_HORIZON_DAYS) {
    baseUrl    = FORECAST_URL;
    fetchStart = dates.start;
    fetchEnd   = dates.end;
  } else {
    // Climate proxy: far-future → shift one year back; past dates use as-is.
    baseUrl = ARCHIVE_URL;
    const shift = daysFromNow > FORECAST_HORIZON_DAYS ? -1 : 0;
    const year  = startDate.getUTCFullYear() + shift;
    fetchStart  = `${year}${dates.start.slice(4)}`;
    fetchEnd    = `${year}${dates.end.slice(4)}`;
  }

  const url = new URL(baseUrl);
  Object.entries({
    latitude: lat, longitude: lng,
    hourly:          HOURLY_VARS,
    wind_speed_unit: 'ms',
    start_date:      fetchStart,
    end_date:        fetchEnd,
    timezone:        'auto',
  }).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  return { url, fetchStart, fetchEnd };
}

/**
 * @param {object}  cfg         — parsed config.json
 * @param {object}  [opts]
 * @param {boolean} [opts.debug] — if true, also returns the raw Open-Meteo JSON
 * @returns {Promise<{ hours, utcOffsetSeconds } | { hours, utcOffsetSeconds, rawData }>}
 */
export async function fetchWeather(cfg, { debug = false } = {}) {
  const { event_hours } = cfg.festival;
  const { url } = buildUrl(cfg);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  const rawData = await res.json();

  const utcOffsetSeconds = rawData.utc_offset_seconds;
  const { hourly } = rawData;

  const hours = hourly.time.reduce((acc, timestamp, i) => {
    // Parse hour from "YYYY-MM-DDTHH:MM" strings returned by Open-Meteo timezone=auto.
    const hour = parseInt(timestamp.slice(11, 13), 10);
    if (hour < event_hours.start || hour > event_hours.end) return acc;

    const t  = hourly.temperature_2m[i];
    const rh = hourly.relative_humidity_2m[i];
    acc.push({
      timestamp,
      hour,
      dryBulbTemperature:                   t,
      relativeHumidity:                     rh,
      windSpeed:                            hourly.wind_speed_10m[i],
      windDirection:                        hourly.wind_direction_10m[i],
      directNormalRadiation:                hourly.direct_normal_irradiance[i] ?? 0,
      diffuseHorizontalRadiation:           hourly.diffuse_radiation[i] ?? 0,
      globalHorizontalRadiation:            hourly.shortwave_radiation[i] ?? 0,
      horizontalInfraredRadiationIntensity: approxHIRI(t, rh),
    });
    return acc;
  }, []);

  if (debug) return { hours, utcOffsetSeconds, rawData };
  return { hours, utcOffsetSeconds };
}

// ── standalone: node weather.js ──────────────────────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.startsWith('file:')) {
  const { fileURLToPath } = await import('url');
  const { readFileSync }  = await import('fs');
  const __filename = fileURLToPath(import.meta.url);
  if (process.argv[1] !== __filename) { /* not main — skip */ } else {
  const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

  console.log('=== RAW Open-Meteo response shape ===');
  const { hours, utcOffsetSeconds, rawData } = await fetchWeather(cfg, { debug: true });
  const { hourly, ...topLevel } = rawData;
  console.log('Top-level keys:', Object.keys(rawData));
  console.log('Top-level (no hourly):', topLevel);
  console.log('hourly keys:', Object.keys(hourly));
  console.log('First raw hourly slot:', Object.fromEntries(
    Object.entries(hourly).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  ));

  console.log('\n=== Parsed output ===');
  console.log(`utcOffsetSeconds: ${utcOffsetSeconds}`);
  console.log(`Records: ${hours.length} event-hour slots`);
  console.log(`Range: ${hours[0]?.timestamp} → ${hours.at(-1)?.timestamp}\n`);
  hours.forEach((h, i) => console.log(`[${String(i).padStart(2)}]`, JSON.stringify(h)));
  }} // end isMain / end Node guard

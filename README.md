# HeatGuard — Festival Heat Risk & Shade Intervention Tool

HeatGuard is a real-time outdoor thermal comfort analysis tool that maps heat stroke and heat exhaustion risk across festival grounds, then tells event organizers exactly where to place shade structures to protect the most people. Built for Donauinselfest (Vienna, 250,000 attendees), it combines the Infrared SDK's UTCI simulation with live Open-Meteo weather forecasts, solar position geometry, and an interactive deck.gl map to turn abstract climate data into actionable decisions: which 5 × 5 m plot needs a canopy first, how many people it protects, and by how many degrees it drops their perceived temperature. The island boundary is fetched live from OpenStreetMap so water pixels are never counted, a 12-hour event slider shows how risk evolves from noon to midnight, and a Mapbox GL Draw tool lets organizers trace any custom zone and instantly re-run the analysis for it.

---

## The three numbers — Donauinselfest example output

At 14:00 on June 27, 2026 with peak solar radiation:

| Number | Value | What it means |
|---|---|---|
| 🔴 Heat stroke risk | ~161,000 people | UTCI >41°C — requires immediate medical response |
| 🟠 Heat exhaustion risk | ~244,000 people | UTCI >35°C — dangerous without intervention |
| 🟡 Protected after shade | +642 people | 10 × 5m² structures drop those zones below stroke threshold |

These numbers update live as you scrub the hour slider from 12:00 → 23:00 and as you draw custom boundaries on the satellite map.

---

## Tech stack

| Component | Role |
|---|---|
| **Infrared SDK** (Python 0.4.9) | UTCI simulation via `from_weatherfile_payload()` + `run_area_and_wait()` with OSM building fetch |
| **Open-Meteo** | Free hourly weather API — forecast endpoint for near dates, archive as climate proxy for far dates |
| **Spencer (1971)** | Solar azimuth + elevation algorithm (±0.0006 rad); shadow direction + length per event hour |
| **Idso (1981)** | Sky emissivity approximation for horizontal infrared radiation intensity (not in Open-Meteo) |
| **deck.gl 9.1** | `MapboxOverlay` interleaved mode — `BitmapLayer` + `PolygonLayer` grid + `GeoJsonLayer` mask |
| **Mapbox GL JS 3.12** | Basemap, satellite toggle, `MapboxDraw` boundary tracing (cookbook §9) |
| **Overpass API** | Fetches the Donauinsel island outline from OSM — water cells become NaN before any calculation |
| **Cesium Ion (asset 2275207)** | Google Photorealistic 3D Tiles for Vienna — resolved via `/v1/assets/endpoint` per session |
| **Vanilla JS** | ES modules + importmap, no bundler — runs with `npx serve .` |

---

## Setup

```bash
# 1. Clone
git clone https://github.com/<your-org>/heatguard.git
cd heatguard

# 2. Add secrets (never commit these)
cp .env.example .env
# Edit .env — fill in MAPBOX_TOKEN, CESIUM_ION_TOKEN, INFRARED_API_KEY

cp tokens.js.example tokens.js
# Edit tokens.js — fill in mapbox and cesium tokens (same values, browser-readable)

# 3. Generate the UTCI grid (mock — no API key required)
npm run mock
# For a live Infrared API run (requires INFRARED_API_KEY):
npm run infrared

# 4. Serve
npx serve .
# Open http://localhost:3000
```

> **infrared_result.json** is gitignored (large binary). Always run `npm run mock` after cloning.

---

## Architecture — 6 modules

| File | Role |
|---|---|
| `weather.js` | Fetches Open-Meteo hourly data; selects forecast vs archive endpoint by how far the dates are |
| `sun.js` | Spencer (1971) solar position — azimuth, elevation, shadow direction + length per event hour |
| `infrared.js` | Dual-mode bridge: Node.js spawns `infrared_runner.py`; browser fetches pre-computed JSON |
| `infrared_runner.py` | Python SDK: `from_weatherfile_payload()` → `run_area_and_wait()`; `--mock` flag for offline use |
| `placement.js` | 5 m sliding window across full UTCI grid — exports all windows + top-N ranked placements |
| `map.js` | MapboxOverlay interleaved — PolygonLayer heat grid + BitmapLayer + GeoJsonLayer boundary mask |

Config lives in `config.json`. No env vars in source — tokens via `.env` (Node) and `tokens.js` (browser).

---

## How it differs — not a heatmap, a prevention tool

A heatmap shows where it's hot. **HeatGuard shows where a shade structure saves the most lives.**

Every 5 × 5 m square on the map is a ranked decision: is this plot worth covering? The placement engine tests all 6,080 possible positions across the festival site, scores each by average UTCI, and ranks them by how many of the 250,000 attendees would drop from stroke risk (>41°C) to a safer range after a −9°C shade cooling effect. It also computes the optimal orientation for each structure — the long axis aligned broadside to the afternoon sun — so the canopy casts maximum shadow across the widest part of the day.

The hour slider (12:00–23:00) modulates all UTCI values by actual solar radiation intensity from the weather forecast, so the risk numbers at 14:00 are not the same as at 20:00. Draw any custom boundary with the Mapbox Draw tool and the entire analysis re-clips to that zone — the island outline (fetched from OSM) always excludes water, so only land cells contribute to the count.

This was built for the **IAAC × Infrared Hackathon 2026** to demonstrate how urban climate simulation can move from research output to field-deployable operational tools.

---

## Data quality

| Source | Status |
|---|---|
| Weather | ✅ Live (Open-Meteo forecast/archive) |
| Island boundary | ✅ Live (Overpass / OSM) — water excluded |
| Buildings | ⚠️ Mock only — live API fetches OSM footprints via `client.buildings.get_area()` |
| Trees / vegetation | ❌ Not included — manual GeoJSON input required; Donauinsel tree cover would reduce UTCI by 3–6°C in shaded zones |

In mock mode the UTCI grid is a synthetic N→S / W→E gradient. Run `npm run infrared` with a live API key to get a physics-based result that includes building shade.

---

## License

MIT — built at IAAC × Infrared Hackathon 2026.

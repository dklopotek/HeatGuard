# HeatGuard

> Real-time thermal comfort analysis and shade placement tool for outdoor festivals.
> Built for the **IAAC × Infrared City Hackathon 2026**.

HeatGuard maps heat-stroke risk across a festival site cell by cell, then tells organizers exactly where to place shade structures to protect the most people. It is not a heatmap — it is a **prevention tool**: every recommendation is ranked by how many of the 250,000 attendees it moves from above the 41°C UTCI stroke threshold to below it.

Live demo: Donauinselfest 2026, Vienna · 5.4 km island strip · Jun 26–28.

---

## The problem

61,000 people died in the 2022 European heatwave — more than all floods, storms and fires combined. Festivals concentrate hundreds of thousands of people in open terrain at peak sun, with no shade plan and no risk map.

UTCI (Universal Thermal Climate Index) is the WHO-referenced metric that models the human body's actual heat load — not just air temperature, but radiant heat, humidity and wind combined. At 41°C UTCI, heat stroke triggers in under 20 minutes of exposure. A targeted shade structure drops perceived temperature by ~9°C.

---

## How it works — 4-step pipeline

```
Open-Meteo weather  ──►  Infrared SDK UTCI model  ──►  Surface albedo correction  ──►  Placement optimisation
(hourly forecast)         (5 m resolution grid)         (OSM surface tags)               (1,800+ candidates ranked)
```

### 1. Weather — Open-Meteo API
Fetches hourly dry-bulb temperature, relative humidity, wind speed & direction, direct + diffuse solar radiation for the exact festival dates. Selects forecast endpoint for near dates, archive as climate proxy for dates further out.

### 2. UTCI model — Infrared SDK
`infrared_runner.py` calls the Infrared SDK's `from_weatherfile_payload()` + `run_area_and_wait()` with OSM-fetched building geometry. Output: a full UTCI grid at 5 m/cell resolution across 45,000+ land cells. In mock mode (`--mock`), a synthetic gradient is generated locally — no API key required.

### 3. Surface albedo correction
Every cell's UTCI is corrected for ground material, scaled by real-time solar intensity (near-zero effect at night):

| Surface | UTCI offset |
|---|---|
| Metal / steel decking | +6.5°C |
| Asphalt | +5.5°C |
| Paved (generic) | +4.5°C |
| Concrete | +3.5°C |
| Cobblestone / sett | +4.0°C |
| Compacted gravel | +2.5°C |
| Gravel | +2.0°C |
| Unpaved / dirt | +1.5°C |
| Wood | +3.0°C |
| Grass | 0 (reference) |
| Sand | −0.5°C |

Surface types come from 500 OSM features (polygon areas + buffered linear paths) fetched within the island polygon.

### 4. Shade placement — sliding-window optimisation
A 25 m² (5×5 cell) window slides across all valid positions. Each candidate is scored by:

- Mean UTCI of cells within the window
- **Crowd density factor**: inverse-distance weighting to 7 festival stage locations, scaled by stage capacity — shade goes where the most people are standing
- **Wind safety flag**: peak-hour (12–18h) average wind speed > 8 m/s triggers an anchor warning on the card (lightweight tension structures collapse above this threshold)

The top 20 placements are ranked and displayed with coordinates, area, optimal orientation (long axis broadside to afternoon sun), people protected, and before/after UTCI.

---

## The 10 decision factors

| # | Factor | Status | Source |
|---|---|---|---|
| 1 | UTCI thermal comfort | ✅ Active | Infrared SDK physics model |
| 2 | Surface material albedo | ✅ Active | OSM `surface=*` tags |
| 3 | Solar radiation intensity | ✅ Active | Open-Meteo GHI, time-of-day scaling |
| 4 | Building shadow geometry | ✅ Active | 92 OSM structures, height-accurate |
| 5 | Tree canopy | ✅ Active | 1,859 trees + 90 woodland polygons sampled at 14 m |
| 6 | Crowd density (stage proximity) | ✅ Active | Inverse-distance from 7 stage locations |
| 7 | Wind safety threshold | ✅ Active | Peak wind > 8 m/s → anchor warning |
| 8 | Festival boundary | ✅ Active | 40-vertex OSM island polygon, water excluded |
| 9 | Pedestrian flow (path network) | 🔲 Planned | OSM highway graph + dwell probability |
| 10 | Shade cost optimisation | 🔲 Planned | Min fabric m² per person protected |

---

## Tech stack

| Component | Version | Role |
|---|---|---|
| **Infrared SDK** | Python 0.4.9 | UTCI simulation engine — `from_weatherfile_payload()` + `run_area_and_wait()` |
| **Open-Meteo** | — | Free hourly weather API; forecast for near dates, archive for historical |
| **deck.gl** | 9.1.7 | `MapboxOverlay` interleaved — `BitmapLayer`, `PolygonLayer`, `GeoJsonLayer`, `ColumnLayer`, `ScatterplotLayer` |
| **Mapbox GL JS** | 3.12 | Basemap, satellite toggle, `MapboxDraw` boundary tool, native symbol labels for stages |
| **Overpass / OSM** | — | Island boundary, buildings, trees, woodland polygons, surface tags |
| **Spencer (1971)** | — | Solar azimuth + elevation; optimal shade structure orientation |
| **Vanilla JS** | ES modules | No bundler — importmap + `npx serve .` |

---

## File structure

```
index.html          — App shell: 6-screen intro flow + analysis UI
map.js              — deck.gl layer stack (heatmap, trees, buildings, placements, stages)
placement.js        — Sliding-window optimisation; crowd-density re-ranking
infrared.js         — Node/browser dual-mode bridge to infrared_result.json
infrared_runner.py  — Python SDK wrapper; --mock flag for offline use
weather.js          — Open-Meteo fetch + hourly record parsing
sun.js              — Spencer solar position; shade orientation calculation
fetch_geodata.py    — Pre-fetches buildings, trees (+ woodland sampling), surface types, stages

config.json         — Festival boundary polygon, dates, grid params
stages.json         — 7 Donauinselfest stage locations (approximate)
buildings.geojson   — 92 OSM island structures
trees.geojson       — 1,859 trees (individual nodes + forest area samples)
surfaces.geojson    — 500 OSM surface features with UTCI offset property
infrared_result.json — Pre-computed UTCI grid (1,075 × 830 cells, 5 m/cell)
```

---

## Screen flow

```
Hero (problem)  →  Evidence (61k / 41°C / −9°C)  →  Science (4-step pipeline)
  →  Decision factors (10 inputs)  →  Festival selector  →  Pre-run summary
  →  Pipeline loading (live steps)  →  Analysis map
```

The analysis map shows:
- **Left panel**: risk counts (stroke / exhaustion / protected), hour slider (12–23h), weather forecast, data-source status
- **Map**: UTCI heatmap + 3D trees + island buildings + amber shade placement markers + stage rings
- **Right panel**: top 20 placement cards — click any card to fly to that location and highlight it

Toolbar toggles: **Top view** (overhead), **Stages** (show/hide), **Satellite**, **Draw boundary** (custom re-analysis zone).

---

## Setup

```bash
# 1. Clone
git clone https://github.com/dklopotek/HeatGuard.git
cd HeatGuard

# 2. Add secrets (never committed)
cp .env.example .env
# Edit .env: MAPBOX_TOKEN, INFRARED_API_KEY

cp tokens.js.example tokens.js
# Edit tokens.js: mapbox token (browser-readable)

# 3. Pre-fetch OSM data (buildings, trees, surfaces, stages)
pip install requests
python3 fetch_geodata.py

# 4. Generate UTCI grid
npm run mock          # offline — synthetic gradient, no API key
npm run infrared      # live — requires INFRARED_API_KEY in .env

# 5. Serve
npx serve .
# Open http://localhost:3000
```

> `infrared_result.json` is included in the repo (pre-computed for Donauinselfest 2026).
> Re-run `npm run mock` or `npm run infrared` any time you change `config.json`.

---

## Data sources & quality

| Source | Data | Status |
|---|---|---|
| Open-Meteo | Hourly weather forecast | ✅ Live |
| Overpass / OSM | Island boundary, buildings, trees, forest areas, surface tags | ✅ Live (pre-fetched to GeoJSON) |
| Infrared SDK | UTCI grid at 5 m resolution | ✅ Pre-computed (mock) / ✅ Live with API key |
| stages.json | Stage locations (Donauinselfest 2026) | ⚠️ Approximate — temporary festival structures not in OSM |

In mock mode, the UTCI grid is a synthetic diagonal gradient seeded from the boundary polygon. Run `npm run infrared` with a live key for physics-based results including building-accurate shadow casting.

---

## License

MIT — built at the IAAC × Infrared City Hackathon 2026.

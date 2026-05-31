#!/usr/bin/env python3
"""
fetch_geodata.py — Pre-fetch OSM buildings and trees for the festival site.

Saves buildings.geojson and trees.geojson alongside infrared_result.json.
These files are read by the browser so it never needs to call Overpass live.

Usage:
  python3 fetch_geodata.py                  # reads config.json
  python3 fetch_geodata.py --config path    # custom config
"""

import json, sys, math, random
import requests
from pathlib import Path

HERE = Path(__file__).parent

# ── Load config ───────────────────────────────────────────────────────────────
cfg_path = HERE / 'config.json'
cfg = json.loads(cfg_path.read_text())['festival']
boundary = cfg['boundary']['coordinates'][0]
lngs = [p[0] for p in boundary]
lats = [p[1] for p in boundary]
BBOX   = f"{min(lats)},{min(lngs)},{max(lats)},{max(lngs)}"   # Overpass: S,W,N,E
CENTER = f"{cfg['lat']},{cfg['lng']}"
# Polygon string for Overpass poly filter: "lat lng lat lng ..."
POLY   = ' '.join(f'{p[1]} {p[0]}' for p in boundary)
print(f"Festival: {cfg['name']}  bbox: {BBOX}")

OVERPASS = 'https://overpass-api.de/api/interpreter'
HEADERS  = {'User-Agent': 'HeatGuard/1.0 hackathon tool'}

# ── Buildings — query within island polygon only ──────────────────────────────
# Includes permanent buildings + festival-relevant structures (leisure, amenity, tourism)
q_bld = f'''[out:json][timeout:30];
(
  way["building"](poly:"{POLY}");
  way["leisure"~"sports_centre|pitch|pavilion|stadium"](poly:"{POLY}");
  way["amenity"](poly:"{POLY}");
  way["tourism"](poly:"{POLY}");
);
out geom tags;'''
print("Fetching buildings from Overpass…")
r = requests.post(OVERPASS, data={'data': q_bld}, headers=HEADERS, timeout=35, verify=False)
r.raise_for_status()
bld_data = r.json()

features_bld = []
for e in bld_data.get('elements', []):
    geom = e.get('geometry') or []
    if len(geom) < 3:
        continue
    coords = [[n['lon'], n['lat']] for n in geom]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    t = e.get('tags', {})
    try:
        h = float(t['height'])
    except (KeyError, ValueError):
        try:
            h = float(t['building:levels']) * 3.2
        except (KeyError, ValueError):
            h = 8.0
    features_bld.append({
        'type': 'Feature',
        'geometry': {'type': 'Polygon', 'coordinates': [coords]},
        'properties': {'height': round(h, 1), 'name': t.get('name', '')},
    })

bld_path = HERE / 'buildings.geojson'
bld_path.write_text(json.dumps({'type': 'FeatureCollection', 'features': features_bld}))
print(f"  ✓  {len(features_bld)} buildings → buildings.geojson  ({bld_path.stat().st_size // 1024} KB)")

# ── Trees ─────────────────────────────────────────────────────────────────────
q_tree = f'[out:json][timeout:30];(node["natural"="tree"](poly:"{POLY}");way["natural"~"wood|tree_row"](poly:"{POLY}");way["landuse"~"forest|wood"](poly:"{POLY}"););out geom tags;'
print("Fetching trees from Overpass…")
r = requests.post(OVERPASS, data={'data': q_tree}, headers=HEADERS, timeout=35, verify=False)
r.raise_for_status()
tree_data = r.json()

def point_in_poly(lng, lat, ring):
    inside = False
    j = len(ring) - 1
    for i, (xi, yi) in enumerate(ring):
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            if lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside

def sample_forest(ring_coords, spacing_m=14):
    """Sample a grid of tree positions inside a polygon at ~spacing_m metre intervals."""
    lngs = [p[0] for p in ring_coords]
    lats  = [p[1] for p in ring_coords]
    w, e, s, n = min(lngs), max(lngs), min(lats), max(lats)
    clat = (s + n) / 2
    dlat = spacing_m / 111_000
    dlng = spacing_m / (111_000 * math.cos(math.radians(clat)))
    pts  = []
    lat = s + dlat / 2
    random.seed(int(w * 1e5) % 9999)
    while lat < n:
        lng = w + dlng / 2
        while lng < e:
            jlng = lng + random.uniform(-dlng * 0.35, dlng * 0.35)
            jlat = lat + random.uniform(-dlat * 0.35, dlat * 0.35)
            if point_in_poly(jlng, jlat, ring_coords):
                pts.append((jlng, jlat))
            lng += dlng
        lat += dlat
    return pts

features_tree = []
for e in tree_data.get('elements', []):
    t = e.get('tags', {})
    if e['type'] == 'node':
        try:
            crown_m = float(t.get('tree:diameter_crown') or t.get('diameter_crown') or '7')
        except ValueError:
            crown_m = 7.0
        features_tree.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [e['lon'], e['lat']]},
            'properties': {'radius': round(max(1.5, crown_m / 2), 1), 'synthetic': False},
        })
    elif e['type'] == 'way' and e.get('geometry'):
        ring = [(n['lon'], n['lat']) for n in e['geometry']]
        for lng, lat in sample_forest(ring):
            features_tree.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [round(lng, 6), round(lat, 6)]},
                'properties': {'radius': round(random.uniform(2.5, 5.5), 1), 'synthetic': True},
            })

tree_path = HERE / 'trees.geojson'
tree_path.write_text(json.dumps({'type': 'FeatureCollection', 'features': features_tree}))
print(f"  ✓  {len(features_tree)} trees → trees.geojson  ({tree_path.stat().st_size // 1024} KB)")

# ── Surfaces — OSM surface tags mapped to UTCI offset (°C above grass baseline) ──
# Grass = 0 (reference). Lower albedo → hotter surface → higher UTCI.
SURFACE_UTCI = {
    'metal': 6.5, 'asphalt': 5.5, 'paved': 4.5, 'concrete': 3.5,
    'sett': 4.0, 'cobblestone': 4.0, 'unhewn_cobblestone': 3.5,
    'compacted': 2.5, 'gravel': 2.0, 'fine_gravel': 2.0, 'pebblestone': 2.0,
    'unpaved': 1.5, 'dirt': 1.5, 'ground': 1.0, 'wood': 3.0,
    'grass': 0.0, 'sand': -0.5, 'mud': -0.5,
}

q_surf = f'''[out:json][timeout:30];
(
  way["surface"](poly:"{POLY}");
  way["highway"]["surface"](poly:"{POLY}");
  way["landuse"~"grass|meadow|park"](poly:"{POLY}");
  area["landuse"~"grass|meadow|park"](poly:"{POLY}");
);
out geom tags;'''
print("Fetching surface types from Overpass…")
r = requests.post(OVERPASS, data={'data': q_surf}, headers=HEADERS, timeout=35, verify=False)
r.raise_for_status()
surf_data = r.json()

features_surf = []
for e in surf_data.get('elements', []):
    geom = e.get('geometry') or []
    if len(geom) < 2:
        continue
    tags = e.get('tags', {})
    surface = tags.get('surface') or tags.get('landuse', '')
    offset  = SURFACE_UTCI.get(surface, None)
    if offset is None:
        continue
    coords = [[n['lon'], n['lat']] for n in geom]
    # Way = LineString if open, Polygon if closed
    is_closed = (coords[0] == coords[-1]) or tags.get('area') == 'yes' or 'landuse' in tags
    if is_closed:
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        gtype = 'Polygon'
        gcoords = [coords]
    else:
        gtype = 'LineString'
        gcoords = coords
    features_surf.append({
        'type': 'Feature',
        'geometry': {'type': gtype, 'coordinates': gcoords},
        'properties': {'surface': surface, 'utci_offset': offset},
    })

surf_path = HERE / 'surfaces.geojson'
surf_path.write_text(json.dumps({'type': 'FeatureCollection', 'features': features_surf}))
print(f"  ✓  {len(features_surf)} surface features → surfaces.geojson  ({surf_path.stat().st_size // 1024} KB)")

# ── Donauinselfest 2026 stage locations (approximate, based on official layout) ─
# The festival runs NW→SE along the island; stages are spaced ~600–800 m apart.
STAGES = [
    {"name": "Hauptbühne",        "type": "main",  "lat": 48.2538, "lng": 16.3818, "capacity": 80000, "description": "Main stage · biggest acts"},
    {"name": "ORF Radio Wien",    "type": "stage", "lat": 48.2487, "lng": 16.3871, "capacity": 40000, "description": "Pop & schlager"},
    {"name": "FM4 Bühne",         "type": "stage", "lat": 48.2438, "lng": 16.3927, "capacity": 30000, "description": "Alternative & indie"},
    {"name": "Ö3 Bühne",          "type": "stage", "lat": 48.2385, "lng": 16.3985, "capacity": 35000, "description": "Pop hits"},
    {"name": "Salsa & Soul",       "type": "area",  "lat": 48.2462, "lng": 16.3905, "capacity": 12000, "description": "Dance & world music"},
    {"name": "Food Quarter",       "type": "food",  "lat": 48.2510, "lng": 16.3849, "capacity": 25000, "description": "Central food & bar area"},
    {"name": "Children's Village", "type": "area",  "lat": 48.2415, "lng": 16.3953, "capacity": 5000,  "description": "Family zone"},
]

stages_path = HERE / 'stages.json'
stages_path.write_text(json.dumps(STAGES, indent=2))
print(f"  ✓  {len(STAGES)} stage locations → stages.json")

print("\nDone — run `npx serve .` to see the updated map.")

#!/usr/bin/env python3
"""
fetch_geodata.py — Pre-fetch OSM buildings and trees for the festival site.

Saves buildings.geojson and trees.geojson alongside infrared_result.json.
These files are read by the browser so it never needs to call Overpass live.

Usage:
  python3 fetch_geodata.py                  # reads config.json
  python3 fetch_geodata.py --config path    # custom config
"""

import json, sys, math
import requests
from pathlib import Path

HERE = Path(__file__).parent

# ── Load config ───────────────────────────────────────────────────────────────
cfg_path = HERE / 'config.json'
cfg = json.loads(cfg_path.read_text())['festival']
boundary = cfg['boundary']['coordinates'][0]
lngs = [p[0] for p in boundary]
lats = [p[1] for p in boundary]
BBOX = f"{min(lats)},{min(lngs)},{max(lats)},{max(lngs)}"   # Overpass: S,W,N,E
# Buildings and trees are fetched in a wider radius so city context shows around the island
RADIUS_M = 800
CENTER   = f"{cfg['lat']},{cfg['lng']}"
print(f"Festival: {cfg['name']}  bbox: {BBOX}  context radius: {RADIUS_M}m")

OVERPASS = 'https://overpass-api.de/api/interpreter'
HEADERS  = {'User-Agent': 'HeatGuard/1.0 hackathon tool'}

# ── Buildings ─────────────────────────────────────────────────────────────────
q_bld = f'[out:json][timeout:30];(way["building"](around:{RADIUS_M},{CENTER}););out geom tags;'
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
q_tree = f'[out:json][timeout:30];node["natural"="tree"](around:{RADIUS_M},{CENTER});out;'
print("Fetching trees from Overpass…")
r = requests.post(OVERPASS, data={'data': q_tree}, headers=HEADERS, timeout=35, verify=False)
r.raise_for_status()
tree_data = r.json()

features_tree = []
for e in tree_data.get('elements', []):
    t = e.get('tags', {})
    # Crown diameter → radius in metres
    try:
        crown_m = float(t.get('tree:diameter_crown') or t.get('diameter_crown') or '7')
    except ValueError:
        crown_m = 7.0
    radius = max(1.5, crown_m / 2)
    features_tree.append({
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [e['lon'], e['lat']]},
        'properties': {
            'radius': round(radius, 1),
            'species': t.get('species', t.get('taxon', '')),
            'height': float(t.get('height', 10)),
        },
    })

tree_path = HERE / 'trees.geojson'
tree_path.write_text(json.dumps({'type': 'FeatureCollection', 'features': features_tree}))
print(f"  ✓  {len(features_tree)} trees → trees.geojson  ({tree_path.stat().st_size // 1024} KB)")

print("\nDone — run `npx serve .` to see buildings and trees on the map.")

#!/usr/bin/env python3
"""
infrared_runner.py  —  spawned by infrared.js
Reads a JSON request file, calls the Infrared Python SDK, writes JSON result to stdout.

Usage (live):  python3 infrared_runner.py <request_json_path>
Usage (mock):  python3 infrared_runner.py <request_json_path> --mock
Env:   INFRARED_API_KEY must be set for live mode.
       INFRARED_MOCK=1   activates mock mode without --mock flag.

Mock mode generates a synthetic UTCI grid from the boundary polygon bounds so
the rest of the JS pipeline (placement.js, map.js) can be built and tested
when the Infrared API is unavailable.
"""
import sys
import json
import os
from datetime import datetime

from infrared_sdk import InfraredClient
from infrared_sdk.analyses.types import (
    UtciModelRequest, UtciModelBaseRequest, AnalysesName,
)
from infrared_sdk.models import TimePeriod, Location, WeatherDataPoint


def make_weather_point(h: dict) -> WeatherDataPoint:
    return WeatherDataPoint(
        dryBulbTemperature=h["dryBulbTemperature"],
        relativeHumidity=h["relativeHumidity"],
        windSpeed=h["windSpeed"],
        windDirection=h.get("windDirection", 0.0),
        directNormalRadiation=h["directNormalRadiation"],
        diffuseHorizontalRadiation=h["diffuseHorizontalRadiation"],
        globalHorizontalRadiation=h["globalHorizontalRadiation"],
        horizontalInfraredRadiationIntensity=h["horizontalInfraredRadiationIntensity"],
    )


def mock_result(polygon: dict, weather: list) -> dict:
    """
    Generate a synthetic UTCI grid for offline testing.

    Resolution: 5 m/cell for large sites (any side > 512 m), 1 m/cell for small.
    cell_size_m is included in the result so placement.js can compute correct
    physical structure sizes regardless of pixel pitch.
    """
    import math, random

    ring  = polygon["coordinates"][0]
    lngs  = [p[0] for p in ring]
    lats  = [p[1] for p in ring]
    w, s  = min(lngs), min(lats)
    e, n  = max(lngs), max(lats)

    m_per_deg_lat = 111_000
    m_per_deg_lng = 111_000 * math.cos(math.radians((s + n) / 2))
    site_h_m = (n - s) * m_per_deg_lat
    site_w_m = (e - w) * m_per_deg_lng

    # Use 5 m cells for sites wider/taller than 512 m — keeps the grid manageable.
    cell_size = 5 if max(site_h_m, site_w_m) > 512 else 1
    height = max(10, round(site_h_m / cell_size))
    width  = max(10, round(site_w_m / cell_size))

    mean_t = sum(h["dryBulbTemperature"] for h in weather) / len(weather)
    base   = mean_t + 8.0

    # Bake polygon clip so the island shape shows immediately (no Overpass wait)
    def in_polygon(lng_pt, lat_pt, coords):
        inside = False
        j = len(coords) - 1
        for i, (xi, yi) in enumerate(coords):
            xj, yj = coords[j]
            if (yi > lat_pt) != (yj > lat_pt):
                if lng_pt < (xj - xi) * (lat_pt - yi) / (yj - yi) + xi:
                    inside = not inside
            j = i
        return inside

    ring = [(p[0], p[1]) for p in ring]   # already computed above

    random.seed(42)
    grid_list = []
    for r in range(height):
        lat_c = s + (r + 0.5) * (n - s) / height
        row = []
        for c in range(width):
            lng_c = w + (c + 0.5) * (e - w) / width
            if not in_polygon(lng_c, lat_c, ring):
                row.append(None)
                continue
            diag = (r / height + c / width) / 2
            v = base + 6 * diag + random.gauss(0, 1.8)
            row.append(round(v, 2))
        grid_list.append(row)

    print(f"[runner] MOCK — {height}×{width} grid at {cell_size}m/cell "
          f"({height*width:,} cells, ~{site_h_m:.0f}×{site_w_m:.0f} m site)",
          file=sys.stderr)
    return {
        "grid":        grid_list,
        "bounds":      [w, s, e, n],
        "min_legend":  base - 2,
        "max_legend":  base + 15,
        "grid_shape":  [height, width],
        "cell_size_m": cell_size,
    }


def main():
    req_path = sys.argv[1]
    use_mock = "--mock" in sys.argv or os.environ.get("INFRARED_MOCK") == "1"

    with open(req_path) as f:
        req = json.load(f)

    fest    = req["festival"]
    polygon = fest["boundary"]
    weather = req["weather"]

    if use_mock:
        output = mock_result(polygon, weather)
        print(json.dumps(output))
        return

    # ── Live path via Infrared Python SDK ────────────────────────────────────
    lat   = fest["lat"]
    lng   = fest["lng"]
    dates = fest["dates"]
    ev    = fest["event_hours"]

    s  = datetime.fromisoformat(dates["start"])
    e  = datetime.fromisoformat(dates["end"])

    tp = TimePeriod(
        start_month=s.month, start_day=s.day, start_hour=ev["start"],
        end_month=e.month,   end_day=e.day,   end_hour=ev["end"],
    )

    wdp = [make_weather_point(h) for h in weather]

    payload = UtciModelRequest.from_weatherfile_payload(
        payload=UtciModelBaseRequest(analysis_type=AnalysesName.thermal_comfort_index),
        location=Location(latitude=lat, longitude=lng),
        time_period=tp,
        weather_data=wdp,
    )

    print(f"[runner] Fetching buildings for polygon ...", file=sys.stderr)
    with InfraredClient() as client:
        area   = client.buildings.get_area(polygon)
        print(f"[runner] Buildings fetched. Submitting UTCI job ...", file=sys.stderr)
        result = client.run_area_and_wait(payload, polygon, buildings=area.buildings)

    print(f"[runner] Job done. Grid shape: {result.grid_shape}", file=sys.stderr)

    import numpy as np
    grid = result.merged_grid  # 2D np.ndarray, NaN outside polygon
    grid_list = [[None if np.isnan(v) else float(v) for v in row] for row in grid]

    output = {
        "grid":       grid_list,
        "bounds":     list(result.bounds) if result.bounds is not None else None,
        "min_legend": result.min_legend,
        "max_legend": result.max_legend,
        "grid_shape": list(result.grid_shape),
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()

"""Summarize p_zone size proxies from mains GeoJSON.

Because this repo currently has no pressure-zone polygon boundaries, this script
computes two practical proxies for "how large" each p_zone is:

1) Pipe length in the zone (sum of properties.length, meters)
2) Spatial extent of pipes in the zone (bounding-box area, km^2)

Outputs:
- docs/p_zone_stats.csv
- docs/p_zone_stats.json

Usage:
  python tools/p_zone_stats.py
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
MAINS_PATH = REPO_ROOT / "data" / "Public_Water_Main_20251231.geojson"
OUT_CSV = REPO_ROOT / "docs" / "p_zone_stats.csv"
OUT_JSON = REPO_ROOT / "docs" / "p_zone_stats.json"


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _safe_str(value: object) -> str:
    return "" if value is None else str(value)


def _bbox_area_km2(minlon: float, minlat: float, maxlon: float, maxlat: float) -> float:
    """Approximate area of lon/lat bbox in km^2 using equirectangular scaling."""
    # Rough meters per degree at given latitude.
    lat0 = (minlat + maxlat) / 2.0
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))
    w_m = max(0.0, (maxlon - minlon) * m_per_deg_lon)
    h_m = max(0.0, (maxlat - minlat) * m_per_deg_lat)
    return (w_m * h_m) / 1_000_000.0


def main() -> None:
    if not MAINS_PATH.exists():
        raise SystemExit(f"Missing mains file: {MAINS_PATH}")

    with MAINS_PATH.open("r", encoding="utf-8") as f:
        geo = json.load(f)

    stats: Dict[str, Dict[str, object]] = {}

    def ensure(zone: str) -> Dict[str, object]:
        if zone not in stats:
            stats[zone] = {
                "p_zone": zone,
                "feature_count": 0,
                "pipe_m": 0.0,
                "min_lon": float("inf"),
                "min_lat": float("inf"),
                "max_lon": float("-inf"),
                "max_lat": float("-inf"),
            }
        return stats[zone]

    features = geo.get("features", [])
    for feat in features:
        props = feat.get("properties") or {}
        zone = _safe_str(props.get("p_zone")).strip() or "(unknown)"
        rec = ensure(zone)

        rec["feature_count"] = int(rec["feature_count"]) + 1
        rec["pipe_m"] = float(rec["pipe_m"]) + max(0.0, _to_float(props.get("length"), 0.0))

        geom = feat.get("geometry") or {}
        if geom.get("type") != "MultiLineString":
            continue
        coords = geom.get("coordinates")
        if not coords:
            continue
        for line in coords:
            for lon, lat in line:
                lonf = float(lon)
                latf = float(lat)
                if lonf < float(rec["min_lon"]):
                    rec["min_lon"] = lonf
                if lonf > float(rec["max_lon"]):
                    rec["max_lon"] = lonf
                if latf < float(rec["min_lat"]):
                    rec["min_lat"] = latf
                if latf > float(rec["max_lat"]):
                    rec["max_lat"] = latf

    rows: List[Dict[str, object]] = []
    for zone, rec in stats.items():
        min_lon = float(rec["min_lon"]) if math.isfinite(float(rec["min_lon"])) else None
        min_lat = float(rec["min_lat"]) if math.isfinite(float(rec["min_lat"])) else None
        max_lon = float(rec["max_lon"]) if math.isfinite(float(rec["max_lon"])) else None
        max_lat = float(rec["max_lat"]) if math.isfinite(float(rec["max_lat"])) else None

        pipe_m = float(rec["pipe_m"])
        pipe_km = pipe_m / 1000.0

        extent_km2 = None
        if None not in (min_lon, min_lat, max_lon, max_lat):
            extent_km2 = _bbox_area_km2(min_lon, min_lat, max_lon, max_lat)

        rows.append(
            {
                "p_zone": zone,
                "feature_count": int(rec["feature_count"]),
                "pipe_km": round(pipe_km, 6),
                "min_lon": min_lon,
                "min_lat": min_lat,
                "max_lon": max_lon,
                "max_lat": max_lat,
                "extent_bbox_km2": round(extent_km2, 6) if extent_km2 is not None else None,
            }
        )

    # Sort by pipe length desc
    rows.sort(key=lambda r: float(r["pipe_km"]), reverse=True)

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        fieldnames = list(rows[0].keys()) if rows else ["p_zone", "feature_count", "pipe_km", "extent_bbox_km2"]
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump({"byZone": rows}, f, indent=2)

    print(f"Zones: {len(rows)}")
    if rows:
        print("Top 10 by pipe_km:")
        for r in rows[:10]:
            print(f"  {r['p_zone']}: {r['pipe_km']} km (features={r['feature_count']}, extent≈{r['extent_bbox_km2']} km^2)")


if __name__ == "__main__":
    main()

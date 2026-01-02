"""Link break points to the nearest water main and enrich breaks with main attributes.

Purpose
- The breaks GeoJSON does not contain pipe attributes (material/diam/year).
- The mains GeoJSON does contain those attributes.

This script spatially joins each break Point to the nearest main LineString (projected
into a meter-based CRS for distance computation), and writes:
- outputs/breaks/breaks_enriched.geojson
- outputs/breaks/breaks_to_mains.csv

Rules
- Deterministic: stable ordering, no randomness.
- Does NOT silently repair data:
  - Breaks without a parseable date are still linked (date is not required for linking).
  - Breaks without valid Point geometry are skipped (logged).

Dependencies: shapely, pyproj
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    from shapely.geometry import shape
    from shapely.strtree import STRtree
except Exception as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: shapely. Install with: pip install shapely") from exc

try:
    from pyproj import Transformer
except Exception as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: pyproj. Install with: pip install pyproj") from exc


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MAINS = ROOT / "data" / "Public_Water_Main_20251231.geojson"
DEFAULT_BREAKS = ROOT / "data" / "Water_Main_Breaks_20251231.geojson"
DEFAULT_OUTDIR = ROOT / "outputs" / "breaks"


def load_geojson(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_geojson(path: Path, obj: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def normalize_material(raw: Any) -> str:
    s = ("" if raw is None else str(raw)).strip().upper()
    if not s:
        return "UNKNOWN"
    # Match existing repo normalization.
    if s == "CON":
        return "PCCP"
    if s == "COPPER":
        return "CU"
    return s


def _transform_geom(g, transformer: Transformer):
    geo = g.__geo_interface__

    def tx(coords):
        # With always_xy=True, transformer expects (lon, lat).
        x, y = transformer.transform(coords[0], coords[1])
        return (x, y)

    def walk(obj):
        if isinstance(obj, (list, tuple)) and obj and isinstance(obj[0], (float, int)):
            return tx(obj)
        if isinstance(obj, (list, tuple)):
            return [walk(x) for x in obj]
        return obj

    geo2 = dict(geo)
    geo2["coordinates"] = walk(geo["coordinates"])
    return shape(geo2)


def build_mains_index(
    mains_features: List[Dict[str, Any]],
    transformer: Transformer,
    logger: logging.Logger,
) -> Tuple[List[str], List[Dict[str, Any]], List[Any], STRtree, Dict[int, int]]:
    main_ids: List[str] = []
    main_props: List[Dict[str, Any]] = []
    geoms: List[Any] = []

    skipped = 0

    for f in mains_features:
        props = f.get("properties") or {}
        gid = (props.get("globalid") or "").strip()
        if not gid:
            skipped += 1
            continue

        geom = f.get("geometry")
        if not geom:
            skipped += 1
            continue

        try:
            g = shape(geom)
        except Exception:
            skipped += 1
            continue

        try:
            g_proj = _transform_geom(g, transformer)
        except Exception:
            skipped += 1
            continue

        main_ids.append(gid)
        main_props.append(
            {
                "globalid": gid,
                "material": normalize_material(props.get("material")),
                "diam": props.get("diam"),
                "year": props.get("year"),
                "status_ind": props.get("status_ind"),
            }
        )
        geoms.append(g_proj)

    if not geoms:
        raise SystemExit("No valid mains geometries found to index.")

    tree = STRtree(geoms)
    geom_id_to_index = {id(g): i for i, g in enumerate(geoms)}

    logger.info(
        "Built mains spatial index: mains=%d skipped=%d", len(main_ids), skipped
    )

    return main_ids, main_props, geoms, tree, geom_id_to_index


def nearest_main(
    bp_proj,
    main_geoms: List[Any],
    main_ids: List[str],
    tree: STRtree,
    geom_id_to_index: Dict[int, int],
) -> Optional[Tuple[int, float]]:
    # Returns (main_index, distance_m)
    idx = None
    dist_m = None
    nearest_geom = None

    if hasattr(tree, "query_nearest"):
        try:
            idxs, dists = tree.query_nearest(bp_proj, return_distance=True)
            idx_arr = np.atleast_1d(idxs)
            dist_arr = np.atleast_1d(dists)
            if idx_arr.size == 0:
                return None
            idx = int(idx_arr[0])
            if idx < 0 or idx >= len(main_geoms):
                return None
            nearest_geom = main_geoms[idx]
            dist_m = float(dist_arr[0]) if dist_arr.size else float(bp_proj.distance(nearest_geom))
        except TypeError:
            pass

    if idx is None or nearest_geom is None or dist_m is None:
        nearest = tree.nearest(bp_proj)
        if nearest is None:
            return None
        nearest_geom = nearest
        idx2 = geom_id_to_index.get(id(nearest_geom))
        if idx2 is None:
            return None
        idx = int(idx2)
        dist_m = float(bp_proj.distance(nearest_geom))

    return int(idx), float(dist_m)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mains", type=Path, default=DEFAULT_MAINS)
    ap.add_argument("--breaks", type=Path, default=DEFAULT_BREAKS)
    ap.add_argument("--outdir", type=Path, default=DEFAULT_OUTDIR)
    ap.add_argument("--max-break-to-main-m", type=float, default=50.0)
    ap.add_argument(
        "--epsg-to",
        type=int,
        default=3400,
        help="Meter-based projected CRS for distance calcs (default EPSG:3400)",
    )
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    logger = logging.getLogger("link")

    if not args.mains.exists():
        raise SystemExit(f"Missing mains file: {args.mains}")
    if not args.breaks.exists():
        raise SystemExit(f"Missing breaks file: {args.breaks}")

    mains_gj = load_geojson(args.mains)
    breaks_gj = load_geojson(args.breaks)

    mains_features = mains_gj.get("features") or []
    breaks_features = breaks_gj.get("features") or []

    transformer = Transformer.from_crs(4326, int(args.epsg_to), always_xy=True)

    main_ids, main_props, main_geoms, tree, geom_id_to_index = build_mains_index(
        mains_features=mains_features,
        transformer=transformer,
        logger=logger,
    )

    out_features: List[Dict[str, Any]] = []
    matched_rows: List[Tuple[str, str, float, str]] = []

    n_total = 0
    n_point = 0
    n_matched = 0
    n_too_far = 0

    for bf in breaks_features:
        n_total += 1
        geom = bf.get("geometry")
        if not geom:
            continue

        try:
            shp = shape(geom)
        except Exception:
            continue

        if (shp.geom_type or "").lower() != "point":
            continue
        n_point += 1

        bp_proj = _transform_geom(shp, transformer)
        hit = nearest_main(bp_proj, main_geoms, main_ids, tree, geom_id_to_index)
        if hit is None:
            continue
        idx, dist_m = hit

        if dist_m > float(args.max_break_to_main_m):
            n_too_far += 1
            continue

        n_matched += 1
        m = main_props[idx]

        props = dict(bf.get("properties") or {})
        props["matched_main_globalid"] = m.get("globalid")
        props["matched_main_material"] = m.get("material")
        props["matched_main_diam"] = m.get("diam")
        props["matched_main_year"] = m.get("year")
        props["match_distance_m"] = round(float(dist_m), 3)

        out_features.append(
            {
                "type": "Feature",
                "geometry": bf.get("geometry"),
                "properties": props,
            }
        )

        matched_rows.append(
            (
                str(props.get("matched_main_globalid") or ""),
                str(props.get("break_date") or ""),
                float(dist_m),
                str(props.get("break_type") or ""),
            )
        )

    logger.info(
        "Link summary: total=%d point=%d matched=%d too_far=%d max_m=%.1f",
        n_total,
        n_point,
        n_matched,
        n_too_far,
        float(args.max_break_to_main_m),
    )

    args.outdir.mkdir(parents=True, exist_ok=True)

    out_geo = args.outdir / "breaks_enriched.geojson"
    out_csv = args.outdir / "breaks_to_mains.csv"

    write_geojson(
        out_geo,
        {
            "type": "FeatureCollection",
            "features": out_features,
        },
    )

    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["main_globalid", "break_date", "distance_m", "break_type"])
        for row in sorted(matched_rows, key=lambda r: (r[0], r[1], r[2])):
            w.writerow(row)

    print("Wrote:")
    print(f"  {out_geo}")
    print(f"  {out_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

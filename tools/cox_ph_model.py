"""Cox proportional hazards model for water main failure risk (segment-level).

Implements a survival-analysis workflow using lifelines.
- start_time = installation date (derived from installation year)
- stop_time  = first failure date OR observation cutoff date
- event      = 1 if failed, 0 if right-censored

Data sources (defaults assume this repo layout):
- data/Public_Water_Main_20251231.geojson (inventory)
- data/Water_Main_Breaks_20251231.geojson (historical failures/breaks as points)
- docs/road_proximity_by_main.json (optional road proximity by main globalid)

If break events do not contain a pipe identifier, this script assigns each break to the
nearest main (within a configurable max distance). This assumption is logged.

Outputs are deterministic: sorting is stable and no randomization is used.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    from lifelines import CoxTimeVaryingFitter
    from lifelines.utils import concordance_index as ll_concordance_index
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: lifelines. Install with: pip install lifelines"
    ) from exc

try:
    from shapely.geometry import shape
    from shapely.strtree import STRtree
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: shapely. Install with: pip install shapely"
    ) from exc

try:
    from pyproj import Transformer
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: pyproj. Install with: pip install pyproj"
    ) from exc


# ---------------------------
# data_load
# ---------------------------


def load_geojson_features(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        gj = json.load(f)
    feats = gj.get("features") or []
    if not isinstance(feats, list):
        raise ValueError(f"Invalid GeoJSON: {path} missing features[]")
    return feats


def load_road_proximity_by_main(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        d = json.load(f)
    rows = d.get("byMain") or []
    out: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        gid = (r.get("globalid") or "").strip().lower()
        if not gid:
            continue
        out[gid] = {
            "min_dist_m": r.get("min_dist_m"),
            "functional_class": r.get("functional_class"),
        }
    return out


# ---------------------------
# feature_engineering
# ---------------------------


def parse_install_year(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # inventory uses 'year' as a string like '2003'
    try:
        y = int(float(s))
    except Exception:
        return None
    if y < 1800 or y > date.today().year:
        return None
    return y


def parse_diameter_mm(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    try:
        v = float(raw)
    except Exception:
        return None
    if not math.isfinite(v) or v <= 0:
        return None
    return v


def normalize_material(raw: Any) -> str:
    s = ("" if raw is None else str(raw)).strip().upper()
    if not s:
        return "UNKNOWN"
    # Match existing map normalization: CON treated as PCCP.
    if s == "CON":
        return "PCCP"
    if s == "COPPER":
        return "CU"
    return s


def safe_date_from_year(y: int) -> date:
    return date(int(y), 1, 1)


def parse_break_date(raw: Any) -> Optional[date]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # Example: 2025-11-10T00:00:00.000
    try:
        dt = datetime.fromisoformat(s.replace("Z", ""))
        return dt.date()
    except Exception:
        return None


def ordinal_days(d: date) -> float:
    # Numeric time axis for lifelines: days since 1970-01-01.
    return float((d - date(1970, 1, 1)).days)


# ---------------------------
# survival_dataset_construction
# ---------------------------


@dataclass(frozen=True)
class LinkConfig:
    max_break_to_main_m: float
    # EPSG:3400 is commonly used for Alberta 10TM AEP; good local meters.
    # If you need a different CRS, adjust epsg_to.
    epsg_from: int = 4326
    epsg_to: int = 3400


def build_spatial_index_for_mains(
    mains_features: List[Dict[str, Any]],
    transformer: Transformer,
) -> Tuple[List[str], List[Any], STRtree, Dict[int, int]]:
    """Returns (main_ids, projected_line_geoms, STRtree, geom_id_to_index)."""
    main_ids: List[str] = []
    geoms: List[Any] = []

    # shapely geometries are immutable; we keep them aligned by index.
    for f in mains_features:
        props = f.get("properties") or {}
        gid = (props.get("globalid") or "").strip().lower()
        if not gid:
            continue
        geom = f.get("geometry")
        if not geom:
            continue
        g = shape(geom)
        # Project coordinates into meters.
        g_proj = _transform_geom(g, transformer)
        main_ids.append(gid)
        geoms.append(g_proj)

    if not geoms:
        raise ValueError("No valid main geometries for spatial indexing.")

    tree = STRtree(geoms)
    geom_id_to_index = {id(g): i for i, g in enumerate(geoms)}
    return main_ids, geoms, tree, geom_id_to_index


def _transform_geom(g, transformer: Transformer):
    # Minimal transformer without pulling in geopandas.
    # Handles Point/LineString/Multi* via __geo_interface__ roundtrip.
    geo = g.__geo_interface__

    def tx(coords):
        # With always_xy=True, transformer expects (lon, lat).
        x, y = transformer.transform(coords[0], coords[1])
        return (x, y)

    def walk(obj):
        if isinstance(obj, (list, tuple)) and obj and isinstance(obj[0], (float, int)):
            return tx(obj)  # a single coordinate pair
        if isinstance(obj, (list, tuple)):
            return [walk(x) for x in obj]
        return obj

    geo2 = dict(geo)
    geo2["coordinates"] = walk(geo["coordinates"])
    return shape(geo2)


def link_breaks_to_mains_first_failure(
    mains_features: List[Dict[str, Any]],
    breaks_features: List[Dict[str, Any]],
    cfg: LinkConfig,
    out_dir: Path,
) -> Dict[str, date]:
    """Returns mapping main_globalid -> first_failure_date.

    Assumption:
      Break point events are linked to the nearest main (within max distance).
    """

    transformer = Transformer.from_crs(cfg.epsg_from, cfg.epsg_to, always_xy=True)
    main_ids, main_geoms, tree, geom_id_to_index = build_spatial_index_for_mains(mains_features, transformer)

    first_failure: Dict[str, date] = {}
    matched_rows: List[Tuple[str, str, float, str]] = []

    n_total = 0
    n_parsed = 0
    n_matched = 0
    n_too_far = 0

    for bf in breaks_features:
        n_total += 1
        props = bf.get("properties") or {}
        bdate = parse_break_date(props.get("break_date"))
        if bdate is None:
            continue
        n_parsed += 1

        geom = bf.get("geometry")
        if not geom:
            continue
        bp = _transform_geom(shape(geom), transformer)

        # Robust nearest lookup across Shapely versions.
        # Prefer query_nearest (returns indices) when available; fall back to nearest(geom).
        idx = None
        dist_m = None
        nearest_geom = None
        if hasattr(tree, "query_nearest"):
            try:
                idxs, dists = tree.query_nearest(bp, return_distance=True)
                idx_arr = np.atleast_1d(idxs)
                dist_arr = np.atleast_1d(dists)
                if idx_arr.size == 0:
                    continue
                idx = int(idx_arr[0])
                if idx < 0 or idx >= len(main_geoms):
                    continue
                nearest_geom = main_geoms[idx]
                dist_m = float(dist_arr[0]) if dist_arr.size else float(bp.distance(nearest_geom))
            except TypeError:
                # Older shapely signatures
                pass

        if idx is None or nearest_geom is None or dist_m is None:
            nearest = tree.nearest(bp)
            if nearest is None:
                continue
            nearest_geom = nearest
            idx2 = geom_id_to_index.get(id(nearest_geom))
            if idx2 is None:
                continue
            idx = int(idx2)
            dist_m = float(bp.distance(nearest_geom))

        gid = main_ids[int(idx)]
        if dist_m > cfg.max_break_to_main_m:
            n_too_far += 1
            continue

        n_matched += 1

        prev = first_failure.get(gid)
        if prev is None or bdate < prev:
            first_failure[gid] = bdate

        matched_rows.append((gid, bdate.isoformat(), dist_m, str(props.get("break_type") or "")))

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "breaks_matched_to_mains.csv"
    with out_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["main_globalid", "break_date", "distance_m", "break_type"])
        # Deterministic order
        for row in sorted(matched_rows, key=lambda r: (r[0], r[1], r[2])):
            w.writerow(row)

    print(
        "Break linkage summary:",
        {
            "breaks_total": n_total,
            "breaks_with_parsed_date": n_parsed,
            "matched_within_max_m": n_matched,
            "rejected_too_far": n_too_far,
            "unique_mains_with_failure": len(first_failure),
            "assumption": f"nearest main within {cfg.max_break_to_main_m}m",
        },
    )

    return first_failure


def build_survival_dataframe(
    mains_features: List[Dict[str, Any]],
    first_failure_by_main: Dict[str, date],
    road_by_main: Dict[str, Dict[str, Any]],
    cutoff: date,
    out_dir: Path,
) -> pd.DataFrame:
    """Builds a per-segment survival table compatible with CoxTimeVaryingFitter."""

    excluded_missing_install = 0
    rejected_failure_before_install = 0
    rejected_negative_exposure = 0

    rows: List[Dict[str, Any]] = []

    for f in mains_features:
        props = f.get("properties") or {}
        gid = (props.get("globalid") or "").strip().lower()
        if not gid:
            continue

        install_year = parse_install_year(props.get("year"))
        if install_year is None:
            excluded_missing_install += 1
            continue

        install_date = safe_date_from_year(install_year)

        failure_date = first_failure_by_main.get(gid)
        event = 1 if failure_date is not None else 0
        stop_date = failure_date if failure_date is not None else cutoff

        if stop_date < install_date:
            rejected_failure_before_install += 1
            continue

        start = ordinal_days(install_date)
        stop = ordinal_days(stop_date)
        if stop <= start:
            rejected_negative_exposure += 1
            continue

        material = normalize_material(props.get("material"))
        diameter_mm = parse_diameter_mm(props.get("diam"))

        road = road_by_main.get(gid, {})
        road_dist_m = road.get("min_dist_m")
        if road_dist_m is None or not isinstance(road_dist_m, (int, float)) or not math.isfinite(float(road_dist_m)):
            # Reasonable default per prompt: if no record, treat as far away.
            # Logged via a feature flag column.
            road_dist_m = 1_000_000.0
            road_dist_missing = 1
        else:
            road_dist_m = float(road_dist_m)
            road_dist_missing = 0

        status_ind = (props.get("status_ind") or "").strip().upper() or None

        age_years = (stop - start) / 365.25

        rows.append(
            {
                "id": gid,
                "start": start,
                "stop": stop,
                "event": int(event),
                "install_year": int(install_year),
                "stop_date": stop_date.isoformat(),
                "material": material,
                "diameter_mm": diameter_mm,
                "log_diameter_mm": (math.log(diameter_mm) if diameter_mm is not None and diameter_mm > 0 else np.nan),
                "road_distance_m": road_dist_m,
                "log1p_road_distance_m": math.log1p(max(0.0, road_dist_m)),
                "road_distance_missing": int(road_dist_missing),
                "age_years": float(age_years),
                "status_ind": status_ind,
            }
        )

    df = pd.DataFrame(rows)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "excluded_summary.json").write_text(
        json.dumps(
            {
                "excluded_missing_install_year": excluded_missing_install,
                "rejected_failure_before_install": rejected_failure_before_install,
                "rejected_non_positive_exposure": rejected_negative_exposure,
                "n_rows": int(df.shape[0]),
                "n_events": int(df["event"].sum()) if "event" in df.columns else 0,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(
        "Survival dataset summary:",
        {
            "rows": int(df.shape[0]),
            "events": int(df["event"].sum()) if "event" in df.columns else 0,
            "cutoff": cutoff.isoformat(),
            "excluded_missing_install_year": excluded_missing_install,
            "rejected_failure_before_install": rejected_failure_before_install,
            "rejected_non_positive_exposure": rejected_negative_exposure,
        },
    )

    return df


# ---------------------------
# cox_model_fit
# ---------------------------


def encode_features(df: pd.DataFrame, reference_material: Optional[str] = None) -> Tuple[pd.DataFrame, str]:
    """One-hot encode material with explicit reference category."""

    if reference_material is None:
        # Prefer PVC if present; otherwise use most common.
        if (df["material"] == "PVC").any():
            reference_material = "PVC"
        else:
            reference_material = str(df["material"].value_counts().idxmax())

    # Create dummies for all materials except reference.
    mats = sorted({m for m in df["material"].astype(str).unique() if m})
    other_mats = [m for m in mats if m != reference_material]

    out = df.copy()
    for m in other_mats:
        out[f"mat__{m}"] = (out["material"] == m).astype(int)

    return out, reference_material


def fit_cox_model(df: pd.DataFrame) -> CoxTimeVaryingFitter:
    # Drop rows with missing required numeric features (explicitly logged).
    required_cols = ["age_years", "log_diameter_mm", "log1p_road_distance_m", "road_distance_missing"]
    before = df.shape[0]
    df2 = df.dropna(subset=required_cols).copy()
    dropped = before - df2.shape[0]
    if dropped:
        print(f"Dropped {dropped} rows due to missing required numeric features: {required_cols}")

    # Choose reference material deterministically.
    df2, ref = encode_features(df2)
    # Guard against duplicate column names (pandas can carry duplicates, and
    # lifelines expects a unique design matrix).
    if df2.columns.duplicated().any():
        dupes = df2.columns[df2.columns.duplicated()].tolist()
        print(f"Dropping duplicated columns before fit: {sorted(set(dupes))}")
        df2 = df2.loc[:, ~df2.columns.duplicated()].copy()
    print(f"Material reference category: {ref}")

    covariate_cols = [
        "age_years",
        "log_diameter_mm",
        "log1p_road_distance_m",
        "road_distance_missing",
    ] + [c for c in df2.columns if c.startswith("mat__")]

    # Validation: no negative exposure time.
    bad_exposure = (df2["stop"] <= df2["start"]).sum()
    if bad_exposure:
        raise ValueError(f"Found {int(bad_exposure)} rows with non-positive exposure time.")

    # Fit Cox time-varying with one row per id.
    ctv = CoxTimeVaryingFitter()
    try:
        ctv.fit(
            df2[["id", "start", "stop", "event"] + covariate_cols],
            id_col="id",
            start_col="start",
            stop_col="stop",
            event_col="event",
            show_progress=False,
        )
    except Exception as exc:
        # Deterministic fallback to stabilize with mild penalization.
        ctv = CoxTimeVaryingFitter(penalizer=0.1)
        ctv.fit(
            df2[["id", "start", "stop", "event"] + covariate_cols],
            id_col="id",
            start_col="start",
            stop_col="stop",
            event_col="event",
            show_progress=False,
        )
        print(f"Fit required penalizer=0.1 due to: {exc}")

    # Attach for downstream.
    ctv._covariate_cols = covariate_cols  # type: ignore[attr-defined]
    ctv._material_reference = ref  # type: ignore[attr-defined]
    ctv._fit_df = df2  # type: ignore[attr-defined]

    return ctv


# ---------------------------
# diagnostics_and_metrics
# ---------------------------


def hazard_ratio_table(ctv: CoxTimeVaryingFitter) -> pd.DataFrame:
    s = ctv.summary.copy()
    # Standardize column names for output.
    s = s.rename(
        columns={
            "coef": "beta",
            "exp(coef)": "hazard_ratio",
            "exp(coef) lower 95%": "hr_lower_95",
            "exp(coef) upper 95%": "hr_upper_95",
            "p": "p_value",
        }
    )
    # Sort by effect magnitude: farthest HR from 1.
    s["effect_magnitude"] = (np.log(s["hazard_ratio"]).abs())
    s = s.sort_values(["effect_magnitude", "hazard_ratio"], ascending=[False, False])
    return s[["beta", "hazard_ratio", "hr_lower_95", "hr_upper_95", "p_value"]]


def concordance_index(ctv: CoxTimeVaryingFitter) -> Optional[float]:
    # Compute deterministically from durations and predicted risk.
    df_fit = getattr(ctv, "_fit_df", None)
    if df_fit is None:
        return None
    covs = list(getattr(ctv, "params_", pd.Series(dtype=float)).index)
    if not covs:
        return None
    df_u = df_fit.loc[:, ~df_fit.columns.duplicated()].copy()
    durations = (df_u["stop"].astype(float) - df_u["start"].astype(float)).astype(float)
    events = df_u["event"].astype(int)
    scores = ctv.predict_partial_hazard(df_u[covs]).astype(float)
    try:
        return float(ll_concordance_index(durations, -scores, events))
    except Exception:
        return None


def observed_vs_predicted_deciles(ctv: CoxTimeVaryingFitter, df_fit: pd.DataFrame) -> pd.DataFrame:
    covs = list(getattr(ctv, "params_", pd.Series(dtype=float)).index)
    df_u = df_fit.loc[:, ~df_fit.columns.duplicated()].copy()
    df_pred = df_u[["id", "event"] + covs].copy()

    # Partial hazard is the relative risk score from Cox model.
    ph = ctv.predict_partial_hazard(df_pred[covs]).astype(float)
    df_pred["hazard_score"] = ph.values

    # Deterministic deciles; if too few rows, fall back to quantiles that exist.
    try:
        df_pred["decile"] = pd.qcut(df_pred["hazard_score"], 10, labels=False, duplicates="drop") + 1
    except Exception:
        df_pred["decile"] = 1

    g = df_pred.groupby("decile", as_index=False)
    out = g.agg(
        n=("id", "count"),
        events=("event", "sum"),
        observed_event_rate=("event", "mean"),
        mean_hazard_score=("hazard_score", "mean"),
        min_hazard_score=("hazard_score", "min"),
        max_hazard_score=("hazard_score", "max"),
    )

    out = out.sort_values("decile")
    return out


# ---------------------------
# risk_scoring_export
# ---------------------------


def export_risk_scores(ctv: CoxTimeVaryingFitter, df_fit: pd.DataFrame, out_dir: Path) -> Tuple[Path, Path]:
    covs = list(getattr(ctv, "params_", pd.Series(dtype=float)).index)

    base_cols = [
        "id",
        "event",
        "install_year",
        "stop_date",
        "material",
        "diameter_mm",
        "road_distance_m",
        "road_distance_missing",
        "age_years",
    ]

    df_u = df_fit.loc[:, ~df_fit.columns.duplicated()].copy()
    # Avoid creating duplicate columns when base_cols overlap covariates.
    covs_only = [c for c in covs if c not in set(base_cols)]
    df_out = df_u[base_cols + covs_only].copy()
    df_out["hazard_score"] = ctv.predict_partial_hazard(df_u[covs]).astype(float).values

    # Deterministic ranking.
    df_out = df_out.sort_values(["hazard_score", "id"], ascending=[False, True]).reset_index(drop=True)
    df_out["risk_rank"] = np.arange(1, df_out.shape[0] + 1)

    out_dir.mkdir(parents=True, exist_ok=True)

    scores_path = out_dir / "segment_hazard_scores.csv"
    df_out.to_csv(scores_path, index=False)

    top_path = out_dir / "top_risk_pipes.csv"
    df_out.head(250).to_csv(top_path, index=False)

    return scores_path, top_path


# ---------------------------
# main
# ---------------------------


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Fit a Cox PH model for water main failures (segment-level).")
    ap.add_argument("--mains", default="data/Public_Water_Main_20251231.geojson")
    ap.add_argument("--breaks", default="data/Water_Main_Breaks_20251231.geojson")
    ap.add_argument("--road-proximity", default="docs/road_proximity_by_main.json")
    ap.add_argument("--cutoff", default="2025-12-31", help="Observation cutoff date (YYYY-MM-DD).")
    ap.add_argument("--max-break-to-main-m", type=float, default=50.0, help="Max distance to link a break to a main.")
    ap.add_argument("--out", default="outputs")

    args = ap.parse_args(argv)

    out_dir = Path(args.out)

    try:
        cutoff = date.fromisoformat(args.cutoff)
    except Exception:
        raise SystemExit("--cutoff must be YYYY-MM-DD")

    mains_path = Path(args.mains)
    breaks_path = Path(args.breaks)
    road_path = Path(args.road_proximity)

    if not mains_path.exists():
        raise SystemExit(f"Missing mains file: {mains_path}")
    if not breaks_path.exists():
        raise SystemExit(f"Missing breaks file: {breaks_path}")

    mains_feats = load_geojson_features(mains_path)
    breaks_feats = load_geojson_features(breaks_path)
    road_by_main = load_road_proximity_by_main(road_path)

    link_cfg = LinkConfig(max_break_to_main_m=float(args.max_break_to_main_m))

    # Link breaks to mains (first failure only).
    first_failure_by_main = link_breaks_to_mains_first_failure(
        mains_features=mains_feats,
        breaks_features=breaks_feats,
        cfg=link_cfg,
        out_dir=out_dir,
    )

    # Build survival dataset.
    df = build_survival_dataframe(
        mains_features=mains_feats,
        first_failure_by_main=first_failure_by_main,
        road_by_main=road_by_main,
        cutoff=cutoff,
        out_dir=out_dir,
    )

    if int(df["event"].sum()) == 0:
        raise SystemExit(
            "No linked failures (events=0). Cannot fit Cox model. "
            "Increase --max-break-to-main-m or provide a failure history linked to segments."
        )

    # Fit model.
    ctv = fit_cox_model(df)

    # Output coefficients / hazard ratios.
    hr = hazard_ratio_table(ctv)
    print("\nHazard ratios (sorted by effect magnitude):")
    with pd.option_context("display.max_rows", 200, "display.width", 200):
        print(hr)

    ci = concordance_index(ctv)
    if ci is not None:
        print(f"\nConcordance index: {ci:.4f}")

    df_fit = getattr(ctv, "_fit_df", df)

    dec = observed_vs_predicted_deciles(ctv, df_fit)
    dec_path = out_dir / "observed_vs_predicted_deciles.csv"
    dec.to_csv(dec_path, index=False)
    print("\nObserved vs predicted (risk deciles):")
    with pd.option_context("display.max_rows", 200, "display.width", 200):
        print(dec)

    scores_path, top_path = export_risk_scores(ctv, df_fit, out_dir)

    coef_path = out_dir / "cox_coefficients.csv"
    hr.reset_index(names="feature").to_csv(coef_path, index=False)

    print("\nWrote outputs:")
    print(f"  {coef_path}")
    print(f"  {scores_path}")
    print(f"  {top_path}")
    print(f"  {dec_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

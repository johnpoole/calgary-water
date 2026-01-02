"""Cox proportional hazards survival model for water main first-failure risk.

Deliverable: deterministic, interpretable Cox PH workflow using lifelines.

Model scope (per prompt):
- Segment-level (one row per segment)
- Uses only the first failure event (no recurrent event modeling)
- Right-censoring for segments without failures

Data sources (repo-local):
- Pipe inventory: data/Public_Water_Main_20251231.geojson
- Failure history: outputs/breaks_matched_to_mains.csv (main_globalid, break_date, ...)
- Road proximity covariates: docs/road_proximity_by_main.json (by main globalid)

Run:
  C:/Users/jdpoo/Documents/GitHub/calgary water/.venv/Scripts/python.exe tools/cox_ph_pipeline.py

Outputs:
- outputs/coxph/hazard_ratios.csv
- outputs/coxph/diagnostics.json
- outputs/coxph/risk_deciles.csv
- outputs/coxph/segment_risk_scores.csv
- outputs/coxph/top_risk_segments.csv
"""

from __future__ import annotations

# =====================
# data_load
# =====================

import csv
import json
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
from lifelines import CoxTimeVaryingFitter
from lifelines.utils import concordance_index


REPO_ROOT = Path(__file__).resolve().parents[1]

MAINS_GEOJSON = REPO_ROOT / "data" / "Public_Water_Main_20251231.geojson"
BREAKS_MATCHED_CSV = REPO_ROOT / "outputs" / "breaks_matched_to_mains.csv"
ROAD_PROX_JSON = REPO_ROOT / "docs" / "road_proximity_by_main.json"

OUT_DIR = REPO_ROOT / "outputs" / "coxph"

# Observation cutoff date (right-censoring date). Chosen as dataset snapshot date.
OBS_CUTOFF_DATE = datetime(2025, 12, 31)


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _safe_upper(value: object) -> str:
    return "" if value is None else str(value).strip().upper()


def _parse_year(value: object) -> Optional[int]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        y = int(float(s))
    except Exception:
        return None
    # Basic sanity bounds.
    if y < 1800 or y > OBS_CUTOFF_DATE.year:
        return None
    return y


def _parse_float(value: object) -> Optional[float]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        x = float(s)
    except Exception:
        return None
    if not np.isfinite(x):
        return None
    return float(x)


def _parse_date(value: object) -> Optional[datetime]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        # Handles "YYYY-MM-DD" and ISO timestamps.
        return datetime.fromisoformat(s.replace("Z", ""))
    except Exception:
        return None


def load_mains_inventory(path: Path) -> pd.DataFrame:
    """Load mains inventory into a DataFrame keyed by globalid."""
    with path.open("r", encoding="utf-8") as f:
        gj = json.load(f)

    rows: List[dict] = []
    for feat in gj.get("features", []):
        props = feat.get("properties") or {}
        gid = (props.get("globalid") or "").strip().lower()
        if not gid:
            continue
        rows.append(
            {
                "globalid": gid,
                "material_raw": props.get("material"),
                "install_year_raw": props.get("year"),
                "diam_mm_raw": props.get("diam"),
                "status_ind": props.get("status_ind"),
                "p_zone": props.get("p_zone"),
            }
        )

    df = pd.DataFrame(rows)
    if df.empty:
        raise RuntimeError(f"No mains found in {path}")
    return df


def load_first_failures(path: Path) -> Dict[str, datetime]:
    """Load earliest break date per main_globalid from the matched CSV."""
    if not path.exists():
        raise FileNotFoundError(
            f"Missing {path}. This pipeline expects pre-matched breaks via outputs/breaks_matched_to_mains.csv"
        )

    first: Dict[str, datetime] = {}
    with path.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            gid = (row.get("main_globalid") or "").strip().lower()
            dt = _parse_date(row.get("break_date"))
            if not gid or dt is None:
                continue
            cur = first.get(gid)
            if cur is None or dt < cur:
                first[gid] = dt

    return first


@dataclass(frozen=True)
class RoadProx:
    road_class: str
    min_dist_m: float


def load_road_proximity(path: Path) -> Tuple[Dict[str, RoadProx], float]:
    """Load road proximity by main globalid.

    Returns:
      - map: globalid -> RoadProx
      - buffer_m: distance threshold used by the precompute
    """
    with path.open("r", encoding="utf-8") as f:
        d = json.load(f)

    buffer_m = float(d.get("buffer_m") or 0.0)
    by_main: Dict[str, RoadProx] = {}
    for row in d.get("byMain") or []:
        gid = str(row.get("globalid") or "").strip().lower()
        if not gid:
            continue
        fc = str(row.get("functional_class") or "").strip().lower() or "unknown"
        md = row.get("min_dist_m")
        try:
            min_dist = float(md)
        except Exception:
            min_dist = float("nan")
        if not np.isfinite(min_dist):
            min_dist = buffer_m
        by_main[gid] = RoadProx(road_class=fc, min_dist_m=min_dist)

    return by_main, buffer_m


# =====================
# feature_engineering
# =====================


def normalize_material(value: object) -> str:
    """Normalize material codes for modeling.

    Mirrors the app's normalization where CON is treated as PCCP.
    """
    m = _safe_upper(value)
    if not m:
        return "UNKNOWN"
    if m == "CON":
        return "PCCP"
    if m == "COPPER":
        return "CU"
    return m


def encode_categoricals(
    df: pd.DataFrame,
    categorical_cols: Iterable[str],
    reference_by_col: Dict[str, str],
) -> pd.DataFrame:
    """One-hot encode categoricals with explicit reference categories."""
    out = df.copy()
    for col in categorical_cols:
        ref = reference_by_col.get(col)
        if ref is None:
            raise ValueError(f"Missing reference for {col}")

        # Ensure ref is present as a category to make drop deterministic.
        out[col] = out[col].astype("string").fillna("")
        # Create dummies with full set.
        dummies = pd.get_dummies(out[col], prefix=col, dtype=float)
        ref_col = f"{col}_{ref}"
        if ref_col not in dummies.columns:
            # If ref isn't present in data, add it as a zero column so dropping is stable.
            dummies[ref_col] = 0.0
        dummies = dummies.drop(columns=[ref_col])

        out = out.drop(columns=[col]).join(dummies)

    return out


# =====================
# survival_dataset_construction
# =====================


def build_survival_dataset(
    mains_df: pd.DataFrame,
    first_failure_by_gid: Dict[str, datetime],
    road_by_gid: Dict[str, RoadProx],
    road_buffer_m: float,
    cutoff: datetime,
) -> pd.DataFrame:
    """Construct segment-level survival rows with start/stop/event and covariates."""

    missing_install: List[str] = []
    rejected_failures: List[Tuple[str, str]] = []
    nonpositive_exposure: List[str] = []

    rows: List[dict] = []

    for _, r in mains_df.iterrows():
        gid = str(r["globalid"]).strip().lower()

        install_year = _parse_year(r.get("install_year_raw"))
        if install_year is None:
            missing_install.append(gid)
            continue

        # Start time: installation year (use Jan 1 of that year).
        start_dt = datetime(install_year, 1, 1)

        # First failure (if any), clipped to cutoff.
        fail_dt = first_failure_by_gid.get(gid)
        stop_dt = fail_dt if fail_dt is not None else cutoff
        event = 1 if (fail_dt is not None and fail_dt <= cutoff) else 0

        # Reject failures earlier than installation.
        if fail_dt is not None and fail_dt < start_dt:
            rejected_failures.append((gid, fail_dt.isoformat()))
            stop_dt = cutoff
            event = 0

        # Prevent negative/zero exposure time.
        if stop_dt <= start_dt:
            nonpositive_exposure.append(gid)
            continue

        # Feature: age at stop.
        age_years = (stop_dt - start_dt).days / 365.25

        material = normalize_material(r.get("material_raw"))
        diam_mm = _parse_float(r.get("diam_mm_raw"))

        # Road proximity (defaults are explicit + logged).
        rp = road_by_gid.get(gid)
        if rp is None:
            road_class = "none"
            road_min_dist_m = float(road_buffer_m)
            used_default_road = 1
        else:
            road_class = rp.road_class or "unknown"
            road_min_dist_m = float(rp.min_dist_m)
            used_default_road = 0

        rows.append(
            {
                "segment_id": gid,
                # lifelines CoxTimeVarying expects numeric start/stop. Use ordinal days.
                "start": float(start_dt.toordinal()),
                "stop": float(stop_dt.toordinal()),
                "event": int(event),
                "install_year": int(install_year),
                "age_years": float(age_years),
                "diam_mm": float(diam_mm) if diam_mm is not None else np.nan,
                "material": material,
                "road_class": road_class,
                "road_min_dist_m": float(road_min_dist_m),
                "used_default_road": int(used_default_road),
                "status_ind": _safe_upper(r.get("status_ind")),
            }
        )

    if missing_install:
        _log(f"Excluded mains missing install year: {len(missing_install)}")
    if rejected_failures:
        _log(f"Rejected failures earlier than install: {len(rejected_failures)}")
    if nonpositive_exposure:
        _log(f"Excluded mains with non-positive exposure: {len(nonpositive_exposure)}")

    df = pd.DataFrame(rows)

    # Validation: no negative exposure time.
    bad = df[df["stop"] <= df["start"]]
    if not bad.empty:
        raise RuntimeError(f"Found {len(bad)} rows with stop<=start")

    # Validation: pipes still in service remain censored.
    # Interpreted as: ACTIVE pipes with no observed failure are event=0.
    active = df[df["status_ind"] == "ACTIVE"]
    if not active.empty:
        # This condition should always hold for active+censored.
        if (active[active["event"] == 0].shape[0]) == 0:
            raise RuntimeError("No ACTIVE pipes were censored; censoring check failed")

    return df


# =====================
# cox_model_fit
# =====================


def fit_cox_model(df: pd.DataFrame) -> Tuple[CoxTimeVaryingFitter, pd.DataFrame]:
    """Fit Cox PH model (time-varying API with one interval per segment)."""

    # Drop rows missing required numeric covariates.
    # We do not silently impute diameter; exclude and log.
    before = df.shape[0]
    model_df = df.dropna(subset=["diam_mm"]).copy()
    dropped = before - model_df.shape[0]
    if dropped:
        _log(f"Excluded mains missing diameter: {dropped}")

    # Choose deterministic reference categories.
    materials = sorted(set(model_df["material"].astype(str)))
    material_ref = "PVC" if "PVC" in materials else (materials[0] if materials else "UNKNOWN")

    road_classes = sorted(set(model_df["road_class"].astype(str)))
    road_ref = "none" if "none" in road_classes else (road_classes[0] if road_classes else "none")

    encoded = encode_categoricals(
        model_df,
        categorical_cols=["material", "road_class"],
        reference_by_col={"material": material_ref, "road_class": road_ref},
    )

    # Keep only specified features (+ required survival cols).
    feature_cols = [
        "age_years",
        "diam_mm",
        "road_min_dist_m",
    ] + [c for c in encoded.columns if c.startswith("material_") or c.startswith("road_class_")]

    tv_df = encoded[["segment_id", "start", "stop", "event"] + feature_cols].copy()

    ctv = CoxTimeVaryingFitter(penalizer=0.0)
    ctv.fit(tv_df, id_col="segment_id", start_col="start", stop_col="stop", event_col="event", show_progress=False)

    return ctv, tv_df


# =====================
# diagnostics_and_metrics
# =====================


def compute_diagnostics(model: CoxTimeVaryingFitter, tv_df: pd.DataFrame) -> Tuple[float, pd.DataFrame]:
    """Compute concordance index and observed-vs-predicted risk deciles."""

    # One row per segment already.
    preds = model.predict_partial_hazard(tv_df)
    preds = pd.Series(np.asarray(preds).reshape(-1), index=tv_df.index, name="partial_hazard")

    # Duration for concordance: use exposure time in days.
    durations = (tv_df["stop"] - tv_df["start"]).astype(float)
    events = tv_df["event"].astype(int)
    c_index = float(concordance_index(durations, preds, events))

    # Risk deciles.
    df = tv_df[["segment_id", "event"]].copy()
    df["partial_hazard"] = preds

    # Deterministic tie-breaking by segment_id.
    df = df.sort_values(["partial_hazard", "segment_id"], ascending=[True, True]).reset_index(drop=True)

    # qcut can fail with too many ties; fall back to rank-based bins.
    try:
        df["decile"] = pd.qcut(df["partial_hazard"], 10, labels=False, duplicates="drop")
    except Exception:
        df["decile"] = pd.cut(np.linspace(0, 1, len(df), endpoint=False), 10, labels=False)

    dec = (
        df.groupby("decile", dropna=False)
        .agg(n=("segment_id", "size"), events=("event", "sum"), event_rate=("event", "mean"), mean_pred=("partial_hazard", "mean"))
        .reset_index()
        .sort_values("decile")
    )

    return c_index, dec


def hazard_ratio_table(model: CoxTimeVaryingFitter) -> pd.DataFrame:
    s = model.summary.reset_index().rename(columns={"index": "covariate"})
    # lifelines uses exp(coef) and CI columns.
    # Sort by absolute effect size for interpretability.
    s["abs_beta"] = s["coef"].abs()
    s = s.sort_values("abs_beta", ascending=False).drop(columns=["abs_beta"])
    cols = [
        "covariate",
        "coef",
        "exp(coef)",
        "exp(coef) lower 95%",
        "exp(coef) upper 95%",
        "p",
    ]
    keep = [c for c in cols if c in s.columns]
    return s[keep]


# =====================
# risk_scoring_export
# =====================


def export_outputs(
    model: CoxTimeVaryingFitter,
    tv_df: pd.DataFrame,
    c_index: float,
    deciles: pd.DataFrame,
) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    hr = hazard_ratio_table(model)
    hr_path = OUT_DIR / "hazard_ratios.csv"
    hr.to_csv(hr_path, index=False)

    # Per-segment risk scores
    preds = model.predict_partial_hazard(tv_df)
    preds = pd.Series(np.asarray(preds).reshape(-1), index=tv_df.index, name="partial_hazard")

    seg = tv_df.copy()
    seg["partial_hazard"] = preds

    # Add human-friendly dates
    seg["start_date"] = seg["start"].map(lambda x: datetime.fromordinal(int(x)).date().isoformat())
    seg["stop_date"] = seg["stop"].map(lambda x: datetime.fromordinal(int(x)).date().isoformat())
    seg["exposure_years"] = (seg["stop"] - seg["start"]) / 365.25

    scores_path = OUT_DIR / "segment_risk_scores.csv"
    seg.sort_values(["partial_hazard", "segment_id"], ascending=[False, True]).to_csv(scores_path, index=False)

    top_path = OUT_DIR / "top_risk_segments.csv"
    seg.sort_values(["partial_hazard", "segment_id"], ascending=[False, True]).head(500).to_csv(top_path, index=False)

    dec_path = OUT_DIR / "risk_deciles.csv"
    deciles.to_csv(dec_path, index=False)

    diag = {
        "concordance_index": c_index,
        "n_rows_model": int(tv_df.shape[0]),
        "n_events_model": int(tv_df["event"].sum()),
        "cutoff_date": OBS_CUTOFF_DATE.date().isoformat(),
    }
    (OUT_DIR / "diagnostics.json").write_text(json.dumps(diag, indent=2), encoding="utf-8")


def main() -> None:
    mains = load_mains_inventory(MAINS_GEOJSON)
    first_fail = load_first_failures(BREAKS_MATCHED_CSV)
    road_by_gid, buffer_m = load_road_proximity(ROAD_PROX_JSON)

    surv = build_survival_dataset(
        mains_df=mains,
        first_failure_by_gid=first_fail,
        road_by_gid=road_by_gid,
        road_buffer_m=buffer_m,
        cutoff=OBS_CUTOFF_DATE,
    )

    model, tv_df = fit_cox_model(surv)

    hr = hazard_ratio_table(model)
    print("\nHazard ratios (sorted by |beta|):")
    with pd.option_context("display.max_rows", 200, "display.max_columns", 20, "display.width", 140):
        print(hr)

    c_index, deciles = compute_diagnostics(model, tv_df)
    print(f"\nConcordance index (C-statistic): {c_index:.4f}")
    print("\nObserved vs predicted risk deciles:")
    with pd.option_context("display.max_rows", 50, "display.width", 140):
        print(deciles)

    export_outputs(model, tv_df, c_index, deciles)
    print(f"\nWrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()

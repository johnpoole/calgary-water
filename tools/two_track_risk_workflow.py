"""Two-track water main failure risk scoring.

Constraints (per user request):
- Use a Cox proportional hazards survival model for all *non* CON( materials.
- Treat SCCP/PCCP concrete pipe segments labeled as material == 'CON(' with a
  separate, rule-based vintage risk model (NOT Cox).

This script builds a unified risk table:
  segment_id, material, risk_method, risk_score, risk_band

Data assumptions (repo defaults):
- Inventory: data/Public_Water_Main_20251231.geojson
- Break linkage: outputs/breaks/breaks_to_mains_largest_within_3m.csv (preferred)
  or outputs/cox/breaks_matched_to_mains.csv
- Road proximity features: docs/road_proximity_by_main.json

The Cox model uses lifelines.CoxTimeVaryingFitter with one interval per segment:
  start = install date (Jan 1 of install_year)
  stop  = first failure date (if any) else observation end date
  event = 1 if failure observed else 0

Covariates:
- material (one-hot, excluding CON() rows entirely)
- age_years (derived as (stop-start) / 365.25)
- diameter_mm
- road proximity features (min_dist_m, uplift_lof, functional_class one-hot)

Outputs:
- outputs/risk/unified_risk_table.csv
- outputs/risk/cox_coefficients.csv
- outputs/risk/cox_model_report.txt
- outputs/risk/pccp_rule_scores.csv

Run:
  .\.venv\Scripts\python.exe tools\two_track_risk_workflow.py

"""

from __future__ import annotations

import argparse
import json
import math
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
    raise SystemExit("Missing dependency: lifelines. Install with: pip install lifelines") from exc


# In this dataset, concrete PCCP/SCCP is encoded as "CON" (not "CON(").
# Keep support for potential variants like "CON(" as well.
PCCP_MATERIAL_PREFIX = "CON"


def is_pccp_material(material_code: str) -> bool:
    s = (material_code or "").strip().upper()
    return s.startswith(PCCP_MATERIAL_PREFIX)


# ---------------------------
# io helpers
# ---------------------------


def load_geojson_features(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        gj = json.load(f)
    feats = gj.get("features") or []
    if not isinstance(feats, list):
        raise ValueError(f"Invalid GeoJSON: {path} missing features[]")
    return feats


def parse_iso_date(s: str) -> date:
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", ""))
        return dt.date()
    except Exception as exc:
        raise ValueError(f"Invalid ISO date: {s!r}") from exc


def safe_int(x: Any) -> Optional[int]:
    if x is None:
        return None
    s = str(x).strip()
    if not s:
        return None
    try:
        v = int(float(s))
    except Exception:
        return None
    return v


def safe_float(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        v = float(x)
    except Exception:
        return None
    if not math.isfinite(v):
        return None
    return v


def normalize_material(raw: Any) -> str:
    # IMPORTANT: do NOT map CON( into another code. We split on exact PCCP_MATERIAL_CODE.
    s = ("" if raw is None else str(raw)).strip().upper()
    return s if s else "UNKNOWN"


def ordinal_days(d: date) -> float:
    # Numeric time axis: days since 1970-01-01.
    return float((d - date(1970, 1, 1)).days)


def safe_date_from_year(y: int) -> date:
    return date(int(y), 1, 1)


def read_first_failure_by_segment_from_link_csv(link_csv: Path) -> Dict[str, date]:
    """Read break-to-main link CSV and return main_globalid -> first break date.

    Expected columns:
    - main_globalid OR id (depending on producer)
    - break_date (ISO)
    """

    if not link_csv.exists():
        raise FileNotFoundError(f"Missing break link CSV: {link_csv}")

    df = pd.read_csv(link_csv)
    # Support both naming conventions used in this repo.
    if "main_globalid" in df.columns:
        gid_col = "main_globalid"
    elif "id" in df.columns:
        gid_col = "id"
    else:
        raise ValueError(f"Link CSV missing id column: {link_csv}")

    if "break_date" not in df.columns:
        raise ValueError(f"Link CSV missing break_date column: {link_csv}")

    # Normalize IDs to lowercase to match map joins.
    df[gid_col] = df[gid_col].astype(str).str.strip().str.lower()

    def _to_date(x: Any) -> Optional[date]:
        if x is None or (isinstance(x, float) and np.isnan(x)):
            return None
        s = str(x).strip()
        if not s:
            return None
        try:
            return parse_iso_date(s)
        except Exception:
            return None

    df["_break_date"] = df["break_date"].map(_to_date)
    df = df[df["_break_date"].notna()].copy()

    if df.empty:
        return {}

    first = df.groupby(gid_col, sort=False)["_break_date"].min()
    return {str(k): v for k, v in first.items() if isinstance(v, date)}


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
            "uplift_lof": r.get("uplift_lof"),
            "functional_class": r.get("functional_class"),
        }
    return out


# ---------------------------
# PCCP rule-based scorer
# ---------------------------


@dataclass(frozen=True)
class PccpRule:
    start_year: int
    end_year: int
    base_risk_score: float
    label: str


@dataclass(frozen=True)
class PccpRulesConfig:
    rules: Tuple[PccpRule, ...]
    default_missing_year_score: float
    default_missing_year_label: str
    default_out_of_range_score: float
    default_out_of_range_label: str


def load_pccp_rules_config(path: Path) -> PccpRulesConfig:
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    raw_rules = raw.get("rules") or []
    if not isinstance(raw_rules, list) or not raw_rules:
        raise ValueError("PCCP rules config must have a non-empty 'rules' list")

    rules: List[PccpRule] = []
    for r in raw_rules:
        rules.append(
            PccpRule(
                start_year=int(r["start_year"]),
                end_year=int(r["end_year"]),
                base_risk_score=float(r["base_risk_score"]),
                label=str(r.get("label") or "Unknown"),
            )
        )

    def_miss = raw.get("default_missing_year") or {}
    def_oor = raw.get("default_out_of_range") or {}

    return PccpRulesConfig(
        rules=tuple(rules),
        default_missing_year_score=float(def_miss.get("base_risk_score", 2.0)),
        default_missing_year_label=str(def_miss.get("label") or "Unknown"),
        default_out_of_range_score=float(def_oor.get("base_risk_score", 2.0)),
        default_out_of_range_label=str(def_oor.get("label") or "Unknown"),
    )


def score_pccp_segment(row: pd.Series, cfg: PccpRulesConfig) -> Dict[str, Any]:
    """Score a single PCCP/SCCP segment (material == 'CON(') using vintage rules."""

    segment_id = str(row.get("segment_id") or "").strip()
    material = str(row.get("material") or "").strip().upper()
    install_year = safe_int(row.get("install_year"))

    if install_year is None:
        print(
            f"WARN: PCCP segment missing install_year: segment_id={segment_id}",
            file=sys.stderr,
        )
        return {
            "segment_id": segment_id,
            "material": material,
            "risk_method": "PCCP_RULE",
            "risk_score": float(cfg.default_missing_year_score),
            "risk_band": str(cfg.default_missing_year_label),
        }

    rule_hit = None
    for rule in cfg.rules:
        if int(rule.start_year) <= int(install_year) <= int(rule.end_year):
            rule_hit = rule
            break

    if rule_hit is None:
        print(
            f"WARN: PCCP segment install_year out-of-range: segment_id={segment_id} install_year={install_year}",
            file=sys.stderr,
        )
        return {
            "segment_id": segment_id,
            "material": material,
            "risk_method": "PCCP_RULE",
            "risk_score": float(cfg.default_out_of_range_score),
            "risk_band": str(cfg.default_out_of_range_label),
        }

    return {
        "segment_id": segment_id,
        "material": material,
        "risk_method": "PCCP_RULE",
        "risk_score": float(rule_hit.base_risk_score),
        "risk_band": str(rule_hit.label),
    }


def score_all_pccp_segments(pccp_df: pd.DataFrame, cfg: PccpRulesConfig) -> pd.DataFrame:
    if pccp_df is None or pccp_df.empty:
        return pd.DataFrame(columns=["segment_id", "material", "risk_method", "risk_score", "risk_band"])

    rows = [score_pccp_segment(r, cfg) for _, r in pccp_df.iterrows()]
    df = pd.DataFrame(rows)
    # Keep schema stable.
    for c in ["segment_id", "material", "risk_method", "risk_score", "risk_band"]:
        if c not in df.columns:
            df[c] = np.nan
    return df[["segment_id", "material", "risk_method", "risk_score", "risk_band"]]


# ---------------------------
# Cox workflow (normal materials)
# ---------------------------


def build_survival_dataset_for_normal_materials(
    inventory_df: pd.DataFrame,
    first_failure_by_segment: Dict[str, date],
    road_by_segment: Dict[str, Dict[str, Any]],
    observation_end_date: date,
) -> pd.DataFrame:
    """Build a survival dataset for non-PCCP materials suitable for CoxTimeVaryingFitter."""

    rows: List[Dict[str, Any]] = []

    excluded_missing_install = 0
    rejected_non_positive_exposure = 0
    rejected_failure_before_install = 0

    for _, r in inventory_df.iterrows():
        segment_id = str(r.get("segment_id") or "").strip().lower()
        if not segment_id:
            continue

        material = normalize_material(r.get("material"))
        if is_pccp_material(material):
            continue

        install_year = safe_int(r.get("install_year"))
        if install_year is None:
            excluded_missing_install += 1
            continue

        install_date = safe_date_from_year(install_year)
        failure_date = first_failure_by_segment.get(segment_id)
        event = 1 if failure_date is not None else 0
        stop_date = failure_date if failure_date is not None else observation_end_date

        if stop_date < install_date:
            rejected_failure_before_install += 1
            continue

        start = ordinal_days(install_date)
        stop = ordinal_days(stop_date)
        if stop <= start:
            rejected_non_positive_exposure += 1
            continue

        diameter_mm = safe_float(r.get("diameter_mm"))
        diameter_missing = 0 if diameter_mm is not None else 1

        road = road_by_segment.get(segment_id, {})
        road_dist_m = safe_float(road.get("min_dist_m"))
        uplift_lof = safe_float(road.get("uplift_lof"))
        functional_class = (road.get("functional_class") or "").strip().lower() or "unknown"

        if road_dist_m is None:
            road_dist_m = 1_000_000.0
            road_dist_missing = 1
        else:
            road_dist_missing = 0

        if uplift_lof is None:
            uplift_lof = 0.0
            uplift_missing = 1
        else:
            uplift_missing = 0

        age_years = (stop - start) / 365.25

        rows.append(
            {
                "segment_id": segment_id,
                "start": float(start),
                "stop": float(stop),
                "event": int(event),
                "material": material,
                "install_year": int(install_year),
                "age_years": float(age_years),
                "diameter_mm": float(diameter_mm) if diameter_mm is not None else np.nan,
                "diameter_missing": int(diameter_missing),
                # log_diameter_mm is filled after imputation.
                "log_diameter_mm": np.nan,
                "road_distance_m": float(road_dist_m),
                "log1p_road_distance_m": math.log1p(max(0.0, float(road_dist_m))),
                "road_distance_missing": int(road_dist_missing),
                "road_uplift_lof": float(uplift_lof),
                "road_uplift_missing": int(uplift_missing),
                "road_functional_class": functional_class,
            }
        )

    df = pd.DataFrame(rows)

    if df.empty:
        return df

    # lifelines cannot handle NaNs/Infs: impute diameter, then re-derive log features.
    if "diameter_mm" in df.columns:
        diam = pd.to_numeric(df["diameter_mm"], errors="coerce")
        med = float(diam[diam.notna()].median()) if diam.notna().any() else 1.0
        df["diameter_mm"] = diam.fillna(med)
        # Avoid non-positive values in logs.
        df.loc[df["diameter_mm"] <= 0, "diameter_mm"] = med if med > 0 else 1.0
        df["log_diameter_mm"] = np.log(df["diameter_mm"].astype(float))

    # Final safety: replace any remaining NaNs/Infs in numeric covariates.
    numeric_cols = [c for c in df.columns if c not in {"segment_id"}]
    num = df[numeric_cols].select_dtypes(include=["number"]).copy()
    n_bad = int((~np.isfinite(num.to_numpy())).sum())
    if n_bad:
        print(f"WARN: replacing {n_bad} non-finite numeric values with 0 for Cox fit", file=sys.stderr)
        num = num.replace([np.inf, -np.inf], np.nan).fillna(0.0)
        df[num.columns] = num

    # One-hot encode categorical covariates.
    df = pd.get_dummies(df, columns=["material", "road_functional_class"], prefix=["mat", "road"], dummy_na=False)

    # Validation: ensure PCCP concrete is excluded from Cox dataset.
    if not df.empty and any(c.startswith("mat_CON") for c in df.columns):
        raise AssertionError("CON material leaked into Cox training dataset (one-hot columns present).")

    print(
        "Normal-material survival dataset summary:",
        {
            "rows": int(df.shape[0]),
            "events": int(df["event"].sum()) if "event" in df.columns else 0,
            "excluded_missing_install_year": excluded_missing_install,
            "rejected_failure_before_install": rejected_failure_before_install,
            "rejected_non_positive_exposure": rejected_non_positive_exposure,
        },
    )

    return df


def fit_cox_model(df_tv: pd.DataFrame) -> CoxTimeVaryingFitter:
    """Fit Cox time-varying model with one interval per segment."""

    if df_tv.empty:
        raise ValueError("Empty Cox dataset: no rows to fit.")

    required = {"segment_id", "start", "stop", "event"}
    missing = required - set(df_tv.columns)
    if missing:
        raise ValueError(f"Cox dataset missing required columns: {sorted(missing)}")

    if not (df_tv["stop"] > df_tv["start"]).all():
        raise AssertionError("Validation failed: start_time < stop_time for all segments.")

    # lifelines uses all remaining columns (besides id/start/stop/event) as covariates.
    # Keep *only* requested covariates; drop helper/debug columns that are not part of the model spec.
    covar_df = df_tv.drop(columns=["install_year"], errors="ignore").copy()

    # Drop extremely low-variance columns (common with rare materials) to reduce
    # complete separation and convergence issues.
    covar_cols = [c for c in covar_df.columns if c not in {"segment_id", "start", "stop", "event"}]
    numeric = covar_df[covar_cols].select_dtypes(include=["number"])
    low_var = [c for c in numeric.columns if float(numeric[c].var()) < 1e-10]
    if low_var:
        print(f"WARN: dropping low-variance covariates for Cox fit: {low_var}", file=sys.stderr)
        covar_df = covar_df.drop(columns=low_var)

    # Small L2 penalizer improves stability with sparse one-hot covariates.
    ctv = CoxTimeVaryingFitter(penalizer=0.1)

    ctv.fit(
        covar_df,
        id_col="segment_id",
        start_col="start",
        stop_col="stop",
        event_col="event",
        show_progress=False,
    )

    return ctv


def score_segments_with_cox(ctv: CoxTimeVaryingFitter, df_tv: pd.DataFrame) -> pd.DataFrame:
    """Score segments with the fitted Cox model.

    risk_score is the partial hazard (hazard ratio-like relative score).
    """

    # One row per segment in this workflow.
    scores = ctv.predict_partial_hazard(df_tv)
    out = pd.DataFrame(
        {
            "segment_id": df_tv["segment_id"].astype(str).values,
            "material": _material_from_one_hot(df_tv),
            "risk_method": "COX",
            "risk_score": scores.values.astype(float),
        }
    )

    # Derive simple quantile-based bands for display.
    out["risk_band"] = quantile_bands(out["risk_score"], labels=["Low", "Medium", "High", "VeryHigh"])
    return out


def _material_from_one_hot(df_tv: pd.DataFrame) -> List[str]:
    # Reconstruct material label for output. Prefer original column if present (before get_dummies).
    # In this workflow, material is one-hot encoded, so infer from columns.
    mat_cols = [c for c in df_tv.columns if c.startswith("mat_")]
    if not mat_cols:
        return ["UNKNOWN"] * int(df_tv.shape[0])

    mats: List[str] = []
    for _, row in df_tv[mat_cols].iterrows():
        best = None
        for c in mat_cols:
            try:
                v = float(row[c])
            except Exception:
                v = 0.0
            if v == 1.0:
                best = c.replace("mat_", "")
                break
        mats.append(best or "UNKNOWN")
    return mats


def quantile_bands(series: pd.Series, labels: List[str]) -> List[str]:
    x = pd.to_numeric(series, errors="coerce")
    if x.isna().all():
        return ["Unknown"] * int(len(series))

    n = len(labels)
    qs = [i / n for i in range(1, n)]
    cuts = [float(x.quantile(q)) for q in qs]

    def band(v: Any) -> str:
        try:
            f = float(v)
        except Exception:
            return "Unknown"
        if not math.isfinite(f):
            return "Unknown"
        for i, c in enumerate(cuts):
            if f <= c:
                return labels[i]
        return labels[-1]

    return [band(v) for v in x.values]


def cox_model_report(ctv: CoxTimeVaryingFitter, concordance: Optional[float] = None) -> Tuple[pd.DataFrame, str]:
    """Return coefficients table and a short text report."""

    summary = ctv.summary.copy()
    # Add hazard ratios and CI if available.
    if "coef" in summary.columns:
        summary["hazard_ratio"] = np.exp(summary["coef"].astype(float))
    if "coef lower 95%" in summary.columns:
        summary["hazard_ratio_lower_95"] = np.exp(summary["coef lower 95%"].astype(float))
    if "coef upper 95%" in summary.columns:
        summary["hazard_ratio_upper_95"] = np.exp(summary["coef upper 95%"].astype(float))

    lines = []
    lines.append("Cox model fit summary")
    if concordance is not None:
        lines.append(f"Concordance index (c-statistic): {float(concordance):.4f}")
    else:
        lines.append("Concordance index (c-statistic): (computed later)")

    # Print requirements: coefficients + hazard ratios + 95% CI are in the saved CSV.
    # This report prints a small preview for quick inspection.
    lines.append("")
    lines.append("Coefficient preview (coef, HR, 95% CI):")
    cols = [
        c
        for c in [
            "coef",
            "hazard_ratio",
            "coef lower 95%",
            "coef upper 95%",
            "hazard_ratio_lower_95",
            "hazard_ratio_upper_95",
            "p",
        ]
        if c in summary.columns
    ]
    preview = summary.reindex(summary["coef"].abs().sort_values(ascending=False).index).head(10)
    for name, r in preview.iterrows():
        parts = [f"{name}"]
        if "coef" in r:
            parts.append(f"coef={float(r['coef']):.4f}")
        if "hazard_ratio" in r:
            parts.append(f"HR={float(r['hazard_ratio']):.4f}")
        if "hazard_ratio_lower_95" in r and "hazard_ratio_upper_95" in r:
            parts.append(
                f"95%CI=[{float(r['hazard_ratio_lower_95']):.4f}, {float(r['hazard_ratio_upper_95']):.4f}]"
            )
        if "p" in r and pd.notna(r.get("p")):
            try:
                parts.append(f"p={float(r['p']):.3g}")
            except Exception:
                pass
        lines.append("  " + " ".join(parts))
    lines.append("")
    lines.append("Top coefficients by |coef|:")
    if "coef" in summary.columns:
        top = summary.reindex(summary["coef"].abs().sort_values(ascending=False).index).head(20)
        for name, r in top.iterrows():
            coef = float(r.get("coef"))
            hr = float(r.get("hazard_ratio")) if "hazard_ratio" in r else math.exp(coef)
            lines.append(f"  {name}: coef={coef:.4f} HR={hr:.4f}")

    return summary.reset_index().rename(columns={"index": "term"}), "\n".join(lines) + "\n"


# ---------------------------
# assembly + validation
# ---------------------------


def assemble_unified_risk_table(cox_scores: pd.DataFrame, pccp_scores: pd.DataFrame) -> pd.DataFrame:
    keep_cols = ["segment_id", "material", "risk_method", "risk_score", "risk_band"]

    a = cox_scores.copy()[keep_cols]
    b = pccp_scores.copy()[keep_cols]

    # Validation: no overlaps.
    overlap = set(a["segment_id"].astype(str)) & set(b["segment_id"].astype(str))
    if overlap:
        raise AssertionError(f"Validation failed: segments scored by both COX and PCCP_RULE: {len(overlap)}")

    if b.empty:
        out = a.reset_index(drop=True)
    elif a.empty:
        out = b.reset_index(drop=True)
    else:
        out = pd.concat([a, b], ignore_index=True)
    # Validation: no duplicates with same method.
    dup = out.duplicated(subset=["segment_id"], keep=False)
    if dup.any():
        # Duplicates here would imply overlap (already checked) or duplicates within a method.
        dups = out.loc[dup, "segment_id"].astype(str).value_counts().head(10).to_dict()
        raise AssertionError(f"Validation failed: duplicate segment_id rows in unified table: {dups}")

    return out


# ---------------------------
# main
# ---------------------------


def build_inventory_dataframe(mains_features: List[Dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for f in mains_features:
        props = f.get("properties") or {}
        gid = (props.get("globalid") or "").strip().lower()
        if not gid:
            continue
        rows.append(
            {
                "segment_id": gid,
                "material": normalize_material(props.get("material")),
                "install_year": safe_int(props.get("year")),
                "diameter_mm": safe_float(props.get("diam")),
            }
        )
    return pd.DataFrame(rows)


def pick_default_break_link_csv(repo_root: Path) -> Path:
    p1 = repo_root / "outputs" / "breaks" / "breaks_to_mains_largest_within_3m.csv"
    if p1.exists():
        return p1
    p2 = repo_root / "outputs" / "cox" / "breaks_matched_to_mains.csv"
    if p2.exists():
        return p2
    # Fall back to the prior nearest-main output if present.
    p3 = repo_root / "outputs" / "breaks_matched_to_mains.csv"
    return p3


def main(argv: Optional[List[str]] = None) -> int:
    repo_root = Path(__file__).resolve().parents[1]

    ap = argparse.ArgumentParser(description="Two-track risk scoring: Cox (non-CON() materials) + PCCP vintage rules (CON().")
    ap.add_argument("--mains-geojson", default=str(repo_root / "data" / "Public_Water_Main_20251231.geojson"))
    ap.add_argument("--road-proximity", default=str(repo_root / "docs" / "road_proximity_by_main.json"))
    ap.add_argument("--break-link-csv", default=str(pick_default_break_link_csv(repo_root)))
    ap.add_argument("--observation-end-date", default="2025-12-31")
    ap.add_argument("--pccp-rules", default=str(repo_root / "config" / "pccp_vintage_risk_rules.json"))
    ap.add_argument("--out-dir", default=str(repo_root / "outputs" / "risk"))

    args = ap.parse_args(argv)

    mains_path = Path(args.mains_geojson)
    road_path = Path(args.road_proximity)
    link_csv = Path(args.break_link_csv)
    rules_path = Path(args.pccp_rules)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    observation_end_date = parse_iso_date(args.observation_end_date)

    mains_features = load_geojson_features(mains_path)
    inventory_df = build_inventory_dataframe(mains_features)

    # Split materials per requirement.
    pccp_mask = inventory_df["material"].astype(str).map(is_pccp_material)
    pccp_df = inventory_df[pccp_mask].copy()
    normal_df = inventory_df[~pccp_mask].copy()

    print("Inventory split:", {"normal_materials": int(normal_df.shape[0]), "pccp_CON(": int(pccp_df.shape[0])})

    # Failure history: first failure per segment
    first_failure_by_segment = read_first_failure_by_segment_from_link_csv(link_csv)

    # Road proximity features (optional)
    road_by_segment = load_road_proximity_by_main(road_path)

    # PCCP rule-based scoring
    pccp_cfg = load_pccp_rules_config(rules_path)
    pccp_scores = score_all_pccp_segments(pccp_df, pccp_cfg)

    if not pccp_df.empty and pccp_scores.shape[0] != pccp_df.shape[0]:
        raise AssertionError("Validation failed: not all PCCP segments received a PCCP_RULE score.")

    # Cox scoring for normal materials
    df_tv = build_survival_dataset_for_normal_materials(
        inventory_df=inventory_df,
        first_failure_by_segment=first_failure_by_segment,
        road_by_segment=road_by_segment,
        observation_end_date=observation_end_date,
    )

    ctv = fit_cox_model(df_tv)
    cox_scores = score_segments_with_cox(ctv, df_tv)

    # Required: compute and print concordance index (c-statistic).
    c_index = None
    try:
        durations = (pd.to_numeric(df_tv["stop"], errors="coerce") - pd.to_numeric(df_tv["start"], errors="coerce")).astype(float)
        events = pd.to_numeric(df_tv["event"], errors="coerce").fillna(0).astype(int)
        # concordance_index expects higher scores => longer survival; Cox risk_score is higher => higher hazard.
        lp = np.log(pd.to_numeric(cox_scores["risk_score"], errors="coerce").astype(float).clip(lower=1e-12))
        c_index = float(ll_concordance_index(durations.values, (-lp).values, events.values))
        print(f"Concordance index (c-statistic): {c_index:.4f}")
    except Exception as exc:
        print(f"WARN: could not compute concordance index: {exc}", file=sys.stderr)

    coef_df, report_txt = cox_model_report(ctv, concordance=c_index)

    # Validation: no segment gets both methods
    unified = assemble_unified_risk_table(cox_scores, pccp_scores)

    # Write outputs
    unified_path = out_dir / "unified_risk_table.csv"
    unified.sort_values(["risk_method", "risk_score"], ascending=[True, False]).to_csv(unified_path, index=False)

    cox_scores.to_csv(out_dir / "cox_segment_scores.csv", index=False)

    (out_dir / "cox_coefficients.csv").write_text(coef_df.to_csv(index=False), encoding="utf-8")
    (out_dir / "cox_model_report.txt").write_text(report_txt, encoding="utf-8")

    pccp_scores.to_csv(out_dir / "pccp_rule_scores.csv", index=False)

    print("Wrote:", {
        "unified_risk_table": str(unified_path),
        "cox_segment_scores": str(out_dir / "cox_segment_scores.csv"),
        "cox_coefficients": str(out_dir / "cox_coefficients.csv"),
        "cox_model_report": str(out_dir / "cox_model_report.txt"),
        "pccp_rule_scores": str(out_dir / "pccp_rule_scores.csv"),
    })

    # Also echo the model report to console for quick review.
    print(report_txt)

    # Final checks requested
    if not pccp_scores.empty:
        bad = pccp_scores[pccp_scores["risk_method"] != "PCCP_RULE"]
        if not bad.empty:
            raise AssertionError("PCCP scores contain non-PCCP_RULE rows")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

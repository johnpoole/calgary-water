"""Generate a *review* CSV from the doc-based heuristics.

Important: the web map does NOT read this CSV. It is an output artifact that
summarizes what the current heuristic model would assign for each distinct
(material, diam, year) combination present in the mains GeoJSON.

Output:
- docs/distinct_material_diameter_year_with_risk.csv

Columns:
- material, diam, year: raw values from GeoJSON properties
- count: number of mains in the dataset with this exact combo
- LoF, CoF: 1..4 discrete levels (doc-based)
- LoF_float: float before rounding (currently same as LoF in this model)
- CoF_float: float before rounding (currently same as CoF in this model)
- risk_bin: 1..4
- risk_label: Low/Medium/High/Very High
- pof_size_uplift: numeric uplift applied to PoF heuristic (if any)
- source: always 'doc' (roads uplift is spatial and not represented here)

Usage:
  python tools/generate_risk_csv_from_docs.py

Optional:
  python tools/generate_risk_csv_from_docs.py --in data/Public_Water_Main_20251231.geojson --out docs/distinct_material_diameter_year_with_risk.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IN = ROOT / "data" / "Public_Water_Main_20251231.geojson"
DEFAULT_OUT = ROOT / "docs" / "distinct_material_diameter_year_with_risk.csv"
CURRENT_YEAR = 2025


def normalize_material(raw: Any) -> str:
    s = ("" if raw is None else str(raw)).strip().upper()
    return s or "Unknown"


def parse_install_year(raw: Any) -> int | None:
    s = "" if raw is None else str(raw)
    # Find a 4-digit year token.
    for token in s.replace("/", " ").replace("-", " ").split():
        if len(token) == 4 and token.isdigit():
            y = int(token)
            if 1800 <= y <= CURRENT_YEAR:
                return y
    # Fallback: scan anywhere.
    import re

    m = re.search(r"\b(18|19|20)\d{2}\b", s)
    if not m:
        return None
    y = int(m.group(0))
    return y if 1800 <= y <= CURRENT_YEAR else None


def age_years(install_year: int | None) -> int | None:
    if install_year is None:
        return None
    a = CURRENT_YEAR - install_year
    return a if a >= 0 else None


def clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def pof_size_uplift(material_code: str, diam_mm: float | None) -> float:
    mat = normalize_material(material_code)
    if diam_mm is None:
        return 0.0
    # Mirrors RiskConsequenceModel.pofSizeUpliftFrom
    size_sensitive = mat in {"DI", "PDI", "YDI", "ST", "STEEL", "CI", "AC"}
    if not size_sensitive:
        return 0.0
    if diam_mm <= 150:
        return 1.0
    if diam_mm <= 305:
        return 0.5
    return 0.0


def pof_score(material_code: str, install_year: int | None, status_ind: str | None, diam_mm: float | None) -> int:
    mat = normalize_material(material_code)
    age = age_years(install_year)
    status = ("" if status_ind is None else str(status_ind)).strip().upper()

    base_by_material = {
        "PVC": 1,
        "PE": 1,
        "HDPE": 1,
        "DI": 2,
        "PDI": 2,
        "YDI": 2,
        "ST": 2,
        "STEEL": 2,
        "CI": 3,
        "AC": 3,
        "PCI": 1,
        "PCCP": 1,
        "CU": 2,
        "COPPER": 2,
    }

    score = float(base_by_material.get(mat, 2))
    score += pof_size_uplift(mat, diam_mm)

    if isinstance(age, int):
        if mat == "CI" and age > 50:
            score += 1
        if mat == "AC" and age > 50:
            score += 2

    if install_year is not None and mat in {"PCI", "PCCP"}:
        if 1972 <= install_year <= 1978:
            score = max(score, 4)
        elif 1970 <= install_year <= 1980:
            score = max(score, 3)

    if "ABAND" in status or "OUT" in status or "INACT" in status:
        score += 1

    return int(clamp(round(score), 1, 4))


def cof_score(material_code: str, diam_mm: float | None, length_m: float | None) -> int:
    score = 2
    if isinstance(diam_mm, (int, float)):
        if diam_mm <= 150:
            score = 1
        elif diam_mm <= 250:
            score = 2
        elif diam_mm <= 400:
            score = 3
        else:
            score = 4

    mat = normalize_material(material_code)
    if mat in {"PCI", "PCCP"}:
        score = max(score, 4)
    if mat == "ST" and isinstance(diam_mm, (int, float)) and diam_mm >= 400:
        score = max(score, 3)
    if mat == "CU":
        score = min(score, 1)

    if isinstance(length_m, (int, float)) and length_m >= 500:
        score += 1

    return int(clamp(round(score), 1, 4))


def risk_bin(pof: int, cof: int) -> int:
    product = (pof or 2) * (cof or 2)
    if product <= 4:
        return 1
    if product <= 8:
        return 2
    if product <= 12:
        return 3
    return 4


def parse_diam_mm(raw: Any) -> float | None:
    try:
        n = float(str(raw).strip())
    except Exception:
        return None
    return n if n > 0 else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", default=str(DEFAULT_IN))
    ap.add_argument("--out", dest="out_path", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    in_path = Path(args.in_path)
    out_path = Path(args.out_path)

    data = json.loads(in_path.read_text(encoding="utf-8"))
    features = data.get("features") or []

    # Count distinct raw combos.
    combos: Counter[tuple[str, str, str]] = Counter()
    # Keep one representative set of parsed values for each combo.
    rep: dict[tuple[str, str, str], dict[str, Any]] = {}

    for f in features:
        props = (f or {}).get("properties") or {}
        material_raw = ("" if props.get("material") is None else str(props.get("material"))).strip()
        diam_raw = ("" if props.get("diam") is None else str(props.get("diam"))).strip()
        year_raw = ("" if props.get("year") is None else str(props.get("year"))).strip()
        key = (material_raw, diam_raw, year_raw)
        combos[key] += 1
        if key not in rep:
            rep[key] = {
                "material_code": normalize_material(material_raw),
                "diam_mm": parse_diam_mm(diam_raw),
                "install_year": parse_install_year(year_raw),
                "status_ind": ("" if props.get("status_ind") is None else str(props.get("status_ind"))),
                "length_m": None,
            }

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "material",
                "diam",
                "year",
                "count",
                "LoF",
                "CoF",
                "LoF_float",
                "CoF_float",
                "risk_bin",
                "risk_label",
                "pof_size_uplift",
                "source",
            ],
        )
        w.writeheader()

        for (material_raw, diam_raw, year_raw), count in sorted(combos.items(), key=lambda kv: (-kv[1], kv[0])):
            r = rep[(material_raw, diam_raw, year_raw)]
            pof = pof_score(r["material_code"], r["install_year"], r["status_ind"], r["diam_mm"])
            cof = cof_score(r["material_code"], r["diam_mm"], r["length_m"])
            rb = risk_bin(pof, cof)
            label = ["Low", "Medium", "High", "Very High"][rb - 1]
            uplift = pof_size_uplift(r["material_code"], r["diam_mm"])
            w.writerow(
                {
                    "material": material_raw,
                    "diam": diam_raw,
                    "year": year_raw,
                    "count": count,
                    "LoF": pof,
                    "CoF": cof,
                    "LoF_float": float(pof),
                    "CoF_float": float(cof),
                    "risk_bin": rb,
                    "risk_label": label,
                    "pof_size_uplift": uplift,
                    "source": "doc",
                }
            )

    print(f"Wrote: {out_path}")
    print(f"Distinct combos: {len(combos)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

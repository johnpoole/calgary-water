from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any


def _norm(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    return s


def _to_int_or_none(s: str) -> int | None:
    try:
        n = int(s)
    except Exception:
        return None
    return n


def _to_float_or_none(s: str) -> float | None:
    try:
        n = float(s)
    except Exception:
        return None
    return n


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    geojson_path = repo_root / "data" / "Public_Water_Main_20251231.geojson"

    with geojson_path.open("r", encoding="utf-8") as f:
        gj = json.load(f)

    features = gj.get("features") if isinstance(gj, dict) else None
    if not isinstance(features, list):
        raise SystemExit("Expected a FeatureCollection with a 'features' list")

    mats: set[str] = set()
    diams: set[str] = set()
    years: set[str] = set()

    mat_counts: Counter[str] = Counter()
    diam_counts: Counter[str] = Counter()
    year_counts: Counter[str] = Counter()

    for feat in features:
        props = (feat or {}).get("properties") or {}

        m = _norm(props.get("material"))
        d = _norm(props.get("diam"))
        y = _norm(props.get("year"))

        if m:
            mats.add(m)
            mat_counts[m] += 1
        else:
            mat_counts["(blank)"] += 1

        if d:
            diams.add(d)
            diam_counts[d] += 1
        else:
            diam_counts["(blank)"] += 1

        if y:
            years.add(y)
            year_counts[y] += 1
        else:
            year_counts["(blank)"] += 1

    def sort_diam(values: set[str]) -> list[str]:
        def key(s: str):
            n = _to_float_or_none(s)
            return (0, n) if n is not None else (1, s)

        return sorted(values, key=key)

    def sort_year(values: set[str]) -> list[str]:
        def key(s: str):
            n = _to_int_or_none(s)
            return (0, n) if n is not None else (1, s)

        return sorted(values, key=key)

    materials_sorted = sorted(mats)
    diameters_sorted = sort_diam(diams)
    years_sorted = sort_year(years)

    out_dir = repo_root / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)

    out_json = out_dir / "distinct_material_diameter_year.json"
    out_json.write_text(
        json.dumps(
            {
                "source": str(geojson_path.as_posix()),
                "featureCount": len(features),
                "materials": materials_sorted,
                "diameters": diameters_sorted,
                "years": years_sorted,
                "counts": {
                    "materials": len(materials_sorted),
                    "diameters": len(diameters_sorted),
                    "years": len(years_sorted),
                    "blank": {
                        "material": mat_counts.get("(blank)", 0),
                        "diam": diam_counts.get("(blank)", 0),
                        "year": year_counts.get("(blank)", 0),
                    },
                },
                "topCounts": {
                    "materials": mat_counts.most_common(50),
                    "diameters": diam_counts.most_common(50),
                    "years": year_counts.most_common(50),
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    def write_list(path: Path, items: list[str]) -> None:
        path.write_text("\n".join(items) + "\n", encoding="utf-8")

    write_list(out_dir / "distinct_materials.txt", materials_sorted)
    write_list(out_dir / "distinct_diameters.txt", diameters_sorted)
    write_list(out_dir / "distinct_years.txt", years_sorted)

    print(f"Features: {len(features)}")
    print(f"Distinct materials: {len(materials_sorted)}")
    print(f"Distinct diameters: {len(diameters_sorted)}")
    print(f"Distinct years: {len(years_sorted)}")
    print(f"Wrote: {out_json}")


if __name__ == "__main__":
    main()

from __future__ import annotations

import csv
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _norm(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


@dataclass(frozen=True)
class Combo:
    material: str
    diam: str
    year: str


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    geojson_path = repo_root / "data" / "Public_Water_Main_20251231.geojson"

    with geojson_path.open("r", encoding="utf-8") as f:
        gj = json.load(f)

    features = gj.get("features") if isinstance(gj, dict) else None
    if not isinstance(features, list):
        raise SystemExit("Expected a FeatureCollection with a 'features' list")

    counter: Counter[Combo] = Counter()

    for feat in features:
        props = (feat or {}).get("properties") or {}
        material = _norm(props.get("material")) or "(blank)"
        diam = _norm(props.get("diam")) or "(blank)"
        year = _norm(props.get("year")) or "(blank)"
        counter[Combo(material=material, diam=diam, year=year)] += 1

    combos = [
        {"material": c.material, "diam": c.diam, "year": c.year, "count": n}
        for c, n in counter.most_common()
    ]

    out_dir = repo_root / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)

    out_json = out_dir / "distinct_material_diameter_year_combinations.json"
    out_csv = out_dir / "distinct_material_diameter_year_combinations.csv"

    out_json.write_text(
        json.dumps(
            {
                "source": str(geojson_path.as_posix()),
                "featureCount": len(features),
                "distinctCombinations": len(combos),
                "combinations": combos,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["material", "diam", "year", "count"])
        w.writeheader()
        w.writerows(combos)

    print(f"Features: {len(features)}")
    print(f"Distinct (material, diam, year) combinations: {len(combos)}")
    print(f"Wrote: {out_csv}")
    print(f"Wrote: {out_json}")


if __name__ == "__main__":
    main()

import json
import re
from collections import Counter, defaultdict

PATH = "data/Public_Water_Main_20251231.geojson"
MAX_FEATURES = None  # set to an int to cap (e.g., 200000)
MAX_VALUES_PER_KEY = 80000

rx_year = re.compile(r"\b(18|19|20)\d{2}\b")


def to_number(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "" or s.lower() in {"null", "none", "nan", "n/a", "na", "unknown", "unk", "-"}:
            return None
        s = s.replace(",", "")
        try:
            return float(s)
        except ValueError:
            return None
    return None


def to_year(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        y = int(v)
        return y if 1800 <= y <= 2100 else None
    if isinstance(v, str):
        m = rx_year.search(v)
        if not m:
            return None
        y = int(m.group(0))
        return y if 1800 <= y <= 2100 else None
    return None


def as_cat(v):
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        if s == "" or s.lower() in {"null", "none", "nan"}:
            return None
        return s
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(int(v)) if float(v).is_integer() else str(v)
    return str(v)


def quantiles(xs, qs=(0.05, 0.25, 0.5, 0.75, 0.95)):
    if not xs:
        return None
    xs = sorted(xs)
    out = {}
    for q in qs:
        idx = int(round(q * (len(xs) - 1)))
        out[q] = xs[idx]
    return out


def main() -> int:
    with open(PATH, "rb") as f:
        data = json.load(f)

    if data.get("type") == "FeatureCollection":
        features = data.get("features", [])
    else:
        features = [data]

    n_total = len(features)
    if MAX_FEATURES is not None:
        features = features[:MAX_FEATURES]

    key_presence = Counter()
    value_type_counts = defaultdict(Counter)

    rx_diam_key = re.compile(r"(diam|diameter|pipe_?size|size|dn|width|nominal)", re.I)
    rx_mat_key = re.compile(r"(mat|material|mtrl|pipe_?mat|pipe_?material)", re.I)
    rx_year_key = re.compile(r"(install|inst|constructed|construct|built|year|date)", re.I)

    cand_diam = defaultdict(list)
    cand_mat = defaultdict(Counter)
    cand_year = defaultdict(list)

    for ft in features:
        props = (ft or {}).get("properties") or {}
        for k, v in props.items():
            key_presence[k] += 1
            value_type_counts[k][type(v).__name__] += 1

            if rx_diam_key.search(k):
                num = to_number(v)
                if num is not None and len(cand_diam[k]) < MAX_VALUES_PER_KEY:
                    cand_diam[k].append(num)
            if rx_mat_key.search(k):
                cat = as_cat(v)
                if cat is not None and sum(cand_mat[k].values()) < MAX_VALUES_PER_KEY:
                    cand_mat[k][cat] += 1
            if rx_year_key.search(k):
                y = to_year(v)
                if y is not None and len(cand_year[k]) < MAX_VALUES_PER_KEY:
                    cand_year[k].append(y)

    print(f"File: {PATH}")
    print(f"Features: {n_total}")
    print(f"Distinct property keys: {len(key_presence)}")

    print("\nTop property keys by presence (key: %features):")
    for k, c in key_presence.most_common(30):
        pct = 100.0 * c / n_total if n_total else 0
        print(f"  {k}: {pct:5.1f}%  types={dict(value_type_counts[k])}")

    print("\nDiameter/width candidates (numeric stats):")
    if not cand_diam:
        print("  (none detected by heuristic)")
    else:
        for k, vals in sorted(cand_diam.items(), key=lambda kv: len(kv[1]), reverse=True)[:15]:
            q = quantiles(vals)
            if not q:
                continue
            rounded = Counter(int(round(v)) for v in vals)
            common = ", ".join([f"{v}({n})" for v, n in rounded.most_common(12)])
            print(
                f"  {k}: n={len(vals)} min={min(vals):.2f} med={q[0.5]:.2f} max={max(vals):.2f} "
                f"q05={q[0.05]:.2f} q95={q[0.95]:.2f}"
            )
            print(f"      common(rounded): {common}")

    print("\nMaterial candidates (top categories):")
    if not cand_mat:
        print("  (none detected by heuristic)")
    else:
        for k, ctr in sorted(cand_mat.items(), key=lambda kv: sum(kv[1].values()), reverse=True)[:15]:
            total = sum(ctr.values())
            common = ", ".join([f"{v}({n})" for v, n in ctr.most_common(15)])
            print(f"  {k}: n={total} distinct={len(ctr)}")
            print(f"      {common}")

    print("\nInstall/Year candidates (year stats):")
    if not cand_year:
        print("  (none detected by heuristic)")
    else:
        for k, ys in sorted(cand_year.items(), key=lambda kv: len(kv[1]), reverse=True)[:15]:
            q = quantiles(ys)
            if not q:
                continue
            rounded = Counter(int(y) for y in ys)
            common = ", ".join([f"{v}({n})" for v, n in rounded.most_common(12)])
            print(
                f"  {k}: n={len(ys)} min={min(ys)} med={int(q[0.5])} max={max(ys)} "
                f"q05={int(q[0.05])} q95={int(q[0.95])}"
            )
            print(f"      common: {common}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Compute break density (breaks per km of pipe) by material.

Break points do not have material, so each break is assigned to the nearest main
feature and inherits that main's material.

Outputs:
- docs/break_density_by_material.csv
- docs/break_density_by_material.json
- docs/breaks_with_material.csv (debug)

Usage (from repo root):
  python tools/break_density_by_material.py

Notes:
- Uses `properties.length` (meters) on mains.
- Nearest-main matching uses a simple spatial grid + point-to-polyline distance
  in an equirectangular projection centered on Calgary (same approach as the
  p_zone variant).
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
MAINS_PATH = REPO_ROOT / "data" / "Public_Water_Main_20251231.geojson"
BREAKS_PATH = REPO_ROOT / "data" / "Water_Main_Breaks_20251231.geojson"

OUT_CSV = REPO_ROOT / "docs" / "break_density_by_material.csv"
OUT_JSON = REPO_ROOT / "docs" / "break_density_by_material.json"
OUT_BREAKS_DEBUG = REPO_ROOT / "docs" / "breaks_with_material.csv"

# Break code dictionary (letters may appear in combos like "CG2", "BCFG", etc.)
BREAK_CODE_LABELS: Dict[str, str] = {
    "A": "Full Circular",
    "B": "Split",
    "C": "Corrosion",
    "D": "Fitting",
    "E": "Joint",
    "F": "Diagonal Crack",
    "G": "Hole",
    "S": "Saddle",
}


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _safe_str(value: object) -> str:
    return "" if value is None else str(value)


def normalize_material(raw: object) -> str:
    s = _safe_str(raw).strip().upper()
    if not s:
        return "UNKNOWN"
    # Match risk model + Cox script aliasing.
    if s == "CON":
        return "PCCP"
    if s == "COPPER":
        return "CU"
    return s


def decode_break_type(code: str) -> List[str]:
    """Decode break_type into a sorted list of known component letters."""
    letters = {ch for ch in (code or "").upper() if ch in BREAK_CODE_LABELS}
    return sorted(letters)


@dataclass(frozen=True)
class XY:
    x: float
    y: float


class LocalProjector:
    """Equirectangular projection around a fixed origin."""

    def __init__(self, origin_lon: float, origin_lat: float):
        self.origin_lon = origin_lon
        self.origin_lat = origin_lat
        self._cos_lat = math.cos(math.radians(origin_lat))
        self._m_per_deg_lat = 111_320.0
        self._m_per_deg_lon = 111_320.0 * self._cos_lat

    def project(self, lon: float, lat: float) -> XY:
        return XY(
            x=(lon - self.origin_lon) * self._m_per_deg_lon,
            y=(lat - self.origin_lat) * self._m_per_deg_lat,
        )


def point_segment_distance_m(p: XY, a: XY, b: XY) -> float:
    """Distance from point p to segment a-b in meters (in local XY)."""
    abx = b.x - a.x
    aby = b.y - a.y
    apx = p.x - a.x
    apy = p.y - a.y

    denom = abx * abx + aby * aby
    if denom <= 0:
        return math.hypot(apx, apy)

    t = (apx * abx + apy * aby) / denom
    if t <= 0:
        return math.hypot(apx, apy)
    if t >= 1:
        return math.hypot(p.x - b.x, p.y - b.y)

    projx = a.x + t * abx
    projy = a.y + t * aby
    return math.hypot(p.x - projx, p.y - projy)


def point_polyline_distance_m(p: XY, line: List[XY]) -> float:
    """Distance from point to polyline represented by XY vertices."""
    if not line:
        return float("inf")
    if len(line) == 1:
        return math.hypot(p.x - line[0].x, p.y - line[0].y)

    best = float("inf")
    for i in range(len(line) - 1):
        d = point_segment_distance_m(p, line[i], line[i + 1])
        if d < best:
            best = d
    return best


@dataclass
class MainFeature:
    material: str
    length_m: float
    parts: List[List[XY]]
    minx: float
    miny: float
    maxx: float
    maxy: float


class SpatialGrid:
    """Simple spatial grid index for bounding boxes."""

    def __init__(self, cell_size_m: float):
        self.cell_size_m = max(1.0, float(cell_size_m))
        self._cells: Dict[Tuple[int, int], List[int]] = {}

    def _cell(self, x: float, y: float) -> Tuple[int, int]:
        return (int(math.floor(x / self.cell_size_m)), int(math.floor(y / self.cell_size_m)))

    def add_bbox(self, feature_index: int, minx: float, miny: float, maxx: float, maxy: float) -> None:
        c0 = self._cell(minx, miny)
        c1 = self._cell(maxx, maxy)
        for cx in range(min(c0[0], c1[0]), max(c0[0], c1[0]) + 1):
            for cy in range(min(c0[1], c1[1]), max(c0[1], c1[1]) + 1):
                self._cells.setdefault((cx, cy), []).append(feature_index)

    def query_point_candidates(self, x: float, y: float, ring: int) -> Iterable[int]:
        cx, cy = self._cell(x, y)
        seen = set()
        for dx in range(-ring, ring + 1):
            for dy in range(-ring, ring + 1):
                if abs(dx) != ring and abs(dy) != ring:
                    continue
                for idx in self._cells.get((cx + dx, cy + dy), []):
                    if idx not in seen:
                        seen.add(idx)
                        yield idx


def _bbox_xy(parts: List[List[XY]]) -> Tuple[float, float, float, float]:
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for part in parts:
        for v in part:
            minx = min(minx, v.x)
            miny = min(miny, v.y)
            maxx = max(maxx, v.x)
            maxy = max(maxy, v.y)
    if minx == float("inf"):
        return (0.0, 0.0, 0.0, 0.0)
    return (minx, miny, maxx, maxy)


def load_geojson(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def compute_origin(mains_geojson: dict) -> Tuple[float, float]:
    lons: List[float] = []
    lats: List[float] = []
    features = mains_geojson.get("features", [])
    for feat in features[:2000]:
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates")
        if not coords:
            continue
        for line in coords:
            for lon, lat in line[:10]:
                lons.append(float(lon))
                lats.append(float(lat))
            if len(lons) >= 2000:
                break
        if len(lons) >= 2000:
            break
    if not lons:
        return (-114.07, 51.05)
    return (sum(lons) / len(lons), sum(lats) / len(lats))


def load_mains(mains_path: Path) -> Tuple[List[MainFeature], SpatialGrid, LocalProjector, Dict[str, float]]:
    mains_geojson = load_geojson(mains_path)
    origin_lon, origin_lat = compute_origin(mains_geojson)
    projector = LocalProjector(origin_lon, origin_lat)

    mains: List[MainFeature] = []
    grid = SpatialGrid(cell_size_m=750.0)

    pipe_len_by_material_m: Dict[str, float] = {}

    for feat in mains_geojson.get("features", []):
        props = feat.get("properties") or {}
        material = normalize_material(props.get("material"))
        length_m = _to_float(props.get("length"), 0.0)
        pipe_len_by_material_m[material] = pipe_len_by_material_m.get(material, 0.0) + max(0.0, length_m)

        geom = feat.get("geometry") or {}
        if geom.get("type") != "MultiLineString":
            continue
        coords = geom.get("coordinates")
        if not coords:
            continue

        parts: List[List[XY]] = []
        for line in coords:
            if not line:
                continue
            parts.append([projector.project(float(lon), float(lat)) for lon, lat in line])

        minx, miny, maxx, maxy = _bbox_xy(parts)
        mains.append(
            MainFeature(
                material=material,
                length_m=length_m,
                parts=parts,
                minx=minx,
                miny=miny,
                maxx=maxx,
                maxy=maxy,
            )
        )
        grid.add_bbox(len(mains) - 1, minx, miny, maxx, maxy)

    return mains, grid, projector, pipe_len_by_material_m


def nearest_main_material(
    mains: List[MainFeature],
    grid: SpatialGrid,
    projector: LocalProjector,
    lon: float,
    lat: float,
    max_search_rings: int = 8,
) -> Tuple[str, float]:
    p = projector.project(lon, lat)

    best_mat = "UNKNOWN"
    best_d = float("inf")

    for ring in range(0, max_search_rings + 1):
        any_candidate = False
        for idx in grid.query_point_candidates(p.x, p.y, ring=ring):
            any_candidate = True
            main_feat = mains[idx]

            dx = 0.0
            if p.x < main_feat.minx:
                dx = main_feat.minx - p.x
            elif p.x > main_feat.maxx:
                dx = p.x - main_feat.maxx
            dy = 0.0
            if p.y < main_feat.miny:
                dy = main_feat.miny - p.y
            elif p.y > main_feat.maxy:
                dy = p.y - main_feat.maxy
            bbox_d = math.hypot(dx, dy)
            if bbox_d >= best_d:
                continue

            d = float("inf")
            for part in main_feat.parts:
                d = min(d, point_polyline_distance_m(p, part))
                if d <= 0:
                    break

            if d < best_d:
                best_d = d
                best_mat = main_feat.material

        if any_candidate and best_d < (grid.cell_size_m * (ring + 0.75)):
            break

    return best_mat, best_d


def main() -> None:
    if not MAINS_PATH.exists():
        raise SystemExit(f"Missing mains file: {MAINS_PATH}")
    if not BREAKS_PATH.exists():
        raise SystemExit(f"Missing breaks file: {BREAKS_PATH}")

    mains, grid, projector, pipe_len_by_material_m = load_mains(MAINS_PATH)

    breaks_geojson = load_geojson(BREAKS_PATH)

    breaks_by_material: Dict[str, int] = {}
    breaks_by_material_by_letter: Dict[str, Dict[str, int]] = {}

    debug_rows: List[Dict[str, object]] = []

    for feat in breaks_geojson.get("features", []):
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates")
        if not coords or len(coords) < 2:
            continue
        lon = float(coords[0])
        lat = float(coords[1])

        props = feat.get("properties") or {}
        break_type = _safe_str(props.get("break_type")).strip()
        break_date = _safe_str(props.get("break_date")).strip()
        status = _safe_str(props.get("status")).strip()

        material, dist_m = nearest_main_material(mains, grid, projector, lon=lon, lat=lat)

        breaks_by_material[material] = breaks_by_material.get(material, 0) + 1
        decoded = decode_break_type(break_type)
        if material not in breaks_by_material_by_letter:
            breaks_by_material_by_letter[material] = {k: 0 for k in BREAK_CODE_LABELS.keys()}
        for letter in decoded:
            breaks_by_material_by_letter[material][letter] += 1

        debug_rows.append(
            {
                "break_date": break_date,
                "break_type": break_type,
                "decoded": ";".join(decoded),
                "status": status,
                "lon": lon,
                "lat": lat,
                "material": material,
                "nearest_main_distance_m": round(dist_m, 3),
            }
        )

    mats = sorted(set(pipe_len_by_material_m.keys()) | set(breaks_by_material.keys()))

    rows: List[Dict[str, object]] = []
    for mat in mats:
        pipe_m = pipe_len_by_material_m.get(mat, 0.0)
        pipe_km = pipe_m / 1000.0
        breaks = breaks_by_material.get(mat, 0)
        density = (breaks / pipe_km) if pipe_km > 0 else 0.0

        row: Dict[str, object] = {
            "material": mat,
            "pipe_m": round(pipe_m, 3),
            "pipe_km": round(pipe_km, 6),
            "breaks_total": breaks,
            "breaks_per_km": round(density, 6),
        }

        for letter, label in BREAK_CODE_LABELS.items():
            row[f"breaks_{letter}"] = breaks_by_material_by_letter.get(mat, {}).get(letter, 0)
            row[f"breaks_{letter}_label"] = label

        rows.append(row)

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        fieldnames = list(rows[0].keys()) if rows else ["material", "pipe_m", "pipe_km", "breaks_total", "breaks_per_km"]
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump({"byMaterial": rows, "breakCodeLabels": BREAK_CODE_LABELS}, f, indent=2)

    with OUT_BREAKS_DEBUG.open("w", newline="", encoding="utf-8") as f:
        if debug_rows:
            w = csv.DictWriter(f, fieldnames=list(debug_rows[0].keys()))
            w.writeheader()
            w.writerows(debug_rows)

    print(f"Wrote {OUT_CSV}")
    print(f"Wrote {OUT_JSON}")
    print(f"Wrote {OUT_BREAKS_DEBUG}")


if __name__ == "__main__":
    main()

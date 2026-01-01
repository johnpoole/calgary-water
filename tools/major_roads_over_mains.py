import csv
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

MAINS_PATH = ROOT / "data" / "Public_Water_Main_20251231.geojson"
ROADS_PATH = ROOT / "data" / "Major_Road_Network_20251231.geojson"

OUT_JSON = ROOT / "docs" / "road_proximity_by_main.json"
OUT_CSV = ROOT / "docs" / "road_proximity_by_main.csv"

# Per docs/roads_risk.txt: avoid wide distance-based nearest-road mapping.
# Instead, do a small-buffer (intersection-style) join.
# Interpretation of "over": road centerline touches the main segment within BUFFER_M.
# NOTE: The roads layer appears to be centerlines; a 1–2m buffer is often too
# small to catch mains under a roadway corridor (pipes are commonly offset from
# centerline). We use a larger corridor buffer to capture "under/within road"
# exposure more reliably.
BUFFER_M = 15.0

# Spatial index grid size (meters). Bigger is faster to build, smaller reduces candidates.
CELL_M = 150.0

# Local equirectangular projection around Calgary (good enough for local distances).
# These are only used to convert lon/lat degrees to approximate meters.
LON0 = -114.07
LAT0 = 51.05
R = 6371000.0
LAT0_RAD = math.radians(LAT0)
COS_LAT0 = math.cos(LAT0_RAD)


def project(lon: float, lat: float):
    x = math.radians(lon - LON0) * R * COS_LAT0
    y = math.radians(lat - LAT0) * R
    return x, y


def clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def point_seg_dist2(px, py, ax, ay, bx, by):
    # Distance^2 from point P to segment AB
    vx = bx - ax
    vy = by - ay
    wx = px - ax
    wy = py - ay
    denom = vx * vx + vy * vy
    if denom <= 0.0:
        dx = px - ax
        dy = py - ay
        return dx * dx + dy * dy
    t = (wx * vx + wy * vy) / denom
    t = clamp(t, 0.0, 1.0)
    cx = ax + t * vx
    cy = ay + t * vy
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy


def _orient(ax, ay, bx, by, cx, cy):
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _on_segment(ax, ay, bx, by, cx, cy):
    return (
        min(ax, bx) <= cx <= max(ax, bx)
        and min(ay, by) <= cy <= max(ay, by)
    )


def segments_intersect(ax, ay, bx, by, cx, cy, dx, dy):
    o1 = _orient(ax, ay, bx, by, cx, cy)
    o2 = _orient(ax, ay, bx, by, dx, dy)
    o3 = _orient(cx, cy, dx, dy, ax, ay)
    o4 = _orient(cx, cy, dx, dy, bx, by)

    # General case
    if (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0):
        return True

    # Collinear edge cases (tolerant-ish)
    eps = 1e-12
    if abs(o1) < eps and _on_segment(ax, ay, bx, by, cx, cy):
        return True
    if abs(o2) < eps and _on_segment(ax, ay, bx, by, dx, dy):
        return True
    if abs(o3) < eps and _on_segment(cx, cy, dx, dy, ax, ay):
        return True
    if abs(o4) < eps and _on_segment(cx, cy, dx, dy, bx, by):
        return True

    return False


def seg_seg_dist2(ax, ay, bx, by, cx, cy, dx, dy):
    if segments_intersect(ax, ay, bx, by, cx, cy, dx, dy):
        return 0.0
    return min(
        point_seg_dist2(ax, ay, cx, cy, dx, dy),
        point_seg_dist2(bx, by, cx, cy, dx, dy),
        point_seg_dist2(cx, cy, ax, ay, bx, by),
        point_seg_dist2(dx, dy, ax, ay, bx, by),
    )


def iter_linestring_coords(geom):
    if not geom:
        return
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "LineString" and isinstance(coords, list):
        yield coords
    elif gtype == "MultiLineString" and isinstance(coords, list):
        for line in coords:
            if isinstance(line, list):
                yield line


def road_is_major(props: dict) -> bool:
    # Dataset is already "Major Road Network", but filter out unbuilt/obsolete.
    obsolete = (props.get("obsolete_code") or "").strip().upper()
    if obsolete in {"Y", "YES", "TRUE"}:
        return False

    built_status = (props.get("built_status") or "").strip().upper()
    if built_status and built_status != "BUILT":
        return False

    return True


def normalize_ctp_class(v: str) -> str:
    return (v or "").strip().lower()


def functional_class_from_ctp_class(ctp_class: str) -> str:
    # Best-effort mapping from this dataset's ctp_class values.
    c = normalize_ctp_class(ctp_class)
    if not c:
        return "unknown"
    if "skeletal" in c:
        return "expressway_freeway"
    if "parkway" in c:
        return "major_arterial"
    if "arterial" in c and "industrial" not in c:
        return "major_arterial"
    if "industrial" in c and "arterial" in c:
        return "minor_arterial"
    if "urban boulevard" in c:
        return "minor_arterial"
    if "neighbourhood boulevard" in c or "neighborhood boulevard" in c:
        return "collector"
    return "unknown"


def road_lof_uplift(functional_class: str) -> float:
    # Method A from docs/roads_risk.txt
    fc = (functional_class or "").strip().lower()
    if fc in {"local", "residential"}:
        return 0.0
    if fc == "collector":
        return 0.5
    if fc == "minor_arterial":
        return 1.0
    if fc == "major_arterial":
        return 1.5
    if fc in {"expressway_freeway", "freeway", "expressway"}:
        return 2.0
    return 0.0


def grid_key(ix: int, iy: int) -> int:
    # Pack into a single int for speed/memory.
    return (ix << 32) ^ (iy & 0xFFFFFFFF)


def main():
    print("Loading roads:", ROADS_PATH)
    roads = json.loads(ROADS_PATH.read_text(encoding="utf-8"))
    road_features = roads.get("features") or []

    # Each road segment: (ax, ay, bx, by, functional_class, uplift, source_ctp_class)
    road_segs = []
    grid = {}

    def add_seg_to_grid(seg_index: int, xmin: float, ymin: float, xmax: float, ymax: float):
        ix0 = int(math.floor(xmin / CELL_M))
        ix1 = int(math.floor(xmax / CELL_M))
        iy0 = int(math.floor(ymin / CELL_M))
        iy1 = int(math.floor(ymax / CELL_M))
        for ix in range(ix0, ix1 + 1):
            for iy in range(iy0, iy1 + 1):
                k = grid_key(ix, iy)
                grid.setdefault(k, []).append(seg_index)

    kept_roads = 0
    for f in road_features:
        props = f.get("properties") or {}
        if not road_is_major(props):
            continue

        ctp_class = (props.get("ctp_class") or "").strip()
        functional_class = functional_class_from_ctp_class(ctp_class)
        uplift = road_lof_uplift(functional_class)
        # If we can't classify it, skip (no defensible uplift).
        if uplift <= 0.0:
            continue

        kept_roads += 1
        geom = f.get("geometry")
        for line in iter_linestring_coords(geom):
            if not line or len(line) < 2:
                continue
            # Project vertices once.
            pts = []
            for lon, lat in line:
                x, y = project(float(lon), float(lat))
                pts.append((x, y))
            for i in range(len(pts) - 1):
                ax, ay = pts[i]
                bx, by = pts[i + 1]
                seg_index = len(road_segs)
                road_segs.append((ax, ay, bx, by, functional_class, uplift, ctp_class))
                xmin = min(ax, bx) - BUFFER_M
                xmax = max(ax, bx) + BUFFER_M
                ymin = min(ay, by) - BUFFER_M
                ymax = max(ay, by) + BUFFER_M
                add_seg_to_grid(seg_index, xmin, ymin, xmax, ymax)

    print(f"Road features kept: {kept_roads:,} / {len(road_features):,}")
    print(f"Road segments indexed: {len(road_segs):,}")
    print(f"Grid cells: {len(grid):,}")

    print("Loading mains:", MAINS_PATH)
    mains = json.loads(MAINS_PATH.read_text(encoding="utf-8"))
    main_features = mains.get("features") or []

    out_rows = []
    hit = 0
    for idx, f in enumerate(main_features):
        props = f.get("properties") or {}
        gid = (props.get("globalid") or "").strip()
        if not gid:
            continue

        geom = f.get("geometry")
        best = None  # { uplift, functional_class, source_ctp_class, min_d2 }

        for line in iter_linestring_coords(geom):
            if not line or len(line) < 2:
                continue
            pts = []
            for lon, lat in line:
                x, y = project(float(lon), float(lat))
                pts.append((x, y))

            for i in range(len(pts) - 1):
                ax, ay = pts[i]
                bx, by = pts[i + 1]

                xmin = min(ax, bx) - BUFFER_M
                xmax = max(ax, bx) + BUFFER_M
                ymin = min(ay, by) - BUFFER_M
                ymax = max(ay, by) + BUFFER_M

                ix0 = int(math.floor(xmin / CELL_M))
                ix1 = int(math.floor(xmax / CELL_M))
                iy0 = int(math.floor(ymin / CELL_M))
                iy1 = int(math.floor(ymax / CELL_M))

                candidates = None
                for ix in range(ix0, ix1 + 1):
                    for iy in range(iy0, iy1 + 1):
                        k = grid_key(ix, iy)
                        lst = grid.get(k)
                        if not lst:
                            continue
                        if candidates is None:
                            candidates = set(lst)
                        else:
                            candidates.update(lst)

                if not candidates:
                    continue

                for si in candidates:
                    cx, cy, dx, dy, functional_class, uplift, source_ctp_class = road_segs[si]
                    d2 = seg_seg_dist2(ax, ay, bx, by, cx, cy, dx, dy)
                    if d2 <= (BUFFER_M * BUFFER_M):
                        # Touching within buffer.
                        if best is None or uplift > best["uplift"] or (
                            uplift == best["uplift"] and d2 < best["min_d2"]
                        ):
                            best = {
                                "uplift": uplift,
                                "functional_class": functional_class,
                                "source_ctp_class": source_ctp_class,
                                "min_d2": d2,
                            }

        if best is None:
            continue

        hit += 1
        out_rows.append(
            {
                "globalid": gid,
                "functional_class": best["functional_class"],
                "uplift_lof": best["uplift"],
                "min_dist_m": math.sqrt(best["min_d2"]),
                "source_ctp_class": best["source_ctp_class"],
            }
        )

        if (idx + 1) % 5000 == 0:
            print(f"Processed mains: {idx+1:,}/{len(main_features):,} | hits so far: {hit:,}")

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "buffer_m": BUFFER_M,
        "byMain": out_rows,
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    with OUT_CSV.open("w", newline="", encoding="utf-8") as fcsv:
        w = csv.writer(fcsv)
        w.writerow(["globalid", "functional_class", "uplift_lof", "min_dist_m", "buffer_m", "source_ctp_class"])
        for r in out_rows:
            w.writerow(
                [
                    r["globalid"],
                    r["functional_class"],
                    f"{float(r['uplift_lof']):.1f}",
                    f"{r['min_dist_m']:.3f}",
                    f"{BUFFER_M:.1f}",
                    r["source_ctp_class"],
                ]
            )

    print("Wrote:", OUT_JSON)
    print("Wrote:", OUT_CSV)
    print(f"Mains touching classified major roads (≤{BUFFER_M}m): {hit:,}")


if __name__ == "__main__":
    main()

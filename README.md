# Calgary Water – D3 Map

This is a minimal static page that renders the GeoJSON in `data/` using D3.

## Interactions

- Pan: click + drag
- Zoom: mouse wheel / trackpad pinch
- Query: hover for a quick tooltip, click a feature to inspect its properties

## Style (Risk / Consequence)

The legend includes a **Style** selector for **Risk** and **Consequence**.

These scores are derived from the available fields (e.g., install year / material / diameter) using the qualitative guidance in [docs/Pipe_Risk_Assessment_Water_Mains_North_America.docx](docs/Pipe_Risk_Assessment_Water_Mains_North_America.docx) (implemented in [risk_consequence.js](risk_consequence.js)).

The map does not load any external scoring CSV. If you want a tabular artifact of what the current heuristics would assign for each distinct (material, diam, year) combination in the dataset, generate it with:

```bash
python tools/generate_risk_csv_from_docs.py
```

This writes:

- `docs/distinct_material_diameter_year_with_risk.csv` (for review / downstream analysis only)

## Style (Break Density)

There is also a **Break density** style that colors mains by the number of breaks per km of pipe for the same pipe **material**.

The break points in `data/Water_Main_Breaks_20251231.geojson` do not include material, so the tool assigns each break to the *nearest* main feature and inherits its material. It then aggregates:

- We first generate a break→main link table that includes **every pipe within 2m** of each break point.
- The break density tool counts **one break per link row** (so a single break near an intersection can count for multiple pipes/materials).

- `breaks_per_km = breaks_total / (pipe_km in material)`

To generate the required file for the overlay:

```bash
python tools/link_breaks_to_mains.py --within-m 2
python tools/break_density_by_material.py
```

This writes:

- `docs/break_density_by_material.json` (used by the map)
- `docs/break_density_by_material.csv`
- `docs/breaks_with_material.csv` (debug)

## Basemap

The page renders an online raster basemap using OpenStreetMap tile images (internet required).

## Shareable views (URL state)

The current pan/zoom and all legend filter toggles are encoded into the page URL query string automatically. Copy/paste the URL to share the exact same view.

## Run locally

Browsers generally block `fetch()` when opening `index.html` directly from disk (the `file://` scheme). Run a local web server from this folder instead.

### Option A: Python

```bash
python -m http.server 8000
```

Then open:

- http://localhost:8000/

### Option B: Node (if you have it)

```bash
npx serve
```

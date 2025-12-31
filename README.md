# Calgary Water – D3 Map

This is a minimal static page that renders the GeoJSON in `data/` using D3.

## Interactions

- Pan: click + drag
- Zoom: mouse wheel / trackpad pinch
- Query: hover for a quick tooltip, click a feature to inspect its properties

## Overlays (Risk / Consequence)

The legend includes optional overlay layers for **Risk** and **Consequence** (shown as a colored halo behind the pipes). These are heuristic scores derived from the available fields (e.g., year/material/diameter) and are intended as a starting point.

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

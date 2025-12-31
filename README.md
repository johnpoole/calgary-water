# Calgary Water – D3 Map

This is a minimal static page that renders the GeoJSON in `data/` using D3.

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

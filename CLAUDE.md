# Repo / deployment facts — read first

**This repo is `github.com/johnpoole/calgary-water`. It is the canonical, deployed repo.**

- **Render deploys this repo** from branch `main`. A push to `main` here goes live.
- There was a duplicate repo, `github.com/johnpoole/water-monitoring`, that held only the river-monitor part. It is dead — do not push to it, clone it, or treat it as a deploy target. If you see it referenced anywhere, ignore it.
- This is a **combined repo**: the Elbow River water monitor (`public/`, `server.js`, `render.yaml`) lives alongside a separate water-main-break risk project (`map.js`, `risk_consequence.js`, `index.html`, `data/`, `outputs/`, `tools/`). The top-level `README.md` documents the risk project; the river monitor is the `public/` + `server.js` app.
- **Never force-push to this repo** — it would wipe one of the two projects.

The local working folder may be named "water monitoring"; that name is cosmetic. The `origin` remote is what's authoritative, and it is calgary-water.

# Documentation Index

## Start here

If you are new to this repo, read the docs in this order:

1. `README.md` in the repo root
2. `docs/SPA_SINGLE_PAGE_GUIDE.md`
3. `docs/SPA_MODULAR_GUIDE.md`
4. `backend/README.md`

## Frontend onboarding docs

- `docs/SPA_SINGLE_PAGE_GUIDE.md`
  - Best starting point for understanding `spa-single-page/`
  - Explains the one-file runtime structure in `script.js`
  - Shows where tree, metadata, preview, and runtime behavior are implemented

- `docs/SPA_MODULAR_GUIDE.md`
  - Best starting point for understanding `spa-modular/`
  - Explains `index.html` + `js2/` and `index2.html` + `js/`
  - Shows how responsibilities are split across the modular files

## Frontend deep-dive docs

These are feature-specific references for the single-page implementation:

- `docs/SPA_FRONTEND_OVERVIEW.md`
- `docs/SPA_TREE_IMPLEMENTATION.md`
- `docs/SPA_METADATA_IMPLEMENTATION.md`
- `docs/SPA_LINE_GRAPH_IMPLEMENTATION.md`
- `docs/SPA_IMAGE_HEATMAP_IMPLEMENTATION.md`
- `docs/SPA_MODULAR_JS_IMPLEMENTATION.md`
- `docs/SPA_MODULAR_JS2_IMPLEMENTATION.md`

Use these after the onboarding guides when you need more detail on a specific area.

## Backend docs

- `backend/README.md`
  - Backend overview, setup, API summary, and test commands

- `docs/BACKEND_IMPLEMENTATION.md`
  - Broader implementation notes for backend behavior

## Quick orientation

Frontend folders:

```text
spa-single-page/   # Single-file frontend runtime
spa-modular/       # Same viewer split across grouped files
```

Backend folder:

```text
backend/           # Flask API for file listing, HDF5 tree/meta/preview/data/export
```

Reference source snapshots in the repo root:

```text
html.txt
styles.txt
fullscript.txt
```

These text files are not the live app entrypoints. The actual runnable frontend code lives in `spa-single-page/` and `spa-modular/`.

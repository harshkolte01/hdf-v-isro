# HDF Viewer Frontend + Backend

This repository contains an HDF5 viewer with:

- a Flask backend for file listing, HDF5 navigation, metadata, preview data, bounded data windows, and CSV export
- a single-page frontend under `spa-single-page/`
- a modular frontend under `spa-modular/`

The two frontend variants are meant to provide the same viewer behavior. The main difference is code organization.

## Repo structure

```text
backend/            # Flask backend API
docs/               # Frontend/backend documentation
spa-single-page/    # Single-file frontend runtime
spa-modular/        # Frontend split into grouped files
html.txt            # Source snapshot / reference text
styles.txt          # Source snapshot / reference text
fullscript.txt      # Source snapshot / reference text
```

Important:

- the live frontend entrypoints are inside `spa-single-page/` and `spa-modular/`
- the root `html.txt`, `styles.txt`, and `fullscript.txt` files are reference/source snapshots, not the main runtime entrypoints

## Which frontend should you open

### `spa-single-page/`

Use this when you want the all-in-one frontend:

- `spa-single-page/index.html`
- `spa-single-page/style.css`
- `spa-single-page/script.js`

Deep link format:

```text
spa-single-page/index.html?file=<backend-object-key>
```

### `spa-modular/`

Use this when you want the frontend split by responsibility.

Primary entry:

```text
spa-modular/index.html?file=<backend-object-key>
```

This uses:

- `spa-modular/js2/` for the ES-module implementation
- `spa-modular/style.css` for shared styles

Legacy entry:

```text
spa-modular/index2.html?file=<backend-object-key>
```

This uses:

- `spa-modular/js/` for the plain-script implementation

Default recommendation:

- use `spa-modular/index.html` if you want the modular version
- use `spa-single-page/index.html` if you want the monolithic version

## Backend overview

The backend is a Flask service that serves:

- `GET /files/`
- `GET /files/<key>/children`
- `GET /files/<key>/meta`
- `GET /files/<key>/preview`
- `GET /files/<key>/data`
- `GET /files/<key>/export/csv`

Main backend files:

```text
backend/app.py
backend/src/routes/files.py
backend/src/routes/hdf5.py
backend/src/readers/hdf5_reader.py
backend/src/storage/filesystem_client.py
backend/src/utils/cache.py
```

## Backend setup

From `backend/`:

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Default runtime:

- host: `0.0.0.0`
- port: `5000`

Required environment configuration is described in `backend/.env.example` and `backend/README.md`.

## Frontend setup

The frontends are plain static assets. You can host them with any static file server.

Common requirements:

- the backend must be reachable
- `window.__CONFIG__.API_BASE_URL` must point to the backend if you are not using the default value
- the page should be opened with a `?file=<backend-object-key>` query parameter to deep-link into a file

The current frontend default is:

```text
https://hdf-viewer-backend.vercel.app
```

That value is defined in:

- `spa-single-page/script.js`
- `spa-modular/js/viewer-core.js`
- `spa-modular/js2/viewer-core.js`

## How the frontends are organized

### Single-page SPA

`spa-single-page/` keeps everything in one runtime file.

Use this if you want:

- one JS runtime file
- one place to trace the whole app
- the simplest deployment shape

Read:

- `docs/SPA_SINGLE_PAGE_GUIDE.md`

### Modular SPA

`spa-modular/` keeps the same viewer architecture split across grouped files:

- `viewer-core.js`
- `viewer-api.js`
- `viewer-state.js`
- `viewer-render.js`
- `viewer-runtimes.js`
- `viewer-shell.js`
- `app-viewer.js`

Use this if you want:

- smaller files
- clearer file-level ownership
- an ES-module entrypoint

Read:

- `docs/SPA_MODULAR_GUIDE.md`

## Recommended reading order

1. `docs/SPA_SINGLE_PAGE_GUIDE.md`
2. `docs/SPA_MODULAR_GUIDE.md`
3. `backend/README.md`
4. `docs/README.md` for the rest of the documentation map

## Quick edit guide

If you need to change something, this is the shortest route:

| Change type | Start here |
| --- | --- |
| Backend API behavior | `backend/src/routes/` and `backend/src/readers/` |
| Single-page frontend behavior | `spa-single-page/script.js` |
| Modular frontend behavior | `spa-modular/js2/` first, then `spa-modular/js/` if both must stay aligned |
| Styling | `spa-single-page/style.css` or `spa-modular/style.css` |
| Documentation | `docs/` and this `README.md` |

## Documentation map

- `docs/README.md`
- `docs/SPA_SINGLE_PAGE_GUIDE.md`
- `docs/SPA_MODULAR_GUIDE.md`
- `backend/README.md`
- existing feature-level docs under `docs/`

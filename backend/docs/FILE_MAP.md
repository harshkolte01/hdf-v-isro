# File Map

This file maps backend files to responsibilities so new developers can quickly find where logic lives.

## Root files

- `backend/app.py`
  - Flask initialization, CORS, route registration, `/` and `/health`.

- `backend/wsgi.py`
  - WSGI entrypoint (`from app import app`).

- `backend/.env` / `backend/.env.example`
  - runtime environment configuration template and local values.

- `backend/requirements.txt`
  - Python dependencies.

- `backend/h5create.py`
  - helper script to generate sample HDF5 files.

## Route layer (`backend/src/routes`)

- `files.py`
  - `GET /files/`
  - `POST /files/refresh`
  - files-cache integration

- `hdf5.py`
  - `GET /files/<key>/children`
  - `GET /files/<key>/meta`
  - `GET /files/<key>/preview`
  - `GET /files/<key>/data`
  - `GET /files/<key>/export/csv`
  - validation, limits, cache keys, CSV streaming

## Reader layer (`backend/src/readers`)

- `hdf5_reader.py`
  - HDF5 object navigation
  - dataset metadata extraction
  - preview generation
  - matrix/line/heatmap extraction
  - value sanitization for JSON safety

## Storage layer (`backend/src/storage`)

- `filesystem_client.py`
  - storage root resolution from env
  - path normalization and traversal protection
  - recursive file listing
  - file metadata and stream/range reads

- `__init__.py`
  - exports storage client class + singleton getter

## Utils (`backend/src/utils`)

- `cache.py`
  - `SimpleCache`
  - global caches and cache-key helper

## Tests (`backend/tests`)

- `test_files_routes.py`
  - file listing endpoint behavior and validation

- `test_hdf5_routes.py`
  - hdf5 route behavior:
    - line/heatmap limits
    - preview flags
    - error mapping
    - response caching
    - csv export behaviors

## Scripts (`backend/scripts`)

- `benchmark.py`
  - performance helper for endpoint reads
- `verify_range_reads.py`
  - validates byte-range operations
- `test_storage.py`
  - storage-client checks

## Templates

- `backend/templates/index.html`
  - static API dashboard template (currently not used by `GET /` route in `app.py`).

## Documentation

- `backend/README.md`
  - main backend README
- `backend/src/*/README.md`
  - module-focused docs
- `backend/docs/*.md`
  - extended implementation docs

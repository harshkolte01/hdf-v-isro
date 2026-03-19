# HDF Viewer Backend

Flask service that reads HDF5 files from a filesystem path (Linux mount, Windows drive, or UNC share) and serves APIs for:
- file browsing
- HDF5 tree navigation
- dataset metadata
- preview payloads
- bounded data windows
- streamed CSV export

The active implementation is filesystem-only. There is no bucket/object-storage dependency in runtime code.

## Runtime at a glance

- App entry: `backend/app.py`
- Default host/port: `0.0.0.0:5000`
- Route prefix for file APIs: `/files`
- Storage backend: `backend/src/storage/filesystem_client.py`
- HDF5 reader: `backend/src/readers/hdf5_reader.py`
- Route layer: `backend/src/routes/files.py`, `backend/src/routes/hdf5.py`
- Cache layer: `backend/src/utils/cache.py`

## How requests flow

1. Flask route validates query/path params.
2. Route checks in-memory cache (where applicable).
3. Route calls `HDF5Reader` or storage client.
4. Reader resolves dataset/object and performs bounded slicing.
5. Route returns JSON payload (or streaming CSV for export).

## Project structure

```text
backend/
  app.py                       # Flask app bootstrap and blueprint wiring
  wsgi.py                      # WSGI entrypoint for production servers
  .env.example                 # Environment template
  src/
    routes/
      files.py                 # /files list + cache refresh endpoints
      hdf5.py                  # children/meta/preview/data/export endpoints
    readers/
      hdf5_reader.py           # HDF5 traversal and data extraction
    storage/
      filesystem_client.py     # Filesystem storage abstraction
    utils/
      cache.py                 # Thread-safe TTL caches
  tests/
    test_files_routes.py       # File-route unit tests
    test_hdf5_routes.py        # HDF5 route unit tests
  scripts/
    benchmark.py               # Local benchmark helper
    verify_range_reads.py      # Range-read verification helper
    test_storage.py            # Storage client smoke checks
  docs/                        # Full backend documentation set
```

## Environment configuration

Set values in `backend/.env` (or exported environment variables).

Required (at least one path source must resolve):
- `STORAGE_ROOT` (explicit root; highest priority)
- or `STORAGE_PATH_LINUX` / `STORAGE_PATH_WINDOWS`

Path selection behavior in `FilesystemStorageClient`:
- If `STORAGE_ROOT` is set, it is used.
- On Windows (`os.name == "nt"`), fallback order is: `STORAGE_PATH_WINDOWS`, then `STORAGE_PATH_LINUX`.
- On Linux/macOS, fallback order is: `STORAGE_PATH_LINUX`, then `STORAGE_PATH_WINDOWS`.

Optional server settings:
- `HOST` (default `0.0.0.0`)
- `PORT` (default `5000`)
- `DEBUG` (`true`/`false`, default `false` in code)

## Run locally

From `backend/`:

```bash
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
python app.py
```

Production WSGI example:

```bash
gunicorn wsgi:app --bind 0.0.0.0:5000
```

## API overview

- `GET /`
  - Service info payload.
- `GET /health`
  - Health payload with UTC timestamp.
- `GET /files/`
  - File/folder listing with `prefix`, `include_folders`, `max_items`.
- `POST /files/refresh`
  - Clears file listing cache.
- `GET /files/<key>/children`
  - Children under HDF5 `path` (default `/`).
- `GET /files/<key>/meta`
  - Metadata for required `path`.
- `GET /files/<key>/preview`
  - Preview payload (`mode`, `detail`, dimensions, stats options).
- `GET /files/<key>/data`
  - Bounded matrix/heatmap/line windows with strict limits.
- `GET /files/<key>/export/csv`
  - Streaming CSV export for matrix/heatmap/line modes.

For full parameter contracts and edge-case rules, see `backend/docs/API_REFERENCE.md`.

## Caching

Global in-memory TTL caches in `src/utils/cache.py`:
- files cache: 30s, 200 entries
- hdf5 cache: 300s, 3000 entries
- dataset cache: 300s, 3000 entries
- data cache: 120s, 1200 entries

The `/data` route builds deterministic cache keys from normalized/sorted query args.

## Limits and safety controls

Main route-level limits in `src/routes/hdf5.py`:
- JSON element limits for `/data`
- matrix max rows/cols
- line exact/overview thresholds
- heatmap max size
- CSV export cell/point limits

Safety behaviors:
- object-key/prefix traversal checks in filesystem client
- CSV formula-injection escaping on export
- not-found style errors mapped to 404 where possible

## Tests

From `backend/`:

```bash
python -m unittest tests/test_files_routes.py tests/test_hdf5_routes.py
```

## Full docs

Start here for complete backend documentation:
- `backend/docs/README.md`

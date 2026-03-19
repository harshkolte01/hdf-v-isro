# Backend Quick Guide

## What this backend does

The backend loads HDF5 files from filesystem storage and exposes HTTP APIs for browsing and visual data access.

Main use cases:
- list HDF5 files under configured storage root
- navigate group/dataset tree
- fetch metadata and preview payloads
- fetch bounded matrix/heatmap/line data windows
- stream CSV exports without loading entire datasets in memory

## Technology

- Python 3
- Flask + Flask-CORS
- h5py + numpy
- python-dotenv

## Run in 3 steps

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Configure env in `backend/.env`:
- `PORT=5000`
- set storage path using `STORAGE_ROOT` or OS-specific variables

3. Start:

```bash
python app.py
```

## Core modules

- `app.py` - Flask bootstrap and blueprint registration
- `src/routes/files.py` - file listing/cache-refresh APIs
- `src/routes/hdf5.py` - HDF5 data APIs
- `src/readers/hdf5_reader.py` - HDF5 extraction logic
- `src/storage/filesystem_client.py` - filesystem access abstraction
- `src/utils/cache.py` - in-memory TTL caches

## Important implementation facts

- Filesystem-only backend (no bucket required).
- Route key supports nested folders (`/<path:key>`) and URL-decoded path separators.
- `/data` endpoint enforces hard limits before heavy read operations.
- `/export/csv` streams chunked output and escapes formula-like cells.

## Where to read next

- `backend/docs/BACKEND_IMPLEMENTATION.md`
- `backend/docs/API_REFERENCE.md`
- `backend/docs/CACHING_AND_LIMITS.md`

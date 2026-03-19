# Testing And Scripts

## Unit tests

Tests are in `backend/tests` and use:
- `unittest`
- Flask test client
- `unittest.mock` for reader/storage/cache patching

Run from `backend/`:

```bash
python -m unittest tests/test_files_routes.py tests/test_hdf5_routes.py
```

## What current tests cover

### `test_files_routes.py`

- `/files` response shape and file/folder counts
- `/files` validation for invalid `max_items`

### `test_hdf5_routes.py`

- `/data` line-mode quality behavior (`auto`, `exact`)
- exact-window rejection for oversized line requests
- heatmap max-size clamping and stats flags
- fixed-index normalization for negative indices
- not-found behavior (404) for data/meta/children
- URL-decoded key handling (`%2F`)
- preview detail and include_stats forwarding
- `/data` response cache reuse
- CSV export:
  - matrix chunking
  - line compare paths
  - formula-like value escaping
  - heatmap export behavior

## Local scripts

Scripts under `backend/scripts`:

- `benchmark.py`
  - endpoint timing helper

- `verify_range_reads.py`
  - checks correctness of storage range reads

- `test_storage.py`
  - storage-client smoke test helper

These scripts are for local verification and are not part of runtime request handling.

## Recommended validation after backend changes

1. Run unit tests.
2. Manually test one endpoint per category (`/files`, `/preview`, `/data`, `/export/csv`).
3. Verify limit behavior on edge requests (large windows / invalid params).
4. Verify storage root env configuration on target OS.

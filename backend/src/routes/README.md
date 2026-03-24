# backend/src/routes

HTTP layer for backend APIs. This folder translates request parameters into reader/storage calls and shapes response payloads.

## Files

- `files.py`
- `hdf5.py`

## `files.py`

Blueprint: `files_bp`

Endpoints:
- `GET /files/`
  - Lists filesystem objects using `FilesystemStorageClient.list_objects()`.
  - Query params:
    - `prefix` (default `""`)
    - `include_folders` (default `true`)
    - `max_items` (default `20000`, allowed `1..50000`)
  - Uses files cache (`get_files_cache`) with key shape: `files_list:{prefix}:{include_folders}:{max_items}`.
  - Returns both raw file rows and derived folder rows.

## `hdf5.py`

Blueprint: `hdf5_bp`

Endpoints:
- `GET /files/<key>/children`
- `GET /files/<key>/meta`
- `GET /files/<key>/preview`
- `GET /files/<key>/data`
- `GET /files/<key>/export/csv`

Key route responsibilities:
- URL key normalization (including `%2F` decoding for nested keys).
- Query validation and defaults.
- Selection normalization (`display_dims`, `fixed_indices`).
- Hard-limit checks before expensive reads.
- Deterministic cache key generation for `/preview` and `/data`.
- CSV streaming for large exports in bounded chunks.

## Cache usage by endpoint

- `/children` and `/meta`: hdf5 cache with file `etag` in key.
- `/preview`: hdf5 cache keyed by file + normalized request shape + cache version token.
- `/data`: dataset cache for shape/dtype and data cache for full response payload.
- `/export/csv`: dataset cache for metadata reuse; streamed output is not cached.

## Error handling model

- Validation errors: `400`
- Not-found style errors: `404` when message includes `not found`
- Unhandled server errors: `500` with generic client-safe message

## Important constants (in `hdf5.py`)

- `/data` guardrails: `MAX_JSON_ELEMENTS`, `MAX_MATRIX_ROWS`, `MAX_MATRIX_COLS`, `MAX_LINE_POINTS`, `MAX_LINE_EXACT_POINTS`, `MAX_HEATMAP_SIZE`
- export guardrails: `MAX_EXPORT_CSV_CELLS`, `MAX_EXPORT_LINE_POINTS`
- chunk defaults: `DEFAULT_EXPORT_MATRIX_CHUNK_ROWS`, `DEFAULT_EXPORT_MATRIX_CHUNK_COLS`, `DEFAULT_EXPORT_LINE_CHUNK_POINTS`

## Registered in

- `backend/app.py`
  - `app.register_blueprint(files_bp, url_prefix='/files')`
  - `app.register_blueprint(hdf5_bp, url_prefix='/files')`

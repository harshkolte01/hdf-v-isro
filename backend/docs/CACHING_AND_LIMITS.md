# Caching And Limits

This document explains how caching and hard limits work in the backend.

## 1) Cache implementation

File: `backend/src/utils/cache.py`

`SimpleCache`:
- in-memory only
- thread-safe with `Lock`
- TTL expiration per entry
- capacity guard with oldest-entry eviction

Cache key helper:
- `make_cache_key(*parts)` joins parts with `:`

## 2) Global caches and TTLs

- files cache
  - `default_ttl=30`
  - `max_entries=200`

- hdf5 cache
  - `default_ttl=300`
  - `max_entries=3000`

- dataset cache
  - `default_ttl=300`
  - `max_entries=3000`

- data cache
  - `default_ttl=120`
  - `max_entries=1200`

## 3) Where each cache is used

### `files` cache

Used by: `GET /files/`

Key pattern:
- `files_list:{prefix}:{include_folders}:{max_items}`

### `hdf5` cache

Used by:
- `GET /files/<key>/children`
- `GET /files/<key>/meta`
- `GET /files/<key>/preview`

Children/meta key shape includes file `etag` from storage metadata.

Preview key shape includes:
- key, path
- selection args
- preview options (`mode`, `detail`, stats flag)
- `cache_version` (derived from `etag` query param or `ttl`)

### `dataset` cache

Used by:
- `/data`
- `/export/csv`

Purpose:
- avoid repeated shape/dtype reads for same dataset.

### `data` cache

Used by:
- `/data`

Key behavior:
- request query args are serialized in sorted order
- unsupported query keys are excluded
- `etag` is excluded from argument serialization and used separately as cache-version token

## 4) Why deterministic query serialization matters

Without deterministic ordering, these two URLs could create different keys even though they are logically the same:

- `?path=/a&mode=line&line_limit=100`
- `?mode=line&line_limit=100&path=/a`

The backend prevents that by sorting query names/values before building cache key strings.

## 5) Route-level limits (`src/routes/hdf5.py`)

These limits protect memory, latency, and JSON payload size.

- `MAX_JSON_ELEMENTS = 500_000`
- `MAX_ELEMENTS = 1_000_000`
- `MAX_MATRIX_ROWS = 2000`
- `MAX_MATRIX_COLS = 2000`
- `MAX_LINE_POINTS = 5000`
- `MAX_LINE_EXACT_POINTS = 20000`
- `MAX_HEATMAP_SIZE = 1024`
- `MAX_EXPORT_CSV_CELLS = 10_000_000`
- `MAX_EXPORT_LINE_POINTS = 5_000_000`

## 6) Mode-specific enforcement

### Matrix (`/data?mode=matrix`)

- `row_limit`/`col_limit` are clamped to dataset bounds
- route rejects limits over matrix caps
- element count after stepping must pass JSON-element checks

### Heatmap (`/data?mode=heatmap`)

- requested `max_size` must be <= `MAX_HEATMAP_SIZE`
- backend computes safe effective size (binary search) so projected cells fit JSON limits

### Line (`/data?mode=line`)

- `quality=exact` fails if requested window > `MAX_LINE_EXACT_POINTS`
- `quality=overview` applies step-based downsampling
- `quality=auto` chooses exact/overview based on window size

### CSV export (`/export/csv`)

- matrix/heatmap export checks `row_limit * col_limit <= MAX_EXPORT_CSV_CELLS`
- line export checks `line_limit <= MAX_EXPORT_LINE_POINTS`
- export is streamed in chunks to keep memory bounded

## 7) Cache invalidation behavior

- TTL-based expiration for all caches.
- files cache can be manually cleared via `POST /files/refresh`.
- children/meta entries are naturally invalidated by file `etag` changes in key.
- preview/data caches can be logically versioned by client-provided `etag` query token.

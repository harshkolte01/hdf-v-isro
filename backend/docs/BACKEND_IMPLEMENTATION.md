# Backend Implementation Walkthrough

This document explains how the backend is implemented today, in easy language, with direct mapping to source files.

## 1. App bootstrap (`backend/app.py`)

What happens on startup:
- `.env` is loaded with `load_dotenv()`.
- logging level is derived from `DEBUG`.
- Flask app is created with `strict_slashes = False`.
- CORS is enabled for all origins.
- blueprints are registered:
  - `files_bp` at `/files`
  - `hdf5_bp` at `/files`

Available top-level routes:
- `GET /` returns service info JSON.
- `GET /health` returns service health and UTC timestamp.

## 2. Storage backend (`backend/src/storage/filesystem_client.py`)

`FilesystemStorageClient` is the only active storage implementation.

### Root path selection

`_resolve_storage_root()` chooses a root path using:
1. `STORAGE_ROOT` (if set)
2. otherwise OS-aware fallback:
   - Windows: `STORAGE_PATH_WINDOWS`, then `STORAGE_PATH_LINUX`
   - Linux/macOS: `STORAGE_PATH_LINUX`, then `STORAGE_PATH_WINDOWS`

### Path safety

Before any file access:
- key/prefix are normalized (`\\` -> `/`, remove leading `/`, reject `..`)
- resolved absolute path must stay under storage root (`relative_to` check)

This protects against traversal attacks and accidental root escape.

### Operations used by the backend

- `list_objects(...)` recursively walks files and can derive folder rows.
- `get_object_metadata(key)` returns `etag`, size, timestamps.
- `open_object_stream(key)` gives a binary stream for `h5py.File`.
- `get_object_range(key, start, end)` supports range reads (used by helper scripts/tests).

## 3. Route layer

### 3.1 File routes (`backend/src/routes/files.py`)

`GET /files/`
- validates:
  - `include_folders` as bool
  - `max_items` in `[1, 50000]`
- checks files cache first
- on miss, calls `storage.list_objects(...)`
- response includes:
  - `files` (mixed file + optional folder entries)
  - `files_count`, `folders_count`, `truncated`, `cached`

`POST /files/refresh`
- clears files cache

### 3.2 HDF5 routes (`backend/src/routes/hdf5.py`)

Shared helper concepts:
- normalize route key (`_normalize_object_key`) to support encoded separators
- parse and validate params (`_parse_*` helpers)
- selection normalization (`_normalize_selection`):
  - choose visible dims (`display_dims`)
  - fill/fix non-visible dims (`fixed_indices`)
- map not-found errors to HTTP 404 when possible

#### `/children`
- checks storage metadata to get file `etag`
- uses hdf5 cache key: `children:key:etag:path`
- on miss, calls `reader.get_children(...)`

#### `/meta`
- requires `path`
- uses hdf5 cache key: `meta:key:etag:path`
- on miss, calls `reader.get_metadata(...)`

#### `/preview`
- requires `path`
- supports:
  - `mode=auto|line|table|heatmap`
  - `detail=fast|full`
  - `include_stats`
  - `display_dims`, `fixed_indices`
  - `max_size`
  - `etag` (cache version hint)
- cache key includes normalized request shape + `cache_version`
- on miss, forwards options to `reader.get_preview(...)`

#### `/data`
- requires `path` and `mode`
- `mode=matrix|heatmap|line`
- builds deterministic cache key from sorted query args (excluding unsupported keys)
- gets dataset shape/dtype/ndim through dataset cache
- enforces limits before read

Mode behavior:
- `matrix`
  - window params: `row_offset`, `row_limit`, `col_offset`, `col_limit`, `row_step`, `col_step`
  - hard caps: `MAX_MATRIX_ROWS`, `MAX_MATRIX_COLS`
- `heatmap`
  - params: `max_size`, `include_stats`
  - clamps requested size to keep element count safe
- `line`
  - params: `line_dim`, `line_index`, `line_offset`, `line_limit`, `quality`, `max_points`
  - quality policy:
    - `exact` for small windows
    - `overview` for downsampled large windows
    - `auto` chooses between them based on window size

#### `/export/csv`
- requires `path` and `mode`
- supports matrix/heatmap/line streaming
- response is streamed (`stream_with_context`) with UTF-8 BOM
- CSV cells are escaped, including formula-like values (`= + - @`) to reduce spreadsheet injection risk

Matrix/heatmap export:
- optional windowing (`row_offset`, `row_limit`, `col_offset`, `col_limit`)
- chunked reads using `chunk_rows`, `chunk_cols`
- fails if cell count exceeds `MAX_EXPORT_CSV_CELLS`

Line export:
- optional `line_*` controls and `chunk_points`
- optional `compare_paths` (up to 4)
- compare datasets must match base shape and be numeric
- fails if point count exceeds `MAX_EXPORT_LINE_POINTS`

## 4. Reader layer (`backend/src/readers/hdf5_reader.py`)

`HDF5Reader` performs all HDF5 object access and slicing.

### Dataset info
- `get_dataset_info` reads shape/ndim/dtype without full dataset load.

### Preview generation
- `get_preview` builds a payload with:
  - `table` preview
  - `plot` preview (line/heatmap style)
  - optional `profile`
  - stats (if enabled and numeric)
- handles 1D, 2D, and N-D datasets.
- for N-D, non-displayed dimensions are fixed to index values.

### Data extraction
- `get_matrix`: returns bounded 2D windows with step-based downsampling.
- `get_heatmap`: returns downsampled 2D planes and optional min/max stats.
- `get_line`: returns 1D profiles using either explicit dimension or row/column semantics.

### Metadata and tree
- `get_children`: immediate children with summary metadata.
- `get_metadata`: detailed metadata (shape, dtype, type info, filters, chunks, attributes).

### Sanitization
All payloads are converted to JSON-safe forms:
- bytes -> string
- complex -> string
- NumPy scalars/arrays -> native Python
- non-finite floats (`NaN`/`Inf`) -> `None`

## 5. Cache layer (`backend/src/utils/cache.py`)

`SimpleCache` is a lock-protected in-memory TTL cache.

- read path drops expired entries
- write path updates recency and evicts oldest when full
- global caches are shared by route modules

Cache types:
- files cache
- hdf5 metadata/preview cache
- dataset info cache
- data response cache

## 6. Tests (`backend/tests/*.py`)

Tests use Flask test client + mocks.

Covered behaviors include:
- `/files` validation and folder counting
- `/data` line/heatmap limits and quality behavior
- preview/detail forwarding
- not-found -> 404 behavior
- response cache reuse
- CSV export windowing and compare paths
- CSV formula-like escaping

## 7. Notes for maintainers

- `backend/templates/index.html` exists but is not currently served by `GET /`.
- If endpoint contracts change, update:
  - `backend/README.md`
  - `backend/src/*/README.md`
  - `backend/docs/API_REFERENCE.md`

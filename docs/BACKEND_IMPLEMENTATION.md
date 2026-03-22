# Backend Implementation Documentation

## 1. Purpose of the backend

The backend in this repository is a Flask-based API service that exposes HDF5 files stored on a local filesystem or mounted network path. Its job is to:

- discover HDF5 files under a configured storage root
- expose file listings to the frontend
- open HDF5 files on demand
- browse HDF5 groups and datasets
- return dataset metadata
- generate lightweight previews
- return bounded data windows for matrix, heatmap, and line views
- stream CSV exports for larger slices

This backend is intentionally filesystem-based. There is no active S3, bucket, blob, or database-backed runtime implementation in the current code.

## 2. Backend directory structure

```text
backend/
  app.py                          # Flask bootstrap, logging, CORS, blueprint registration
  wsgi.py                         # Production WSGI entrypoint
  requirements.txt                # Python dependencies
  .env.example                    # Example runtime configuration
  h5create.py                     # Utility to generate sample HDF5 files
  templates/
    index.html                    # Dashboard template asset (currently not wired to app.py)
  src/
    routes/
      files.py                    # File listing and cache refresh routes
      hdf5.py                     # HDF5 children, metadata, preview, data, and CSV export routes
    readers/
      hdf5_reader.py              # HDF5 access and slicing logic
    storage/
      filesystem_client.py        # Filesystem abstraction used by routes and reader
    utils/
      cache.py                    # In-memory TTL caches
  scripts/
    benchmark.py                  # Storage performance benchmark helper
    test_storage.py               # Storage smoke test helper
    verify_range_reads.py         # Range-read verification helper
  tests/
    test_files_routes.py          # Unit tests for file routes
    test_hdf5_routes.py           # Unit tests for HDF5 routes
```

## 3. High-level architecture

At runtime, the backend is organized in four layers:

1. App bootstrap layer
   - `backend/app.py`
   - creates the Flask app, loads environment variables, configures logging and CORS, and registers route blueprints

2. Route layer
   - `backend/src/routes/files.py`
   - `backend/src/routes/hdf5.py`
   - validates HTTP inputs, uses cache, decides which reader/storage method to call, and shapes the HTTP response

3. Reader layer
   - `backend/src/readers/hdf5_reader.py`
   - opens HDF5 files through the storage client and performs all HDF5 traversal, metadata extraction, and slicing

4. Storage and utility layer
   - `backend/src/storage/filesystem_client.py`
   - `backend/src/utils/cache.py`
   - resolves filesystem paths safely and provides process-local caching

The common request flow is:

```text
HTTP request
  -> Flask route
  -> parameter parsing and validation
  -> cache lookup where applicable
  -> filesystem metadata lookup or HDF5 reader call
  -> reader opens HDF5 file from filesystem
  -> data/metadata is sanitized to JSON-safe Python values
  -> JSON or streamed CSV response
```

## 4. File-by-file responsibility map

| File | Role | Used by |
| --- | --- | --- |
| `backend/app.py` | Main Flask application bootstrap | Entry script, `wsgi.py` |
| `backend/wsgi.py` | Imports and exposes `app` for WSGI servers | Production server process |
| `backend/src/routes/files.py` | `/files/` listing and `/files/refresh` | Registered in `app.py` |
| `backend/src/routes/hdf5.py` | `/children`, `/meta`, `/preview`, `/data`, `/export/csv` | Registered in `app.py` |
| `backend/src/readers/hdf5_reader.py` | Opens HDF5 files, reads groups/datasets, slices arrays | Called by `hdf5.py` |
| `backend/src/storage/filesystem_client.py` | Resolves keys to filesystem paths, lists files, opens streams | Called by `files.py`, `hdf5.py`, `hdf5_reader.py` |
| `backend/src/utils/cache.py` | TTL caches and cache-key helper | Called by `files.py`, `hdf5.py` |
| `backend/tests/test_files_routes.py` | Verifies file route behavior | Developer test run |
| `backend/tests/test_hdf5_routes.py` | Verifies HDF5 route validation/caching/export behavior | Developer test run |
| `backend/scripts/test_storage.py` | Manual storage smoke test | Developer utility |
| `backend/scripts/verify_range_reads.py` | Validates byte-range reads | Developer utility |
| `backend/scripts/benchmark.py` | Benchmarks storage operations | Developer utility |
| `backend/h5create.py` | Generates synthetic HDF5 fixtures | Developer utility |
| `backend/templates/index.html` | Dashboard UI template asset | Not currently used by `app.py` |

## 5. Backend app implementation

### 5.1 `backend/app.py`

This is the real runtime entrypoint during local development.

It does the following in order:

1. imports Python stdlib and Flask modules
2. calls `load_dotenv()` so values from `.env` become available in `os.getenv`
3. configures application-wide logging
4. creates the Flask app
5. disables strict trailing-slash handling with `app.url_map.strict_slashes = False`
6. enables CORS for all routes
7. defines the root `/` endpoint
8. defines the `/health` endpoint
9. imports and registers two blueprints:
   - `files_bp` from `src.routes.files`
   - `hdf5_bp` from `src.routes.hdf5`
10. runs `app.run(...)` when executed directly

### 5.2 Logging behavior

`app.py` sets:

- `DEBUG` env var controls log level
- `DEBUG=true` gives `logging.DEBUG`
- any other value gives `logging.INFO`

The format includes timestamp, logger name, level, and message. This becomes the default logging setup used by route, reader, and storage modules.

### 5.3 CORS behavior

`app.py` uses `flask_cors.CORS` with:

- `origins="*"`
- methods `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`
- headers `Content-Type`, `Authorization`

This is a development-friendly open configuration. It is not restricted to a specific frontend origin.

### 5.4 Root and health routes

`GET /`

- returns a small JSON payload
- acts as a service info endpoint
- currently reports the service name, status, health route, and files route

`GET /health`

- logs the request
- returns a health payload with:
  - `status`
  - UTC `timestamp`
  - `service`

### 5.5 Blueprint mounting

Both blueprints are mounted under `/files`:

- `files_bp` handles file listing and refresh
- `hdf5_bp` handles HDF5 navigation and data access

That means the effective routes are:

- `/files/`
- `/files/refresh`
- `/files/<key>/children`
- `/files/<key>/meta`
- `/files/<key>/preview`
- `/files/<key>/data`
- `/files/<key>/export/csv`

### 5.6 `backend/wsgi.py`

This file only contains:

- `from app import app`

It exists so a production WSGI server like Gunicorn can import the Flask app object without executing development-only logic manually.

## 6. Backend storage implementation

### 6.1 `backend/src/storage/filesystem_client.py`

This module provides the filesystem abstraction used everywhere else. The rest of the backend does not touch raw paths directly. It goes through `FilesystemStorageClient`.

### 6.2 Main class: `FilesystemStorageClient`

Responsibilities:

- resolve the configured storage root from environment variables
- normalize prefixes and object keys
- prevent directory traversal
- list files under the root
- return object metadata
- open file streams
- support range reads

### 6.3 Storage root resolution

Method: `_resolve_storage_root()`

Priority order:

1. `STORAGE_ROOT`
2. OS-aware fallback:
   - on Windows: `STORAGE_PATH_WINDOWS`, then `STORAGE_PATH_LINUX`
   - on Linux/macOS: `STORAGE_PATH_LINUX`, then `STORAGE_PATH_WINDOWS`

If none of these exist, initialization raises:

- `ValueError("Missing storage configuration...")`

This keeps the rest of the application from running without a valid file root.

### 6.4 Key and prefix normalization

Methods:

- `_normalize_prefix(prefix)`
- `_normalize_object_key(key)`

Behavior:

- trims whitespace
- converts backslashes to `/`
- strips leading `/`
- removes `.` segments
- rejects `..` segments

This is one of the main security barriers against traversal outside the configured root.

### 6.5 Root boundary enforcement

Method: `_ensure_within_root(root, path)`

It verifies that the resolved path remains inside `storage_root` by calling `path.relative_to(root)`. If the file escapes the root, it raises `ValueError`.

This protects against:

- malicious keys with traversal attempts
- symlink or path manipulation that would leave the configured storage area

### 6.6 File listing

Method: `list_objects(prefix="", include_folders=False, max_items=None)`

Behavior:

- recursively walks the filesystem using `os.walk`
- converts each discovered file into a response row containing:
  - `key`
  - `size`
  - `last_modified`
  - `etag`
  - `type="file"`
  - `is_folder=False`
- can optionally add synthetic folder rows
- stops early once `max_items` file rows are collected

Important implementation detail:

- `max_items` is enforced against file rows during the walk
- folder rows are added afterward if `include_folders=True`
- so `count` can be larger than `max_items` when synthetic folders are included

### 6.7 Synthetic folder generation

Method: `_derive_parent_folders(key, normalized_prefix)`

Folder rows are virtual. They are not created by scanning only directories. Instead, they are inferred from each file path. This allows the frontend to build a folder tree without a dedicated directory API.

Folder rows include:

- `key` ending with `/`
- `size=0`
- `last_modified=None`
- `etag=None`
- `type="folder"`
- `is_folder=True`

### 6.8 ETag generation

Method: `_build_etag(stat_result)`

ETag format:

- hex-encoded `mtime_ns`
- dash
- hex-encoded file size

This creates a lightweight cache fingerprint that changes when file size or nanosecond-precision modification time changes.

### 6.9 Metadata lookup

Method: `get_object_metadata(key)`

Returns:

- normalized key
- file size
- last modified ISO timestamp in UTC
- synthetic etag
- content type from `mimetypes.guess_type`

This method is used by HDF5 routes to build cache keys that auto-invalidates when the file changes.

### 6.10 Opening file streams

Method: `open_object_stream(key)`

Behavior:

- resolves the object path
- opens the file in binary mode
- returns a stream handle

The HDF5 reader uses this method before wrapping the stream with `h5py.File`.

### 6.11 Range reads

Method: `get_object_range(key, start, end)`

Behavior:

- validates the range
- seeks to `start`
- reads `end - start + 1` bytes

This helper is not used by the current route handlers, but it is supported and verified by the developer scripts.

### 6.12 Singleton accessor

Function: `get_storage_client()`

The module keeps a single global `_storage_client`. This avoids rebuilding the client repeatedly.

## 7. Backend utility implementation

### 7.1 `backend/src/utils/cache.py`

This module provides in-memory TTL caches for file lists, HDF5 metadata, dataset info, and `/data` responses.

### 7.2 `SimpleCache`

Design:

- uses `OrderedDict` to preserve access order
- uses `Lock` for thread safety
- stores:
  - `value`
  - `expires_at`
  - `created_at`

Main methods:

- `get(key)`
- `set(key, value, ttl=None)`
- `delete(key)`
- `clear()`
- `clear_pattern(pattern)`
- `stats()`

### 7.3 Cache behavior

`get(key)`:

- returns `None` if key is missing
- deletes and returns `None` if the entry is expired
- moves the key to the end on hit

`set(key, value, ttl=None)`:

- assigns expiry time
- refreshes existing entry order
- evicts least-recently-used items from the front if `max_entries` is exceeded

This means the cache is:

- TTL based
- access-order aware
- bounded in size

### 7.4 Global cache instances

The module creates four singleton caches:

- files cache
  - TTL: 30 seconds
  - max entries: 200

- hdf5 cache
  - TTL: 300 seconds
  - max entries: 3000

- dataset cache
  - TTL: 300 seconds
  - max entries: 3000

- data cache
  - TTL: 120 seconds
  - max entries: 1200

These are accessed through:

- `get_files_cache()`
- `get_hdf5_cache()`
- `get_dataset_cache()`
- `get_data_cache()`

### 7.5 Cache key helper

Function: `make_cache_key(*parts)`

Behavior:

- stringifies each part
- joins them with `:`

The routes use this to build consistent keys across file listings, metadata, preview payloads, dataset info, and data windows.

## 8. Backend routes implementation

### 8.1 `backend/src/routes/files.py`

This file defines the `files_bp` blueprint and contains the HTTP layer for filesystem listing.

#### 8.1.1 Helper parsers

`_parse_bool_param(name, default)`

- accepts `1`, `true`, `yes`, `on`
- accepts `0`, `false`, `no`, `off`
- raises `ValueError` for invalid values

`_parse_int_param(name, default, min_value, max_value)`

- reads an integer from `request.args`
- validates numeric conversion
- validates min/max range
- raises `ValueError` on failure

`_error_payload(status_code, message)`

- standardizes the error response shape:
  - `success=False`
  - `error=<message>`

#### 8.1.2 `GET /files/`

Function: `list_files()`

Responsibilities:

- reads:
  - `prefix`
  - `include_folders`
  - `max_items`
- checks the files cache
- on miss, calls `storage.list_objects(...)`
- counts file rows and folder rows
- computes `truncated`
- returns the list payload

Cache key format:

```text
files_list:{prefix}:{include_folders}:{max_items}
```

Response fields:

- `success`
- `count`
- `files`
- `files_count`
- `folders_count`
- `truncated`
- `prefix`
- `include_folders`
- `max_items`
- `cached`

Important implementation detail:

- `truncated` is based on file count reaching `max_items`
- folder rows are synthetic and do not change the truncation calculation

#### 8.1.3 `POST /files/refresh`

Function: `refresh_files()`

Responsibilities:

- clears the entire files cache
- does not rescan files immediately
- makes the next `GET /files/` request re-read from disk

### 8.2 `backend/src/routes/hdf5.py`

This is the main API layer for HDF5 access. It contains:

- constants for request limits
- request parsing helpers
- cache key helpers
- five HDF5 endpoints

#### 8.2.1 Route-level guardrail constants

The route file enforces request limits before expensive reads happen.

Main constants:

- `MAX_ELEMENTS = 1_000_000`
- `MAX_JSON_ELEMENTS = 500_000`
- `MAX_MATRIX_ROWS = 2000`
- `MAX_MATRIX_COLS = 2000`
- `MAX_LINE_POINTS = 5000`
- `MAX_LINE_EXACT_POINTS = 20000`
- `MAX_HEATMAP_SIZE = 1024`
- `MAX_EXPORT_CSV_CELLS = 10_000_000`
- `MAX_EXPORT_LINE_POINTS = 5_000_000`

Defaults:

- matrix default `row_limit=100`
- matrix default `col_limit=100`
- heatmap default `max_size=512`
- line default quality `auto`
- preview default detail `full`

These route-level limits complement the reader-level preview limits.

#### 8.2.2 Core helper functions

Important helpers and what they do:

- `_normalize_object_key(raw_key)`
  - decodes `%2F`-style path separators
  - normalizes route keys before storage/reader calls

- `_parse_display_dims(param, ndim)`
  - parses the two visible dimensions for N-D datasets
  - supports negative indices
  - requires two distinct valid dimensions

- `_parse_fixed_indices(param, ndim)`
  - parses fixed indices for non-displayed dimensions
  - supports both `dim=idx` and `dim:idx`

- `_fill_fixed_indices(...)`
  - fills any missing non-display dimensions with midpoint indices

- `_normalize_selection(shape, display_dims_param, fixed_indices_param)`
  - combines the previous helpers
  - removes conflicts between `display_dims` and `fixed_indices`
  - normalizes negative indices
  - returns a stable selection object for reader calls

- `_compute_safe_heatmap_size(rows, cols, requested_size)`
  - reduces requested heatmap size when the output would exceed JSON element limits
  - uses binary search to find the largest safe value

- `_enforce_element_limits(count)`
  - blocks oversized JSON payloads before reader calls

- `_resolve_cache_version_tag()`
  - reads optional `etag` query param
  - defaults to `ttl`
  - lets clients opt into stronger cache versioning

- `_serialize_request_args(exclude_keys=None)`
  - sorts query args and values
  - produces deterministic cache-key fragments

- `_get_cached_dataset_info(reader, key, hdf_path, cache_version)`
  - caches `shape`, `ndim`, and `dtype` for datasets
  - avoids re-opening the same dataset repeatedly just to validate requests

- `_csv_escape(value)`
  - prevents formula injection in spreadsheet software
  - prefixes values beginning with `=`, `+`, `-`, `@` with `'`
  - also quotes values containing commas, quotes, or newlines

- `_build_export_filename(key, path, mode)`
  - creates a filesystem-safe download filename

- `_parse_compare_paths(param, base_path)`
  - parses comma-separated comparison dataset paths for line CSV export
  - removes duplicates and excludes the base path

#### 8.2.3 `GET /files/<key>/children`

Function: `get_children(key)`

Flow:

1. normalize the route key
2. read `path` query param, default `/`
3. get file metadata from storage to obtain file `etag`
4. build cache key: `children:<key>:<etag>:<path>`
5. check HDF5 cache
6. on miss, call `reader.get_children(key, path)`
7. cache and return the result

Important detail:

- this route uses file metadata first so the cache auto-invalidates when the file changes on disk

#### 8.2.4 `GET /files/<key>/meta`

Function: `get_metadata(key)`

Flow:

1. normalize key
2. require query param `path`
3. get file `etag` from storage metadata
4. build cache key: `meta:<key>:<etag>:<path>`
5. check HDF5 cache
6. on miss, call `reader.get_metadata(key, path)`
7. cache and return metadata

#### 8.2.5 `GET /files/<key>/preview`

Function: `get_preview(key)`

Purpose:

- return a lightweight preview payload that helps the frontend decide how to display a dataset

Accepted query parameters:

- `path` required
- `mode` optional: `auto`, `line`, `table`, `heatmap`
- `detail` optional: `fast`, `full`
- `include_stats` optional bool
- `display_dims` optional
- `fixed_indices` optional
- `max_size` optional positive integer
- `etag` optional cache version token

Flow:

1. normalize key
2. validate required `path`
3. parse preview options
4. create a deterministic preview cache key from:
   - file key
   - cache version
   - HDF5 path
   - display dims
   - fixed indices
   - max size
   - mode
   - detail
   - stats on/off
5. check HDF5 cache
6. on miss, call `reader.get_preview(...)`
7. return payload with:
   - `success`
   - `cached`
   - `cache_version`
   - preview data from reader

Important detail:

- unlike `/children` and `/meta`, preview does not use filesystem metadata `etag` automatically
- it uses the optional request `etag` token or falls back to `ttl`
- this is deliberate route behavior in the current code

#### 8.2.6 `GET /files/<key>/data`

Function: `get_data(key)`

Purpose:

- return the actual data payload for one of three access modes:
  - `matrix`
  - `heatmap`
  - `line`

This route is where most request validation happens.

Accepted query parameters depend on mode, but the route recognizes:

- `path`
- `mode`
- `display_dims`
- `fixed_indices`
- `row_offset`
- `col_offset`
- `row_limit`
- `col_limit`
- `row_step`
- `col_step`
- `max_size`
- `include_stats`
- `line_dim`
- `quality`
- `line_index`
- `line_offset`
- `line_limit`
- `max_points`
- `etag`

##### Data route cache behavior

The route:

1. computes `cache_version` from request `etag` or `ttl`
2. serializes supported query params in sorted order
3. builds a cache key:

```text
data:<key>:<cache_version>:<normalized_query_string>
```

4. checks `data_cache`
5. on miss, reads dataset info from `dataset_cache` or `reader.get_dataset_info`

This avoids reopening the dataset just to validate shape and dimensionality on repeated requests.

##### Matrix mode

Parameters:

- `row_offset`, default `0`
- `col_offset`, default `0`
- `row_limit`, default `100`
- `col_limit`, default `100`
- `row_step`, default `1`
- `col_step`, default `1`

Validation:

- dataset must be at least 2D
- selected `row_limit` and `col_limit` are clamped to available size
- limits cannot exceed `MAX_MATRIX_ROWS x MAX_MATRIX_COLS`
- final output element count must pass `_enforce_element_limits`

Reader call:

- `reader.get_matrix(...)`

Response includes:

- sliced `data`
- returned `shape`
- `source_shape`
- `source_ndim`
- `display_dims`
- `fixed_indices`
- `row_offset`
- `col_offset`
- `downsample_info`

##### Heatmap mode

Parameters:

- `max_size`, default `512`
- `include_stats`, default `true`

Validation:

- dataset must be at least 2D
- requested `max_size` cannot exceed route constant `1024`
- route computes `effective_max_size` using `_compute_safe_heatmap_size(...)`
- output cells must pass JSON element limits

Reader call:

- `reader.get_heatmap(...)`

Response includes:

- `data`
- `shape`
- `stats`
- `downsample_info`
- `sampled`
- `requested_max_size`
- `effective_max_size`
- `max_size_clamped`

This route logic is why a request can ask for `1024` but still receive a smaller safe heatmap size.

##### Line mode

Parameters:

- `line_dim`
- `quality`: `auto`, `overview`, `exact`
- `line_index`
- `line_offset`
- `line_limit`
- `max_points`

Behavior:

- 1D datasets use their only axis
- for N-D datasets, the line can be:
  - along a specific dimension number
  - a row profile
  - a column profile
- if the caller chooses a dimension number, other dimensions are fixed to midpoint indices unless already supplied

Quality handling:

- `exact`
  - returns exact data
  - rejects requests larger than `MAX_LINE_EXACT_POINTS`

- `overview`
  - always computes a stride to keep the response within `max_points`

- `auto`
  - exact when request is small enough
  - overview when request is large

Reader call:

- `reader.get_line(...)`

Response includes:

- `axis`
- `index`
- `quality_requested`
- `quality_applied`
- `line_offset`
- `line_limit`
- `requested_points`
- `returned_points`
- `line_step`
- `downsample_info`

#### 8.2.7 `GET /files/<key>/export/csv`

Function: `export_csv(key)`

Purpose:

- stream CSV output for:
  - matrix window export
  - heatmap-mode full slice export
  - line export

Important implementation design:

- streamed response, not a single huge in-memory string
- `Cache-Control: no-store`
- `X-Accel-Buffering: no`
- `Content-Disposition` filename generated from key/path/mode

##### Matrix and heatmap CSV export

Shared behavior:

- require a 2D or higher dataset
- read `row_offset`, `col_offset`, `row_limit`, `col_limit`
- validate non-empty export window
- reject if cell count exceeds `MAX_EXPORT_CSV_CELLS`
- chunk work by:
  - `chunk_rows`
  - `chunk_cols`

Implementation detail:

- even `mode=heatmap` export uses `reader.get_matrix(...)`
- it exports the selected full slice window, not the downsampled heatmap payload

Streaming logic:

1. emit UTF-8 BOM for Excel compatibility
2. emit `row\col` header row
3. iterate row chunks
4. iterate column chunks inside each row chunk
5. call `reader.get_matrix(...)` per chunk
6. accumulate row buffers
7. yield sanitized CSV rows

##### Line CSV export

Behavior:

- validates numeric dataset dtype
- resolves line geometry similarly to `/data`
- validates non-empty export window
- rejects if point count exceeds `MAX_EXPORT_LINE_POINTS`
- supports up to 4 `compare_paths`

Comparison handling:

- each compare dataset must have the same shape as the base dataset
- each compare dataset must be numeric
- compare labels are the tail segment of the HDF5 path

Streaming logic:

1. emit UTF-8 BOM
2. emit header: `index,base,<compare1>,<compare2>...`
3. iterate in `chunk_points` windows
4. call `reader.get_line(...)` for base and each compare dataset
5. yield one CSV row per point

#### 8.2.8 Error handling strategy in `hdf5.py`

The route layer maps errors like this:

- `ValueError`
  - `404` if the message contains `not found`
  - otherwise `400`

- `TypeError`
  - `400`

- unexpected exception
  - usually `500`
  - response body is sanitized with `_client_error_message(...)` so internal details are not leaked for server-side failures

This means not-found detection is currently string-based, not exception-class-based.

## 9. Backend reader implementation

### 9.1 `backend/src/readers/hdf5_reader.py`

This file contains the actual HDF5 logic. The route layer does not read HDF5 objects directly.

### 9.2 Main class: `HDF5Reader`

Construction:

- `__init__()` calls `get_storage_client()`
- keeps the filesystem client on `self.storage`

Singleton:

- global `_hdf5_reader`
- accessor `get_hdf5_reader()`

### 9.3 Reader-level constants

These constants control preview and stats behavior inside the reader:

- `MAX_PREVIEW_ELEMENTS = 250_000`
- `MAX_HEATMAP_SIZE = 512`
- `MAX_HEATMAP_ELEMENTS = 200_000`
- `MAX_LINE_POINTS = 5000`
- `MIN_LINE_POINTS = 2000`
- `TABLE_1D_MAX = 1000`
- `TABLE_2D_MAX = 200`
- `MAX_STATS_SAMPLE = 100_000`

These are separate from the route-level limits. The route layer focuses on HTTP request safety, while the reader layer focuses on preview generation and sampling.

### 9.4 Dataset info lookup

Method: `get_dataset_info(key, path)`

Purpose:

- return lightweight dataset metadata without reading the full array

Returns:

- `shape`
- `ndim`
- `dtype`

This method is heavily used by the `/data` and `/export/csv` routes for validation before slicing.

### 9.5 Dimension label extraction

The reader contains a dedicated label-resolution pipeline:

- `_coerce_dimension_label(...)`
- `_get_attribute_dimension_labels(dataset)`
- `_get_dimension_scale_label(dataset, dim)`
- `_get_dimension_labels(dataset)`

Label priority:

1. `dataset.dims[dim].label`
2. `DIMENSION_LABELS` attribute
3. first attached dimension scale name

This is why preview responses can include `dimension_labels`.

### 9.6 Preview axis normalization

Method: `normalize_preview_axes(shape, display_dims_param, fixed_indices_param)`

Purpose:

- convert raw query strings into stable selection inputs for preview generation

Behavior:

- determines the two visible dimensions
- parses fixed indices
- removes fixed indices that conflict with visible dims
- fills missing non-visible dims with midpoint defaults
- clamps indices to valid bounds

### 9.7 `get_preview(...)`

This method builds the preview payload returned by the `/preview` route.

Common steps:

1. open the file using `self.storage.open_object_stream(key)`
2. wrap it in `h5py.File(..., "r")`
3. resolve the target HDF5 path
4. require the object to be a dataset
5. inspect shape, ndim, dtype, numeric status, and dimension labels
6. optionally compute statistics
7. build preview structures based on dimensionality and requested mode/detail

Preview payload always contains:

- `key`
- `path`
- `dtype`
- `shape`
- `ndim`
- `dimension_labels`
- `preview_type`
- `mode`
- `detail`
- `display_dims`
- `fixed_indices`
- `stats`
- `table`
- `plot`
- `profile`
- `limits`

#### 1D preview behavior

Handled by `_preview_1d(...)`.

Table behavior:

- returns up to `TABLE_1D_MAX` elements
- includes `kind`, `values`, `count`, `start`, `step`

Plot behavior:

- if dtype is numeric:
  - exact read for small datasets
  - strided downsample for large datasets
- if dtype is non-numeric:
  - returns `supported=False`

#### 2D and N-D preview behavior

Handled by `_preview_2d(...)` after axis normalization.

Generated structures:

- `table`
  - top-left bounded 2D slice
- `plot`
  - heatmap-style preview
- `profile`
  - a center-row line profile

Fast-detail behavior:

- if `detail=fast` and a specific mode is requested, the reader skips building unused preview payloads
- this reduces unnecessary work

### 9.8 `get_matrix(...)`

Purpose:

- return a bounded 2D slice for the `/data` route and CSV export

Behavior:

- requires a dataset with `ndim >= 2`
- resolves `row_dim` and `col_dim`
- clamps offsets and limits to legal bounds
- builds row/column slices
- creates a full N-D indexer through `_build_indexer(...)`
- reads the HDF5 slice
- transposes data when `row_dim > col_dim` so the returned orientation matches the requested display order
- sanitizes the output

Returns:

- `data`
- `shape`
- `dtype`
- `row_offset`
- `col_offset`
- `downsample_info`

### 9.9 `get_line(...)`

Purpose:

- return a 1D line profile for `/data` and line CSV export

Behavior:

- supports three line modes:
  - natural 1D dataset axis
  - explicit numeric dimension
  - row/column profile from a selected 2D view
- builds a mixed indexer of:
  - one varying slice
  - one fixed row/column index if needed
  - fixed midpoint indices for the remaining dimensions
- sanitizes the result

Returns:

- `data`
- `shape`
- `dtype`
- `axis`
- `index`
- `downsample_info`

### 9.10 `get_heatmap(...)`

Purpose:

- return a downsampled 2D plane for heatmap rendering

Behavior:

- requires `ndim >= 2`
- computes target rows and columns capped by `max_size`
- derives integer row/column strides
- reads the strided slice
- transposes if needed
- sanitizes the data
- optionally computes `min` and `max` stats from the sampled data

Returns:

- `data`
- `shape`
- `dtype`
- `stats`
- `row_offset`
- `col_offset`
- `downsample_info`
- `sampled`

Important distinction:

- heatmap stats are calculated from the sampled heatmap array, not from the full original dataset

### 9.11 `get_children(...)`

Purpose:

- return immediate children for an HDF5 group or the root

Behavior:

- if `path == "/"`, uses the file root
- otherwise resolves the requested object
- if the path does not exist, it currently returns an empty list from inside the reader
- iterates child objects and builds summary rows

For groups, it returns:

- `name`
- `path`
- `type="group"`
- `num_children`

For datasets, it returns:

- `name`
- `path`
- `type="dataset"`
- `shape`
- `dtype`
- `size`
- `ndim`
- optional `chunks`
- optional `compression`
- up to 10 attributes
- `num_attributes`
- `attributes_truncated=True` when more than 10 exist

### 9.12 Metadata extraction

Method: `get_metadata(key, path)`

Purpose:

- return detailed metadata for a group or dataset

Common metadata:

- `name`
- `path`
- `attributes` list, capped at 20 entries

If object is a group:

- `kind="group"`
- `type="group"`
- `num_children`

If object is a dataset:

- `kind="dataset"`
- `shape`
- `dtype`
- `size`
- `ndim`
- `type` replaced with the result of `_get_type_info(...)`
- `rawType` from `_get_raw_type_info(...)`
- `filters` from `_get_filters_info(...)`
- optional `chunks`
- optional `compression`
- optional `compression_opts`

### 9.13 Type and filter helpers

`_get_type_info(dtype)` builds a human-readable type summary:

- class
- signedness for integers
- endianness
- size in bits

`_get_raw_type_info(dtype)` builds a lower-level dtype summary:

- numeric type id
- item size
- endian flag
- variable-length info

`_get_filters_info(dataset)` reports HDF5 filters such as:

- gzip
- lzf
- szip
- shuffle
- fletcher32

### 9.14 Stats computation

Method: `_compute_stats(dataset, shape, numeric)`

Behavior:

- skips non-numeric data
- computes total elements
- derives strided sampling so the sample remains within `MAX_STATS_SAMPLE`
- flattens the sample
- rejects empty and complex arrays
- computes:
  - `min`
  - `max`
  - `mean`
  - `std`
  - `sample_size`
  - `sampled`
  - `method="strided"`

This is used for preview stats, not for `/data` matrix responses.

### 9.15 Index building and sanitization

`_build_indexer(...)`

- assembles a full HDF5 indexer for N-D access
- visible dimensions receive slices
- non-visible dimensions receive fixed indices

`_sanitize_numpy_array(...)` and `_sanitize(...)`

These functions convert HDF5/NumPy values into JSON-safe values:

- bytes -> UTF-8 string
- complex -> string
- NumPy scalars -> native Python scalars
- non-finite floats (`NaN`, `Inf`) -> `None`
- arrays -> Python lists

This sanitization is a critical part of the backend because raw NumPy and HDF5 objects are not safe to return directly in Flask JSON responses.

## 10. Supporting backend files

### 10.1 `backend/requirements.txt`

The current runtime dependency set is small:

- `flask`
- `flask-cors`
- `python-dotenv`
- `numpy`
- `h5py`

There is no ORM, message broker, task queue, authentication library, or cloud SDK in the current backend.

### 10.2 `backend/.env.example`

This file documents the expected runtime variables:

- `PORT`
- `HOST`
- `DEBUG`
- `PUBLIC_BASE_URL`
- `STORAGE_PATH_LINUX`
- `STORAGE_PATH_WINDOWS`
- `STORAGE_ROOT`

Important note:

- `PUBLIC_BASE_URL` appears in `.env.example` and in the HTML dashboard template, but it is not currently consumed by `app.py`

### 10.3 `backend/templates/index.html`

This is a polished API dashboard template. It includes:

- runtime metrics
- health checking
- endpoint cards
- parameter tables
- curl command copy buttons

However, in the current backend implementation:

- `app.py` does not call `render_template`
- the `/` route returns JSON, not HTML

So this template is present in the repository but not currently active in the request flow.

### 10.4 `backend/h5create.py`

Developer utility for generating synthetic HDF5 test files.

It:

- targets roughly 100 MiB per file
- creates 2D, 3D, and 4D random `uint8` datasets
- writes sample files with extensions:
  - `.h5`
  - `.hdf`
  - `.hdf5`

This is useful for manual testing of:

- file discovery
- preview generation
- large data slicing
- higher-dimensional selection logic

### 10.5 `backend/scripts/test_storage.py`

Manual smoke test script that checks:

- storage client initialization
- object listing
- metadata reads
- opening and reading bytes from a file

### 10.6 `backend/scripts/verify_range_reads.py`

Manual verification script for inclusive byte-range reads.

It:

- lists available files
- picks the largest file
- tests multiple byte windows
- validates that returned byte counts match expectations

### 10.7 `backend/scripts/benchmark.py`

Benchmark helper for filesystem operations.

It measures:

- `list_objects`
- `get_object_metadata`
- sequential stream reads

This is intended to guide caching and performance decisions for the storage backend.

## 11. Test implementation

### 11.1 `backend/tests/test_files_routes.py`

This test file focuses on `files.py`.

It verifies:

- `/files/` returns file and folder counts correctly
- `/files/` passes the correct arguments to storage
- invalid `max_items` returns `400`

### 11.2 `backend/tests/test_hdf5_routes.py`

This test file focuses on HDF5 route behavior using mocks.

It verifies important route-level behavior such as:

- large line requests can still succeed when downsampled
- `quality=exact` allows small windows and rejects large ones
- heatmap requests can clamp `max_size`
- heatmap stats can be disabled
- negative fixed indices are normalized
- not-found paths map to `404`
- encoded route keys like `%2F` are decoded
- invalid preview detail returns `400`
- `/data` response caching works
- preview returns dimension labels
- matrix CSV export streams chunked windows
- line CSV export supports compare paths
- CSV export escapes formula-like cells
- heatmap CSV export uses full matrix slices instead of sampled heatmap output

The tests are focused mainly on:

- HTTP contract
- validation logic
- caching behavior
- export semantics

They do not perform deep real-file integration reads through `h5py` in the current test suite.

## 12. End-to-end request flows

### 12.1 File listing flow

```text
GET /files/
  -> files.py:list_files
  -> parse prefix/include_folders/max_items
  -> files cache lookup
  -> FilesystemStorageClient.list_objects
  -> synthetic folder generation if enabled
  -> JSON response
```

### 12.2 Children flow

```text
GET /files/<key>/children?path=/
  -> hdf5.py:get_children
  -> normalize key
  -> storage.get_object_metadata(key) for etag
  -> hdf5 cache lookup
  -> HDF5Reader.get_children
  -> JSON response
```

### 12.3 Preview flow

```text
GET /files/<key>/preview?path=/array_3d&display_dims=1,2
  -> hdf5.py:get_preview
  -> validate preview parameters
  -> preview cache lookup
  -> HDF5Reader.get_preview
     -> normalize axes
     -> inspect dtype/shape/labels
     -> compute optional stats
     -> build table/heatmap/profile preview structures
  -> JSON response
```

### 12.4 Data flow

```text
GET /files/<key>/data?path=/array_3d&mode=matrix
  -> hdf5.py:get_data
  -> deterministic request cache key
  -> data cache lookup
  -> dataset info cache lookup
  -> validate dimensions and limits
  -> HDF5Reader.get_matrix/get_heatmap/get_line
  -> sanitize payload
  -> cache response
  -> JSON response
```

### 12.5 CSV export flow

```text
GET /files/<key>/export/csv?path=/array_2d&mode=matrix
  -> hdf5.py:export_csv
  -> dataset info cache lookup
  -> validate export window and limits
  -> stream Response(...)
  -> repeated reader.get_matrix or reader.get_line calls per chunk
  -> CSV rows yielded progressively
```

## 13. Important implementation characteristics and limitations

### 13.1 Filesystem-only backend

The current runtime assumes the HDF5 files are available under a filesystem path. There is no cloud object storage integration in active use.

### 13.2 Process-local cache only

All caches are in-memory Python objects. They are:

- local to one backend process
- lost on restart
- not shared across multiple instances

### 13.3 No authentication or authorization layer

The current backend exposes the API without auth middleware. Access control is expected to be handled outside this codebase if needed.

### 13.4 String-based not-found detection

Several route handlers decide whether to return `404` by checking whether the exception message contains `not found`. This works, but it is looser than having dedicated exception types.

### 13.5 Template asset is not active

`backend/templates/index.html` exists, but the current `/` route returns JSON, so that template is not part of the active request path right now.

### 13.6 Reader and route limits are both important

The backend defends itself in two places:

- route layer limits stop dangerous requests early
- reader layer limits keep previews and stats bounded

This split is intentional and should be preserved if new endpoints are added.

## 14. Summary

The backend is implemented as a clean four-layer system:

- `app.py` wires the service together
- `routes` define the HTTP API and enforce request contracts
- `hdf5_reader.py` contains the real HDF5 traversal and slicing logic
- `filesystem_client.py` and `cache.py` provide safe storage access and reusable caching

If you need to understand where to change behavior, the shortest mapping is:

- app startup or CORS: `backend/app.py`
- file listing behavior: `backend/src/routes/files.py`
- HDF5 endpoint validation and HTTP response shape: `backend/src/routes/hdf5.py`
- HDF5 read logic and slicing: `backend/src/readers/hdf5_reader.py`
- storage root, path resolution, and file access: `backend/src/storage/filesystem_client.py`
- cache TTL or capacity: `backend/src/utils/cache.py`

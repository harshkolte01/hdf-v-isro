# Backend Reader, Route, Storage, and Utils Guide

This document explains the backend files inside:

- `backend/src/readers`
- `backend/src/routes`
- `backend/src/storage`
- `backend/src/utils`

It is written as a practical code-reading guide: what each file does, why it exists, and how it connects to the rest of the backend.

## Big Picture

The backend is a Flask service that serves HDF5 files from a filesystem-backed storage root.

The flow is:

1. `backend/app.py` starts Flask and registers the route blueprints.
2. Route files in `backend/src/routes` receive HTTP requests and validate query parameters.
3. Storage code in `backend/src/storage` resolves file keys into safe filesystem paths.
4. Reader code in `backend/src/readers` opens HDF5 files and extracts data, metadata, previews, matrices, lines, and heatmaps.
5. Utility code in `backend/src/utils` provides in-memory TTL caches so repeated requests do not reopen files unnecessarily.

In short:

- `routes` = HTTP layer
- `storage` = file access layer
- `readers` = HDF5 interpretation layer
- `utils` = shared helpers, mainly caching

## How the Four Areas Work Together

Example request flow for `GET /files/<key>/preview?path=/dataset`:

1. `backend/src/routes/hdf5.py` receives the request.
2. It validates query parameters like `path`, `mode`, `display_dims`, and `fixed_indices`.
3. It checks the preview cache.
4. If needed, it calls `get_hdf5_reader()`.
5. `HDF5Reader` uses `get_storage_client()` to open the target file safely.
6. The reader opens the HDF5 file with `h5py`, reads only the requested data, sanitizes values for JSON, and returns a Python dictionary.
7. The route returns that dictionary as a JSON response.

That same pattern is reused across metadata, children listing, matrix extraction, line extraction, heatmap generation, and CSV export.

---

## `backend/src/readers`

The `readers` package is responsible for understanding HDF5 structure and converting HDF5 objects into JSON-friendly backend responses.

### `backend/src/readers/README.md`

This is a folder-level summary.

What it tells you:

- The package exists to open HDF5 files and convert them into backend-friendly shapes.
- `HDF5Reader` is the main class.
- The route layer uses a singleton accessor named `get_hdf5_reader()`.
- The public methods expected by routes are `get_dataset_info`, `get_children`, `get_metadata`, `get_preview`, `get_matrix`, `get_line`, and `get_heatmap`.
- It also documents the main limits used to prevent oversized responses.

Why it matters:

- It gives the intended contract of the reader layer without making you read the whole Python file first.

### `backend/src/readers/hdf5_reader.py`

This is the core HDF5 data-access file in the backend.

Main responsibility:

- Open HDF5 files from storage.
- Navigate to groups or datasets.
- Read only the requested slices.
- Convert NumPy and HDF5 data into JSON-safe Python values.

Main class:

- `HDF5Reader`

Important constants:

- `MAX_PREVIEW_ELEMENTS`
- `MAX_HEATMAP_SIZE`
- `MAX_HEATMAP_ELEMENTS`
- `MAX_LINE_POINTS`
- `MIN_LINE_POINTS`
- `TABLE_1D_MAX`
- `TABLE_2D_MAX`
- `MAX_STATS_SAMPLE`

Why these constants exist:

- They stop the API from trying to serialize huge arrays.
- They keep preview responses fast enough for UI use.
- They keep memory usage predictable.

Key methods:

- `__init__()`
  - Creates one storage client and keeps it on `self.storage`.

- `get_dataset_info(key, path)`
  - Lightweight metadata call.
  - Returns `shape`, `ndim`, and `dtype`.
  - Used by routes before expensive reads so the route can validate request size.

- `_coerce_dimension_label`, `_get_attribute_dimension_labels`, `_get_dimension_scale_label`, `_get_dimension_labels`
  - These methods resolve human-readable labels for dataset dimensions.
  - They look at HDF5 dimension labels, attributes like `DIMENSION_LABELS`, and attached dimension scales.
  - This is useful for a UI that wants better axis names than plain dimension numbers.

- `normalize_preview_axes(shape, display_dims_param, fixed_indices_param)`
  - Converts raw request parameters into a valid pair of visible dimensions plus fixed indices for the remaining dimensions.
  - For datasets with more than two dimensions, all non-visible dimensions are pinned to a single index.
  - Default behavior uses the midpoint for hidden dimensions.

- `get_preview(...)`
  - The main preview builder.
  - Handles 1D, 2D, and N-D datasets.
  - Returns a combined response that can contain:
    - table preview
    - plot or heatmap preview
    - optional line profile
    - optional stats
    - dimension labels
    - display/fixed selection state
  - This is meant for the first view the frontend shows before the user requests a bigger data window.

- `get_matrix(...)`
  - Reads a bounded 2D window.
  - Supports row/column offsets, limits, and step values.
  - Used for viewport-style matrix access.

- `get_line(...)`
  - Extracts a 1D series.
  - Works for:
    - real 1D datasets
    - a chosen dimension in an N-D dataset
    - a row or column profile from a 2D view
  - Returns the actual sampled data and downsample info.

- `get_heatmap(...)`
  - Reads a downsampled 2D plane suitable for rendering as a heatmap.
  - Computes row and column step sizes so large datasets can be reduced safely.
  - Optionally returns min/max stats for the selected plane.

- `get_children(key, path="/")`
  - Lists child groups and datasets at a given HDF5 path.
  - For datasets it includes shape, dtype, size, ndim, optional chunks, optional compression, and a small attribute sample.
  - This is what powers tree navigation.

- `get_metadata(key, path)`
  - Returns detailed metadata about one HDF5 object.
  - For datasets it adds:
    - shape
    - dtype
    - size
    - ndim
    - detailed type info
    - raw dtype info
    - compression/filter info
    - chunks
    - attributes

- `_get_type_info`, `_get_raw_type_info`, `_get_filters_info`
  - These are metadata helpers.
  - They convert HDF5 dtype and filter details into frontend-usable dictionaries.

- `_parse_display_dims`, `_parse_fixed_indices`, `_default_index`, `_clamp_index`
  - These normalize axis-selection inputs.

- `_is_numeric_dtype`, `_total_elements`, `_compute_strides`, `_compute_stats`
  - These are used to decide whether stats are valid and how to sample large datasets efficiently.

- `_preview_1d`, `_preview_2d`
  - Internal helpers that assemble actual preview payload shapes.

- `_build_indexer`
  - Builds the HDF5 slice/index tuple for multidimensional reads.

- `_safe_number`, `_sanitize_numpy_array`, `_sanitize`
  - These are critical for JSON compatibility.
  - They convert:
    - bytes to strings
    - NumPy scalars to native Python scalars
    - arrays to lists
    - `NaN` and `Inf` to `None`
    - complex values to strings

Design importance:

- This file keeps HDF5-specific complexity out of the HTTP layer.
- Routes ask for data in business terms like "preview", "matrix", or "line", and the reader does the low-level HDF5 work.

### `backend/src/readers/__init__.py`

This file is currently empty.

Why it still exists:

- It marks `readers` as a Python package.
- It gives the project a standard importable package structure.
- It also leaves a place to add package-level exports later if needed.

---

## `backend/src/routes`

The `routes` package is the HTTP layer. It translates HTTP requests into calls to storage and reader modules and returns JSON or streamed CSV responses.

### `backend/src/routes/README.md`

This is the folder-level explanation for the route layer.

What it tells you:

- `files.py` handles filesystem listing.
- `hdf5.py` handles HDF5 navigation and data APIs.
- It documents route responsibilities such as:
  - parameter validation
  - key normalization
  - cache usage
  - export handling
  - error response model

Why it matters:

- It explains the separation between generic file listing and HDF5-specific operations.

### `backend/src/routes/files.py`

This file exposes the file-listing API.

Main blueprint:

- `files_bp`

Main endpoint:

- `GET /files/`

What it does:

- Reads query parameters:
  - `prefix`
  - `include_folders`
  - `max_items`
- Validates those parameters.
- Uses the files cache.
- Calls `FilesystemStorageClient.list_objects(...)`.
- Returns file and optional synthetic folder entries as JSON.

Main helpers:

- `_parse_bool_param(name, default)`
  - Accepts common boolean strings like `true`, `false`, `1`, `0`, `yes`, `no`.

- `_parse_int_param(name, default, min_value, max_value)`
  - Parses and range-checks integer query params.

- `_error_payload(status_code, message)`
  - Standard JSON error helper for this file.

- `list_files()`
  - The actual route handler.
  - Builds a cache key using all request parameters.
  - On cache hit, returns cached results plus counts and truncation information.
  - On cache miss, asks the storage client for a fresh listing and stores it in cache.

Important behavior:

- `include_folders=True` means the response can include folder rows even though those rows are derived rather than separately read from the filesystem.
- `truncated` becomes true when file count reaches the limit.

Why this file exists separately from `hdf5.py`:

- File listing is storage-focused.
- HDF5 tree browsing is HDF5-object-focused.
- Keeping them separate prevents one large route file from mixing two different concerns.

### `backend/src/routes/hdf5.py`

This is the main backend API file for HDF5 operations.

Main blueprint:

- `hdf5_bp`

Main route groups:

- `GET /files/<key>/children`
- `GET /files/<key>/meta`
- `GET /files/<key>/preview`
- `GET /files/<key>/data`
- `GET /files/<key>/export/csv`

Overall role:

- Validate request arguments before expensive HDF5 reads.
- Normalize dimension-selection inputs.
- Enforce response-size limits.
- Reuse cached dataset metadata.
- Call the reader layer.
- Return API-friendly JSON or streamed CSV.

Important helper groups:

- Parameter parsing:
  - `_parse_int_param`
  - `_parse_display_dims`
  - `_parse_fixed_indices`
  - `_parse_line_dim`
  - `_parse_line_quality`
  - `_parse_preview_detail`
  - `_parse_bool_param`

- Selection normalization:
  - `_fill_fixed_indices`
  - `_normalize_selection`

- Safety and response-size control:
  - `_compute_safe_heatmap_size`
  - `_enforce_element_limits`
  - `_is_not_found_error`
  - `_client_error_message`

- CSV export helpers:
  - `_csv_escape`
  - `_csv_row`
  - `_sanitize_filename_segment`
  - `_build_export_filename`
  - `_is_numeric_dtype_string`
  - `_parse_compare_paths`

- Cache helpers:
  - `_resolve_cache_version_tag`
  - `_serialize_request_args`
  - `_get_cached_dataset_info`

Route-by-route explanation:

- `get_children(key)`
  - Reads `path` query param, default `/`.
  - Fetches file metadata to obtain an `etag`.
  - Uses `etag` in the cache key so cache entries are invalidated when the file changes.
  - Calls `reader.get_children(...)`.

- `get_metadata(key)`
  - Requires a `path` query parameter.
  - Uses file `etag` in the metadata cache key.
  - Calls `reader.get_metadata(...)`.

- `get_preview(key)`
  - Requires `path`.
  - Supports preview options like:
    - `mode`
    - `detail`
    - `include_stats`
    - `display_dims`
    - `fixed_indices`
    - `max_size`
  - Uses a detailed cache key because preview output changes with selection state and mode.
  - Calls `reader.get_preview(...)`.

- `get_data(key)`
  - This is the precise data-fetch endpoint, separate from preview.
  - Requires:
    - `path`
    - `mode`
  - Supports three modes:
    - `matrix`
    - `heatmap`
    - `line`
  - It first gets dataset shape/dtype info from dataset cache, then validates limits before reading any actual arrays.

  In `matrix` mode:

  - Validates row/column offsets, limits, and steps.
  - Enforces matrix size caps.
  - Calls `reader.get_matrix(...)`.

  In `heatmap` mode:

  - Validates `max_size`.
  - May clamp requested heatmap size to stay under JSON element limits.
  - Calls `reader.get_heatmap(...)`.

  In `line` mode:

  - Supports exact or overview behavior using `quality`.
  - Can read:
    - full 1D data
    - one dimension of an N-D dataset
    - one row/column slice of a 2D selection
  - Uses downsampling when needed.
  - Calls `reader.get_line(...)`.

- `export_csv(key)`
  - Streams CSV instead of building one huge string in memory.
  - Supports:
    - `matrix`
    - `heatmap`
    - `line`
  - Reuses cached dataset info.
  - Applies hard export limits.
  - Uses chunked reads to avoid loading very large exports all at once.
  - For line export it also supports `compare_paths`, which lets the API export the base line plus up to four comparison datasets with the same shape.

Important design choices in this file:

- Routes do not contain raw HDF5 slicing logic. They validate and dispatch.
- Cache keys are deterministic, which reduces accidental misses caused by parameter ordering.
- CSV export is streamed and chunked, which is much safer than generating huge in-memory strings.
- Error handling is consistent:
  - bad client input -> `400`
  - missing path/object style errors -> `404`
  - internal failures -> `500`

### `backend/src/routes/__init__.py`

This file is currently empty.

Why it exists:

- It marks `routes` as a Python package.
- It keeps imports like `from src.routes.files import files_bp` clean and conventional.

---

## `backend/src/storage`

The `storage` package abstracts filesystem access so route and reader code do not work with raw OS paths directly.

### `backend/src/storage/README.md`

This is the folder summary for storage.

What it documents:

- The backend uses a filesystem client, not S3 or another object store.
- How storage-root environment variables are chosen.
- Which operations the storage client supports.
- What security protections exist against path traversal.

Why it matters:

- It explains that the storage layer is meant to look like an object-store client even though it is implemented on top of local or mounted files.

### `backend/src/storage/filesystem_client.py`

This file is the filesystem-backed storage implementation.

Main class:

- `FilesystemStorageClient`

Main responsibility:

- Convert logical object keys like `folder/file.h5` into safe filesystem paths under the configured storage root.

Key methods:

- `__init__()`
  - Resolves the storage root once and stores it.

- `_resolve_storage_root()`
  - Reads environment variables in priority order.
  - Supports both Windows and Linux-style configuration.
  - Raises an error if no usable root is configured.

- `_normalize_prefix(prefix)` and `_normalize_object_key(key)`
  - Normalize separators.
  - Remove leading slashes.
  - Reject `..` traversal attempts.

- `_ensure_within_root(root, path)`
  - Final security check.
  - Ensures the resolved path still sits inside the configured storage root.

- `_derive_parent_folders(key, normalized_prefix)`
  - Generates synthetic folder paths from file keys.
  - This is how the API can return folder entries without a separate directory index.

- `_build_etag(stat_result)`
  - Builds a lightweight fingerprint from file mtime and size.
  - Used by route-layer caching.

- `resolve_object_path(key)`
  - Converts an object key into an absolute safe path inside the storage root.

- `list_objects(prefix="", include_folders=False, max_items=None)`
  - Walks the storage root recursively.
  - Returns file entries.
  - Optionally adds synthetic folder entries.
  - Stops early when `max_items` is reached.

- `get_object_metadata(key)`
  - Returns:
    - key
    - size
    - last modified timestamp
    - etag
    - content type

- `open_object_stream(key)`
  - Opens the target file in binary read mode.
  - This is used by `HDF5Reader`.

- `get_object_range(key, start, end)`
  - Reads an inclusive byte range.
  - Not the main path for HDF5 operations, but useful if future APIs need partial file access.

- `get_storage_client()`
  - Singleton accessor for the storage client.

Why this file matters architecturally:

- It keeps OS path logic, root resolution, and traversal defense out of the route layer.
- It makes the rest of the backend behave as if it is talking to a generic object store keyed by relative paths.

### `backend/src/storage/__init__.py`

This file re-exports:

- `FilesystemStorageClient`
- `get_storage_client`

Why it exists:

- It gives the package a clean public interface.
- Callers can import from `src.storage` if desired instead of importing the concrete file directly.

---

## `backend/src/utils`

The `utils` package holds shared helpers. In the current backend, the main shared utility is in-memory caching.

### `backend/src/utils/README.md`

This is the folder summary for utilities.

What it documents:

- The presence of `SimpleCache`
- Available cache instances
- Their TTL/capacity choices
- The helper for building cache keys

Why it matters:

- It tells you that caching is a first-class part of request handling in this backend, especially for HDF5 metadata and data windows.

### `backend/src/utils/cache.py`

This file implements the in-memory cache system used across the route layer.

Main class:

- `SimpleCache`

Core design:

- Uses `OrderedDict` to preserve access order.
- Uses `Lock` for thread-safe mutation and reads.
- Uses TTL-based expiration.
- Evicts oldest entries when capacity is exceeded.

Method-by-method:

- `__init__(default_ttl, max_entries)`
  - Stores cache policy.

- `get(key)`
  - Returns cached value when present and unexpired.
  - Deletes expired entries on read.
  - Moves a hit to the end of the ordered dictionary.

- `set(key, value, ttl=None)`
  - Stores a new value with expiration time.
  - Refreshes position if the key already exists.
  - Evicts old entries when the cache is full.

- `delete(key)`
  - Removes one cache entry.

- `clear()`
  - Removes all entries.

- `clear_pattern(pattern)`
  - Removes entries whose keys contain a given substring.
  - Useful when key naming conventions group related cache entries.

- `stats()`
  - Returns counts for total, active, and expired entries.

Global caches defined in this file:

- `_files_cache`
  - Short TTL because file listings should refresh quickly.

- `_hdf5_cache`
  - Longer TTL for tree, metadata, and preview responses.

- `_dataset_cache`
  - Reuses shape/dtype/ndim lookups across preview, data, and export requests.

- `_data_cache`
  - Separate cache for `/data` responses.

Accessors:

- `get_files_cache()`
- `get_hdf5_cache()`
- `get_dataset_cache()`
- `get_data_cache()`

Helper:

- `make_cache_key(*parts)`
  - Joins parts with `:`.
  - The whole backend depends on this convention for deterministic cache keys.

Why this file matters:

- HDF5 access can be expensive.
- This cache layer prevents repeated identical requests from reopening and re-reading the same data immediately.
- It is simple and process-local, which makes it easy to understand and good enough for a single backend process.

### `backend/src/utils/__init__.py`

This file is currently empty.

Why it exists:

- It marks `utils` as a package.
- It leaves room for future shared exports.

---

## Practical Summary

If you want to understand the backend quickly, read it in this order:

1. `backend/app.py`
2. `backend/src/routes/files.py`
3. `backend/src/routes/hdf5.py`
4. `backend/src/storage/filesystem_client.py`
5. `backend/src/readers/hdf5_reader.py`
6. `backend/src/utils/cache.py`

That order matches the real request flow:

- request enters through Flask
- route validates input
- storage resolves the file path
- reader opens and slices the HDF5 file
- cache reduces repeated work

## One-Line Meaning of Each Requested Area

- `readers`: understand HDF5 content
- `routes`: expose backend APIs
- `storage`: safely access files from disk
- `utils`: support the rest of the backend with shared helpers

# API Reference

Base URL (local default): `http://localhost:5000`

All HDF5 routes are under `/files/<key>/...` where `<key>` is the relative file key under configured storage root.

`<key>` supports nested folders. Encoded separators like `%2F` are decoded.

## 1) Service routes

### `GET /`

Returns service info JSON.

### `GET /health`

Returns:
- `status`
- `timestamp` (UTC ISO format)
- `service`

## 2) File listing routes

### `GET /files/`

List filesystem entries.

Query params:
- `prefix` (string, optional, default `""`)
- `include_folders` (bool, optional, default `true`)
- `max_items` (int, optional, default `20000`, range `1..50000`)

Response fields:
- `success`
- `count`
- `files` (array)
- `files_count`
- `folders_count`
- `truncated`
- `prefix`
- `include_folders`
- `max_items`
- `cached`

### `POST /files/refresh`

Clears file-list cache.

## 3) HDF5 tree + metadata routes

### `GET /files/<key>/children`

Query params:
- `path` (string, optional, default `/`)

Response:
- `children` array for immediate child nodes.

### `GET /files/<key>/meta`

Query params:
- `path` (string, required)

Response:
- metadata for dataset/group path

## 4) Preview route

### `GET /files/<key>/preview`

Query params:
- `path` (string, required)
- `mode` (enum, optional): `auto|line|table|heatmap` (invalid -> `auto`)
- `detail` (enum, optional): `fast|full` (default `full`, invalid -> 400)
- `include_stats` (bool, optional, default `true` when detail=`full`)
- `display_dims` (string, optional, format like `1,2`)
- `fixed_indices` (string, optional, format like `0=10,3=2`)
- `max_size` (int, optional, must be `>0`)
- `etag` (string, optional cache-version hint)

Response highlights:
- `preview_type`: `1d|2d|nd`
- `table`, `plot`, `profile`
- `stats`
- `display_dims`, `fixed_indices`
- `limits`
- `cached`, `cache_version`

## 5) Data route

### `GET /files/<key>/data`

Required query params:
- `path`
- `mode=matrix|heatmap|line`

Shared optional params:
- `display_dims`
- `fixed_indices`
- `etag`

### `mode=matrix`

Optional params:
- `row_offset` (int >= 0, default `0`)
- `col_offset` (int >= 0, default `0`)
- `row_limit` (int >= 1, default `100`)
- `col_limit` (int >= 1, default `100`)
- `row_step` (int >= 1, default `1`)
- `col_step` (int >= 1, default `1`)

### `mode=heatmap`

Optional params:
- `max_size` (int >= 1, default `512`, capped by route limit)
- `include_stats` (bool, default `true`)

### `mode=line`

Optional params:
- `line_dim` (`row|col|<int dim index>`, default behavior depends on ndim)
- `quality` (`auto|overview|exact`, default `auto`)
- `line_index` (int >= 0 when needed)
- `line_offset` (int >= 0, default `0`)
- `line_limit` (int >= 1, default: remaining points)
- `max_points` (int >= 1, default `5000`, capped to route max)

Line quality behavior:
- `exact`: no downsampling, but fails for very large windows
- `overview`: downsampling applied
- `auto`: exact for small windows, overview for large windows

## 6) CSV export route

### `GET /files/<key>/export/csv`

Required query params:
- `path`
- `mode=matrix|heatmap|line`

Returns `text/csv` stream with `Content-Disposition: attachment`.

Shared optional params:
- `display_dims`
- `fixed_indices`
- `etag`

### `mode=matrix|heatmap` export params

- `row_offset` (int >= 0, default `0`)
- `col_offset` (int >= 0, default `0`)
- `row_limit` (optional, defaults to remaining rows)
- `col_limit` (optional, defaults to remaining cols)
- `chunk_rows` (int >= 1, default `256`)
- `chunk_cols` (int >= 1, default `256`)

### `mode=line` export params

- `line_dim`
- `line_index`
- `line_offset` (default `0`)
- `line_limit` (optional, defaults to remaining points)
- `chunk_points` (int >= 1, default `50000`)
- `compare_paths` (comma-separated dataset paths, max 4)

Compare path rules:
- each compare dataset must have the same shape as base dataset
- compare dataset dtype must be numeric

## 7) Error model

Common response shape for errors:
- `success: false`
- `error: <message>`

Status behavior:
- `400` for validation/type issues
- `404` for not-found style failures
- `500` for unhandled server failures

## 8) Route-level limits (from `src/routes/hdf5.py`)

- `MAX_ELEMENTS = 1_000_000`
- `MAX_JSON_ELEMENTS = 500_000`
- `MAX_MATRIX_ROWS = 2000`
- `MAX_MATRIX_COLS = 2000`
- `MAX_LINE_POINTS = 5000`
- `MAX_LINE_EXACT_POINTS = 20000`
- `MAX_HEATMAP_SIZE = 1024`
- `MAX_EXPORT_CSV_CELLS = 10_000_000`
- `MAX_EXPORT_LINE_POINTS = 5_000_000`

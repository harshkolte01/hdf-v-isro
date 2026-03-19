# Backend CSV Export Implementation

File of record: `backend/src/routes/hdf5.py` (`export_csv` route).

This document explains how CSV export is implemented today.

## Endpoint

`GET /files/<key>/export/csv`

Required query params:
- `path`
- `mode=matrix|heatmap|line`

Response:
- streamed CSV (`text/csv; charset=utf-8`)
- UTF-8 BOM emitted first
- download filename from `_build_export_filename(...)`

## Shared processing steps

1. normalize `<key>`
2. validate required params
3. read base dataset metadata through dataset-cache helper
4. normalize selection (`display_dims`, `fixed_indices`)
5. validate mode-specific rules
6. stream rows via generator

## Matrix and heatmap export behavior

Although mode may be `matrix` or `heatmap`, CSV export uses matrix-window reads (`reader.get_matrix`) so output remains rectangular.

Supported params:
- `row_offset`, `row_limit`
- `col_offset`, `col_limit`
- `chunk_rows`, `chunk_cols`

Implementation notes:
- export window is clamped to dataset bounds
- empty windows return `400`
- total cell count must be <= `MAX_EXPORT_CSV_CELLS`
- data is read chunk-by-chunk and appended into row buffers
- first column is row index (`row\col` header pattern)

## Line export behavior

Supported params:
- `line_dim`
- `line_index`
- `line_offset`
- `line_limit`
- `chunk_points`
- `compare_paths` (comma-separated)

Rules:
- line dataset dtype must be numeric
- `line_limit` must be > 0 and <= `MAX_EXPORT_LINE_POINTS`
- up to 4 compare paths
- each compare dataset must:
  - have same shape as base dataset
  - be numeric

Streaming behavior:
- each chunk reads base line window with `reader.get_line(..., step=1)`
- each compare path is read for same chunk window
- output columns are: `index,base,<compare...>`

## CSV safety behavior

Function `_csv_escape` applies:
- quote escaping for commas/quotes/newlines
- spreadsheet formula protection:
  - if trimmed cell starts with `=`, `+`, `-`, or `@`
  - prefix with single quote (`'`)

This reduces CSV formula-injection risk when opened in spreadsheet tools.

## Performance controls

- chunked reading (`chunk_rows`, `chunk_cols`, `chunk_points`)
- streaming response (`stream_with_context`) to avoid large in-memory buffers
- dataset metadata caching avoids repeated shape/dtype opens across requests

## Related tests

See `backend/tests/test_hdf5_routes.py`:
- matrix window export
- line compare paths
- formula-like escaping
- heatmap-mode CSV behavior

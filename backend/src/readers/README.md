# backend/src/readers

Reader layer that opens HDF5 files and extracts data in backend-friendly shapes.

## File

- `hdf5_reader.py`

## Main class

- `HDF5Reader`

It is created as a singleton via `get_hdf5_reader()` and used by route handlers.

## What it does

- Opens file streams from storage client (`FilesystemStorageClient`).
- Resolves HDF5 objects by internal path.
- Validates object type expectations (dataset/group).
- Performs bounded slicing for matrix/line/heatmap paths.
- Builds preview payloads for 1D, 2D, and N-D datasets.
- Sanitizes NumPy/HDF5 values into JSON-safe Python values.

## Public APIs used by routes

- `get_dataset_info(key, path)`
  - Returns `shape`, `ndim`, `dtype`.

- `get_children(key, path='/')`
  - Returns immediate children under a group/root.

- `get_metadata(key, path)`
  - Returns dataset/group metadata and attributes.

- `get_preview(...)`
  - Returns preview payload with `table`, `plot`, optional `profile`, `stats`, and limits.

- `get_matrix(...)`
  - Returns bounded 2D window with optional row/column stepping.

- `get_line(...)`
  - Returns 1D extraction by dimension or row/column view.

- `get_heatmap(...)`
  - Returns downsampled 2D plane and optional min/max stats.

## Key implementation behaviors

- Axis normalization for N-D datasets:
  - `display_dims` choose two visible dimensions.
  - all non-visible dims are fixed (explicit index or midpoint default).
- Orientation handling:
  - data is transposed when selected dim order would otherwise invert row/column orientation.
- Sanitization:
  - bytes -> UTF-8 strings
  - complex -> string
  - `NaN`/`Inf` -> `None`
  - numpy scalars/arrays -> native Python lists/scalars

## Reader constants

Main constants in `hdf5_reader.py`:
- `MAX_PREVIEW_ELEMENTS`
- `MAX_HEATMAP_SIZE`
- `MAX_HEATMAP_ELEMENTS`
- `MAX_LINE_POINTS`
- `TABLE_1D_MAX`
- `TABLE_2D_MAX`
- `MAX_STATS_SAMPLE`

## Called from

- `backend/src/routes/hdf5.py`

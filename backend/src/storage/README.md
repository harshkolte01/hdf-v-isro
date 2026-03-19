# backend/src/storage

Filesystem storage abstraction used by routes and reader code.

## Files

- `filesystem_client.py`
- `__init__.py`

## Main class

- `FilesystemStorageClient`

This backend uses local/network filesystem paths only. There is no active bucket/object-storage implementation.

## Storage root resolution

Environment variables read in priority order:

1. `STORAGE_ROOT` (explicit override)
2. OS-aware fallback:
   - Windows: `STORAGE_PATH_WINDOWS`, then `STORAGE_PATH_LINUX`
   - Linux/macOS: `STORAGE_PATH_LINUX`, then `STORAGE_PATH_WINDOWS`

If no usable value exists, initialization raises `ValueError`.

## Implemented operations

- `list_objects(prefix='', include_folders=False, max_items=None)`
  - Recursively walks storage root.
  - Returns file rows and optional derived folder rows.

- `get_object_metadata(key)`
  - Returns `size`, `last_modified`, synthetic `etag`, `content_type`.

- `open_object_stream(key)`
  - Opens the object in binary-read mode.

- `get_object_range(key, start, end)`
  - Reads inclusive byte ranges.

- `resolve_object_path(key)`
  - Normalizes key and enforces path remains inside storage root.

## Security and safety

- Normalizes separators to `/`.
- Rejects `..` traversal in prefix/key parsing.
- Verifies resolved path is a child of configured root (`relative_to` check).

## Imported by

- `backend/src/routes/files.py`
- `backend/src/routes/hdf5.py`
- `backend/src/readers/hdf5_reader.py`

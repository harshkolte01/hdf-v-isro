# backend/src/utils

Shared utility code used by route modules.

## File

- `cache.py`

## `SimpleCache`

Thread-safe in-memory TTL cache using:
- `OrderedDict` for insertion/access order
- `Lock` for concurrent access safety

Implemented methods:
- `get(key)`
- `set(key, value, ttl=None)`
- `delete(key)`
- `clear()`
- `clear_pattern(pattern)`
- `stats()`

Behavior:
- Expired keys are dropped on read.
- Hits move keys to the end of the ordered map.
- When `max_entries` is exceeded, the oldest entry is evicted.

## Global caches

- files cache: `SimpleCache(default_ttl=30, max_entries=200)`
- hdf5 cache: `SimpleCache(default_ttl=300, max_entries=3000)`
- dataset cache: `SimpleCache(default_ttl=300, max_entries=3000)`
- data cache: `SimpleCache(default_ttl=120, max_entries=1200)`

Accessors:
- `get_files_cache()`
- `get_hdf5_cache()`
- `get_dataset_cache()`
- `get_data_cache()`

Helper:
- `make_cache_key(*parts)` -> `:`-joined key string

## Imported by

- `backend/src/routes/files.py`
- `backend/src/routes/hdf5.py`

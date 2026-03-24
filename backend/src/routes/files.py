"""
File listing routes
"""
import logging
from flask import Blueprint, jsonify, request
from src.storage.filesystem_client import get_storage_client
from src.utils.cache import get_files_cache

logger = logging.getLogger(__name__)

files_bp = Blueprint('files', __name__)


def _parse_bool_param(name: str, default: bool) -> bool:
    # Accept various truthy/falsy string representations so API clients
    # that send '1'/'0' or 'yes'/'no' all work without extra middleware.
    raw = request.args.get(name)
    if raw is None:
        return default

    normalized = str(raw).strip().lower()
    if normalized in ('1', 'true', 'yes', 'on'):
        return True
    if normalized in ('0', 'false', 'no', 'off'):
        return False
    raise ValueError(f"Invalid {name} parameter")


def _parse_int_param(name: str, default: int, min_value: int, max_value: int) -> int:
    # Parse and range-check an integer query parameter; raises ValueError (400)
    # if the value is present but unparseable or out of the allowed range.
    raw = request.args.get(name)
    if raw is None:
        return default

    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"Invalid {name} parameter") from exc

    if value < min_value or value > max_value:
        raise ValueError(f"{name} must be between {min_value} and {max_value}")

    return value


def _error_payload(status_code: int, message: str):
    return jsonify({
        'success': False,
        'error': message
    }), status_code


@files_bp.route('/', methods=['GET'])
def list_files():
    """List all files in configured filesystem storage with caching."""
    try:
        prefix = str(request.args.get('prefix', '') or '').strip()
        include_folders = _parse_bool_param('include_folders', True)
        max_items = _parse_int_param('max_items', 20000, 1, 50000)

        cache = get_files_cache()
        # Cache key encodes every parameter that changes the result so different
        # queries don't collide and each unique combination is cached separately.
        cache_key = f"files_list:{prefix}:{include_folders}:{max_items}"
        
        # Try to get from cache
        cached_data = cache.get(cache_key)
        if cached_data is not None:
            logger.info("Files list requested - CACHE HIT")
            files_count = sum(1 for entry in cached_data if entry.get('type') == 'file')
            folders_count = sum(1 for entry in cached_data if entry.get('type') == 'folder')
            # Truncation flag tells the UI when the result has been capped at max_items.
            # Folder rows are synthetic (derived from file paths) so only file rows count.
            truncated = files_count >= max_items
            return jsonify({
                'success': True,
                'count': len(cached_data),
                'files': cached_data,
                'files_count': files_count,
                'folders_count': folders_count,
                'truncated': truncated,
                'prefix': prefix,
                'include_folders': include_folders,
                'max_items': max_items,
                'cached': True
            }), 200
        
        # Cache miss - fetch from storage
        logger.info("Files list requested - CACHE MISS")
        storage = get_storage_client()
        list_kwargs = {
            'prefix': prefix,
            'include_folders': include_folders,
            'max_items': max_items
        }
        entries = storage.list_objects(**list_kwargs)
        files_count = sum(1 for entry in entries if entry.get('type') == 'file')
        folders_count = sum(1 for entry in entries if entry.get('type') == 'folder')
        # Same truncation logic as the cache-hit path above.
        truncated = files_count >= max_items
        
        # Store in cache
        cache.set(cache_key, entries)
        
        return jsonify({
            'success': True,
            'count': len(entries),
            'files': entries,
            'files_count': files_count,
            'folders_count': folders_count,
            'truncated': truncated,
            'prefix': prefix,
            'include_folders': include_folders,
            'max_items': max_items,
            'cached': False
        }), 200

    except ValueError as e:
        logger.error(f"Invalid files list request: {e}")
        return _error_payload(400, str(e))
    except Exception as e:
        logger.error(f"Error listing files: {e}")
        return _error_payload(500, 'Internal server error')

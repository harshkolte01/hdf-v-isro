import logging
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


class FilesystemStorageClient:
    """Filesystem storage client for local or network-mounted HDF5 files."""

    def __init__(self):
        self.storage_root = self._resolve_storage_root()
        logger.info("Filesystem storage initialized with root: %s", self.storage_root)

    def _resolve_storage_root(self) -> Path:
        # Read storage root from environment. Priority order:
        # 1. STORAGE_ROOT (explicit, platform-agnostic)
        # 2. STORAGE_PATH_WINDOWS / STORAGE_PATH_LINUX (platform-specific fallbacks)
        # On Windows STORAGE_PATH_WINDOWS is tried first; on Linux the reverse.
        explicit_root = os.getenv("STORAGE_ROOT")
        linux_root = os.getenv("STORAGE_PATH_LINUX")
        windows_root = os.getenv("STORAGE_PATH_WINDOWS")

        ordered_candidates = []
        if explicit_root:
            ordered_candidates.append(explicit_root)
        if os.name == "nt":
            ordered_candidates.extend([windows_root, linux_root])
        else:
            ordered_candidates.extend([linux_root, windows_root])

        # Pick the first configured candidate so the same code works on both
        # Linux and Windows deployments without branching in route/read logic.
        for raw in ordered_candidates:
            value = str(raw or "").strip()
            if value:
                return Path(value).expanduser().resolve(strict=False)

        raise ValueError(
            "Missing storage configuration. Set STORAGE_ROOT or STORAGE_PATH_LINUX/STORAGE_PATH_WINDOWS."
        )

    def _normalize_prefix(self, prefix: str) -> str:
        # Normalise and validate the prefix query param. Backslashes are converted
        # to forward slashes; '..' components are rejected to prevent directory traversal.
        normalized = str(prefix or "").strip().replace("\\", "/").lstrip("/")
        parts = [part for part in normalized.split("/") if part and part != "."]
        if any(part == ".." for part in parts):
            raise ValueError("Invalid prefix parameter")
        return "/".join(parts)

    def _normalize_object_key(self, key: str) -> str:
        # Same traversal defence as _normalize_prefix but applied to file object keys.
        normalized = str(key or "").strip().replace("\\", "/").lstrip("/")
        parts = [part for part in normalized.split("/") if part and part != "."]
        if any(part == ".." for part in parts):
            raise ValueError("Invalid object key")
        return "/".join(parts)

    def _ensure_within_root(self, root: Path, path: Path) -> None:
        # Security guard: raises if the resolved path escapes the storage root.
        # This prevents directory traversal attacks via crafted file keys.
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise ValueError("Path escapes configured storage root") from exc

    def _derive_parent_folders(self, key: str, normalized_prefix: str) -> Set[str]:
        # Build synthetic folder entries from a file key's path components.
        # The folder rows are not real filesystem entries; they let the UI render
        # a tree without a separate "list directories" API call.
        folders: Set[str] = set()
        parts = [part for part in str(key).split("/") if part]
        if len(parts) <= 1:
            return folders

        running = []
        for part in parts[:-1]:
            running.append(part)
            folder = "/".join(running) + "/"
            if normalized_prefix and not folder.startswith(normalized_prefix):
                continue
            folders.add(folder)
        return folders

    def _build_etag(self, stat_result: os.stat_result) -> str:
        # Create a lightweight etag fingerprint from mtime_ns and file size.
        # Using nanosecond precision mtime avoids false cache hits on fast writes.
        return f"{int(stat_result.st_mtime_ns):x}-{int(stat_result.st_size):x}"

    def resolve_object_path(self, key: str) -> Path:
        root = self.storage_root
        normalized_key = self._normalize_object_key(key)
        if not normalized_key:
            raise ValueError("Object key is required")

        parts = [part for part in normalized_key.split("/") if part]
        path = root.joinpath(*parts).resolve(strict=False)
        # Guard against traversal (`..`) or symlink escapes outside STORAGE_ROOT.
        self._ensure_within_root(root, path)
        return path

    def list_objects(
        self,
        prefix: str = "",
        include_folders: bool = False,
        max_items: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        normalized_prefix = self._normalize_prefix(prefix)
        normalized_max_items = None
        if max_items is not None:
            normalized_max_items = max(1, int(max_items))

        root = self.storage_root
        if not root.exists():
            logger.warning("Storage root does not exist: %s", root)
            return []
        if not root.is_dir():
            raise NotADirectoryError(f"Storage root is not a directory: {root}")

        objects: List[Dict[str, Any]] = []
        folders: Set[str] = set()
        reached_limit = False

        for current_dir, _dirs, files in os.walk(root):
            current_path = Path(current_dir)
            for filename in files:
                file_path = (current_path / filename).resolve(strict=False)
                try:
                    relative = file_path.relative_to(root).as_posix()
                except ValueError:
                    continue

                if normalized_prefix and not relative.startswith(normalized_prefix):
                    continue

                stat_result = file_path.stat()
                objects.append(
                    {
                        "key": relative,
                        "size": int(stat_result.st_size),
                        "last_modified": datetime.fromtimestamp(
                            stat_result.st_mtime, tz=timezone.utc
                        ).isoformat(),
                        "etag": self._build_etag(stat_result),
                        "type": "file",
                        "is_folder": False,
                    }
                )

                if include_folders:
                    # Synthesise virtual folder rows so the UI can show a directory
                    # tree without a separate API for listing subdirectories.
                    folders.update(self._derive_parent_folders(relative, normalized_prefix))

                if normalized_max_items is not None and len(objects) >= normalized_max_items:
                    # Set the early-abort flag and break out of both the inner
                    # (files) and outer (directory walk) loops immediately.
                    reached_limit = True
                    break

            if reached_limit:
                break

        if include_folders and folders:
            folder_entries = [
                {
                    "key": folder,
                    "size": 0,
                    "last_modified": None,
                    "etag": None,
                    "type": "folder",
                    "is_folder": True,
                }
                for folder in sorted(folders)
            ]
            objects.extend(folder_entries)

        return objects

    def get_object_metadata(self, key: str) -> Dict[str, Any]:
        path = self.resolve_object_path(key)
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"Path '{key}' not found")

        stat_result = path.stat()
        content_type, _ = mimetypes.guess_type(str(path))
        return {
            "key": self._normalize_object_key(key),
            "size": int(stat_result.st_size),
            "last_modified": datetime.fromtimestamp(
                stat_result.st_mtime, tz=timezone.utc
            ).isoformat(),
            "etag": self._build_etag(stat_result),
            "content_type": content_type or "application/octet-stream",
        }

    def open_object_stream(self, key: str) -> BinaryIO:
        path = self.resolve_object_path(key)
        return path.open("rb")

    def get_object_range(self, key: str, start: int, end: int) -> bytes:
        if start < 0 or end < start:
            raise ValueError("Invalid range")

        with self.open_object_stream(key) as stream:
            stream.seek(start)
            return stream.read(end - start + 1)


_storage_client: Optional[FilesystemStorageClient] = None


def get_storage_client() -> FilesystemStorageClient:
    # Singleton accessor — the storage client is expensive to construct (resolves
    # environment variables and validates the root path) so we reuse one instance.
    global _storage_client
    if _storage_client is None:
        _storage_client = FilesystemStorageClient()
    return _storage_client

import unittest
from unittest.mock import Mock, patch

from flask import Flask

from src.routes.files import files_bp


class _NullCache:
    def get(self, _key):
        return None

    def set(self, _key, _value):
        return None

    def clear(self):
        return None


class FilesRoutesTestCase(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(files_bp, url_prefix="/files")
        self.client = app.test_client()

    def test_list_files_includes_folder_metadata(self):
        storage = Mock()
        storage.list_objects.return_value = [
            {
                "key": "dataset_a.h5",
                "size": 1024,
                "last_modified": "2026-02-25T10:00:00",
                "etag": "etag-file",
                "type": "file",
                "is_folder": False,
            },
            {
                "key": "archive/",
                "size": 0,
                "last_modified": None,
                "etag": None,
                "type": "folder",
                "is_folder": True,
            },
        ]

        with patch("src.routes.files.get_storage_client", return_value=storage), patch(
            "src.routes.files.get_files_cache", return_value=_NullCache()
        ):
            response = self.client.get("/files/")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["files_count"], 1)
        self.assertEqual(payload["folders_count"], 1)
        self.assertEqual(payload["count"], 2)
        self.assertFalse(payload["cached"])
        storage.list_objects.assert_called_once_with(
            prefix="",
            include_folders=True,
            max_items=20000,
        )

    def test_list_files_rejects_invalid_max_items(self):
        response = self.client.get("/files/?max_items=0")
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertFalse(payload["success"])
        self.assertIn("max_items", payload["error"])


if __name__ == "__main__":
    unittest.main()

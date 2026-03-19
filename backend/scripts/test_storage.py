"""
Quick test script to verify filesystem storage connection and basic operations.
"""

import sys
from dotenv import load_dotenv
from src.storage.filesystem_client import get_storage_client

load_dotenv()


def test_connection():
    """Test storage connection and basic operations."""
    print("Testing storage connection...")
    print("-" * 60)

    try:
        print("Initializing storage client...")
        storage = get_storage_client()
        print(f"  Root: {storage.storage_root}")

        print("\nTesting list_objects()...")
        objects = storage.list_objects()
        print(f"  Found {len(objects)} entries")

        if objects:
            print("\n  First 3 entries:")
            for obj in objects[:3]:
                print(f"    - {obj['key']} ({obj['size']} bytes)")

            print(f"\nTesting get_object_metadata() on '{objects[0]['key']}'...")
            metadata = storage.get_object_metadata(objects[0]["key"])
            print(f"  Size: {metadata['size']} bytes")
            print(f"  Content-Type: {metadata['content_type']}")
            print(f"  Last Modified: {metadata['last_modified']}")

            print(f"\nTesting open_object_stream() on '{objects[0]['key']}'...")
            stream = storage.open_object_stream(objects[0]["key"])
            data = stream.read(100)
            stream.close()
            print(f"  Successfully read {len(data)} bytes")
        else:
            print("\n  No files found in storage root (this is okay if root is empty)")

        print("\n" + "=" * 60)
        print("All tests passed!")
        print("=" * 60)
        return True

    except Exception as exc:
        print(f"\nError: {exc}")
        print("\nPlease check your .env configuration:")
        print("  - STORAGE_ROOT (optional)")
        print("  - STORAGE_PATH_LINUX")
        print("  - STORAGE_PATH_WINDOWS")
        return False


if __name__ == "__main__":
    success = test_connection()
    sys.exit(0 if success else 1)

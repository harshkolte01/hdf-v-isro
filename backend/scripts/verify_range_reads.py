"""
Verification script to ensure filesystem range reads work as expected.
"""

import logging
from dotenv import load_dotenv
from src.storage.filesystem_client import get_storage_client

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def verify_range_reads() -> bool:
    """Verify range reads return exact requested byte windows."""
    logger.info("=" * 60)
    logger.info("VERIFYING FILESYSTEM RANGE READ SUPPORT")
    logger.info("=" * 60)

    try:
        storage = get_storage_client()
        objects = storage.list_objects()

        if not objects:
            logger.error("No files found in storage root.")
            return False

        test_obj = max(objects, key=lambda item: item.get("size", 0))
        test_key = test_obj["key"]
        test_size = int(test_obj["size"])

        logger.info("Testing with file: %s (%s bytes)", test_key, test_size)

        ranges = [
            (0, min(511, max(0, test_size - 1))),
            (max(0, test_size // 2), min(test_size - 1, (test_size // 2) + 1023)),
            (max(0, test_size - 512), max(0, test_size - 1)),
        ]

        for index, (start, end) in enumerate(ranges, start=1):
            if end < start:
                continue
            data = storage.get_object_range(test_key, start, end)
            expected_size = end - start + 1
            logger.info(
                "Range %s: bytes=%s-%s -> read=%s (expected=%s)",
                index,
                start,
                end,
                len(data),
                expected_size,
            )
            if len(data) != expected_size:
                logger.error("Size mismatch for range %s", index)
                return False

        logger.info("All range reads succeeded.")
        return True
    except Exception as exc:
        logger.error("Error during verification: %s", exc)
        return False


if __name__ == "__main__":
    ok = verify_range_reads()
    raise SystemExit(0 if ok else 1)

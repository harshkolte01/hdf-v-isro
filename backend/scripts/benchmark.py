"""
Performance benchmarking script for filesystem storage operations.
Measures latency for listing, metadata reads, and chunk reads.
"""
import os
import time
import logging
from dotenv import load_dotenv
from src.storage.filesystem_client import get_storage_client

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


def measure_time(func, *args, **kwargs):
    """Measure execution time of a function"""
    start = time.perf_counter()
    result = func(*args, **kwargs)
    end = time.perf_counter()
    elapsed_ms = (end - start) * 1000
    return result, elapsed_ms


def benchmark_list_objects():
    """Benchmark listing all files in storage."""
    logger.info("\n" + "="*60)
    logger.info("BENCHMARK 1: List Objects")
    logger.info("="*60)
    
    try:
        storage = get_storage_client()
        
        # Warm-up run
        logger.info("Performing warm-up run...")
        storage.list_objects()
        
        # Actual benchmark runs
        runs = 5
        times = []
        
        for i in range(runs):
            result, elapsed = measure_time(storage.list_objects)
            times.append(elapsed)
            logger.info(f"Run {i+1}: {elapsed:.2f}ms - Found {len(result)} objects")
        
        avg_time = sum(times) / len(times)
        min_time = min(times)
        max_time = max(times)
        
        logger.info(f"\nResults:")
        logger.info(f"  Average: {avg_time:.2f}ms")
        logger.info(f"  Min: {min_time:.2f}ms")
        logger.info(f"  Max: {max_time:.2f}ms")
        logger.info(f"  Assessment: {'✓ INSTANT' if avg_time < 100 else '⚠ SLOW' if avg_time < 500 else '✗ TOO SLOW'}")
        
        return result
        
    except Exception as e:
        logger.error(f"Error during list benchmark: {e}")
        return []


def benchmark_head_request(objects):
    """Benchmark metadata reads for object metadata."""
    logger.info("\n" + "="*60)
    logger.info("BENCHMARK 2: HEAD Request (Get Metadata)")
    logger.info("="*60)
    
    if not objects:
        logger.warning("No objects available for HEAD benchmark")
        return
    
    try:
        storage = get_storage_client()
        
        # Test with first object
        test_key = objects[0]['key']
        logger.info(f"Testing with object: {test_key}")
        
        # Warm-up run
        logger.info("Performing warm-up run...")
        storage.get_object_metadata(test_key)
        
        # Actual benchmark runs
        runs = 10
        times = []
        
        for i in range(runs):
            result, elapsed = measure_time(storage.get_object_metadata, test_key)
            times.append(elapsed)
            logger.info(f"Run {i+1}: {elapsed:.2f}ms - Size: {result['size']} bytes")
        
        avg_time = sum(times) / len(times)
        min_time = min(times)
        max_time = max(times)
        
        logger.info(f"\nResults:")
        logger.info(f"  Average: {avg_time:.2f}ms")
        logger.info(f"  Min: {min_time:.2f}ms")
        logger.info(f"  Max: {max_time:.2f}ms")
        logger.info(f"  Assessment: {'✓ INSTANT' if avg_time < 50 else '⚠ SLOW' if avg_time < 200 else '✗ TOO SLOW'}")
        
    except Exception as e:
        logger.error(f"Error during HEAD benchmark: {e}")


def benchmark_range_read(objects):
    """Benchmark reading a small range from a large file."""
    logger.info("\n" + "="*60)
    logger.info("BENCHMARK 3: Range Read (Small chunk from large file)")
    logger.info("="*60)
    
    if not objects:
        logger.warning("No objects available for range read benchmark")
        return
    
    try:
        storage = get_storage_client()
        
        # Find a reasonably large object (prefer > 1MB)
        large_objects = [obj for obj in objects if obj['size'] > 1024 * 1024]
        if not large_objects:
            large_objects = objects
        
        test_obj = max(large_objects, key=lambda x: x['size'])
        test_key = test_obj['key']
        test_size = test_obj['size']
        
        logger.info(f"Testing with object: {test_key}")
        logger.info(f"Object size: {test_size:,} bytes ({test_size / (1024*1024):.2f} MB)")
        
        # Read different chunk sizes
        chunk_sizes = [1024, 10240, 102400]  # 1KB, 10KB, 100KB
        
        for chunk_size in chunk_sizes:
            if chunk_size > test_size:
                logger.info(f"\nSkipping {chunk_size} byte read (larger than file)")
                continue
                
            logger.info(f"\nReading {chunk_size:,} bytes ({chunk_size/1024:.1f} KB):")
            logger.info("  Opening stream ONCE and performing multiple reads from same handle...")
            
            # Open stream once for all benchmark runs
            stream = storage.open_object_stream(test_key)
            
            # Warm-up read
            logger.info("  Performing warm-up read...")
            stream.read(chunk_size)
            
            # Benchmark runs - reusing the same stream
            runs = 5
            times = []
            
            logger.info(f"  Running {runs} sequential reads from same stream:")
            for i in range(runs):
                start = time.perf_counter()
                data = stream.read(chunk_size)
                elapsed = (time.perf_counter() - start) * 1000
                
                times.append(elapsed)
                throughput = (chunk_size / 1024) / (elapsed / 1000)  # KB/s
                logger.info(f"    Run {i+1}: {elapsed:.2f}ms - Throughput: {throughput:.2f} KB/s - Read {len(data)} bytes")
            
            # Close stream after all reads
            stream.close()
            
            avg_time = sum(times) / len(times)
            min_time = min(times)
            max_time = max(times)
            avg_throughput = (chunk_size / 1024) / (avg_time / 1000)
            
            logger.info(f"  Results:")
            logger.info(f"    Average: {avg_time:.2f}ms")
            logger.info(f"    Min: {min_time:.2f}ms")
            logger.info(f"    Max: {max_time:.2f}ms")
            logger.info(f"    Avg Throughput: {avg_throughput:.2f} KB/s")
            logger.info(f"    Assessment: {'✓ FAST' if avg_time < 100 else '⚠ MODERATE' if avg_time < 500 else '✗ SLOW'}")
        
    except Exception as e:
        logger.error(f"Error during range read benchmark: {e}")


def main():
    """Run all benchmarks"""
    logger.info("="*60)
    logger.info("Filesystem Storage Performance Benchmarking")
    logger.info("="*60)
    logger.info(f"Storage root (linux): {os.getenv('STORAGE_PATH_LINUX')}")
    logger.info(f"Storage root (windows): {os.getenv('STORAGE_PATH_WINDOWS')}")
    logger.info("="*60)
    
    # Benchmark 1: List objects
    objects = benchmark_list_objects()
    
    # Benchmark 2: HEAD request
    if objects:
        benchmark_head_request(objects)
    
    # Benchmark 3: Range read
    if objects:
        benchmark_range_read(objects)
    
    # Final summary
    logger.info("\n" + "="*60)
    logger.info("SUMMARY")
    logger.info("="*60)
    logger.info("Based on these benchmarks, you can determine:")
    logger.info("1. Whether listing is fast enough for real-time UI updates")
    logger.info("2. If metadata fetching can be done on-demand without caching")
    logger.info("3. Expected throughput for streaming HDF5 data chunks")
    logger.info("\nRecommendations:")
    logger.info("- If listing > 500ms: Consider caching file list")
    logger.info("- If HEAD > 200ms: Consider caching metadata")
    logger.info("- If range reads > 500ms: Consider chunking strategy optimization")
    logger.info("="*60)


if __name__ == '__main__':
    main()

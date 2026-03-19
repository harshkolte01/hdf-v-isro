import h5py
import numpy as np
import math

# Utility script that generates synthetic HDF5 test files for local development.
# Each file contains three datasets (2-D, 3-D, 4-D) totalling ~100 MiB of random
# uint8 data so the viewer can be exercised with realistic-sized inputs.

TARGET_SIZE_MB = 100
TARGET_BYTES = TARGET_SIZE_MB * 1024 * 1024  # 100 MiB
DTYPE = np.uint8  # 1 byte per element


def best_2d_shape(n):
    """Find a 2D shape whose product is exactly n, as close to square as possible."""
    r = int(math.isqrt(n))
    while r > 1:
        if n % r == 0:
            return (r, n // r)
        r -= 1
    return (1, n)


def best_3d_shape(n):
    """Find a 3D shape whose product is exactly n, reasonably balanced."""
    a = int(round(n ** (1 / 3)))
    for x in range(a, 0, -1):
        if n % x == 0:
            rem = n // x
            y, z = best_2d_shape(rem)
            return tuple(sorted((x, y, z)))
    return (1, 1, n)


def best_4d_shape(n):
    """Find a 4D shape whose product is exactly n, reasonably balanced."""
    a = int(round(n ** 0.25))
    for w in range(a, 0, -1):
        if n % w == 0:
            rem = n // w
            x, y, z = best_3d_shape(rem)
            return tuple(sorted((w, x, y, z)))
    return (1, 1, 1, n)


def make_data(shape, dtype=np.uint8):
    """Create random data for the given shape."""
    return np.random.randint(0, 256, size=shape, dtype=dtype)


def create_hdf5_file(filename):
    # Divide total byte budget roughly equally across three datasets of different
    # dimensionality so test files exercise 2-D, 3-D, and 4-D viewer code paths.
    n2 = TARGET_BYTES // 3
    n3 = TARGET_BYTES // 3
    n4 = TARGET_BYTES - n2 - n3  # remaining bytes

    shape2d = best_2d_shape(n2)
    shape3d = best_3d_shape(n3)
    shape4d = best_4d_shape(n4)

    print(f"\nCreating {filename}")
    print(f"  2D shape: {shape2d}, elements: {np.prod(shape2d)}")
    print(f"  3D shape: {shape3d}, elements: {np.prod(shape3d)}")
    print(f"  4D shape: {shape4d}, elements: {np.prod(shape4d)}")

    with h5py.File(filename, "w") as f:
        f.create_dataset("array_2d", data=make_data(shape2d, DTYPE), dtype=DTYPE)
        f.create_dataset("array_3d", data=make_data(shape3d, DTYPE), dtype=DTYPE)
        f.create_dataset("array_4d", data=make_data(shape4d, DTYPE), dtype=DTYPE)

    print(f"  Done: {filename}")


if __name__ == "__main__":
    for fname in ["sample.h5", "sample.hdf", "sample.hdf5"]:
        create_hdf5_file(fname)

    print("\nAll files created successfully.")
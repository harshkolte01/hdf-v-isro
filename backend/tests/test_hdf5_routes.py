import unittest
from unittest.mock import Mock, patch

from flask import Flask

from src.routes.hdf5 import hdf5_bp


class _NullCache:
    def get(self, _key):
        return None

    def set(self, _key, _value):
        return None


class _MemoryCache:
    def __init__(self):
        self._store = {}

    def get(self, key):
        return self._store.get(key)

    def set(self, key, value):
        self._store[key] = value


class Hdf5RoutesTestCase(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(hdf5_bp, url_prefix='/files')
        self.client = app.test_client()

    def test_data_line_allows_large_source_when_downsampled(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [5_000_000],
            'ndim': 1,
            'dtype': 'float32'
        }
        reader.get_line.return_value = {
            'dtype': 'float32',
            'data': [0.1, 0.2, 0.3],
            'shape': [5000],
            'axis': 'dim',
            'index': None,
            'downsample_info': {'step': 1000}
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get('/files/sample.h5/data?path=/array_1d&mode=line')

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertEqual(payload['line_limit'], 5_000_000)
        self.assertEqual(payload['quality_requested'], 'auto')
        self.assertEqual(payload['quality_applied'], 'overview')
        self.assertEqual(payload['requested_points'], 5_000_000)
        self.assertEqual(payload['downsample_info']['step'], 1000)
        reader.get_line.assert_called_once()
        args = reader.get_line.call_args[0]
        self.assertEqual(args[7], 5_000_000)  # line_limit
        self.assertEqual(args[8], 1000)  # line_step

    def test_data_line_exact_mode_small_window(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [10_000],
            'ndim': 1,
            'dtype': 'float32'
        }
        reader.get_line.return_value = {
            'dtype': 'float32',
            'data': [1.0, 2.0, 3.0, 4.0],
            'shape': [4],
            'axis': 'dim',
            'index': None,
            'downsample_info': {'step': 1}
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get(
                '/files/sample.h5/data'
                '?path=/array_1d'
                '&mode=line'
                '&quality=exact'
                '&line_offset=100'
                '&line_limit=4'
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertEqual(payload['quality_requested'], 'exact')
        self.assertEqual(payload['quality_applied'], 'exact')
        self.assertEqual(payload['line_step'], 1)
        self.assertEqual(payload['requested_points'], 4)
        self.assertEqual(payload['returned_points'], 4)

        reader.get_line.assert_called_once()
        args = reader.get_line.call_args[0]
        self.assertEqual(args[7], 4)  # line_limit
        self.assertEqual(args[8], 1)  # line_step

    def test_data_line_exact_mode_rejects_large_window(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [2_000_000],
            'ndim': 1,
            'dtype': 'float32'
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get(
                '/files/sample.h5/data'
                '?path=/array_1d'
                '&mode=line'
                '&quality=exact'
                '&line_limit=500000'
            )

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertFalse(payload['success'])
        self.assertIn('Exact line window exceeds', payload['error'])

    def test_data_heatmap_auto_clamps_max_size(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [5000, 5000],
            'ndim': 2,
            'dtype': 'float32'
        }
        reader.get_heatmap.return_value = {
            'dtype': 'float32',
            'data': [[1.0]],
            'shape': [1, 1],
            'stats': {'min': 1.0, 'max': 1.0},
            'row_offset': 0,
            'col_offset': 0,
            'downsample_info': {'row_step': 8, 'col_step': 8},
            'sampled': True
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get('/files/sample.h5/data?path=/array_2d&mode=heatmap&max_size=1024')

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertTrue(payload['max_size_clamped'])
        self.assertEqual(payload['requested_max_size'], 1024)
        self.assertEqual(payload['effective_max_size'], 707)
        reader.get_heatmap.assert_called_once()
        args, kwargs = reader.get_heatmap.call_args
        self.assertEqual(args[4], 707)
        self.assertTrue(kwargs['include_stats'])

    def test_data_heatmap_can_disable_stats(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [1024, 1024],
            'ndim': 2,
            'dtype': 'float32'
        }
        reader.get_heatmap.return_value = {
            'dtype': 'float32',
            'data': [[1.0]],
            'shape': [1, 1],
            'stats': {'min': None, 'max': None},
            'row_offset': 0,
            'col_offset': 0,
            'downsample_info': {'row_step': 2, 'col_step': 2},
            'sampled': True
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get(
                '/files/sample.h5/data'
                '?path=/array_2d'
                '&mode=heatmap'
                '&max_size=512'
                '&include_stats=0'
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        reader.get_heatmap.assert_called_once()
        _, kwargs = reader.get_heatmap.call_args
        self.assertFalse(kwargs['include_stats'])

    def test_data_normalizes_negative_fixed_indices(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [10, 20, 30],
            'ndim': 3,
            'dtype': 'float32'
        }
        reader.get_matrix.return_value = {
            'dtype': 'float32',
            'data': [[1.0]],
            'shape': [1, 1],
            'row_offset': 0,
            'col_offset': 0,
            'downsample_info': {'row_step': 1, 'col_step': 1}
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get(
                '/files/sample.h5/data'
                '?path=/array_3d'
                '&mode=matrix'
                '&display_dims=1,2'
                '&fixed_indices=0=-1'
                '&row_limit=1'
                '&col_limit=1'
            )

        self.assertEqual(response.status_code, 200)
        reader.get_matrix.assert_called_once()
        args = reader.get_matrix.call_args[0]
        self.assertEqual(args[2], (1, 2))  # display_dims
        self.assertEqual(args[3], {0: 9})  # normalized fixed_indices

    def test_data_not_found_returns_404(self):
        reader = Mock()
        reader.get_dataset_info.side_effect = ValueError("Path '/missing' not found in 'sample.h5'")

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader):
            response = self.client.get('/files/sample.h5/data?path=/missing&mode=line')

        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertFalse(payload['success'])

    def test_children_not_found_returns_404(self):
        reader = Mock()
        reader.get_children.side_effect = ValueError("Path '/missing' not found in 'sample.h5'")
        storage = Mock()
        storage.get_object_metadata.return_value = {'etag': 'etag-1'}

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_storage_client', return_value=storage), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_NullCache()):
            response = self.client.get('/files/sample.h5/children?path=/missing')

        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertFalse(payload['success'])

    def test_children_decodes_encoded_key_segments(self):
        reader = Mock()
        reader.get_children.return_value = []
        storage = Mock()
        storage.get_object_metadata.return_value = {'etag': 'etag-1'}

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_storage_client', return_value=storage), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_NullCache()):
            response = self.client.get('/files/Folder_1%2Frandom_05.h5/children?path=/')

        self.assertEqual(response.status_code, 200)
        storage.get_object_metadata.assert_called_once_with('Folder_1/random_05.h5')
        reader.get_children.assert_called_once_with('Folder_1/random_05.h5', '/')

    def test_meta_not_found_returns_404(self):
        reader = Mock()
        reader.get_metadata.side_effect = ValueError("Path '/missing' not found in 'sample.h5'")
        storage = Mock()
        storage.get_object_metadata.return_value = {'etag': 'etag-1'}

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_storage_client', return_value=storage), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_NullCache()):
            response = self.client.get('/files/sample.h5/meta?path=/missing')

        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertFalse(payload['success'])

    def test_meta_non_dataset_returns_400(self):
        reader = Mock()
        reader.get_metadata.side_effect = TypeError("Path '/group' is not a dataset")
        storage = Mock()
        storage.get_object_metadata.return_value = {'etag': 'etag-1'}

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_storage_client', return_value=storage), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_NullCache()):
            response = self.client.get('/files/sample.h5/meta?path=/group')

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertFalse(payload['success'])

    def test_preview_invalid_display_dims_returns_400(self):
        reader = Mock()
        reader.get_preview.side_effect = ValueError("display_dims must include two distinct dims")
        storage = Mock()
        storage.get_object_metadata.return_value = {'etag': 'etag-1'}

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_storage_client', return_value=storage), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_NullCache()), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_NullCache()):
            response = self.client.get(
                '/files/sample.h5/preview?path=/array_3d&display_dims=1,1'
            )

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertFalse(payload['success'])
        self.assertIn('display_dims', payload['error'])

    def test_preview_not_found_returns_404(self):
        reader = Mock()
        reader.get_preview.side_effect = ValueError("Path '/missing' not found in 'sample.h5'")
        storage = Mock()
        storage.get_object_metadata.return_value = {'etag': 'etag-1'}

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_storage_client', return_value=storage), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_NullCache()), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_NullCache()):
            response = self.client.get('/files/sample.h5/preview?path=/missing')

        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertFalse(payload['success'])

    def test_data_uses_response_cache_on_repeat(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [1000],
            'ndim': 1,
            'dtype': 'float32'
        }
        reader.get_line.return_value = {
            'dtype': 'float32',
            'data': [1.0, 2.0, 3.0],
            'shape': [3],
            'axis': 'dim',
            'index': None,
            'downsample_info': {'step': 1}
        }

        dataset_cache = _MemoryCache()
        data_cache = _MemoryCache()

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=dataset_cache), \
             patch('src.routes.hdf5.get_data_cache', return_value=data_cache):
            first = self.client.get('/files/sample.h5/data?path=/cached_line&mode=line&line_limit=3')
            second = self.client.get('/files/sample.h5/data?path=/cached_line&mode=line&line_limit=3')

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        first_payload = first.get_json()
        second_payload = second.get_json()

        self.assertFalse(first_payload['cached'])
        self.assertTrue(second_payload['cached'])
        self.assertEqual(first_payload['cache_version'], 'ttl')
        self.assertEqual(second_payload['cache_version'], 'ttl')

        reader.get_dataset_info.assert_called_once()
        reader.get_line.assert_called_once()

    def test_preview_works_without_head_and_uses_ttl_cache_version(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [10],
            'ndim': 1,
            'dtype': 'float32'
        }
        reader.get_preview.return_value = {
            'key': 'sample.h5',
            'path': '/array_1d',
            'dtype': 'float32',
            'shape': [10],
            'ndim': 1,
            'preview_type': '1d',
            'mode': 'auto',
            'display_dims': None,
            'fixed_indices': {},
            'stats': {'supported': True, 'min': 1.0, 'max': 10.0},
            'table': {'kind': '1d', 'values': [1.0, 2.0]},
            'plot': {'type': 'line', 'x': [0, 1], 'y': [1.0, 2.0]},
            'profile': None,
            'limits': {}
        }

        dataset_cache = _MemoryCache()
        preview_cache = _MemoryCache()

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=dataset_cache), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=preview_cache):
            response = self.client.get('/files/sample.h5/preview?path=/array_1d')

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertFalse(payload['cached'])
        self.assertEqual(payload['cache_version'], 'ttl')

        reader.get_dataset_info.assert_not_called()
        reader.get_preview.assert_called_once()
        _, kwargs = reader.get_preview.call_args
        self.assertEqual(kwargs['detail'], 'full')
        self.assertTrue(kwargs['include_stats'])

    def test_preview_fast_detail_forwards_reader_flags(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [10],
            'ndim': 1,
            'dtype': 'float32'
        }
        reader.get_preview.return_value = {
            'key': 'sample.h5',
            'path': '/array_1d',
            'dtype': 'float32',
            'shape': [10],
            'ndim': 1,
            'preview_type': '1d',
            'mode': 'line',
            'detail': 'fast',
            'display_dims': None,
            'fixed_indices': {},
            'stats': {'supported': False, 'reason': 'disabled'},
            'table': None,
            'plot': {'type': 'line', 'x': [0, 1], 'y': [1.0, 2.0]},
            'profile': None,
            'limits': {}
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_MemoryCache()), \
             patch('src.routes.hdf5.get_hdf5_cache', return_value=_MemoryCache()):
            response = self.client.get(
                '/files/sample.h5/preview'
                '?path=/array_1d'
                '&mode=line'
                '&detail=fast'
                '&include_stats=0'
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        reader.get_preview.assert_called_once()
        _, kwargs = reader.get_preview.call_args
        self.assertEqual(kwargs['mode'], 'line')
        self.assertEqual(kwargs['detail'], 'fast')
        self.assertFalse(kwargs['include_stats'])

    def test_preview_rejects_invalid_detail(self):
        response = self.client.get('/files/sample.h5/preview?path=/array_1d&detail=ultra')
        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertFalse(payload['success'])
        self.assertIn('detail', payload['error'])

    def test_export_csv_matrix_streams_requested_window(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [4, 5],
            'ndim': 2,
            'dtype': 'float32'
        }

        def matrix_side_effect(_key, _path, _display_dims, _fixed_indices, row_offset, row_limit, col_offset, col_limit, row_step=1, col_step=1):
            data = []
            for row in range(row_limit):
                data.append([
                    float((row_offset + row) * 10 + (col_offset + col))
                    for col in range(col_limit)
                ])
            return {
                'dtype': 'float32',
                'data': data,
                'shape': [row_limit, col_limit],
                'row_offset': row_offset,
                'col_offset': col_offset,
                'downsample_info': {'row_step': row_step, 'col_step': col_step}
            }

        reader.get_matrix.side_effect = matrix_side_effect

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_MemoryCache()):
            response = self.client.get(
                '/files/sample.h5/export/csv'
                '?path=/array_2d'
                '&mode=matrix'
                '&row_limit=2'
                '&col_limit=3'
                '&chunk_rows=1'
                '&chunk_cols=2'
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        self.assertIn('row\\col,0,1,2', body)
        self.assertIn('0,0.0,1.0,2.0', body)
        self.assertIn('1,10.0,11.0,12.0', body)
        self.assertGreaterEqual(reader.get_matrix.call_count, 2)

    def test_export_csv_line_supports_compare_paths(self):
        reader = Mock()

        def dataset_info_side_effect(_key, path):
            if path == '/cmp':
                return {'shape': [10], 'ndim': 1, 'dtype': 'float32'}
            return {'shape': [10], 'ndim': 1, 'dtype': 'float32'}

        reader.get_dataset_info.side_effect = dataset_info_side_effect

        def line_side_effect(_key, path, _display_dims, _fixed_indices, _line_dim, _line_index, line_offset, line_limit, _line_step):
            base = 100 if path == '/cmp' else 0
            data = [base + line_offset + idx for idx in range(line_limit)]
            return {
                'dtype': 'float32',
                'data': data,
                'shape': [line_limit],
                'axis': 'dim',
                'index': None,
                'downsample_info': {'step': 1}
            }

        reader.get_line.side_effect = line_side_effect

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_MemoryCache()):
            response = self.client.get(
                '/files/sample.h5/export/csv'
                '?path=/base'
                '&mode=line'
                '&line_limit=4'
                '&chunk_points=2'
                '&compare_paths=/cmp'
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        self.assertIn('index,base,cmp', body)
        self.assertIn('0,0,100', body)
        self.assertIn('3,3,103', body)
        # two chunks, base + compare each chunk
        self.assertEqual(reader.get_line.call_count, 4)

    def test_export_csv_escapes_formula_like_cells(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [1, 1],
            'ndim': 2,
            'dtype': 'object'
        }
        reader.get_matrix.return_value = {
            'dtype': 'object',
            'data': [['=2+2']],
            'shape': [1, 1],
            'row_offset': 0,
            'col_offset': 0,
            'downsample_info': {'row_step': 1, 'col_step': 1}
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_MemoryCache()):
            response = self.client.get(
                '/files/sample.h5/export/csv'
                '?path=/array_2d'
                '&mode=matrix'
                '&row_limit=1'
                '&col_limit=1'
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        self.assertIn("0,'=2+2", body)

    def test_export_csv_heatmap_mode_uses_full_matrix_slice(self):
        reader = Mock()
        reader.get_dataset_info.return_value = {
            'shape': [3, 3],
            'ndim': 2,
            'dtype': 'float32'
        }
        reader.get_heatmap = Mock()
        reader.get_matrix.return_value = {
            'dtype': 'float32',
            'data': [[1.0, 2.0], [3.0, 4.0]],
            'shape': [2, 2],
            'row_offset': 0,
            'col_offset': 0,
            'downsample_info': {'row_step': 1, 'col_step': 1}
        }

        with patch('src.routes.hdf5.get_hdf5_reader', return_value=reader), \
             patch('src.routes.hdf5.get_dataset_cache', return_value=_MemoryCache()):
            response = self.client.get(
                '/files/sample.h5/export/csv'
                '?path=/array_2d'
                '&mode=heatmap'
                '&row_limit=2'
                '&col_limit=2'
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        self.assertIn('row\\col,0,1', body)
        self.assertIn('0,1.0,2.0', body)
        self.assertIn('1,3.0,4.0', body)
        reader.get_matrix.assert_called()
        reader.get_heatmap.assert_not_called()


if __name__ == '__main__':
    unittest.main()


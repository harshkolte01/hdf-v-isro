# Operations And Runbook

## Local run

From `backend/`:

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Service default URL:
- `http://localhost:5000`

## Environment variables

Required storage config:
- `STORAGE_ROOT`
- or `STORAGE_PATH_LINUX` / `STORAGE_PATH_WINDOWS`

Optional service config:
- `HOST`
- `PORT`
- `DEBUG`

## Production entry

Use `backend/wsgi.py`.

Example:

```bash
gunicorn wsgi:app --bind 0.0.0.0:5000
```

## Health checks

- `GET /health` should return 200 with:
  - `status: healthy`
  - `timestamp`

## Common troubleshooting

### 1) Startup error: missing storage configuration

Cause:
- no valid path in `STORAGE_ROOT`, `STORAGE_PATH_LINUX`, `STORAGE_PATH_WINDOWS`

Fix:
- set at least one valid path
- ensure service process can read that path

### 2) Listing returns empty array

Possible causes:
- storage root exists but contains no files
- wrong root path
- process lacks read permissions

### 3) 404 on `/files/<key>/...`

Possible causes:
- key does not exist under configured storage root
- HDF5 internal `path` does not exist

### 4) 400 on `/data` or `/export/csv`

Likely causes:
- invalid parameter type or range
- selection exceeds hard limits
- unsupported mode/value

### 5) Slow responses

Checks:
- dataset size and requested window size
- cache hit/miss behavior
- chunk parameters for CSV export

## Safe change checklist

Before merging backend changes:

1. Run unit tests.
2. Confirm README and docs are updated.
3. Verify one happy-path call for each route category.
4. Verify limit and error behavior for invalid inputs.

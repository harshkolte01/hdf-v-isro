# Backend Docs

Backend documentation for `backend/`.

## Start here

- `BACKEND.md` - quick onboarding guide (what this backend is and how to run it)
- `BACKEND_IMPLEMENTATION.md` - end-to-end implementation walkthrough
- `API_REFERENCE.md` - endpoint contracts and parameter rules
- `CACHING_AND_LIMITS.md` - cache behavior, limits, and performance guardrails
- `FILE_MAP.md` - file-by-file ownership map
- `OPERATIONS_AND_RUNBOOK.md` - run, deploy, and troubleshoot guide
- `TESTING_AND_SCRIPTS.md` - tests and local helper scripts
- `BACKEND_EXPORT_IMPLEMENTATION_PLAN.md` - CSV export implementation notes

## Audience

These docs are written for:
- new developers joining the project
- reviewers validating API/backend behavior
- maintainers debugging data path and cache behavior

## Source of truth

The implementation itself is in:
- `backend/app.py`
- `backend/src/routes/*.py`
- `backend/src/readers/hdf5_reader.py`
- `backend/src/storage/filesystem_client.py`
- `backend/src/utils/cache.py`

If docs and code disagree, code wins. Update docs in the same change whenever behavior changes.

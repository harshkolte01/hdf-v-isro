# SPA Metadata Implementation

## 1. Scope

This document explains how metadata is loaded, stored, rendered, and styled in the SPA frontend.

Metadata in this SPA lives in the sidebar, below the tree. It is not treated as a separate main-panel tab anymore.

The metadata feature covers:

- backend `/meta` calls
- metadata caching
- metadata loading/error state
- sidebar rendering
- summary row formatting
- raw JSON display

## 2. Main files and modules

Metadata behavior is mainly implemented in:

- `spa-single-page/script.js`
  - `api/contracts`
  - `api/hdf5Service`
  - `state/reducers/dataActions`
  - `components/viewerPanel/render/sections`
  - `components/sidebarTree`
  - `views/viewerView`

- `spa-single-page/style.css`
  - `.sidebar-metadata-panel`
  - `.metadata-simple`
  - `.info-row`
  - `.json-view`

## 3. Backend contract used by metadata

Metadata is fetched from:

```text
GET /files/<key>/meta?path=<hdf5-path>
```

Frontend normalization happens in:

- `normalizeMetaResponse(payload)`

Important behavior:

- `metadata` is kept largely raw
- the frontend does not remap every metadata field into a rigid schema
- summary rows are selected later during rendering

This is intentional because dataset metadata can vary by file and dtype.

## 4. State fields that drive metadata

The metadata feature uses these state fields:

- `metadata`
- `metadataLoading`
- `metadataError`
- `selectedFile`
- `selectedPath`

Meaning:

- `metadata`
  - latest metadata object for the active tree selection

- `metadataLoading`
  - drives loading UI in the sidebar

- `metadataError`
  - drives error UI in the sidebar

Metadata rendering is purely state-derived.

## 5. Where metadata loads are triggered

Metadata is loaded in several places.

### 5.1 On file open

`filesActions.openViewer(...)` immediately calls:

- `actions.loadMetadata("/")`

This primes the sidebar with root-level metadata as soon as the file opens.

### 5.2 On tree selection

`treeActions.selectTreeNode(...)` calls:

- `actions.loadMetadata(normalizedPath)`

for both:

- groups
- datasets

### 5.3 On breadcrumb navigation

`treeActions.onBreadcrumbSelect(...)` also calls:

- `actions.loadMetadata(normalizedPath)`

This keeps the sidebar in sync with breadcrumb-based navigation.

### 5.4 On forced view mode sync

`viewActions.setViewMode(...)` also triggers metadata reloads, although the SPA keeps the main panel in display mode.

## 6. Metadata API service

Metadata fetching is wrapped by:

- `api/hdf5Service.getFileMeta(key, path, options)`

Important behavior:

- uses an LRU cache
- cache key is:
  - `fileKey|path|etag`
- adds frontend cache reuse on top of backend cache reuse

If metadata is appearing stale, inspect:

- selected file etag propagation
- `getFileMeta(...)`
- backend `/meta` cache behavior

## 7. Metadata loading flow

The actual reducer action is:

- `dataActions.loadMetadata(path = null)`

Flow:

1. resolve target path from input or `state.selectedPath`
2. bail out if no file is selected
3. set:
   - `metadataLoading = true`
   - `metadataError = null`
4. call `getFileMeta(selectedFile, targetPath, { etag })`
5. when response returns, verify selection is still current
6. if still current:
   - write `metadata`
   - clear loading state
   - store metadata snapshot in `cacheResponses.meta`
7. on failure:
   - verify selection is still current
   - set `metadataError`

That stale-selection guard is important. It prevents an old request from overwriting metadata after the user has already navigated elsewhere.

## 8. Metadata rendering

Rendering is centralized in:

- `renderMetadataPanelContent(state, options)`

This is the main metadata renderer used by both:

- the sidebar metadata block
- any legacy inspect-panel callers

### 8.1 Render states

The renderer supports four states:

1. no selection yet
2. loading
3. error
4. loaded metadata

This means any metadata UI change should usually happen in this single function first.

### 8.2 Summary rows

When metadata exists, `renderMetadataPanelContent(...)` builds an `infoRows` array.

Current summary rows include:

- `Name`
- `Path`
- `Kind`
- `Children` when present
- `Type`
- `Shape`
- `Dimensions`
- `Total Elements`
- `DType`
- `Chunks`
- `Compression`

These rows are rendered as simple label/value pairs.

Important detail:

- the function decides which rows appear based on field presence
- this is where developer-facing metadata formatting should be changed

### 8.3 Raw JSON block

After the summary rows, the renderer shows:

- `Raw JSON`
- full `JSON.stringify(meta, null, 2)`

This makes debugging easier because a developer can still inspect the original metadata object even if the summary rows do not expose a specific field.

## 9. Sidebar integration

The metadata panel is inserted into the sidebar by:

- `components/sidebarTree.renderSidebarMetadata(state)`

That function simply delegates markup generation to:

- `renderMetadataPanelContent(...)`

So the integration is:

```text
loadMetadata()
  -> state.metadata updated
  -> renderSidebarMetadata(state)
  -> renderMetadataPanelContent(state)
  -> sidebar metadata HTML
```

## 10. Formatting and helper behavior

Metadata rendering relies on helper functions from the render module, for example:

- `formatTypeDescription(...)`
- `formatValue(...)`
- `escapeHtml(...)`

If metadata text formatting looks wrong, inspect the render helper layer before changing the backend contract.

## 11. CSS surfaces for metadata

Metadata styling is mostly under sidebar-specific selectors in `style.css`:

- `.sidebar-metadata-panel`
- `.sidebar-metadata-panel .panel-state`
- `.sidebar-metadata-panel .metadata-simple`
- `.sidebar-metadata-panel .info-row`
- `.sidebar-metadata-panel .info-label`
- `.sidebar-metadata-panel .info-value`
- `.sidebar-metadata-panel .info-value.mono`
- `.sidebar-metadata-panel .info-section-title`
- `.sidebar-metadata-panel .json-view`

There is also a shared:

- `.metadata-simple`

Use CSS for:

- spacing
- scroll behavior
- font treatment for monospaced rows
- JSON block readability

## 12. What to change where

### 12.1 Add or remove summary rows

Edit:

- `renderMetadataPanelContent(...)`

This is the right place for:

- new rows
- changed labels
- new conditional visibility rules

### 12.2 Change the raw JSON block

Edit:

- `renderMetadataPanelContent(...)`
- `.json-view` styles in `style.css`

### 12.3 Change metadata fetch behavior or caching

Edit:

- `api/hdf5Service.getFileMeta(...)`
- `dataActions.loadMetadata(...)`

### 12.4 Change when metadata loads

Edit the call sites:

- `filesActions.openViewer(...)`
- `treeActions.selectTreeNode(...)`
- `treeActions.onBreadcrumbSelect(...)`
- `viewActions.setViewMode(...)`

### 12.5 Support new backend metadata fields

If the backend adds new fields:

1. ensure they arrive inside `normalizeMetaResponse(...)`
2. render them in `renderMetadataPanelContent(...)`
3. add CSS only if layout needs to change

### 12.6 Change loading/error UI

Edit:

- `renderMetadataPanelContent(...)`
- metadata-related selectors in `style.css`

## 13. Safe change recipes

### Example: show filter information as a dedicated row

Edit:

1. `renderMetadataPanelContent(...)`
2. read `meta.filters`
3. format the filter names into a readable string
4. add a new `infoRows.push(...)`

Do not change reducers unless the data-loading contract also changes.

### Example: hide the raw JSON block for end users

Edit:

- `renderMetadataPanelContent(...)`

You can:

- remove the JSON section entirely
- gate it behind a debug flag
- collapse it behind a details control

### Example: fetch metadata only for datasets, not groups

Edit:

- `treeActions.selectTreeNode(...)`
- `treeActions.onBreadcrumbSelect(...)`
- `filesActions.openViewer(...)` if root metadata should also be skipped

### Example: add custom formatting for shapes and chunks

Edit:

- `renderMetadataPanelContent(...)`
- helper formatting functions used there

## 14. Developer cautions

- metadata is selection-sensitive, so stale-request guards matter
- do not write directly into `state.metadata`
- raw metadata is intentionally preserved; avoid over-normalizing unless the backend contract is stable
- sidebar metadata rendering is shared and centralized; do not duplicate metadata markup in another component

## 15. Summary

Metadata implementation is simple but important:

- `getFileMeta(...)` fetches and caches raw metadata
- `loadMetadata(...)` protects state from stale async updates
- `renderMetadataPanelContent(...)` decides what the user sees
- `renderSidebarMetadata(...)` mounts that content in the sidebar

If a developer needs to change metadata behavior, the first files to inspect are:

- `api/hdf5Service.getFileMeta(...)`
- `state/reducers/dataActions.loadMetadata(...)`
- `components/viewerPanel/render/sections.renderMetadataPanelContent(...)`
- metadata selectors in `style.css`

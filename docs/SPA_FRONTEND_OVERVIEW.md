# SPA Frontend Overview

## 1. Purpose

This document explains how the SPA frontend is implemented under `spa-single-page/`, how the large `script.js` file is organized, how data moves from the backend into the UI, and where a developer should make changes for each class of frontend behavior.

The SPA is not built with React, Vue, or any bundler-managed component framework. It is a plain HTML/CSS/JavaScript application that uses:

- a fixed HTML shell in `spa-single-page/index.html`
- one large concatenated stylesheet in `spa-single-page/style.css`
- one large concatenated runtime in `spa-single-page/script.js`

## 2. Frontend files

```text
spa-single-page/
  index.html     # Static shell: sidebar, topbar, subbar, main panel, status nodes
  style.css      # Concatenated styles for shell, tree, metadata, matrix, line, image, heatmap
  script.js      # Entire SPA runtime: config, API client, store, reducers, renderers, runtimes, boot
```

## 3. Core implementation style

The frontend is implemented as a set of self-contained plain-script modules inside `script.js`.

Each module:

- is wrapped in an IIFE
- writes into `window.HDFViewer`
- usually registers itself with `ns.core.registerModule("module/id")`
- can expose helpers globally for later modules

This means `script.js` is effectively a manual module bundle.

Important consequence for maintenance:

- do not treat `script.js` as one random file
- always edit the correct module block identified by its leading comment and `registerModule(...)` name

## 4. High-level architecture

The SPA has six layers:

1. Runtime bootstrap/config
   - reads `window.__CONFIG__`
   - resolves backend base URL

2. Core helpers
   - namespace creation
   - DOM reference helpers
   - formatting helpers
   - export helpers

3. API layer
   - raw fetch client
   - backend payload normalization
   - frontend-side request/data caching

4. State layer
   - one mutable global state object
   - reducer-style action factories
   - state subscriptions

5. Render layer
   - tree/sidebar markup
   - metadata markup
   - preview and runtime shell markup
   - toolbar and export menu markup

6. Runtime layer
   - matrix virtual scrolling
   - line chart interaction
   - heatmap/image canvas interaction
   - image histogram interaction

The boot module (`app-viewer`) wires these layers together.

## 5. Boot flow

When the page loads, the SPA works in this order:

1. `window.__CONFIG__.API_BASE_URL` is initialized at the top of `script.js`
2. the `HDFViewer` namespace and module registry are created
3. config, DOM, utility, API, state, component, and view modules register themselves
4. `app-viewer` verifies required modules and required DOM IDs
5. `app-viewer` subscribes the render loop to state changes
6. `app-viewer` reads `?file=` from the browser URL
7. if `file` exists, `openViewer()` is called
8. `openViewer()` resets viewer state and starts loading tree + metadata
9. later selections load preview data and then full runtimes

The app is deep-link driven. The intended contract is:

```text
spa-single-page/index.html?file=<backend-object-key>
```

## 6. HTML shell responsibilities

`index.html` only defines the shell. It does not contain feature logic.

Main regions:

- `#viewer-app`
  - root container

- `#viewer-sidebar`
  - tree panel
  - metadata panel

- `#viewer-topbar`
  - sidebar toggle
  - breadcrumb path
  - back/fullscreen buttons

- `#viewer-subbar`
  - tabs and mode actions

- `#viewer-panel`
  - display content mount
  - status nodes

The JS layer rewrites much of this markup during rendering, but the IDs must exist or boot fails.

## 7. CSS organization

`style.css` is a concatenated stylesheet with section comments.

Main style groups:

- shell and layout
- tree and sidebar
- metadata panel
- subbar/tabs/export menu
- preview sidebar and dimension controls
- matrix table runtime
- line chart
- heatmap/image canvas
- histogram
- responsive and large-screen overrides

If behavior is correct but layout is wrong, the fix is usually in `style.css`, not `script.js`.

## 8. JavaScript module map

Important module groups inside `script.js`:

### 8.1 Core and config

- `core/namespace`
- `core/config`
- `core/domRefs`
- `utils/format`
- `utils/lru`
- `utils/export`

Use these when changing:

- API base URL behavior
- required DOM IDs
- shared formatters
- client-side cache implementation
- PNG/SVG export helpers

### 8.2 API modules

- `api/client`
- `api/contracts`
- `api/hdf5Service`

Use these when changing:

- fetch request behavior
- request cancellation
- response normalization
- frontend cache key rules
- backend contract mapping

### 8.3 State modules

- `state/store`
- `state/reducers/utils`
- `state/reducers/filesActions`
- `state/reducers/treeActions`
- `state/reducers/viewActions`
- `state/reducers/displayConfigActions`
- `state/reducers/dataActions`
- `state/reducers/compareActions`
- `state/reducers`

Use these when changing:

- what state exists
- what happens after a user action
- when preview/metadata/tree reloads occur
- compare-mode validation
- dimension/slice behavior

### 8.4 Render modules

- `components/sidebarTree`
- `components/viewerPanel/render/config`
- `components/viewerPanel/render/previews`
- `components/viewerPanel/render/dimensionControls`
- `components/viewerPanel/render/sections`
- `components/viewerPanel/render`
- `components/viewerPanel`
- `views/viewerView`

Use these when changing:

- HTML markup
- what appears in each panel
- fast preview appearance
- which controls are rendered
- export menu placement

### 8.5 Runtime modules

- `components/viewerPanel/runtime/common`
- `components/viewerPanel/runtime/matrixRuntime`
- `components/viewerPanel/runtime/lineRuntime`
- `components/viewerPanel/runtime/heatmapRuntime`
- `components/viewerPanel/runtime/imageHistogramRuntime`
- `components/viewerPanel/runtime/bindEvents`
- `components/viewerPanel/runtime`

Use these when changing:

- zoom/pan behavior
- canvas drawing
- line data windowing
- linked line plots
- runtime export behavior
- runtime event wiring

## 9. Global state model

The SPA uses one mutable state object in `state/store`.

The most important top-level fields are:

- file/session state
  - `route`
  - `viewerBlocked`
  - `selectedFile`
  - `selectedFileEtag`

- tree state
  - `selectedPath`
  - `selectedNodeType`
  - `expandedPaths`
  - `childrenCache`
  - `treeLoadingPaths`
  - `treeErrors`

- sidebar metadata and preview state
  - `metadata`
  - `metadataLoading`
  - `metadataError`
  - `preview`
  - `previewLoading`
  - `previewError`
  - `previewRequestKey`

- view state
  - `displayTab`
  - `lineGrid`
  - `lineAspect`
  - `lineCompareEnabled`
  - `lineCompareItems`
  - `heatmapGrid`
  - `heatmapColormap`

- full runtime flags
  - `matrixFullEnabled`
  - `lineFullEnabled`
  - `heatmapFullEnabled`

- multidimensional selection state
  - `displayConfig.displayDims`
  - `displayConfig.fixedIndices`
  - `displayConfig.stagedDisplayDims`
  - `displayConfig.stagedFixedIndices`
  - `displayConfig.playingFixedDim`

The render layer is state-derived. Direct DOM mutation should only happen inside runtime modules or controlled render helpers.

## 10. End-to-end request flow

### 10.1 Opening a file

```text
?file=<key>
  -> app-viewer bootstrap
  -> actions.openViewer()
  -> actions.loadTreeChildren("/")
  -> actions.loadMetadata("/")
  -> viewer render
```

### 10.2 Selecting a tree node

```text
tree click
  -> components/sidebarTree event delegation
  -> actions.selectTreeNode(...)
  -> if group: load children + metadata
  -> if dataset: load metadata + preview
  -> render tabs and preview content
```

### 10.3 Loading preview

```text
actions.loadPreview()
  -> build preview params from displayTab + displayConfig
  -> api.hdf5Service.getFilePreview()
  -> normalize payload
  -> stale-request guard
  -> state.preview updated
  -> preview renderer or runtime shell re-renders
```

### 10.4 Entering a full runtime

```text
Load full line / Load high-res / Load full matrix
  -> state flag enabled
  -> render layer emits runtime shell with data-* attributes
  -> runtime binder finds shell
  -> runtime module initializes itself
  -> runtime fetches detailed /data payloads as needed
```

## 11. Where to change what

If you need to change a specific type of behavior, start here:

- Change backend base URL
  - top of `script.js`
  - `core/config`

- Change shell IDs or top-level page structure
  - `index.html`
  - `core/domRefs`
  - `views/viewerView`

- Change request URLs, cache keys, cancellation, or response normalization
  - `api/client`
  - `api/contracts`
  - `api/hdf5Service`

- Change selection flow, reset behavior, or what happens after clicking a node
  - `state/reducers/filesActions`
  - `state/reducers/treeActions`
  - `state/reducers/dataActions`

- Change tabs, controls, or section markup
  - `components/viewerPanel/render/sections`
  - `components/viewerPanel/render/previews`
  - `views/viewerView`

- Change 3D+/N-D slice controls
  - `state/reducers/displayConfigActions`
  - `components/viewerPanel/render/dimensionControls`

- Change full line chart behavior
  - `components/viewerPanel/runtime/lineRuntime`

- Change image/heatmap behavior
  - `components/viewerPanel/runtime/heatmapRuntime`
  - `components/viewerPanel/runtime/imageHistogramRuntime`

- Change visuals only
  - `style.css`

## 12. Safe change process

For this SPA, the safest edit order is:

1. identify the module block by its comment and `registerModule(...)`
2. check whether the change belongs to:
   - state
   - render
   - runtime
   - API/service
   - CSS
3. make the behavioral change in the smallest responsible module
4. only then update matching markup or styles
5. avoid duplicating state logic inside runtime code

## 13. Key maintenance warning

`script.js` contains repeated helper names in different modules, for example:

- `normalizePath`
- `isNumericDtype`
- `buildDisplayDimsParam`
- `render...`

Always edit the copy that belongs to the correct module. The module comment immediately above the function is the reliable guide.

## 14. Related detailed docs

Use the companion docs for feature-specific work:

- `docs/SPA_TREE_IMPLEMENTATION.md`
- `docs/SPA_METADATA_IMPLEMENTATION.md`
- `docs/SPA_LINE_GRAPH_IMPLEMENTATION.md`
- `docs/SPA_IMAGE_HEATMAP_IMPLEMENTATION.md`

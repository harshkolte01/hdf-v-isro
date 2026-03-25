# Single-Page SPA Guide

## What this document is for

This guide explains the `spa-single-page/` implementation in the simplest possible way:

- what files matter
- how the app starts
- how data flows from backend to UI
- where each feature is implemented
- where a new developer should edit first

If you are new to this repo, start here before reading the deeper feature docs.

## Folder map

```text
spa-single-page/
  index.html     # Fixed DOM shell for the viewer
  style.css      # All styles for layout, tree, metadata, table, charts, image, heatmap
  script.js      # Full frontend runtime in one large file
```

This version is the "all-in-one" frontend.

- HTML shell is in one file.
- CSS is in one file.
- JavaScript runtime is in one file.

That does not mean the code is random. `script.js` is large, but it is internally split into many logical modules.

## When to use this version

Use `spa-single-page/` when you want:

- one self-contained frontend bundle
- the easiest deployment shape
- one place to trace the full runtime from boot to rendering

Use the modular version when you want the same viewer behavior split across smaller files.

## Entry point and URL contract

Main entry:

```text
spa-single-page/index.html?file=<backend-object-key>
```

Actual bootstrap behavior:

- the runtime reads `?file=` from `location.search`
- if a host app wants to use `path`, `key`, or `filePath`, it should normalize that to `file` before loading the viewer

Important:

- pass the backend object key/path, not a local disk path
- the viewer expects the backend API to serve `/files/...` endpoints
- the default frontend API base URL is injected through `window.__CONFIG__.API_BASE_URL`

## The three important files

### `index.html`

`index.html` only provides the viewer shell. It does not contain feature logic.

Main DOM regions:

- `#viewer-sidebar`
  - tree panel
  - metadata panel
- `#viewer-topbar`
  - file breadcrumb
  - back button
  - fullscreen button
- `#viewer-subbar`
  - tabs and action buttons
- `#viewer-panel`
  - preview area
  - full runtime mounts
- `#global-status`
  - boot and error status

If a required DOM ID is removed, boot fails in the app bootstrap module.

### `style.css`

`style.css` contains all visual styling for:

- page shell and responsive layout
- sidebar tree
- metadata panel
- preview sections
- table and matrix display
- line graph
- image and heatmap canvas views
- histogram and export UI

If behavior works but the page looks wrong, the fix is usually here.

### `script.js`

`script.js` is the full runtime. It is large, but it is intentionally structured as manual modules.

Each section:

- is wrapped in an IIFE
- registers itself with `ns.core.registerModule("...")`
- writes into `window.HDFViewer`

Think of it as a hand-built bundle containing many internal modules.

## Internal architecture inside `script.js`

The easiest way to navigate `script.js` is to search for `registerModule("...")`.

The runtime is organized into these layers.

### 1. Core and config

Main module IDs:

- `core/namespace`
- `core/config`
- `core/domRefs`
- `utils/format`
- `utils/lru`
- `utils/export`

Responsibilities:

- create `window.HDFViewer`
- read `window.__CONFIG__.API_BASE_URL`
- validate required DOM IDs
- provide shared formatters
- provide cache helpers
- provide CSV/PNG/SVG export helpers

Edit here when you need to change:

- API base URL handling
- common helpers
- DOM reference validation
- shared formatting/export behavior

### 2. API layer

Main module IDs:

- `api/client`
- `api/contracts`
- `api/hdf5Service`

Responsibilities:

- wrap `fetch`
- build endpoint URLs
- normalize backend payloads
- manage request cancellation and caching
- expose frontend-friendly service calls

Edit here when you need to change:

- request URLs
- query parameters
- payload mapping
- caching rules
- error handling for API calls

### 3. State layer

Main module IDs:

- `state/store`
- `state/reducers/utils`
- `state/reducers/filesActions`
- `state/reducers/treeActions`
- `state/reducers/viewActions`
- `state/reducers/displayConfigActions`
- `state/reducers/dataActions`
- `state/reducers/compareActions`
- `state/reducers`

Responsibilities:

- hold the single app state object
- manage file open/reset flow
- manage tree expansion and selection
- manage metadata and preview loading
- manage tabs, compare mode, line/image/heatmap state
- manage N-D display dimensions and fixed indices

Edit here when the wrong thing happens after a user action.

### 4. Render layer

Main module IDs:

- `components/viewerPanel/shared`
- `components/viewerPanel/render/config`
- `components/viewerPanel/render/previews`
- `components/viewerPanel/render/dimensionControls`
- `components/viewerPanel/render/sections`
- `components/viewerPanel/render`
- `components/viewerPanel`
- `components/sidebarTree`
- `views/viewerView`

Responsibilities:

- render tree HTML
- render metadata blocks
- render preview content
- render dimension controls
- render matrix/line/image/heatmap sections
- render the full page shell from state

Edit here when state is correct but the UI markup is wrong.

### 5. Runtime layer

Main module IDs:

- `components/viewerPanel/runtime/common`
- `components/viewerPanel/runtime/matrixRuntime`
- `components/viewerPanel/runtime/lineRuntime`
- `components/viewerPanel/runtime/heatmapRuntime`
- `components/viewerPanel/runtime/imageHistogramRuntime`
- `components/viewerPanel/runtime/bindEvents`
- `components/viewerPanel/runtime`

Responsibilities:

- full matrix interaction
- full line chart interaction
- high-resolution image and heatmap interaction
- histogram interaction
- runtime cleanup and event binding

Edit here when the problem is in zooming, panning, canvas rendering, large-data loading, or runtime export behavior.

### 6. App bootstrap

Main module ID:

- `app-viewer`

Responsibilities:

- verify required modules
- verify required DOM nodes
- subscribe rendering to state changes
- parse the deep link from the URL
- call `openViewer(...)`
- trigger the first render

Edit here when the page loads but does not start correctly.

## Boot sequence

This is the normal app startup flow.

1. `index.html` loads the fixed viewer shell.
2. `style.css` loads the full styling layer.
3. `script.js` initializes config and `window.HDFViewer`.
4. Internal modules register themselves with `registerModule(...)`.
5. `app-viewer` verifies required modules and DOM IDs.
6. `app-viewer` subscribes `queueRender()` to state changes.
7. `app-viewer` reads `?file=` from `location.search`.
8. If a file exists, `openViewer({ key, etag })` runs.
9. State actions start loading tree and root metadata.
10. Renderers paint the initial UI.
11. Runtime modules activate only when a full dataset view is requested.

## Request and rendering flow

### Open a file

```text
?file=<key>
  -> app-viewer bootstrap
  -> filesActions.openViewer(...)
  -> treeActions.loadTreeChildren("/")
  -> dataActions.loadMetadata("/")
  -> render
```

### Select a node from the tree

```text
tree click
  -> sidebarTree event handler
  -> treeActions.selectTreeNode(...)
  -> load children if group
  -> load metadata
  -> load preview if dataset
  -> render
```

### Load a preview

```text
state action
  -> api.hdf5Service.getFilePreview(...)
  -> normalize response
  -> update preview state
  -> preview renderer updates UI
```

### Enter a full runtime

```text
user enables full view
  -> state flag changes
  -> render layer emits runtime shell
  -> runtime binder finds mount node
  -> runtime module fetches exact/full data
  -> interactive view starts
```

## What is implemented where

Use this as the fastest edit guide.

| Task | Start here |
| --- | --- |
| Change API base URL behavior | `script.js` core/config section |
| Change request URLs or payload mapping | `script.js` API modules |
| Change file open/reset flow | `script.js` `filesActions` |
| Change tree behavior | `script.js` `treeActions` and `components/sidebarTree` |
| Change metadata loading | `script.js` `dataActions` and `views/viewerView` |
| Change tabs or top-level page rendering | `script.js` `views/viewerView` |
| Change preview markup | `script.js` render/previews |
| Change N-D dimension controls | `script.js` render/dimensionControls and displayConfigActions |
| Change matrix behavior | `script.js` runtime/matrixRuntime |
| Change line graph behavior | `script.js` runtime/lineRuntime |
| Change image or heatmap behavior | `script.js` runtime/heatmapRuntime |
| Change histogram behavior | `script.js` runtime/imageHistogramRuntime |
| Change only styling | `style.css` |

## Important state concepts

The single-page SPA uses one shared mutable store. The most important state groups are:

- file/session state
  - selected file
  - route/home state
  - viewer blocked state
- tree state
  - selected path
  - expanded nodes
  - cached children
- metadata and preview state
  - current metadata payload
  - preview payload
  - loading/error flags
- display state
  - current tab
  - line/image/heatmap settings
  - compare mode settings
- multidimensional selection state
  - `displayDims`
  - `fixedIndices`
  - staged dimension changes

If you change behavior, prefer updating state once and letting renderers respond. Avoid adding ad hoc DOM mutations outside the render/runtime boundaries.

## Safe way to work in this version

Follow this order:

1. Find the right internal module by searching for `registerModule("...")`.
2. Decide whether the change belongs to core, API, state, render, or runtime.
3. Edit the smallest responsible section.
4. Update markup or CSS only after the behavior is correct.
5. Keep state logic in the state layer, not inside runtime event code.

## Common confusion points

### `script.js` is big, but not flat

Treat it as many internal modules, not one unstructured file.

### Similar helper names appear more than once

Functions like `normalizePath`, `render...`, or display-dimension helpers may exist in different internal sections. Always edit the copy inside the correct module.

### Full runtimes are not the same as previews

Preview rendering and full interactive runtimes are different layers.

- Preview logic lives in render modules.
- Full interactive behavior lives in runtime modules.

## Related docs

After this guide, use these deeper docs when needed:

- `docs/SPA_TREE_IMPLEMENTATION.md`
- `docs/SPA_METADATA_IMPLEMENTATION.md`
- `docs/SPA_LINE_GRAPH_IMPLEMENTATION.md`
- `docs/SPA_IMAGE_HEATMAP_IMPLEMENTATION.md`

# SPA Modular JS Implementation

## 1. Purpose

This document explains the plain JavaScript grouped-file implementation under `spa-modular/js/`.

This version is meant to behave like a normal browser website without ES-module imports. It keeps the old runtime style:

- ordered `<script>` tags in HTML
- shared `window.HDFViewer` namespace
- grouped files instead of one giant `script.js`

In the current project layout, this plain-script version is loaded by:

- `spa-modular/index2.html`

The shared stylesheet for this version is:

- `spa-modular/style.css`

## 2. High-Level Idea

The old single-file SPA runtime was split into 7 browser-loaded files.

The split is by responsibility:

1. core and utilities
2. API layer
3. state layer
4. render layer
5. heavy runtimes
6. shell wiring
7. app bootstrap

The important thing is that this version is still not a real import/export application. It works because the browser loads files in order, and each file publishes functions and data into `window.HDFViewer` and some legacy globals.

## 3. Folder Layout

```text
spa-modular/
  index2.html
  style.css
  js/
    viewer-core.js
    viewer-api.js
    viewer-state.js
    viewer-render.js
    viewer-runtimes.js
    viewer-shell.js
    app-viewer.js
```

## 4. Entry HTML

`spa-modular/index2.html` contains:

- the fixed viewer DOM shell
- all required IDs such as `viewer-app`, `tree-list`, `viewer-panel`, `global-status`
- ordered `<script>` tags for the grouped runtime files

The current script order is:

1. `js/viewer-core.js`
2. `js/viewer-api.js`
3. `js/viewer-state.js`
4. `js/viewer-render.js`
5. `js/viewer-runtimes.js`
6. `js/viewer-shell.js`
7. `js/app-viewer.js`

This order must stay correct. The later files depend on globals and namespace values created by earlier files.

## 5. Runtime Load Sequence

When the browser opens `index2.html`, this is the sequence:

1. HTML shell loads.
2. `style.css` loads.
3. `viewer-core.js` creates `window.HDFViewer`, runtime config helpers, DOM helpers, format helpers, cache helpers, and export helpers.
4. `viewer-api.js` adds fetch/client logic and HDF5 response normalization.
5. `viewer-state.js` adds the store and all action factories.
6. `viewer-render.js` adds preview, section, and display rendering functions.
7. `viewer-runtimes.js` adds matrix, line, heatmap, and histogram runtime behavior.
8. `viewer-shell.js` connects the viewer shell, sidebar, and top-level page rendering.
9. `app-viewer.js` verifies dependencies, reads `?file=`, subscribes rendering, and starts the app.

## 6. What Each File Does

### 6.1 `viewer-core.js`

This file creates the base platform that everything else depends on.

Internal module groups:

- `core/namespace`
- `core/config`
- `core/domRefs`
- `utils/format`
- `utils/lru`
- `utils/export`

Main responsibilities:

- initialize `window.HDFViewer`
- expose `registerModule(...)` and `requireModules(...)`
- read `window.__CONFIG__.API_BASE_URL`
- define backend URL helpers
- collect required DOM refs
- provide shared formatters like HTML escaping and byte formatting
- provide LRU cache helpers
- provide CSV and PNG export helpers

If something fundamental is wrong very early in startup, the problem is usually here.

### 6.2 `viewer-api.js`

This file owns all backend communication.

Internal module groups:

- `api/client`
- `api/contracts`
- `api/hdf5Service`

Main responsibilities:

- wrap `fetch`
- normalize API errors
- support cancellation and in-flight request management
- map backend payloads into stable frontend shapes
- expose frontend-facing file, tree, metadata, preview, and data calls

If URLs, payload shapes, or caching behavior are wrong, start here.

### 6.3 `viewer-state.js`

This file owns application state and actions.

Internal module groups:

- `state/store`
- `state/reducers/utils`
- `state/reducers/filesActions`
- `state/reducers/treeActions`
- `state/reducers/viewActions`
- `state/reducers/displayConfigActions`
- `state/reducers/dataActions`
- `state/reducers/compareActions`
- `state/reducers`

Main responsibilities:

- hold the shared mutable state object
- expose `getState`, `setState`, and `subscribe`
- manage file open/reset flow
- manage tree expand/select behavior
- manage view/tab toggles
- manage line, image, and heatmap display state
- manage N-D display dimensions and fixed indices
- manage preview and metadata loading
- manage compare-mode state

If a click or user action causes the wrong state change, the problem is usually here.

### 6.4 `viewer-render.js`

This file creates the display markup.

Internal module groups:

- `components/viewerPanel/shared`
- `components/viewerPanel/render/config`
- `components/viewerPanel/render/previews`
- `components/viewerPanel/render/dimensionControls`
- `components/viewerPanel/render/sections`
- `components/viewerPanel/render`

Main responsibilities:

- define shared chart and table constants
- resolve line, matrix, and heatmap render config from state
- render preview HTML
- render dimension controls
- render display sections for matrix, line, image, and heatmap
- build the main viewer panel content

If the markup is wrong but state looks right, start here.

### 6.5 `viewer-runtimes.js`

This file owns the interactive heavy behavior after preview mode.

Internal module groups:

- `components/viewerPanel/runtime/common`
- `components/viewerPanel/runtime/matrixRuntime`
- `components/viewerPanel/runtime/lineRuntime`
- `components/viewerPanel/runtime/heatmapRuntime`
- `components/viewerPanel/runtime/imageHistogramRuntime`
- `components/viewerPanel/runtime/bindEvents`
- `components/viewerPanel/runtime`

Main responsibilities:

- initialize full matrix runtime
- initialize full line runtime
- initialize full heatmap/image runtime
- initialize histogram runtime
- manage runtime cleanup and delegated panel events

If zoom, pan, fullscreen, progressive loading, or canvas behavior is wrong, start here.

### 6.6 `viewer-shell.js`

This file connects the shell around the data views.

Internal module groups:

- `components/viewerPanel`
- `components/sidebarTree`
- `views/viewerView`

Main responsibilities:

- provide stable top-level viewer panel facade functions
- render the sidebar tree
- render sidebar metadata
- render the top bar, subbar, and missing-file panel
- manage viewer-level export menu behavior
- bind shell-level events

If the main page layout, sidebar, topbar, or viewer shell interactions are wrong, start here.

### 6.7 `app-viewer.js`

This is the bootstrap file.

Internal module group:

- `app-viewer`

Main responsibilities:

- verify required modules were loaded
- verify required DOM IDs exist
- subscribe the renderer to store updates
- read `?file=` from the URL
- call `openViewer(...)` and `loadFiles()`
- trigger the first render

If the page loads but nothing starts, start here.

## 7. Boot Flow

The normal boot path is:

1. Browser loads `index2.html`.
2. Browser executes all 7 files in order.
3. `app-viewer.js` checks for required modules and DOM IDs.
4. The store subscription is attached.
5. `?file=` is read from `location.search`.
6. If `file` exists, `openViewer(...)` runs and file data begins loading.
7. State changes trigger rendering.
8. `viewer-shell.js` and `viewer-render.js` produce the visible UI.
9. `viewer-runtimes.js` activates full interactive runtimes when needed.

## 8. URL Contract

This version expects:

```text
spa-modular/index2.html?file=<backend-object-key>
```

Important:

- `file` is the real supported query parameter
- the value should be the backend object key/path expected by the API
- this is not meant to receive a raw local filesystem path

## 9. How Data Moves Through the App

The normal flow is:

1. URL provides `?file=...`
2. bootstrap opens the viewer
3. state actions load tree and metadata
4. selecting a dataset loads preview data
5. render layer shows preview HTML
6. enabling full view starts runtime modules
7. runtime modules fetch larger or more exact data as needed

## 10. Where To Change What

Use this guide when editing:

- change API base URL behavior
  - `js/viewer-core.js`

- change fetch logic, cancellation, or response normalization
  - `js/viewer-api.js`

- change state transitions or user action behavior
  - `js/viewer-state.js`

- change markup, preview UI, or section layout
  - `js/viewer-render.js`

- change zoom, pan, full view, canvas, histogram, or runtime exports
  - `js/viewer-runtimes.js`

- change shell layout, sidebar, topbar, export menu, or page-level events
  - `js/viewer-shell.js`

- change startup, deep-link handling, or render subscription
  - `js/app-viewer.js`

- change appearance only
  - `style.css`

## 11. Safe Maintenance Rules

- keep script order unchanged in `index2.html`
- do not remove `window.HDFViewer` usage in this version unless you plan a full refactor
- do not rename required DOM IDs without updating DOM validation code
- change behavior in the smallest responsible grouped file
- use `registerModule(...)` names to understand the real internal boundaries inside each grouped file

## 12. Summary

The `js/` version is the browser-safe grouped-script implementation.

It is:

- modular by file grouping
- still global-namespace based
- dependent on strict script order
- easy to host as a normal static page

Use `index2.html` when you want the non-ES-module version of `spa-modular`.

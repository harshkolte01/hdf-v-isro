# SPA Modular JS2 Implementation

## 1. Purpose

This document explains the ES-module-based grouped implementation under `spa-modular/js2/`.

This version is the newer `spa-modular` entry and is currently loaded by:

- `spa-modular/index.html`

The shared stylesheet is:

- `spa-modular/style.css`

This version uses browser ES modules, but it still keeps the same grouped runtime architecture as the plain `js/` version.

Important difference:

- `js/` depends on ordered `<script>` tags
- `js2/` depends on `import` order starting from one module entry file

## 2. Current Folder Layout

```text
spa-modular/
  index.html
  style.css
  js2/
    viewer-core.js
    viewer-api.js
    viewer-state.js
    viewer-render.js
    viewer-runtimes.js
    viewer-shell.js
    app-viewer.js
```

## 3. Entry HTML

`spa-modular/index.html` contains the same fixed viewer DOM shell as the plain-script version, but the loader is different.

Instead of loading many plain script tags, it loads one ES-module entry:

```html
<script type="module" src="js2/app-viewer.js"></script>
```

From that point, the browser follows the import chain automatically.

## 4. Import Sequence

The current module import chain is:

1. `app-viewer.js` imports `viewer-shell.js`
2. `viewer-shell.js` imports `viewer-runtimes.js`
3. `viewer-runtimes.js` imports `viewer-render.js`
4. `viewer-render.js` imports `viewer-state.js`
5. `viewer-state.js` imports `viewer-api.js`
6. `viewer-api.js` imports `viewer-core.js`

So even though `index.html` loads only one file, the browser ends up loading the full chain in the correct dependency order.

Execution order is effectively:

1. `viewer-core.js`
2. `viewer-api.js`
3. `viewer-state.js`
4. `viewer-render.js`
5. `viewer-runtimes.js`
6. `viewer-shell.js`
7. `app-viewer.js`

## 5. Important Architecture Note

`js2/` is an ES-module version, but it is not yet a fully pure import/export application.

Right now it uses both:

- ES-module loading
- the existing `window.HDFViewer` runtime namespace

That means:

- imports control load order
- exports expose grouped module access
- the internal app still communicates largely through shared namespace/global bridges

This was done to make the app cleaner and easier to host without breaking current behavior.

## 6. Why You See `init_viewer_*()` Functions

Inside `js2/`, the old IIFE wrapper style was removed.

Instead of this:

```js
(function (global) {
  ...
})(window);
```

each internal block now looks like:

```js
function init_viewer_render_3() {
  const global = window;
  ...
}

init_viewer_render_3();
```

This keeps the old grouped-module execution boundaries while making the file more normal and easier to read than the previous wrapper form.

## 7. What Each File Does

### 7.1 `viewer-core.js`

This file is still the foundation of the app.

Internal initializer blocks register:

- `core/namespace`
- `core/config`
- `core/domRefs`
- `utils/format`
- `utils/lru`
- `utils/export`

It also exports:

- `HDFViewer`
- `ViewerCore`
- `ViewerUtils`

Responsibilities:

- create the global namespace
- expose runtime config helpers
- expose DOM utilities
- expose shared formatters
- expose cache helpers
- expose export helpers

### 7.2 `viewer-api.js`

This file imports `viewer-core.js`.

Internal initializer blocks register:

- `api/client`
- `api/contracts`
- `api/hdf5Service`

It exports:

- `HDFViewer`
- `ViewerApi`

Responsibilities:

- fetch wrapper and cancellation
- API error handling
- payload normalization
- HDF5 service helpers for tree, metadata, preview, and data requests

### 7.3 `viewer-state.js`

This file imports `viewer-api.js`.

Internal initializer blocks register:

- `state/store`
- `state/reducers/utils`
- `state/reducers/filesActions`
- `state/reducers/treeActions`
- `state/reducers/viewActions`
- `state/reducers/displayConfigActions`
- `state/reducers/dataActions`
- `state/reducers/compareActions`
- `state/reducers`

It exports:

- `HDFViewer`
- `ViewerState`
- `actions`

Responsibilities:

- hold app state
- expose store helpers
- implement all state transitions
- compose all actions used by the UI

### 7.4 `viewer-render.js`

This file imports `viewer-state.js`.

Internal initializer blocks register:

- `components/viewerPanel/shared`
- `components/viewerPanel/render/config`
- `components/viewerPanel/render/previews`
- `components/viewerPanel/render/dimensionControls`
- `components/viewerPanel/render/sections`
- `components/viewerPanel/render`

It exports:

- `HDFViewer`
- `ViewerComponents`

Responsibilities:

- shared panel constants and helpers
- preview rendering
- dimension-control rendering
- line, matrix, heatmap, and image section rendering
- top-level viewer panel rendering

### 7.5 `viewer-runtimes.js`

This file imports `viewer-render.js`.

Internal initializer blocks register:

- `components/viewerPanel/runtime/common`
- `components/viewerPanel/runtime/matrixRuntime`
- `components/viewerPanel/runtime/lineRuntime`
- `components/viewerPanel/runtime/heatmapRuntime`
- `components/viewerPanel/runtime/imageHistogramRuntime`
- `components/viewerPanel/runtime/bindEvents`
- `components/viewerPanel/runtime`

It exports:

- `HDFViewer`
- `ViewerRuntime`

Responsibilities:

- full interactive matrix runtime
- full line runtime
- full heatmap/image runtime
- histogram runtime
- runtime event binding and cleanup

### 7.6 `viewer-shell.js`

This file imports `viewer-runtimes.js`.

Internal initializer blocks register:

- `components/viewerPanel`
- `components/sidebarTree`
- `views/viewerView`

It exports:

- `HDFViewer`
- `ViewerViews`

Responsibilities:

- top-level viewer panel facade
- sidebar tree rendering and events
- viewer shell rendering
- topbar and subbar rendering
- export menu wiring
- page-level DOM event handling

### 7.7 `app-viewer.js`

This file imports `viewer-shell.js`.

Internal initializer blocks register:

- `app-viewer`

It exports:

- `HDFViewer`
- `bootstrapApp`
- `renderApp`
- `queueRender`

Responsibilities:

- startup verification
- DOM validation
- state subscription
- `?file=` parsing
- initial open/load flow
- first render

## 8. Boot Sequence In Practice

The boot path for `js2/` is:

1. Browser opens `spa-modular/index.html`.
2. Browser loads `js2/app-viewer.js` as an ES module.
3. The import chain pulls in all required grouped modules down to `viewer-core.js`.
4. Each grouped file runs its `init_viewer_*()` blocks in order.
5. The shared namespace and module registry are populated.
6. `app-viewer.js` verifies required modules and DOM IDs.
7. The app reads `?file=` from the URL.
8. If `file` exists, viewer state opens the selected file and loads data.
9. Rendering starts and later upgrades previews into full runtimes when requested.

## 9. URL Contract

This version expects:

```text
spa-modular/index.html?file=<backend-object-key>
```

Important:

- `file` is the supported deep-link parameter
- the value should match what the backend API expects
- it should not be a raw local filesystem path

## 10. How To Read The Files

The best way to read `js2/` is:

1. start at `index.html`
2. open `js2/app-viewer.js`
3. follow the import chain backward toward `viewer-core.js`
4. inside each file, treat each `init_viewer_*()` block as one internal module section
5. use `registerModule(...)` names to understand what that block owns

## 11. Where To Change What

Use this guide:

- change runtime config, namespace, DOM helpers, formatters, caches, exports
  - `js2/viewer-core.js`

- change request logic or payload normalization
  - `js2/viewer-api.js`

- change state shape or action behavior
  - `js2/viewer-state.js`

- change rendered markup or preview UI
  - `js2/viewer-render.js`

- change interactive chart/runtime behavior
  - `js2/viewer-runtimes.js`

- change shell, sidebar, export menu, or page-level event flow
  - `js2/viewer-shell.js`

- change startup behavior
  - `js2/app-viewer.js`

- change styling only
  - `style.css`

## 12. Difference From `js/`

The `js/` and `js2/` versions share the same logical architecture, but the loading model is different.

`js/`:

- loaded by `index2.html`
- uses ordered plain script tags
- no import/export

`js2/`:

- loaded by `index.html`
- uses one module entry file and browser imports
- exposes grouped exports at the bottom of each file
- no old IIFE wrappers remain

## 13. Current Limitation

Even though `js2/` is cleaner, it still uses `window.HDFViewer` and some global bridge symbols internally.

So the current state is:

- cleaner than the plain-script version
- more modern loading model
- still not a fully pure direct import/export refactor

If a future refactor is planned, the next step would be replacing those global bridges with direct module imports between internal sections.

## 14. Summary

The `js2/` version is the ES-module entry for `spa-modular`.

It is:

- loaded from `index.html`
- organized into 7 grouped module files
- executed through an import chain
- easier to reason about than the plain-script version
- still compatible with the current shared namespace runtime design

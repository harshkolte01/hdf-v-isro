# Modular SPA Guide

## What this document is for

This guide explains the `spa-modular/` frontend in a way that is easy for a new developer to follow.

It answers:

- which entry page to use
- why there are two JS folders
- how the modular frontend is split
- where each feature lives
- how the modular version differs from the single-page version

## Big picture

`spa-modular/` is the same HDF viewer split into smaller files.

The UI, behavior, and backend contract are intentionally close to `spa-single-page/`. The main difference is code organization and load strategy.

Shared frontend assets:

```text
spa-modular/
  style.css
  index.html     # Main modular entry
  index2.html    # Legacy plain-script entry
  js/            # Plain script version
  js2/           # ES-module version
```

## The two modular variants

There are two loader styles inside `spa-modular/`.

### 1. `index.html` + `js2/`

This is the primary modular entry.

- uses `<script type="module" src="js2/app-viewer.js">`
- uses browser ES module imports
- still keeps the existing `window.HDFViewer` runtime namespace internally
- is the cleaner and more modern modular path

Use this version by default.

### 2. `index2.html` + `js/`

This is the legacy modular entry.

- uses ordered plain `<script>` tags
- does not use ES module imports
- depends on strict script order
- keeps the same `window.HDFViewer` architecture

Use this only if you specifically need a non-ES-module page.

## Folder map

```text
spa-modular/
  index.html
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
  js2/
    viewer-core.js
    viewer-api.js
    viewer-state.js
    viewer-render.js
    viewer-runtimes.js
    viewer-shell.js
    app-viewer.js
```

The `js/` and `js2/` folders have the same responsibility split. Only the loading model changes.

## Entry points and URL contract

Main modular entry:

```text
spa-modular/index.html?file=<backend-object-key>
```

Legacy modular entry:

```text
spa-modular/index2.html?file=<backend-object-key>
```

Important:

- pass the backend object key/path, not a local disk path
- both modular variants talk to the same backend API contract
- both default to `window.__CONFIG__.API_BASE_URL || "https://hdf-viewer-backend.vercel.app"`

## Shared page shell

`index.html` and `index2.html` both define the same main DOM shell:

- `#viewer-sidebar`
- `#tree-list`
- `#metadata-panel`
- `#viewer-topbar`
- `#viewer-subbar`
- `#viewer-panel`
- `#global-status`

That means most UI logic is shared conceptually across both modular variants.

If a required DOM ID is removed, bootstrap fails in `app-viewer.js`.

## How the modular architecture is split

Both `js/` and `js2/` divide the viewer into 7 files.

### 1. `viewer-core.js`

Responsibilities:

- initialize `window.HDFViewer`
- register module boundaries
- read runtime config
- expose API base URL helpers
- expose DOM utilities
- expose formatting helpers
- expose cache helpers
- expose export helpers

Internal module families:

- `core/namespace`
- `core/config`
- `core/domRefs`
- `utils/format`
- `utils/lru`
- `utils/export`

Change this file when the problem is foundational.

### 2. `viewer-api.js`

Responsibilities:

- wrap `fetch`
- build URLs
- normalize backend payloads
- manage request cancellation
- expose file/tree/metadata/preview/data service methods

Internal module families:

- `api/client`
- `api/contracts`
- `api/hdf5Service`

Change this file when API behavior is wrong.

### 3. `viewer-state.js`

Responsibilities:

- own the application state object
- expose store helpers
- implement file actions
- implement tree selection and expansion actions
- implement view and display config actions
- implement metadata/preview/data loading actions
- implement compare mode behavior

Internal module families:

- `state/store`
- `state/reducers/utils`
- `state/reducers/filesActions`
- `state/reducers/treeActions`
- `state/reducers/viewActions`
- `state/reducers/displayConfigActions`
- `state/reducers/dataActions`
- `state/reducers/compareActions`
- `state/reducers`

Change this file when a click causes the wrong state transition.

### 4. `viewer-render.js`

Responsibilities:

- render preview HTML
- render dimension controls
- render matrix/line/image/heatmap sections
- build viewer panel markup

Internal module families:

- `components/viewerPanel/shared`
- `components/viewerPanel/render/config`
- `components/viewerPanel/render/previews`
- `components/viewerPanel/render/dimensionControls`
- `components/viewerPanel/render/sections`
- `components/viewerPanel/render`

Change this file when state is correct but the visible markup is wrong.

### 5. `viewer-runtimes.js`

Responsibilities:

- full matrix runtime
- full line runtime
- full heatmap/image runtime
- histogram runtime
- runtime event binding and cleanup

Internal module families:

- `components/viewerPanel/runtime/common`
- `components/viewerPanel/runtime/matrixRuntime`
- `components/viewerPanel/runtime/lineRuntime`
- `components/viewerPanel/runtime/heatmapRuntime`
- `components/viewerPanel/runtime/imageHistogramRuntime`
- `components/viewerPanel/runtime/bindEvents`
- `components/viewerPanel/runtime`

Change this file when the issue is in zoom, pan, high-resolution loading, canvas work, or runtime interactivity.

### 6. `viewer-shell.js`

Responsibilities:

- sidebar tree rendering
- metadata panel rendering
- top bar and subbar rendering
- top-level viewer shell interactions
- export menu wiring
- page-level event handling

Internal module families:

- `components/viewerPanel`
- `components/sidebarTree`
- `views/viewerView`

Change this file when the shell layout or page-level wiring is wrong.

### 7. `app-viewer.js`

Responsibilities:

- verify runtime dependencies
- validate required DOM IDs
- subscribe rendering to state changes
- parse `?file=` from the URL
- call `openViewer(...)`
- trigger initial render

Change this file when the app does not boot or deep linking is broken.

## How loading differs between `js/` and `js2/`

### Plain scripts: `js/`

`index2.html` loads files in this exact order:

1. `viewer-core.js`
2. `viewer-api.js`
3. `viewer-state.js`
4. `viewer-render.js`
5. `viewer-runtimes.js`
6. `viewer-shell.js`
7. `app-viewer.js`

This order must stay correct.

### ES modules: `js2/`

`index.html` loads only `js2/app-viewer.js`, and imports resolve the rest.

Current import chain:

1. `app-viewer.js` imports `viewer-shell.js`
2. `viewer-shell.js` imports `viewer-runtimes.js`
3. `viewer-runtimes.js` imports `viewer-render.js`
4. `viewer-render.js` imports `viewer-state.js`
5. `viewer-state.js` imports `viewer-api.js`
6. `viewer-api.js` imports `viewer-core.js`

Effective execution order is therefore still:

1. `viewer-core.js`
2. `viewer-api.js`
3. `viewer-state.js`
4. `viewer-render.js`
5. `viewer-runtimes.js`
6. `viewer-shell.js`
7. `app-viewer.js`

## Boot sequence

Both modular variants follow the same startup logic.

1. Page shell loads.
2. Shared `style.css` loads.
3. Core, API, state, render, runtime, shell, and app bootstrap layers load in order.
4. `app-viewer.js` verifies dependencies and DOM IDs.
5. State subscription attaches the render loop.
6. `?file=` is read from `location.search`.
7. `openViewer(...)` runs if a file exists.
8. Tree and metadata loading begin.
9. Preview UI renders.
10. Full runtimes activate only when the user asks for them.

## Data flow

The normal data flow is the same as the single-page SPA:

```text
URL ?file=...
  -> app bootstrap
  -> open viewer
  -> load tree + root metadata
  -> user selects dataset
  -> load metadata + preview
  -> render preview
  -> full runtime fetches exact/full data when enabled
```

## What is implemented where

Use this table as the practical starting point.

| Task | Start here |
| --- | --- |
| Change API base URL or shared helpers | `viewer-core.js` |
| Change request URLs, query params, or normalization | `viewer-api.js` |
| Change state transitions | `viewer-state.js` |
| Change preview/layout markup | `viewer-render.js` |
| Change runtime chart/canvas behavior | `viewer-runtimes.js` |
| Change tree/sidebar/topbar/export menu behavior | `viewer-shell.js` |
| Change boot or deep-link startup | `app-viewer.js` |
| Change styling only | `style.css` |

## How this differs from `spa-single-page/`

`spa-single-page/`:

- one `script.js`
- one `style.css`
- one HTML entry
- easier to deploy as a single runtime file

`spa-modular/`:

- same logical layers split into multiple files
- easier to navigate by responsibility
- supports both legacy plain scripts and ES modules

If you already understand the single-page version, the modular version is mostly the same viewer architecture with file boundaries made explicit.

## Best way for a new developer to read it

If you are reading the modular version for the first time:

1. Start at `spa-modular/index.html`.
2. Open `js2/app-viewer.js`.
3. Follow imports backward until `viewer-core.js`.
4. Inside each file, use the registered module names to see which section owns what.
5. Only switch to `index2.html` and `js/` if you need to understand the non-ES-module loader.

## Safe maintenance rules

- Prefer editing `js2/` first if both modular variants need to stay aligned.
- Keep `index2.html` script order unchanged.
- Do not rename required DOM IDs without updating validation logic.
- Keep behavior changes in the smallest responsible file.
- Treat `viewer-render.js` and `viewer-runtimes.js` as separate concerns.
  - render file = markup and configuration
  - runtime file = heavy interaction after render

## Relationship to the rest of the repo

The modular frontend uses the same backend contract as the single-page frontend:

- `GET /files/`
- `GET /files/<key>/children`
- `GET /files/<key>/meta`
- `GET /files/<key>/preview`
- `GET /files/<key>/data`
- `GET /files/<key>/export/csv`

That means frontend work usually does not depend on which SPA variant is used. Most product behavior should stay aligned across both.

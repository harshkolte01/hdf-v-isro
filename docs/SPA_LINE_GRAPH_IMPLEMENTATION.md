# SPA Line Graph Implementation

## 1. Scope

This document explains how the SPA implements line graph preview, full interactive line mode, line comparison, runtime fetching, and line export.

The line feature has two layers:

- a fast preview renderer
- a full runtime that supports zoom, pan, compare overlays, fullscreen, and export

## 2. Main files and modules

Primary implementation lives in:

- `spa-single-page/script.js`
  - `state/reducers/viewActions`
  - `state/reducers/dataActions`
  - `state/reducers/compareActions`
  - `components/viewerPanel/render/config`
  - `components/viewerPanel/render/previews`
  - `components/viewerPanel/render/sections`
  - `components/viewerPanel/runtime/lineRuntime`
  - `components/sidebarTree`
  - `views/viewerView`

- `spa-single-page/style.css`
  - line chart shell and toolbar
  - compare panel and chips
  - line fullscreen styling

## 3. State fields that control line mode

Important line-related state:

- `displayTab`
- `preview`
- `lineFullEnabled`
- `lineGrid`
- `lineAspect`
- `notation`
- `lineCompareEnabled`
- `lineCompareItems`
- `lineCompareStatus`
- `displayConfig.displayDims`
- `displayConfig.fixedIndices`

Meaning:

- `displayTab`
  - whether line mode is the active tab

- `lineFullEnabled`
  - whether the SPA should render the full interactive runtime shell instead of the preview

- `lineCompareEnabled`
  - whether tree compare controls should be shown and runtime compare overlays should be considered

## 4. Tab and preview selection flow

The line tab is selected through:

- `viewActions.setDisplayTab("line")`

This can trigger preview reloads when switching from another preview mode because preview mode choice is tied to the current tab.

`dataActions.loadPreview(...)` resolves preview mode like this:

- line tab -> backend preview mode `line`
- heatmap/image tabs -> backend preview mode `heatmap`
- matrix tab -> backend preview mode `table`

So line preview and heatmap preview are separate backend preview requests.

## 5. Fast line preview

Fast preview rendering lives in:

- `renderLinePreview(preview, options)`

This preview:

- extracts points from:
  - `preview.profile`
  - or `preview.plot`
  - or fallback value arrays
- builds inline SVG markup
- respects:
  - `lineGrid`
  - `lineAspect`

This is the lightweight mode shown before the full runtime is enabled.

If the preview chart looks wrong but full line mode is fine, start here rather than in the runtime.

## 6. Full line mode entry

The full line mode section is rendered by:

- `renderLineSection(state, preview)`

This function:

- resolves runtime config with `resolveLineRuntimeConfig(...)`
- shows:
  - load full line button
  - compare toggle
  - compare clear button
  - compare chip/status panel
- renders either:
  - `renderLinePreview(...)`
  - or `renderVirtualLineShell(...)`

The switch is controlled by:

- `state.lineFullEnabled`

## 7. Runtime shell markup

`renderVirtualLineShell(state, config, preview)` outputs the HTML shell for the runtime.

It embeds runtime configuration in `data-*` attributes, including:

- file identity
- etag
- selected path
- display dims
- fixed indices
- selection key
- total points
- line index
- compare items
- base dataset shape/ndim/dtype
- notation
- grid/aspect
- quality defaults

The runtime module reads these attributes during initialization.

Important consequence:

- if a line runtime behavior depends on state but is missing in the runtime, check whether the value was actually emitted into the shell markup

## 8. Line runtime configuration

Runtime config is produced by:

- `resolveLineRuntimeConfig(state, preview)`

This function computes:

- whether line runtime is supported
- total point count
- row count
- `displayDimsParam`
- `fixedIndicesParam`
- inferred `lineIndex`
- `selectionKey`

It handles both:

- 1D datasets
- 2D+/N-D datasets where one row/column profile is extracted from a selected display slice

If line runtime picks the wrong slice, inspect:

- `resolveLineRuntimeConfig(...)`
- `displayConfig`
- preview-provided `display_dims`

## 9. Full runtime behavior

The interactive runtime is implemented by:

- `initializeLineRuntime(shell)`

Key responsibilities:

- read configuration from `data-*`
- restore cached viewport state
- fetch line windows from the backend
- draw SVG line series
- handle pan/zoom/fullscreen
- handle compare overlays
- expose export methods

### 9.1 Core runtime functions

Important functions inside the runtime:

- `initializeLineRuntime(...)`
- `renderSeries(basePoints, compareSeries)`
- `scheduleFetch()`
- `fetchLineRange()`
- `updateViewport(start, span, immediate)`
- `setQuality(nextQuality)`
- `getComparePathsForExport()`
- fullscreen rerender helpers

### 9.2 Data fetching

The runtime fetches data from:

- `getFileData(..., { mode: "line" })`

The fetch uses:

- current path
- display dims
- fixed indices
- line index
- quality
- line offset
- line limit

The runtime only asks for the currently visible window instead of the full dataset.

### 9.3 Quality modes

The runtime supports:

- `auto`
- `overview`
- `exact`

The runtime syncs quality with UI controls and uses the backend to enforce exact/overview behavior.

If you need to change line quality defaults or limits, inspect:

- render shell defaults in `renderVirtualLineShell(...)`
- backend route limits
- runtime `setQuality(...)`

### 9.4 Viewport and interaction

The line runtime supports:

- mouse wheel zoom
- hand-pan mode
- click-to-zoom mode
- keyboard navigation
- jump to start/end
- step previous/next
- jump to a numeric index

Viewport state is persisted in a line view cache keyed by selection key, so re-renders can restore the last range.

## 10. Line comparison feature

Line comparison is implemented across three areas:

1. `state/reducers/compareActions`
2. `components/sidebarTree`
3. `components/viewerPanel/runtime/lineRuntime`

### 10.1 Compare selection state

`compareActions` manages:

- toggling compare mode
- clearing compare state
- removing a selected compare dataset
- validating and adding compare datasets

Compatibility rules include:

- dataset only
- not the base dataset
- numeric dtype
- same ndim
- same shape
- maximum of 4 compare datasets

### 10.2 Tree integration

When compare mode is enabled on the line tab:

- the tree renders `Compare` buttons beside compatible datasets
- clicking them calls `addLineCompareDataset(...)`

### 10.3 Runtime integration

The line runtime decodes compare items from shell data attributes and:

- validates them again before requesting data
- fetches compare series together with the base series
- renders overlay paths using fixed compare colors
- includes compare series in CSV export

If comparison UI changes are needed, inspect both:

- `renderLineSection(...)`
- `compareActions`
- `initializeLineRuntime(...)`

## 11. Export flow

The full line runtime exposes `shell.__exportApi`.

Viewer-level export menu handling lives in:

- `views/viewerView`

The viewer view:

- resolves the active export shell
- calls `shell.__exportApi.exportCsvDisplayed`
- or `exportCsvFull`
- or `exportPng`

Line runtime export behavior includes:

- displayed-range CSV from currently loaded points
- full CSV via backend export route
- PNG export using SVG-to-PNG conversion

If export menu clicks work but line export content is wrong, inspect `lineRuntime`.
If export menu itself is wrong, inspect `viewerView`.

## 12. CSS surfaces for line mode

Important selectors in `style.css`:

- `.line-chart-shell`
- `.line-chart-shell-full`
- `.line-chart-shell.is-fullscreen`
- `.line-chart-toolbar`
- `.line-chart-stage`
- `.line-chart-canvas`
- `.line-hover`
- `.line-stats`
- `.line-legend`
- `.line-compare-panel`
- `.line-compare-chip-list`
- `.line-compare-chip`
- `.line-compare-status`

Use CSS for:

- toolbar layout
- hover popup styling
- compare chip appearance
- fullscreen layout
- line panel responsiveness

## 13. What to change where

### 13.1 Change fast preview appearance

Edit:

- `renderLinePreview(...)`
- line preview selectors in `style.css`

### 13.2 Change when full line mode is allowed

Edit:

- `resolveLineRuntimeConfig(...)`
- `viewActions.enableLineFullView()`
- `renderLineSection(...)`

### 13.3 Change line zoom/pan behavior

Edit inside `initializeLineRuntime(...)`:

- wheel handler
- viewport logic
- `zoomBy(...)`
- `updateViewport(...)`

### 13.4 Change default quality or window sizes

Edit:

- `renderVirtualLineShell(...)` data attributes
- runtime quality logic
- backend limits if needed

### 13.5 Change compare rules

Edit:

- `state/reducers/compareActions`

### 13.6 Change compare rendering

Edit:

- `renderLineSection(...)`
- `initializeLineRuntime(...)`
- compare colors/constants

### 13.7 Change export behavior

Edit:

- runtime export methods in `lineRuntime`
- export menu wiring in `views/viewerView`

### 13.8 Change what line tab shows in preview mode

Edit:

- `renderLineSection(...)`
- `renderLinePreview(...)`

## 14. Safe change recipes

### Example: change compare overlay colors

Edit:

- `LINE_COMPARE_COLORS` in `lineRuntime`

No reducer or render changes are needed unless legend markup also changes.

### Example: add another quality option

Edit:

1. shell select/options in line render markup
2. quality parsing and handling in runtime
3. backend API support if the backend must recognize the new option

### Example: disable line compare for boolean datasets

Edit:

- `isNumericDtype(...)` in compare logic and runtime precheck logic

### Example: change the initial visible line window

Edit:

- viewport initialization in `initializeLineRuntime(...)`
- possibly the cached-view restore behavior

## 15. Developer cautions

- preview mode and full mode are separate implementations
- compare state is stored globally, not inside the line runtime only
- line runtime reads configuration from shell attributes; missing attributes cause hidden bugs
- export is split between viewer-level menu handling and runtime-level implementation
- selection key stability matters for cached viewport restore

## 16. Summary

The line feature is implemented as:

- preview request
  -> preview render
  -> optional full runtime shell
  -> runtime fetch windows from `/data?mode=line`
  -> compare overlays and exports built on top

If a developer needs to change line graph behavior, inspect in this order:

1. `resolveLineRuntimeConfig(...)`
2. `renderLineSection(...)`
3. `state/reducers/compareActions`
4. `components/viewerPanel/runtime/lineRuntime`
5. line-related selectors in `style.css`

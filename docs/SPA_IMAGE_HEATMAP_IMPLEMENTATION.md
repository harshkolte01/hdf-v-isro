# SPA Image and Heatmap Implementation

## 1. Scope

This document explains how the SPA implements:

- heatmap preview
- image preview
- full high-resolution heatmap/image runtime
- dimension selection and hidden-dimension playback
- linked row/column line plots from heatmap clicks
- histogram rendering for image mode and optional heatmap histogram behavior

In this SPA, image mode and heatmap mode share most of the same pipeline. Image mode is effectively the heatmap pipeline rendered with grayscale defaults and histogram support.

## 2. Main files and modules

Primary implementation lives in:

- `spa-single-page/script.js`
  - `state/reducers/viewActions`
  - `state/reducers/displayConfigActions`
  - `state/reducers/dataActions`
  - `components/viewerPanel/render/config`
  - `components/viewerPanel/render/previews`
  - `components/viewerPanel/render/dimensionControls`
  - `components/viewerPanel/render/sections`
  - `components/viewerPanel/runtime/heatmapRuntime`
  - `components/viewerPanel/runtime/imageHistogramRuntime`
  - `views/viewerView`

- `spa-single-page/style.css`
  - heatmap preview
  - heatmap runtime shell
  - linked line plot layout
  - intensity controls
  - image histogram styles
  - dimension control styles

## 3. State fields that drive image and heatmap behavior

Important state:

- `displayTab`
- `preview`
- `heatmapFullEnabled`
- `heatmapGrid`
- `heatmapColormap`
- `notation`
- `lineGrid`
- `lineAspect`
- `displayConfig.displayDims`
- `displayConfig.fixedIndices`
- `displayConfig.stagedDisplayDims`
- `displayConfig.stagedFixedIndices`
- `displayConfig.playingFixedDim`

Meaning:

- `displayTab`
  - `image` or `heatmap`

- `heatmapFullEnabled`
  - whether preview mode should switch to the full interactive runtime

- `displayConfig`
  - controls which axes are visible and which non-visible dimensions are fixed

## 4. Shared architecture between image and heatmap

The render layer treats both tabs as variants of the same 2D slice system.

Shared pieces:

- `resolveHeatmapRuntimeConfig(...)`
- `renderHeatmapPreview(...)`
- `renderVirtualHeatmapShell(...)`
- `initializeHeatmapRuntime(...)`

Differences:

- image mode forces grayscale colormap
- image mode always includes histogram UI
- heatmap mode can include histogram depending on feature flags
- labels and subtitles differ

## 5. Preview mode

Fast preview is rendered before the full runtime is enabled.

Relevant functions:

- `renderHeatmapPreview(preview, options)`
- `renderHeatmapSection(state, preview)`
- `renderImageSection(state, preview)`

### 5.1 Heatmap preview

Heatmap preview:

- uses preview payload data from the backend
- applies selected colormap
- can optionally show a histogram block
- is cheap compared to the full runtime

### 5.2 Image preview

Image preview:

- reuses the same preview renderer
- forces:
  - grayscale colormap
  - histogram enabled

If preview visuals are wrong but the full runtime is correct, start in the preview render module, not the runtime.

## 6. Full runtime entry

The full runtime is enabled through:

- `viewActions.enableHeatmapFullView()`

Once enabled:

- `renderHeatmapSection(...)` or `renderImageSection(...)`
- switches from preview markup to `renderVirtualHeatmapShell(...)`

The runtime shell includes `data-*` attributes for:

- file key and etag
- HDF5 path
- display dims
- fixed indices
- selection key
- colormap
- grid on/off
- notation/grid/aspect settings for linked line plots

## 7. Heatmap runtime configuration

`resolveHeatmapRuntimeConfig(state, preview)` computes:

- whether runtime is supported
- visible row/column counts
- normalized display/fixed params
- selection key
- shape
- dimension labels

If the wrong slice or wrong axes are shown, inspect this function first together with `displayConfig`.

## 8. Dimension controls and slice selection

This is one of the most important parts of image/heatmap mode.

### 8.1 Render layer

Dimension controls are rendered by:

- `renderDimensionControls(state, preview)`
- `renderFixedIndexControls(options)`

Behavior:

- for 2D datasets:
  - simple axis toggles

- for 3D+ datasets:
  - staged display-dim selectors
  - staged fixed-index sliders/number inputs
  - Set / Reset actions
  - optional hidden-dimension playback controls

### 8.2 State/action layer

Selection behavior is managed by:

- `state/reducers/displayConfigActions`

Important actions:

- `setDisplayAxis(...)`
- `setDisplayDim(...)`
- `stageDisplayDims(...)`
- `stageFixedIndex(...)`
- `applyDisplayConfig()`
- `resetDisplayConfigFromPreview()`
- `startFixedIndexPlayback(...)`
- `stopFixedIndexPlayback()`

Important behavior:

- 2D changes can apply immediately
- 3D+ changes are staged and then applied
- preview reload is debounced
- live updates are possible for an active full heatmap runtime

If multidimensional slice behavior needs to change, start here before touching the runtime.

## 9. Full heatmap/image runtime

The interactive canvas runtime is implemented by:

- `initializeHeatmapRuntime(shell)`

Key responsibilities:

- read shell `data-*`
- restore cached view state
- progressively fetch heatmap data
- build canvas bitmap
- render axes, color bar, labels, and tooltips
- support zoom/pan/fullscreen
- support plot mode and linked line plots
- support intensity window controls
- support export

### 9.1 Important runtime constants

Examples:

- `HEATMAP_MAX_SIZE = 1024`
- `HEATMAP_MIN_ZOOM = 1`
- `HEATMAP_MAX_ZOOM = 8`
- selection cache limits
- fullscreen restore TTL

These constants control runtime behavior and are the first place to inspect for scaling changes.

### 9.2 Progressive loading

High-resolution loading happens in:

- `fetchHeatmapAtSize(maxSize, loadingMessage, options)`
- `loadHighResHeatmap(options)`

Current strategy:

1. load a fast preview-size heatmap first
2. render it quickly
3. then request a larger high-resolution version

This is why the runtime feels responsive before the full high-res slice is finished.

If load size, speed, or memory behavior must change, inspect these two functions first.

### 9.3 Bitmap generation

Important functions:

- `normalizeHeatmapGrid(data)`
- `createHeatmapBitmap(grid, min, max, colormap)`
- `rebuildHeatmapBitmap()`
- `renderHeatmap()`

Color mapping uses:

- colormap stop arrays
- lookup-table interpolation
- cached `ImageData`/bitmap generation

If you need to add a colormap, update the color stop map and the UI that selects it.

## 10. Plot mode and linked line plots

Heatmap runtime supports a plot mode where clicking a cell opens linked row/column line plots.

Relevant functions:

- `onTogglePlotMode()`
- `onCanvasClick(event)`
- `renderLinkedPlotLine(options)`

Behavior:

- click a heatmap cell
- runtime derives row/column context
- linked line shells are rendered
- line runtime is initialized for those linked shells

This is the bridge between heatmap mode and the line runtime.

If cell-click analysis behavior changes, inspect `heatmapRuntime` first, then the linked line shell markup.

## 11. Intensity window controls

The full runtime includes intensity controls over the color bar.

Relevant behavior:

- enable/disable intensity mode
- drag upper/lower handles
- clamp values safely
- rebuild bitmap using new intensity min/max

Important functions:

- intensity drag handlers
- `onToggleIntensity(...)`
- `rebuildHeatmapBitmap()`

If brightness/contrast style controls need to change, edit the intensity section inside `heatmapRuntime`.

## 12. Histogram behavior

Histogram support is split across two layers.

### 12.1 Histogram preview markup

Functions in render/previews:

- `renderImageHistogramMarkup(...)`
- `renderImageHistogramEmptyMarkup(...)`
- histogram data builders

### 12.2 Interactive histogram runtime

Implemented by:

- `initializeImageHistogramRuntime(shell)`

Responsibilities:

- parse histogram payload
- render histogram SVG/canvas interaction
- support zoom/pan/fullscreen
- update stats and visible range labels

Image mode always uses histogram support. Heatmap mode can optionally use it depending on the feature flag in the render section module.

## 13. Export flow

Like line mode, the heatmap/image runtime exposes:

- `shell.__exportApi`

Viewer-level export menu dispatch happens in:

- `views/viewerView`

Runtime exports generally include:

- displayed CSV
- full CSV
- PNG of current view

If export menu clicks are correct but content is wrong, inspect `heatmapRuntime`.
If the menu itself is wrong, inspect `viewerView`.

## 14. CSS surfaces for image and heatmap

Important selectors in `style.css`:

- `.heatmap-preview-shell`
- `.heatmap-chart-shell`
- `.heatmap-chart-shell.is-fullscreen`
- `.heatmap-chart-toolbar`
- `.heatmap-chart-canvas`
- `.heatmap-canvas`
- `.heatmap-intensity-overlay`
- `.heatmap-intensity-handle`
- `.heatmap-linked-plot`
- `.heatmap-linked-line-panel`
- `.heatmap-inline-line-shell`
- `.image-histogram-shell`
- `.image-histogram-toolbar`
- `.image-histogram-canvas`
- `.image-histogram-stats`
- `.preview-sidebar`
- `.dim-sliders`
- `.dim-slider`
- `.dim-slider-playback`

Use CSS for:

- canvas heights
- fullscreen layout
- toolbar spacing
- histogram panel appearance
- linked plot area layout
- dimension control layout

## 15. What to change where

### 15.1 Change preview appearance only

Edit:

- `renderHeatmapPreview(...)`
- `renderHeatmapSection(...)`
- `renderImageSection(...)`
- heatmap/image preview selectors in `style.css`

### 15.2 Change high-resolution load size or progressive loading strategy

Edit:

- `HEATMAP_MAX_SIZE`
- `fetchHeatmapAtSize(...)`
- `loadHighResHeatmap(...)`

### 15.3 Add or change colormaps

Edit:

1. heatmap colormap stop definitions in `heatmapRuntime`
2. tab/action UI in `viewerView`
3. any preview colormap handling if needed

### 15.4 Change grayscale image behavior

Edit:

- `renderImageSection(...)`
- grayscale defaults in `renderVirtualHeatmapShell(...)`
- histogram titles/subtitles if needed

### 15.5 Change hidden-dimension sliders or playback

Edit:

- `renderDimensionControls(...)`
- `renderFixedIndexControls(...)`
- `state/reducers/displayConfigActions`

### 15.6 Change live slice update behavior

Edit:

- `displayConfigActions.stageFixedIndex(...)`
- `heatmapRuntime.updateSelection(...)`

### 15.7 Change click-to-plot behavior

Edit:

- `onCanvasClick(...)`
- `onTogglePlotMode(...)`
- `renderLinkedPlotLine(...)`

### 15.8 Change histogram behavior

Edit:

- preview histogram render functions
- `initializeImageHistogramRuntime(...)`
- histogram integration points inside `heatmapRuntime`

## 16. Safe change recipes

### Example: add a new colormap

Edit:

1. colormap stop definition map in `heatmapRuntime`
2. `setHeatmapColormap(...)` allowed values
3. color selector UI in `viewerView`

### Example: increase high-resolution limit

Edit:

1. frontend `HEATMAP_MAX_SIZE`
2. backend heatmap limits if necessary
3. test performance and memory before shipping

### Example: disable hidden-dimension playback

Edit:

- playback controls in `renderFixedIndexControls(...)`
- playback actions in `displayConfigActions`

### Example: remove histogram from heatmap mode but keep it for image mode

Edit:

- heatmap histogram feature flag in render sections

### Example: make image mode use a custom intensity title and labels

Edit:

- `renderImageSection(...)`
- histogram subtitle/title values
- possibly `setImageHistogramEmptyState(...)`

## 17. Developer cautions

- image and heatmap share runtime code, so changes in one tab often affect the other
- dimension controls are state-driven; avoid hardcoding slice logic inside the runtime
- runtime shell attributes must stay in sync with state/render config
- linked plot mode reuses the line runtime, so heatmap changes can break line-in-heatmap flows
- progressive loading and bitmap caching are performance-critical

## 18. Summary

Image and heatmap mode are implemented as a shared 2D slice system:

- preview request
  -> preview render
  -> optional high-res runtime shell
  -> heatmap runtime progressive loading
  -> histogram and linked plots layered on top

If a developer needs to change image/heatmap behavior, inspect in this order:

1. `resolveHeatmapRuntimeConfig(...)`
2. `renderHeatmapSection(...)` / `renderImageSection(...)`
3. `renderDimensionControls(...)`
4. `state/reducers/displayConfigActions`
5. `components/viewerPanel/runtime/heatmapRuntime`
6. `components/viewerPanel/runtime/imageHistogramRuntime`
7. related selectors in `style.css`

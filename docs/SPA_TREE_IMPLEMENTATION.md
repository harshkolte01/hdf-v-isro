# SPA Tree Implementation

## 1. Scope

This document explains how the left sidebar tree is implemented in the SPA, how lazy loading works, how tree selection changes the rest of the viewer, and exactly where to edit the code when tree behavior needs to change.

The tree is not an isolated widget. It is tightly connected to:

- selected file state
- selected HDF5 path state
- metadata loading
- preview loading
- line compare dataset selection

## 2. Main files and modules

Primary implementation lives in:

- `spa-single-page/script.js`
  - `api/contracts`
  - `api/hdf5Service`
  - `state/reducers/treeActions`
  - `components/sidebarTree`
  - `views/viewerView`

- `spa-single-page/style.css`
  - tree selectors
  - sidebar layout selectors
  - compare-mode tree selectors

## 3. Backend contract used by the tree

The tree reads backend children from:

```text
GET /files/<key>/children?path=<hdf5-path>
```

Frontend normalization happens in `api/contracts`:

- `normalizeTreeNode(...)`
- `normalizeChildrenResponse(...)`

The normalized node shape used in the SPA is:

- `type`
- `name`
- `path`
- `num_children`
- optional dataset fields:
  - `shape`
  - `dtype`
  - `ndim`
  - `chunks`
  - `compression`

If the backend adds new tree node fields, this module is the first place that must be updated.

## 4. State fields that drive the tree

Tree behavior is controlled by these fields in `state/store`:

- `selectedFile`
- `selectedFileEtag`
- `selectedPath`
- `selectedNodeType`
- `selectedNodeName`
- `expandedPaths`
- `childrenCache`
- `treeLoadingPaths`
- `treeErrors`

Meaning:

- `expandedPaths`
  - which group paths are open

- `childrenCache`
  - map of `path -> children[]`
  - avoids refetching when a group is reopened

- `treeLoadingPaths`
  - set of paths currently loading
  - used to render loading rows

- `treeErrors`
  - map of `path -> error message`
  - used to render retry controls

## 5. Tree lifecycle

### 5.1 When a file opens

`filesActions.openViewer(...)` resets tree-related state to a clean viewer session:

- `selectedPath = "/"`
- `selectedNodeType = "group"`
- `expandedPaths = new Set(["/"])`
- `childrenCache = new Map()`
- `treeLoadingPaths = new Set()`
- `treeErrors = new Map()`

Then it immediately calls:

- `actions.loadTreeChildren("/")`

That means the root group is loaded lazily right after a file is opened.

### 5.2 Lazy loading children

`treeActions.loadTreeChildren(path, options)`

Responsibilities:

- normalize the HDF5 path
- return cached children if already loaded and `force !== true`
- mark the path as loading
- call `getFileChildren(selectedFile, path, { etag })`
- store returned children in `childrenCache`
- clear loading/error state
- save the error in `treeErrors` if the request fails

This is the core lazy-loading function for the entire tree.

### 5.3 Expanding and collapsing groups

`treeActions.toggleTreePath(path)`

Responsibilities:

- toggle the path inside `expandedPaths`
- force root `/` to stay expandable
- if a path is being expanded, call `loadTreeChildren(path)`

Changing expand/collapse behavior always starts here.

### 5.4 Selecting a tree node

`treeActions.selectTreeNode(node)`

This is the most important tree action.

For every selection, it:

- normalizes the path
- updates:
  - `selectedPath`
  - `selectedNodeType`
  - `selectedNodeName`
- ensures ancestors are expanded
- resets full-view runtime flags

Then it branches by node type:

If the node is a group:

- loads children
- loads metadata
- clears preview state
- resets line comparison state

If the node is a dataset:

- loads metadata
- loads preview
- resets display config when base dataset changes
- clears compare items when base dataset changes

This is the main reason tree code affects the rest of the application so strongly.

### 5.5 Breadcrumb navigation

The top breadcrumb uses:

- `treeActions.onBreadcrumbSelect(path)`

It:

- expands required ancestors
- updates selected path
- resets preview-related state for group navigation
- loads children for the destination path when needed
- always loads metadata for the destination path

If you change tree path navigation semantics, update both:

- `selectTreeNode(...)`
- `onBreadcrumbSelect(...)`

## 6. Tree API service and caching

The tree uses `api/hdf5Service.getFileChildren(...)`.

Important caching behavior:

- cache is per file
- cache key is `path|etag`
- cache lives in a per-file `Map`

This means tree cache is invalidated when:

- a different file is opened
- the selected file etag changes
- frontend caches are cleared

If tree cache behavior changes, edit:

- `getFileChildren(...)`
- `getTreeCache(...)`
- the reducer actions that call them

## 7. Tree rendering

The sidebar tree markup is built in `components/sidebarTree`.

Key functions:

- `renderSidebarTree(state)`
- `renderNode(node, state, compareContext)`
- `renderStatus(state, path)`
- `renderSidebarMetadata(state)` for the lower half of the sidebar

### 7.1 Render model

The tree is rendered recursively.

`renderSidebarTree(...)` creates a synthetic root node:

- `type: "group"`
- `path: "/"`
- `name: selectedFile`

Then `renderNode(...)` recursively renders:

- caret
- icon
- label
- child count
- compare button when compare mode is active
- nested `<ul>` branch if the group is expanded

### 7.2 Loading/error rows

`renderStatus(state, path)` appends status rows under a group:

- loading row
- error row with retry button
- empty state row

If you want different loading or retry UI, edit this function first.

### 7.3 Selection visuals

The selected row is based on:

- `state.selectedPath === path`

The active row gets the `active` class.

If selection looks wrong, inspect both:

- `renderNode(...)`
- reducer updates to `selectedPath`

## 8. Tree event handling

Tree events are delegated inside `components/sidebarTree`.

The sidebar tree module handles:

- compare add buttons
- caret toggles
- retry buttons
- row selection buttons

It forwards actions to reducer methods such as:

- `toggleTreePath(...)`
- `loadTreeChildren(...)`
- `selectTreeNode(...)`
- `addLineCompareDataset(...)`

This means tree buttons are mostly dumb UI. Real state changes happen in the reducers.

## 9. Tree compare integration

The tree is also the dataset picker for line comparison.

Important behavior:

- compare controls appear only when:
  - route is `viewer`
  - current tab is `line`
  - `lineCompareEnabled === true`

- compare eligibility is computed in `renderNode(...)`
- compatibility is checked using:
  - numeric dtype
  - same ndim
  - same shape

Related modules:

- `components/sidebarTree`
- `state/reducers/compareActions`
- `components/viewerPanel/render/sections`
- `components/viewerPanel/runtime/lineRuntime`

If compare buttons in the tree need to change, start in `renderNode(...)`.

## 10. CSS surfaces for the tree

Tree-related selectors in `style.css` include:

- `.viewer-sidebar`
- `.sidebar-section-tree`
- `.sidebar-tree`
- `.tree-root`
- `.tree-branch`
- `.tree-node`
- `.tree-row`
- `.tree-row.active`
- `.tree-caret`
- `.tree-icon`
- `.tree-label`
- `.tree-count`
- `.tree-status`
- `.tree-retry-btn`
- `.tree-compare-btn`
- `.sidebar-tree.is-compare-mode`

Use CSS for:

- spacing
- hover/active visuals
- compare-mode layout
- icon/caret sizing
- mobile/sidebar responsiveness

Do not put tree state logic into CSS.

## 11. What to change where

### 11.1 Change lazy loading or caching

Edit:

- `api/hdf5Service.getFileChildren(...)`
- `state/reducers/treeActions.loadTreeChildren(...)`

### 11.2 Change what happens after selecting a group

Edit:

- `state/reducers/treeActions.selectTreeNode(...)`

Specifically the `group` branch.

### 11.3 Change what happens after selecting a dataset

Edit:

- `state/reducers/treeActions.selectTreeNode(...)`
- possibly `state/reducers/dataActions.loadPreview(...)`

### 11.4 Change expand/collapse behavior

Edit:

- `state/reducers/treeActions.toggleTreePath(...)`
- `components/sidebarTree.renderNode(...)`

### 11.5 Change breadcrumb behavior

Edit:

- `state/reducers/treeActions.onBreadcrumbSelect(...)`
- `views/viewerView.renderViewerTopBar(...)`

### 11.6 Add more information to each tree row

Edit:

1. `api/contracts.normalizeTreeNode(...)` if the backend field is new
2. `components/sidebarTree.renderNode(...)` to render it
3. `style.css` for row layout

### 11.7 Change tree icons, labels, or row visuals

Edit:

- `components/sidebarTree.renderNode(...)`
- tree-related selectors in `style.css`

### 11.8 Change compare buttons in the tree

Edit:

- `components/sidebarTree.renderNode(...)`
- `state/reducers/compareActions`

## 12. Safe change recipes

### Example: add dtype text beside dataset names

Edit:

1. `renderNode(...)` to include `node.dtype`
2. `style.css` to keep rows aligned

Do not change reducers unless selection behavior also changes.

### Example: force children to reload every expand

Edit:

1. `toggleTreePath(...)` to call `loadTreeChildren(path, { force: true })`
2. possibly `getFileChildren(...)` if you also want to bypass frontend cache

### Example: add a new badge for compressed datasets

Edit:

1. ensure `compression` is normalized in `normalizeTreeNode(...)`
2. render the badge in `renderNode(...)`
3. style the badge in `style.css`

## 13. Developer cautions

- `selectedPath` drives both tree highlight and downstream preview/metadata behavior
- tree code is coupled to metadata and preview loading through reducer actions
- compare mode adds extra tree controls; test line mode after changing tree markup
- do not mutate `childrenCache`, `expandedPaths`, or `treeErrors` directly outside reducer updates

## 14. Summary

The tree is implemented as:

- backend children data
  -> normalized by `api/contracts`
  -> cached by `api/hdf5Service`
  -> written into state by `treeActions`
  -> rendered recursively by `components/sidebarTree`

If a developer needs to change tree behavior, the first files to inspect are:

- `state/reducers/treeActions`
- `components/sidebarTree`
- tree selectors in `style.css`

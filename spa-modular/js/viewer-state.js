// Viewer HTML module: Defines the mutable global viewer state object with subscribe and setState update hooks.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/store.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/store.");
        return;
    }
    var moduleState = ensurePath(ns, "state.store");

    // Single mutable state object â€” the entire UI is derived from this.
    // Mutated only via setState(); reads via getState().
    const state = {
        // Current page route: 'home' shows file list, 'viewer' shows the HDF5 file viewer
        route: "home",
        // Blocks viewer render until a file is loaded via deep-link or user selection
        viewerBlocked: true,

        // --- File list ---
        files: [],
        loading: false,
        error: null,
        refreshing: false,
        searchQuery: "",

        // --- Selected file ---
        selectedFile: null,       // object key of the HDF5 file being viewed
        selectedFileEtag: null,   // ETag used to detect file changes for cache validation

        // --- Selected HDF5 node in the tree ---
        selectedNodeType: "group",
        selectedNodeName: "/",
        selectedPath: "/",

        // --- Tree state ---
        expandedPaths: new Set(["/"]),    // Set of paths with open group nodes
        childrenCache: new Map(),          // path -> TreeNode[] for loaded group children
        treeLoadingPaths: new Set(),       // paths currently loading children
        treeErrors: new Map(),             // path -> error message for failed child loads

        // --- Panel view mode ---
        viewMode: "display",              // SPA shell keeps the main area on display; metadata now lives in the sidebar

        // --- Metadata and preview data ---
        metadata: null,
        metadataLoading: false,
        metadataError: null,
        preview: null,
        previewLoading: false,
        previewError: null,
        previewRequestKey: null,           // unique key stamped onto the latest preview request to detect stale responses
        previewRequestInFlight: false,

        // --- Display mode sub-tab ---
        displayTab: "line",               // active tab: 'line', 'image', 'heatmap', or 'matrix'

        // --- Per-view display preferences ---
        notation: "auto",                 // numeric notation for matrix cells: 'auto', 'fixed', or 'sci'
        lineGrid: true,
        lineAspect: "line",
        lineCompareEnabled: false,         // whether the compare overlay is active in line mode
        lineCompareItems: [],              // array of { path, name, dtype, ndim, shape } compare entries
        lineCompareStatus: null,
        heatmapGrid: true,
        heatmapColormap: "viridis",       // colormap name for heatmap: viridis, plasma, inferno, etc.

        // --- Full-view enable flags ---
        // When false, only the fast preview is shown; setting to true activates the interactive runtime
        matrixFullEnabled: false,
        lineFullEnabled: false,
        heatmapFullEnabled: false,

        // --- Matrix block streaming config ---
        matrixBlockSize: {
            rows: 160,   // number of data rows per streamed block request
            cols: 40,    // number of data columns per streamed block request
        },

        // --- Dimension config for 3D+ datasets ---
        // displayDims: which two dimensions map to the XY axes (e.g. [0, 1])
        // fixedIndices: slice index for each non-displayed dimension (e.g. { 2: 5 })
        // staged* = pending user selection not yet applied; applied after clicking "Apply"
        displayConfig: {
            displayDims: null,
            fixedIndices: {},
            stagedDisplayDims: null,
            stagedFixedIndices: {},
            playingFixedDim: null,
        },

        // --- Cache response snapshots (informational only, not used for rendering) ---
        cacheResponses: {
            files: [],
            children: {},
            meta: {},
            preview: {},
            data: {},
        },

        // --- Which renderer implementation to use per view type ---
        rendererPlan: {
            line: "svg",                  // line chart uses inline SVG
            heatmap: "canvas",            // heatmap uses Canvas 2D API
            matrix: "block-rendering",    // matrix uses virtual block streaming
        },

        // Whether the sidebar is expanded
        sidebarOpen: true,
    };

    // Subscriber set â€” all listeners are called after every setState call
    const listeners = new Set();

    // Returns the current state object by reference (do not mutate directly)
    function getState() {
        return state;
    }

    // Merges a patch or the result of an updater function into state,
    // then notifies all subscribers so the UI can re-render.
    function setState(updater, options = {}) {
        const notify = options && options.notify === false ? false : true;
        const patch = typeof updater === "function" ? updater(state) : updater;
        if (!patch || typeof patch !== "object") {
            return;
        }

        Object.assign(state, patch);
        if (notify) {
            listeners.forEach((listener) => listener(state));
        }
    }

    // Registers a listener to be called after each setState; returns an unsubscribe function
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
    if (typeof state !== "undefined") {
        moduleState.state = state;
        global.state = state;
    }
    if (typeof getState !== "undefined") {
        moduleState.getState = getState;
        global.getState = getState;
    }
    if (typeof setState !== "undefined") {
        moduleState.setState = setState;
        global.setState = setState;
    }
    if (typeof subscribe !== "undefined") {
        moduleState.subscribe = subscribe;
        global.subscribe = subscribe;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/store");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Contains shared reducer helpers for path normalization and multidimensional display configuration math.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/utils.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/utils.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.utils");

    // Normalizes an HDF5 path string to always start with / and never end with / (except root)
    function normalizePath(path) {
        if (!path || path === "/") {
            return "/";
        }

        const normalized = `/${String(path).replace(/^\/+/, "").replace(/\/+/g, "/")}`;
        return normalized.endsWith("/") && normalized.length > 1
            ? normalized.slice(0, -1)
            : normalized;
    }

    // Returns the full list of ancestor paths for a given path, including root and the path itself
    function getAncestorPaths(path) {
        const normalized = normalizePath(path);
        if (normalized === "/") {
            return ["/"];
        }

        const parts = normalized.split("/").filter(Boolean);
        const ancestors = ["/"];
        let current = "";

        parts.forEach((part) => {
            current += `/${part}`;
            ancestors.push(current);
        });

        return ancestors;
    }

    // Returns the last segment of a path as a display name; falls back to the provided fallbackName if available
    function getNodeName(path, fallbackName = "") {
        if (fallbackName) {
            return fallbackName;
        }

        const normalized = normalizePath(path);
        if (normalized === "/") {
            return "/";
        }

        const parts = normalized.split("/").filter(Boolean);
        return parts[parts.length - 1] || "/";
    }

    // Parses a value to an integer; returns fallback for non-finite inputs (unlike parseInt, handles Infinity/NaN)
    function toSafeInteger(value, fallback = null) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.trunc(parsed);
    }

    // Returns a clean displayConfig object with all fields reset to null/empty; used when opening a new viewer screen
    function getDisplayConfigDefaults() {
        return {
            displayDims: null,
            fixedIndices: {},
            stagedDisplayDims: null,
            stagedFixedIndices: {},
            playingFixedDim: null,
        };
    }

    // Clamps each shape dimension to a non-negative safe integer; used to protect against malformed server responses
    function normalizeShape(shape) {
        if (!Array.isArray(shape)) {
            return [];
        }

        return shape.map((size) => Math.max(0, toSafeInteger(size, 0)));
    }

    // Returns the default two display axes [0, 1] for a dataset with ndim >= 2; null for 1-D or scalar datasets
    function getDefaultDisplayDims(shape) {
        return shape.length >= 2 ? [0, 1] : null;
    }

    // Validates and normalizes displayDims for a given shape; prevents out-of-range axes and ensures the two axes differ
    function normalizeDisplayDimsForShape(displayDims, shape) {
        if (shape.length < 2) {
            return null;
        }

        if (!Array.isArray(displayDims) || displayDims.length !== 2) {
            return null;
        }

        const dims = displayDims.map((dim) => toSafeInteger(dim, null));
        if (dims.some((dim) => dim === null || dim < 0 || dim >= shape.length)) {
            return null;
        }

        if (dims[0] === dims[1]) {
            const fallback = Array.from({ length: shape.length }, (_, idx) => idx).find(
                (dim) => dim !== dims[0]
            );

            if (fallback === undefined) {
                return null;
            }

            dims[1] = fallback;
        }

        return dims;
    }

    // Normalizes fixedIndices, removing entries for displayDims axes and clamping values to valid dimension bounds
    function normalizeFixedIndicesForShape(fixedIndices, shape, displayDims = []) {
        // displayDims axes should not have fixed indices â€” they are the display axes
        const hiddenDims = new Set(Array.isArray(displayDims) ? displayDims : []);
        const normalized = {};

        if (!fixedIndices || typeof fixedIndices !== "object") {
            return normalized;
        }

        Object.entries(fixedIndices).forEach(([dimKey, indexValue]) => {
            const dim = toSafeInteger(dimKey, null);
            const index = toSafeInteger(indexValue, null);

            if (
                dim === null ||
                index === null ||
                dim < 0 ||
                dim >= shape.length ||
                hiddenDims.has(dim)
            ) {
                return;
            }

            const max = Math.max(0, shape[dim] - 1);
            normalized[dim] = Math.max(0, Math.min(max, index));
        });

        return normalized;
    }

    function buildNextFixedIndices(currentIndices, displayDims, shape) {
        const normalizedDims = Array.isArray(displayDims) ? displayDims : [];
        const next = normalizeFixedIndicesForShape(currentIndices, shape, normalizedDims);
        const hidden = new Set(normalizedDims);

        shape.forEach((size, dim) => {
            if (hidden.has(dim)) {
                delete next[dim];
                return;
            }

            const max = Math.max(0, size - 1);
            const fallback = size > 0 ? Math.floor(size / 2) : 0;

            if (!Number.isFinite(next[dim])) {
                next[dim] = fallback;
                return;
            }

            next[dim] = Math.max(0, Math.min(max, toSafeInteger(next[dim], fallback)));
        });

        return next;
    }

    function buildDisplayDimsParam(displayDims) {
        if (!Array.isArray(displayDims) || displayDims.length !== 2) {
            return undefined;
        }

        return `${displayDims[0]},${displayDims[1]}`;
    }

    function buildFixedIndicesParam(fixedIndices) {
        if (!fixedIndices || typeof fixedIndices !== "object") {
            return undefined;
        }

        const entries = Object.entries(fixedIndices)
            .map(([dim, index]) => [toSafeInteger(dim, null), toSafeInteger(index, null)])
            .filter(([dim, index]) => dim !== null && index !== null)
            .sort(([a], [b]) => a - b);

        if (!entries.length) {
            return undefined;
        }

        return entries.map(([dim, index]) => `${dim}=${index}`).join(",");
    }

    function areDisplayDimsEqual(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 && a[0] === b[0] && a[1] === b[1];
    }

    function areFixedIndicesEqual(a, b) {
        const left = a && typeof a === "object" ? a : {};
        const right = b && typeof b === "object" ? b : {};
        const leftKeys = Object.keys(left).sort((x, y) => Number(x) - Number(y));
        const rightKeys = Object.keys(right).sort((x, y) => Number(x) - Number(y));

        if (leftKeys.length !== rightKeys.length) {
            return false;
        }

        return leftKeys.every((key, index) => {
            const otherKey = rightKeys[index];
            return key === otherKey && Number(left[key]) === Number(right[otherKey]);
        });
    }

    function resolveDisplayDimsFromConfig(config, shape) {
        return (
            normalizeDisplayDimsForShape(config?.stagedDisplayDims, shape) ||
            normalizeDisplayDimsForShape(config?.displayDims, shape) ||
            getDefaultDisplayDims(shape)
        );
    }

    function getNextAvailableDim(totalDims, disallowedDims = [], preferred = 0) {
        if (totalDims <= 0) {
            return null;
        }

        const blocked = new Set(disallowedDims);
        const normalizedPreferred = Math.max(0, Math.min(totalDims - 1, toSafeInteger(preferred, 0)));

        if (!blocked.has(normalizedPreferred)) {
            return normalizedPreferred;
        }

        for (let offset = 1; offset < totalDims; offset += 1) {
            const plus = normalizedPreferred + offset;
            if (plus < totalDims && !blocked.has(plus)) {
                return plus;
            }

            const minus = normalizedPreferred - offset;
            if (minus >= 0 && !blocked.has(minus)) {
                return minus;
            }
        }

        return null;
    }
    if (typeof normalizePath !== "undefined") {
        moduleState.normalizePath = normalizePath;
        global.normalizePath = normalizePath;
    }
    if (typeof getAncestorPaths !== "undefined") {
        moduleState.getAncestorPaths = getAncestorPaths;
        global.getAncestorPaths = getAncestorPaths;
    }
    if (typeof getNodeName !== "undefined") {
        moduleState.getNodeName = getNodeName;
        global.getNodeName = getNodeName;
    }
    if (typeof toSafeInteger !== "undefined") {
        moduleState.toSafeInteger = toSafeInteger;
        global.toSafeInteger = toSafeInteger;
    }
    if (typeof getDisplayConfigDefaults !== "undefined") {
        moduleState.getDisplayConfigDefaults = getDisplayConfigDefaults;
        global.getDisplayConfigDefaults = getDisplayConfigDefaults;
    }
    if (typeof normalizeShape !== "undefined") {
        moduleState.normalizeShape = normalizeShape;
        global.normalizeShape = normalizeShape;
    }
    if (typeof getDefaultDisplayDims !== "undefined") {
        moduleState.getDefaultDisplayDims = getDefaultDisplayDims;
        global.getDefaultDisplayDims = getDefaultDisplayDims;
    }
    if (typeof normalizeDisplayDimsForShape !== "undefined") {
        moduleState.normalizeDisplayDimsForShape = normalizeDisplayDimsForShape;
        global.normalizeDisplayDimsForShape = normalizeDisplayDimsForShape;
    }
    if (typeof normalizeFixedIndicesForShape !== "undefined") {
        moduleState.normalizeFixedIndicesForShape = normalizeFixedIndicesForShape;
        global.normalizeFixedIndicesForShape = normalizeFixedIndicesForShape;
    }
    if (typeof buildNextFixedIndices !== "undefined") {
        moduleState.buildNextFixedIndices = buildNextFixedIndices;
        global.buildNextFixedIndices = buildNextFixedIndices;
    }
    if (typeof buildDisplayDimsParam !== "undefined") {
        moduleState.buildDisplayDimsParam = buildDisplayDimsParam;
        global.buildDisplayDimsParam = buildDisplayDimsParam;
    }
    if (typeof buildFixedIndicesParam !== "undefined") {
        moduleState.buildFixedIndicesParam = buildFixedIndicesParam;
        global.buildFixedIndicesParam = buildFixedIndicesParam;
    }
    if (typeof areDisplayDimsEqual !== "undefined") {
        moduleState.areDisplayDimsEqual = areDisplayDimsEqual;
        global.areDisplayDimsEqual = areDisplayDimsEqual;
    }
    if (typeof areFixedIndicesEqual !== "undefined") {
        moduleState.areFixedIndicesEqual = areFixedIndicesEqual;
        global.areFixedIndicesEqual = areFixedIndicesEqual;
    }
    if (typeof resolveDisplayDimsFromConfig !== "undefined") {
        moduleState.resolveDisplayDimsFromConfig = resolveDisplayDimsFromConfig;
        global.resolveDisplayDimsFromConfig = resolveDisplayDimsFromConfig;
    }
    if (typeof getNextAvailableDim !== "undefined") {
        moduleState.getNextAvailableDim = getNextAvailableDim;
        global.getNextAvailableDim = getNextAvailableDim;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/utils");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Handles file list loading, viewer open/reset lifecycle, and route-level file selection state.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/filesActions.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/filesActions.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.filesActions");

    // Destructures all dependencies from the shared deps bundle for use inside action functions
    function unpackDeps(deps) {
        const { actions, getState, setState, api, utils } = deps;
        const { getFiles, refreshFiles, getFileChildren, getFileMeta, getFilePreview } = api;
        const {
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = utils;

        return {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        };
    }
    function createFileActions(deps) {
        const {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getDisplayConfigDefaults,
        } = unpackDeps(deps);

        return {
            // Fetches the file list from the API (or frontend cache) and updates state.files
            async loadFiles() {
                setState({ loading: true, error: null });

                try {
                    const data = await getFiles();
                    const files = Array.isArray(data.files) ? data.files : [];

                    setState((prev) => ({
                        files,
                        loading: false,
                        cacheResponses: {
                            ...prev.cacheResponses,
                            files,
                        },
                    }));
                } catch (error) {
                    setState({
                        loading: false,
                        error: error.message || "Failed to load files",
                    });
                }
            },

            // Triggers a backend cache refresh, clears frontend caches, then reloads the file list
            async refreshFileList() {
                setState({ refreshing: true, error: null });

                try {
                    await refreshFiles();
                    await actions.loadFiles();
                } catch (error) {
                    setState({
                        error: error.message || "Failed to refresh files",
                    });
                } finally {
                    setState({ refreshing: false });
                }
            },

            // Sets route to "viewer", resets all per-session state to initial defaults, and starts loading the root tree node
            openViewer(fileSelection) {
                const selection =
                    typeof fileSelection === "string"
                        ? { key: fileSelection, etag: null }
                        : fileSelection || {};

                setState({
                    route: "viewer",
                    viewerBlocked: false,
                    selectedFile: selection.key || null,
                    selectedFileEtag: selection.etag || null,
                    selectedNodeType: "group",
                    selectedNodeName: "/",
                    selectedPath: "/",
                    expandedPaths: new Set(["/"]),
                    childrenCache: new Map(),
                    treeLoadingPaths: new Set(),
                    treeErrors: new Map(),
                    metadata: null,
                    metadataLoading: false,
                    metadataError: null,
                    preview: null,
                    previewLoading: false,
                    previewError: null,
                    previewRequestKey: null,
                    previewRequestInFlight: false,
                    viewMode: "display",
                    displayTab: "line",
                    notation: "auto",
                    lineGrid: true,
                    lineAspect: "line",
                    lineCompareEnabled: false,
                    lineCompareItems: [],
                    lineCompareStatus: null,
                    heatmapGrid: true,
                    heatmapColormap: "viridis",
                    matrixFullEnabled: false,
                    lineFullEnabled: false,
                    heatmapFullEnabled: false,
                    displayConfig: getDisplayConfigDefaults(),
                });

                void actions.loadTreeChildren("/");
                // Prime the sidebar metadata panel with root-level metadata as soon as a file opens.
                void actions.loadMetadata("/");
            },

            // Resets route to "home", clears all viewer state, and marks viewerBlocked to prevent dataset rendering
            goHome() {
                setState({
                    route: "home",
                    viewerBlocked: true,
                    selectedFile: null,
                    selectedFileEtag: null,
                    selectedNodeType: "group",
                    selectedNodeName: "/",
                    selectedPath: "/",
                    expandedPaths: new Set(["/"]),
                    childrenCache: new Map(),
                    treeLoadingPaths: new Set(),
                    treeErrors: new Map(),
                    metadata: null,
                    metadataLoading: false,
                    metadataError: null,
                    preview: null,
                    previewLoading: false,
                    previewError: null,
                    previewRequestKey: null,
                    previewRequestInFlight: false,
                    viewMode: "display",
                    displayTab: "line",
                    lineCompareEnabled: false,
                    lineCompareItems: [],
                    lineCompareStatus: null,
                    matrixFullEnabled: false,
                    lineFullEnabled: false,
                    heatmapFullEnabled: false,
                    displayConfig: getDisplayConfigDefaults(),
                });
            },

            setSearchQuery(searchQuery) {
                setState({ searchQuery });
            },

            setSelectedPath(path) {
                return actions.onBreadcrumbSelect(path);
            },

        };
    }
    if (typeof createFileActions !== "undefined") {
        moduleState.createFileActions = createFileActions;
        global.createFileActions = createFileActions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/filesActions");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Handles tree expand/select/breadcrumb interactions and lazy child loading behavior.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/treeActions.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/treeActions.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.treeActions");

    // Destructures all needed dependencies from the shared deps bundle
    function unpackDeps(deps) {
        const { actions, getState, setState, api, utils } = deps;
        const { getFiles, refreshFiles, getFileChildren, getFileMeta, getFilePreview } = api;
        const {
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = utils;

        return {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        };
    }
    function createTreeActions(deps) {
        const {
            actions,
            getState,
            setState,
            getFileChildren,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            getDisplayConfigDefaults,
        } = unpackDeps(deps);

        return {
            // Handles navigation via the breadcrumb bar: expands ancestor paths, clears preview state, and loads children
            onBreadcrumbSelect(path) {
                const normalizedPath = normalizePath(path);
                const requiredAncestors = getAncestorPaths(normalizedPath);
                const snapshot = getState();
                const preserveDatasetSelection =
                    snapshot.selectedNodeType === "dataset" &&
                    snapshot.selectedPath === normalizedPath;

                setState((prev) => {
                    const expanded = new Set(prev.expandedPaths || ["/"]);
                    requiredAncestors.forEach((entry) => expanded.add(entry));

                    if (preserveDatasetSelection) {
                        return {
                            selectedPath: normalizedPath,
                            selectedNodeType: "dataset",
                            selectedNodeName: getNodeName(normalizedPath, prev.selectedNodeName || ""),
                            expandedPaths: expanded,
                        };
                    }

                    return {
                        selectedPath: normalizedPath,
                        selectedNodeType: "group",
                        selectedNodeName: getNodeName(normalizedPath),
                        expandedPaths: expanded,
                        matrixFullEnabled: false,
                        lineFullEnabled: false,
                        heatmapFullEnabled: false,
                        displayConfig: getDisplayConfigDefaults(),
                        metadata: null,
                        metadataLoading: false,
                        metadataError: null,
                        preview: null,
                        previewLoading: false,
                        previewError: null,
                        previewRequestKey: null,
                        previewRequestInFlight: false,
                        lineCompareItems: [],
                        lineCompareStatus: null,
                    };
                });

                if (!preserveDatasetSelection) {
                    void actions.loadTreeChildren(normalizedPath);
                }

                const current = getState();
                if (current.route === "viewer") {
                    // Breadcrumb navigation should update sidebar metadata even when the main panel stays in display mode.
                    void actions.loadMetadata(normalizedPath);
                }
            },

            // Lazily loads children for a tree path; uses the childrenCache Map to avoid refetching on re-expand
            async loadTreeChildren(path, options = {}) {
                const normalizedPath = normalizePath(path);
                const { force = false } = options;
                const snapshot = getState();

                if (!snapshot.selectedFile) {
                    return [];
                }

                if (!force && snapshot.childrenCache instanceof Map && snapshot.childrenCache.has(normalizedPath)) {
                    return snapshot.childrenCache.get(normalizedPath) || [];
                }

                setState((prev) => {
                    const treeLoadingPaths = new Set(prev.treeLoadingPaths || []);
                    treeLoadingPaths.add(normalizedPath);

                    const treeErrors = new Map(prev.treeErrors || []);
                    treeErrors.delete(normalizedPath);

                    return {
                        treeLoadingPaths,
                        treeErrors,
                    };
                });

                try {
                    const response = await getFileChildren(snapshot.selectedFile, normalizedPath, {
                        force,
                        etag: snapshot.selectedFileEtag || undefined,
                    });
                    const children = Array.isArray(response.children) ? response.children : [];

                    setState((prev) => {
                        const childrenCache = new Map(prev.childrenCache || []);
                        childrenCache.set(normalizedPath, children);

                        const treeLoadingPaths = new Set(prev.treeLoadingPaths || []);
                        treeLoadingPaths.delete(normalizedPath);

                        return {
                            childrenCache,
                            treeLoadingPaths,
                        };
                    });

                    return children;
                } catch (error) {
                    setState((prev) => {
                        const treeLoadingPaths = new Set(prev.treeLoadingPaths || []);
                        treeLoadingPaths.delete(normalizedPath);

                        const treeErrors = new Map(prev.treeErrors || []);
                        treeErrors.set(normalizedPath, error.message || "Failed to load tree node");

                        return {
                            treeLoadingPaths,
                            treeErrors,
                        };
                    });

                    throw error;
                }
            },

            toggleTreePath(path) {
                const normalizedPath = normalizePath(path);
                let shouldExpand = false;

                setState((prev) => {
                    const expandedPaths = new Set(prev.expandedPaths || ["/"]);

                    if (normalizedPath === "/") {
                        expandedPaths.add("/");
                        shouldExpand = true;
                    } else if (expandedPaths.has(normalizedPath)) {
                        expandedPaths.delete(normalizedPath);
                    } else {
                        expandedPaths.add(normalizedPath);
                        shouldExpand = true;
                    }

                    return { expandedPaths };
                });

                if (shouldExpand) {
                    void actions.loadTreeChildren(normalizedPath);
                }
            },

            selectTreeNode(node) {
                const normalizedPath = normalizePath(node.path || "/");
                const nodeType = node.type === "dataset" ? "dataset" : "group";
                const nodeName = getNodeName(normalizedPath, node.name || "");
                const requiredAncestors = getAncestorPaths(normalizedPath);

                setState((prev) => {
                    const expandedPaths = new Set(prev.expandedPaths || ["/"]);
                    requiredAncestors.forEach((entry) => expandedPaths.add(entry));
                    const datasetBaseChanged =
                        nodeType === "dataset" && normalizePath(prev.selectedPath || "/") !== normalizedPath;

                    return {
                        selectedPath: normalizedPath,
                        selectedNodeType: nodeType,
                        selectedNodeName: nodeName,
                        expandedPaths,
                        matrixFullEnabled: false,
                        lineFullEnabled: false,
                        heatmapFullEnabled: false,
                        ...(datasetBaseChanged
                            ? {
                                lineCompareItems: [],
                                lineCompareStatus: null,
                            }
                            : {}),
                        ...(nodeType === "dataset" ? { displayConfig: getDisplayConfigDefaults() } : {}),
                        ...(nodeType === "group"
                            ? {
                                displayConfig: getDisplayConfigDefaults(),
                                metadata: null,
                                metadataLoading: false,
                                metadataError: null,
                                preview: null,
                                previewLoading: false,
                                previewError: null,
                                previewRequestKey: null,
                                previewRequestInFlight: false,
                                lineCompareItems: [],
                                lineCompareStatus: null,
                            }
                            : {}),
                    };
                });

                const current = getState();
                if (nodeType === "group") {
                    void actions.loadTreeChildren(normalizedPath);
                    // Groups only affect the tree + sidebar metadata panel.
                    void actions.loadMetadata(normalizedPath);
                    return;
                }

                // Datasets drive both sidebar metadata and the main display preview.
                void actions.loadMetadata(normalizedPath);
                if (current.viewMode === "display") {
                    void actions.loadPreview(normalizedPath);
                }
            },

        };
    }
    if (typeof createTreeActions !== "undefined") {
        moduleState.createTreeActions = createTreeActions;
        global.createTreeActions = createTreeActions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/treeActions");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Handles sidebar, mode/tab toggles, display options, and full-view enable transitions.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/viewActions.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/viewActions.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.viewActions");
    function unpackDeps(deps) {
        const { actions, getState, setState, api, utils } = deps;
        const { getFiles, refreshFiles, getFileChildren, getFileMeta, getFilePreview } = api;
        const {
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = utils;

        return {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        };
    }
    function createViewActions(deps) {
        const {
            actions,
            getState,
            setState,
            normalizeShape,
            normalizeDisplayDimsForShape,
            getDefaultDisplayDims,
        } = unpackDeps(deps);

        return {
            // Flips sidebar open/closed; used by the toggle button in the topbar
            toggleSidebar() {
                const current = getState();
                setState({ sidebarOpen: !current.sidebarOpen });
            },

            // Explicitly sets sidebar open state; called by the responsive breakpoint listener in app-viewer.js
            setSidebarOpen(open) {
                setState({ sidebarOpen: !!open });
            },

            // SPA shell is display-only in the main panel; keep viewMode pinned to display if any legacy caller invokes this.
            setViewMode(viewMode) {
                void viewMode;
                const mode = "display";
                setState({
                    viewMode: mode,
                });

                const current = getState();
                if (current.route !== "viewer") {
                    return;
                }

                if (current.selectedNodeType === "dataset") {
                    void actions.loadPreview(current.selectedPath);
                }

                void actions.loadMetadata(current.selectedPath);
            },

            setDisplayTab(tab) {
                const nextTab = ["table", "line", "image", "heatmap"].includes(tab) ? tab : "line";
                const snapshot = getState();
                const tabChanged = snapshot.displayTab !== nextTab;
                const nextTabIsHeatmapLike = nextTab === "heatmap" || nextTab === "image";
                const currentPreviewMode =
                    snapshot.displayTab === "line"
                        ? "line"
                        : snapshot.displayTab === "heatmap" || snapshot.displayTab === "image"
                            ? "heatmap"
                            : "table";
                const nextPreviewMode =
                    nextTab === "line"
                        ? "line"
                        : nextTabIsHeatmapLike
                            ? "heatmap"
                            : "table";
                setState({
                    displayTab: nextTab,
                    ...(nextTab !== "table" ? { matrixFullEnabled: false } : {}),
                    ...(nextTab !== "line" ? { lineFullEnabled: false } : {}),
                    ...(!nextTabIsHeatmapLike ? { heatmapFullEnabled: false } : {}),
                    ...(!nextTabIsHeatmapLike
                        ? {
                            displayConfig: {
                                ...(snapshot.displayConfig || getDisplayConfigDefaults()),
                                playingFixedDim: null,
                            },
                        }
                        : {}),
                });

                if (!nextTabIsHeatmapLike && typeof actions.stopFixedIndexPlayback === "function") {
                    actions.stopFixedIndexPlayback();
                }

                if (!tabChanged) {
                    return;
                }

                const shouldReloadPreview =
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset" &&
                    snapshot.selectedPath !== "/";

                if (shouldReloadPreview && currentPreviewMode !== nextPreviewMode) {
                    void actions.loadPreview(snapshot.selectedPath);
                }
            },

            enableMatrixFullView() {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                const displayDims =
                    normalizeDisplayDimsForShape(snapshot.displayConfig?.displayDims, shape) ||
                    normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) ||
                    getDefaultDisplayDims(shape);

                const canEnable =
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset" &&
                    shape.length >= 2 &&
                    Array.isArray(displayDims) &&
                    displayDims.length === 2;

                if (!canEnable) {
                    return;
                }

                setState({ matrixFullEnabled: true });
            },

            enableLineFullView() {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                const shapeValid = shape.length >= 1 && shape.every((size) => Number.isFinite(size) && size >= 0);
                const displayDims =
                    normalizeDisplayDimsForShape(snapshot.displayConfig?.displayDims, shape) ||
                    normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) ||
                    getDefaultDisplayDims(shape);

                const lineReady =
                    shape.length === 1
                        ? shape[0] > 0
                        : Array.isArray(displayDims) &&
                        displayDims.length === 2 &&
                        shape[displayDims[0]] > 0 &&
                        shape[displayDims[1]] > 0;

                const canEnable =
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset" &&
                    shapeValid &&
                    lineReady;

                if (!canEnable) {
                    return;
                }

                setState({ lineFullEnabled: true });
            },

            enableHeatmapFullView() {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                const displayDims =
                    normalizeDisplayDimsForShape(snapshot.displayConfig?.displayDims, shape) ||
                    normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) ||
                    getDefaultDisplayDims(shape);

                const canEnable =
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset" &&
                    shape.length >= 2 &&
                    Array.isArray(displayDims) &&
                    displayDims.length === 2 &&
                    shape[displayDims[0]] > 0 &&
                    shape[displayDims[1]] > 0;

                if (!canEnable) {
                    return;
                }

                setState({ heatmapFullEnabled: true });
            },

            setNotation(notation) {
                const nextNotation = ["auto", "scientific", "exact"].includes(notation)
                    ? notation
                    : "auto";
                setState({ notation: nextNotation });
            },

            toggleLineGrid() {
                setState((prev) => ({ lineGrid: !prev.lineGrid }));
            },

            setLineAspect(value) {
                const nextValue = ["line", "point", "both"].includes(value) ? value : "line";
                setState({ lineAspect: nextValue });
            },

            toggleHeatmapGrid() {
                setState((prev) => ({ heatmapGrid: !prev.heatmapGrid }));
            },

            setHeatmapColormap(value) {
                const options = ["viridis", "plasma", "inferno", "magma", "cool", "hot"];
                const nextValue = options.includes(value) ? value : "viridis";
                setState({ heatmapColormap: nextValue });
            },

        };
    }
    if (typeof createViewActions !== "undefined") {
        moduleState.createViewActions = createViewActions;
        global.createViewActions = createViewActions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/viewActions");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Stages and applies display dimensions and fixed indices for multidimensional dataset views.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/displayConfigActions.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/displayConfigActions.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.displayConfigActions");
    function unpackDeps(deps) {
        const { actions, getState, setState, api, utils } = deps;
        const { getFiles, refreshFiles, getFileChildren, getFileMeta, getFilePreview } = api;
        const {
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = utils;

        return {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        };
    }
    function createDisplayConfigActions(deps) {
        const {
            actions,
            getState,
            setState,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = unpackDeps(deps);
        // Debounce delay prevents a new preview fetch on every keystroke in the dimension pickers
        const PREVIEW_RELOAD_DEBOUNCE_MS = 140;
        const FIXED_INDEX_PLAYBACK_INTERVAL_MS = 400;
        let previewReloadTimer = null;
        let fixedIndexPlaybackTimer = null;
        let fixedIndexPlaybackDim = null;
        let fixedIndexPlaybackRunId = 0;

        // Clears any pending debounce timer and schedules a fresh preview reload after the quiet period
        function schedulePreviewReload(fallbackPath) {
            if (previewReloadTimer !== null) {
                clearTimeout(previewReloadTimer);
            }

            previewReloadTimer = setTimeout(() => {
                previewReloadTimer = null;
                const latest = getState();
                const shouldLoad =
                    latest.route === "viewer" &&
                    latest.viewMode === "display" &&
                    latest.selectedNodeType === "dataset";

                if (shouldLoad) {
                    void actions.loadPreview(latest.selectedPath || fallbackPath);
                }
            }, PREVIEW_RELOAD_DEBOUNCE_MS);
        }

        function resolveActiveHeatmapRuntimeApi(snapshot) {
            if (typeof document === "undefined") {
                return null;
            }

            const shell = document.querySelector("[data-heatmap-shell]");
            if (!shell) {
                return null;
            }

            if ((shell.dataset.heatmapFileKey || "") !== String(snapshot.selectedFile || "")) {
                return null;
            }

            if ((shell.dataset.heatmapPath || "/") !== String(snapshot.selectedPath || "/")) {
                return null;
            }

            const runtimeApi = shell.__heatmapRuntimeApi;
            return runtimeApi && typeof runtimeApi.updateSelection === "function" ? runtimeApi : null;
        }

        function clearFixedIndexPlaybackTimer() {
            if (fixedIndexPlaybackTimer !== null) {
                clearTimeout(fixedIndexPlaybackTimer);
                fixedIndexPlaybackTimer = null;
            }
        }

        function setPlayingFixedDim(dimIndex) {
            setState((prev) => ({
                displayConfig: {
                    ...(prev.displayConfig || getDisplayConfigDefaults()),
                    playingFixedDim: dimIndex,
                },
            }), { notify: false });
        }

        function formatFixedIndexStatus(value, size) {
            const safeSize = Math.max(0, toSafeInteger(size, 0));
            const max = Math.max(0, safeSize - 1);
            const current = Math.max(0, Math.min(max, toSafeInteger(value, 0)));
            return `Index ${current} / ${max}`;
        }

        function syncFixedIndexControlDom(dim, value = null, size = null) {
            if (typeof document === "undefined") {
                return;
            }

            const dimIndex = toSafeInteger(dim, null);
            if (dimIndex === null || dimIndex < 0) {
                return;
            }

            const controls = Array.from(document.querySelectorAll(`[data-fixed-index-control="${dimIndex}"]`))
                .filter((control) => control instanceof Element);
            if (controls.length === 0) {
                return;
            }

            controls.forEach((control) => {
                const playbackAvailable =
                    control.getAttribute("data-fixed-playback-available") === "1" ||
                    control.querySelector('[data-fixed-playback-available="1"]') !== null;

                let resolvedMax = null;
                control.querySelectorAll(`[data-fixed-dim="${dimIndex}"]`).forEach((input) => {
                    if (!(input instanceof HTMLInputElement)) {
                        return;
                    }

                    const inputMax = Number(input.getAttribute("max"));
                    if (Number.isFinite(inputMax)) {
                        resolvedMax = resolvedMax === null ? inputMax : Math.max(resolvedMax, inputMax);
                    }
                });

                const inferredSize = resolvedMax === null ? 0 : resolvedMax + 1;
                const safeSize = Math.max(0, toSafeInteger(size, inferredSize));
                const max = Math.max(0, safeSize - 1);
                const nextValue = Math.max(0, Math.min(max, toSafeInteger(value, 0)));

                control.querySelectorAll(`[data-fixed-dim="${dimIndex}"]`).forEach((input) => {
                    if (!(input instanceof HTMLInputElement)) {
                        return;
                    }
                    if (input.value !== String(nextValue)) {
                        input.value = String(nextValue);
                    }
                });

                const status = control.querySelector(`[data-fixed-index-status="true"][data-fixed-status-dim="${dimIndex}"]`);
                if (status) {
                    status.textContent = formatFixedIndexStatus(nextValue, safeSize);
                }

                const activeDim = toSafeInteger(getState().displayConfig?.playingFixedDim, null);
                const isPlaying = activeDim === dimIndex;
                const playButton = control.querySelector(`[data-fixed-index-play-action="start"][data-fixed-dim="${dimIndex}"]`);
                const pauseButton = control.querySelector(`[data-fixed-index-play-action="stop"][data-fixed-dim="${dimIndex}"]`);
                const canUsePlayback = playbackAvailable && max >= 1;

                if (playButton instanceof HTMLButtonElement) {
                    playButton.disabled = !canUsePlayback;
                    playButton.classList.toggle("active", !isPlaying && canUsePlayback);
                }

                if (pauseButton instanceof HTMLButtonElement) {
                    pauseButton.disabled = !canUsePlayback;
                    pauseButton.classList.toggle("active", isPlaying && canUsePlayback);
                }
            });
        }

        function syncAllFixedIndexPlaybackDom() {
            if (typeof document === "undefined") {
                return;
            }

            const syncedDims = new Set();
            document.querySelectorAll("[data-fixed-index-control]").forEach((control) => {
                if (!(control instanceof Element)) {
                    return;
                }
                const dimIndex = toSafeInteger(control.getAttribute("data-fixed-index-control"), null);
                if (dimIndex === null || dimIndex < 0 || syncedDims.has(dimIndex)) {
                    return;
                }
                syncedDims.add(dimIndex);
                const valueInput = control.querySelector(`[data-fixed-index-number="true"][data-fixed-dim="${dimIndex}"]`)
                    || control.querySelector(`[data-fixed-index-range="true"][data-fixed-dim="${dimIndex}"]`);
                const sizeValue = valueInput instanceof HTMLInputElement
                    ? Number(valueInput.getAttribute("data-fixed-size"))
                    : null;
                const currentValue = valueInput instanceof HTMLInputElement ? valueInput.value : 0;
                syncFixedIndexControlDom(dimIndex, currentValue, sizeValue);
            });
        }

        function resolveFixedIndexPlaybackContext(snapshot, requestedDim = null) {
            const activeTab = snapshot.displayTab;
            if (
                snapshot.route !== "viewer" ||
                snapshot.viewMode !== "display" ||
                snapshot.selectedNodeType !== "dataset" ||
                (activeTab !== "heatmap" && activeTab !== "image") ||
                snapshot.heatmapFullEnabled !== true
            ) {
                return null;
            }

            const runtimeApi = resolveActiveHeatmapRuntimeApi(snapshot);
            if (!runtimeApi) {
                return null;
            }

            const shape = normalizeShape(snapshot.preview?.shape);
            if (shape.length < 3) {
                return null;
            }

            const config = snapshot.displayConfig || getDisplayConfigDefaults();
            const appliedDims =
                normalizeDisplayDimsForShape(config.displayDims, shape) ||
                normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) ||
                getDefaultDisplayDims(shape);

            if (!Array.isArray(appliedDims) || appliedDims.length !== 2) {
                return null;
            }

            const dimIndex = toSafeInteger(requestedDim !== null ? requestedDim : config.playingFixedDim, null);
            if (dimIndex === null || dimIndex < 0 || dimIndex >= shape.length || appliedDims.includes(dimIndex)) {
                return null;
            }

            const size = Math.max(0, toSafeInteger(shape[dimIndex], 0));
            if (size <= 1) {
                return null;
            }

            const fixedIndices = buildNextFixedIndices(
                normalizeFixedIndicesForShape(config.fixedIndices, shape, appliedDims),
                appliedDims,
                shape
            );

            return {
                dimIndex,
                size,
                fixedIndices,
                runtimeApi,
            };
        }

        function stopFixedIndexPlaybackInternal() {
            clearFixedIndexPlaybackTimer();
            fixedIndexPlaybackRunId += 1;
            fixedIndexPlaybackDim = null;
            setPlayingFixedDim(null);
            syncAllFixedIndexPlaybackDom();
        }

        function scheduleNextFixedIndexPlayback(runId, delay = FIXED_INDEX_PLAYBACK_INTERVAL_MS) {
            clearFixedIndexPlaybackTimer();
            fixedIndexPlaybackTimer = setTimeout(() => {
                fixedIndexPlaybackTimer = null;
                void advanceFixedIndexPlayback(runId);
            }, Math.max(0, delay));
        }

        async function advanceFixedIndexPlayback(runId) {
            if (runId !== fixedIndexPlaybackRunId) {
                return;
            }

            const snapshot = getState();
            const activeDim = toSafeInteger(snapshot.displayConfig?.playingFixedDim, null);
            if (fixedIndexPlaybackDim === null || activeDim !== fixedIndexPlaybackDim) {
                stopFixedIndexPlaybackInternal();
                return;
            }

            const context = resolveFixedIndexPlaybackContext(snapshot, fixedIndexPlaybackDim);
            if (!context) {
                stopFixedIndexPlaybackInternal();
                return;
            }

            const currentValue = Number.isFinite(context.fixedIndices[context.dimIndex])
                ? context.fixedIndices[context.dimIndex]
                : 0;
            const nextValue = currentValue >= context.size - 1 ? 0 : currentValue + 1;
            let loaded = true;
            try {
                loaded = await Promise.resolve(actions.stageFixedIndex(context.dimIndex, nextValue, context.size, {
                    interaction: "change",
                    forceFullLoad: true,
                }));
            } catch (_error) {
                loaded = false;
            }

            if (runId !== fixedIndexPlaybackRunId) {
                return;
            }

            if (loaded === false) {
                stopFixedIndexPlaybackInternal();
                return;
            }

            scheduleNextFixedIndexPlayback(runId);
        }

        function buildHeatmapLiveSelection(snapshot, displayDims, fixedIndices) {
            const displayDimsParam = buildDisplayDimsParam(displayDims) || "";
            const fixedIndicesParam = buildFixedIndicesParam(fixedIndices) || "";
            const selectionKey = [
                snapshot.selectedFile || "no-file",
                snapshot.selectedPath || "/",
                displayDimsParam || "none",
                fixedIndicesParam || "none",
            ].join("|");

            return {
                displayDims,
                fixedIndices,
                displayDimsParam,
                fixedIndicesParam,
                selectionKey,
            };
        }

        return {
            setDisplayConfig(displayConfigPatch) {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                const current = snapshot.displayConfig || getDisplayConfigDefaults();
                const nextRaw = { ...current, ...(displayConfigPatch || {}) };
                const nextDims = normalizeDisplayDimsForShape(nextRaw.displayDims, shape);
                const nextStagedDims = normalizeDisplayDimsForShape(nextRaw.stagedDisplayDims, shape);

                setState((prev) => ({
                    displayConfig: {
                        ...(prev.displayConfig || getDisplayConfigDefaults()),
                        ...nextRaw,
                        displayDims: nextDims,
                        fixedIndices: normalizeFixedIndicesForShape(nextRaw.fixedIndices, shape, nextDims || []),
                        stagedDisplayDims: nextStagedDims,
                        stagedFixedIndices: normalizeFixedIndicesForShape(
                            nextRaw.stagedFixedIndices,
                            shape,
                            nextStagedDims || []
                        ),
                    },
                }));
            },

            stageDisplayDims(nextDims, options = {}) {
                const { applyImmediately = false } = options;
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                const normalizedDims = normalizeDisplayDimsForShape(nextDims, shape);

                if (!normalizedDims) {
                    return;
                }

                if (fixedIndexPlaybackDim !== null) {
                    stopFixedIndexPlaybackInternal();
                }

                const currentConfig = snapshot.displayConfig || getDisplayConfigDefaults();
                const sourceFixedIndices =
                    Object.keys(currentConfig.stagedFixedIndices || {}).length > 0
                        ? currentConfig.stagedFixedIndices
                        : currentConfig.fixedIndices;
                const nextFixedIndices = buildNextFixedIndices(sourceFixedIndices, normalizedDims, shape);

                setState((prev) => ({
                    displayConfig: {
                        ...(prev.displayConfig || getDisplayConfigDefaults()),
                        stagedDisplayDims: normalizedDims,
                        stagedFixedIndices: nextFixedIndices,
                        ...(applyImmediately
                            ? {
                                displayDims: normalizedDims,
                                fixedIndices: nextFixedIndices,
                            }
                            : {}),
                    },
                    ...(applyImmediately
                        ? {}
                        : { matrixFullEnabled: false, lineFullEnabled: false, heatmapFullEnabled: false }),
                }));

                if (
                    applyImmediately &&
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset"
                ) {
                    schedulePreviewReload(snapshot.selectedPath);
                }
            },

            setDisplayAxis(axis, dimValue) {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                if (shape.length < 2) {
                    return;
                }

                const dim = toSafeInteger(dimValue, null);
                if (dim === null || dim < 0 || dim >= shape.length) {
                    return;
                }

                const resolvedDims = resolveDisplayDimsFromConfig(snapshot.displayConfig, shape);
                if (!resolvedDims) {
                    return;
                }

                const nextDims = [...resolvedDims];
                if (axis === "x") {
                    nextDims[1] = dim;
                } else {
                    nextDims[0] = dim;
                }

                if (nextDims[0] === nextDims[1]) {
                    const movingIndex = axis === "x" ? 1 : 0;
                    const partnerIndex = movingIndex === 1 ? 0 : 1;
                    const replacement = getNextAvailableDim(shape.length, [nextDims[movingIndex]], nextDims[partnerIndex]);

                    if (replacement !== null) {
                        nextDims[partnerIndex] = replacement;
                    }
                }

                actions.stageDisplayDims(nextDims, { applyImmediately: shape.length === 2 });
            },

            setDisplayDim(indexValue, dimValue) {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                if (shape.length < 2) {
                    return;
                }

                const index = toSafeInteger(indexValue, null);
                const dim = toSafeInteger(dimValue, null);
                if ((index !== 0 && index !== 1) || dim === null || dim < 0 || dim >= shape.length) {
                    return;
                }

                const resolvedDims = resolveDisplayDimsFromConfig(snapshot.displayConfig, shape);
                if (!resolvedDims) {
                    return;
                }

                const nextDims = [...resolvedDims];
                nextDims[index] = dim;

                if (nextDims[0] === nextDims[1]) {
                    const partnerIndex = index === 0 ? 1 : 0;
                    const replacement = getNextAvailableDim(shape.length, [nextDims[index]], nextDims[partnerIndex]);
                    if (replacement !== null) {
                        nextDims[partnerIndex] = replacement;
                    }
                }

                actions.stageDisplayDims(nextDims, { applyImmediately: shape.length === 2 });
            },

            stageFixedIndex(dim, value, size = null, options = {}) {
                const interaction = options && options.interaction === "change" ? "change" : "input";
                const forceFullLoad = options && options.forceFullLoad === true;
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                const dimIndex = toSafeInteger(dim, null);

                if (shape.length < 2 || dimIndex === null || dimIndex < 0 || dimIndex >= shape.length) {
                    return;
                }

                const config = snapshot.displayConfig || getDisplayConfigDefaults();
                const appliedDims =
                    normalizeDisplayDimsForShape(config.displayDims, shape) ||
                    normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) ||
                    getDefaultDisplayDims(shape) ||
                    [];
                const stagedDims =
                    normalizeDisplayDimsForShape(config.stagedDisplayDims, shape) ||
                    appliedDims;

                if (stagedDims.includes(dimIndex)) {
                    return;
                }

                const sourceSize = Math.max(0, toSafeInteger(size, shape[dimIndex]));
                const max = Math.max(0, sourceSize - 1);
                const normalizedValue = Math.max(0, Math.min(max, toSafeInteger(value, 0)));
                const canLiveUpdateHeatmap =
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset" &&
                    (snapshot.displayTab === "heatmap" || snapshot.displayTab === "image") &&
                    snapshot.heatmapFullEnabled === true &&
                    Array.isArray(appliedDims) &&
                    appliedDims.length === 2 &&
                    areDisplayDimsEqual(stagedDims, appliedDims);

                const heatmapRuntimeApi = canLiveUpdateHeatmap ? resolveActiveHeatmapRuntimeApi(snapshot) : null;
                if (heatmapRuntimeApi) {
                    const currentAppliedFixed = buildNextFixedIndices(
                        normalizeFixedIndicesForShape(config.fixedIndices, shape, appliedDims),
                        appliedDims,
                        shape
                    );
                    const nextFixedIndices = buildNextFixedIndices(
                        {
                            ...currentAppliedFixed,
                            [dimIndex]: normalizedValue,
                        },
                        appliedDims,
                        shape
                    );

                    setState((prev) => ({
                        displayConfig: {
                            ...(prev.displayConfig || getDisplayConfigDefaults()),
                            displayDims: appliedDims,
                            fixedIndices: nextFixedIndices,
                            stagedDisplayDims: appliedDims,
                            stagedFixedIndices: nextFixedIndices,
                        },
                    }), { notify: false });

                    let updatePromise = Promise.resolve(true);
                    if (!areFixedIndicesEqual(nextFixedIndices, currentAppliedFixed)) {
                        const nextSelection = buildHeatmapLiveSelection(snapshot, appliedDims, nextFixedIndices);
                        updatePromise = Promise.resolve(
                            heatmapRuntimeApi.updateSelection(
                            {
                                displayDims: nextSelection.displayDimsParam,
                                fixedIndices: nextSelection.fixedIndicesParam,
                                selectionKey: nextSelection.selectionKey,
                            },
                            {
                                immediate: interaction === "change",
                                preserveViewState: true,
                                forceFullLoad,
                            }
                            )
                        ).then((result) => result !== false);
                    }
                    syncFixedIndexControlDom(dimIndex, normalizedValue, sourceSize);
                    return updatePromise;
                }

                setState((prev) => {
                    const prevConfig = prev.displayConfig || getDisplayConfigDefaults();
                    const existing = normalizeFixedIndicesForShape(
                        prevConfig.stagedFixedIndices,
                        shape,
                        stagedDims
                    );

                    return {
                        displayConfig: {
                            ...prevConfig,
                            stagedFixedIndices: {
                                ...existing,
                                [dimIndex]: normalizedValue,
                            },
                        },
                    };
                });
                syncFixedIndexControlDom(dimIndex, normalizedValue, sourceSize);
                return Promise.resolve(true);
            },

            startFixedIndexPlayback(dim, size = null) {
                const dimIndex = toSafeInteger(dim, null);
                if (dimIndex === null || dimIndex < 0) {
                    return;
                }

                const snapshot = getState();
                const context = resolveFixedIndexPlaybackContext(snapshot, dimIndex);
                if (!context) {
                    stopFixedIndexPlaybackInternal();
                    return;
                }

                if (fixedIndexPlaybackDim === dimIndex) {
                    stopFixedIndexPlaybackInternal();
                    return;
                }

                stopFixedIndexPlaybackInternal();
                fixedIndexPlaybackDim = dimIndex;
                setPlayingFixedDim(dimIndex);
                syncFixedIndexControlDom(dimIndex, context.fixedIndices[dimIndex], size ?? context.size);
                syncAllFixedIndexPlaybackDom();
                fixedIndexPlaybackRunId += 1;
                scheduleNextFixedIndexPlayback(fixedIndexPlaybackRunId);
            },

            stopFixedIndexPlayback() {
                stopFixedIndexPlaybackInternal();
            },

            applyDisplayConfig() {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                if (shape.length < 2) {
                    return;
                }

                const config = snapshot.displayConfig || getDisplayConfigDefaults();
                const nextDims =
                    normalizeDisplayDimsForShape(config.stagedDisplayDims, shape) ||
                    normalizeDisplayDimsForShape(config.displayDims, shape) ||
                    getDefaultDisplayDims(shape);

                const nextFixedIndices = buildNextFixedIndices(
                    config.stagedFixedIndices || config.fixedIndices,
                    nextDims || [],
                    shape
                );
                const currentDims =
                    normalizeDisplayDimsForShape(config.displayDims, shape) ||
                    normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) ||
                    getDefaultDisplayDims(shape);
                const currentFixedIndices = buildNextFixedIndices(
                    normalizeFixedIndicesForShape(config.fixedIndices, shape, currentDims || []),
                    currentDims || [],
                    shape
                );

                if (
                    areDisplayDimsEqual(nextDims, currentDims) &&
                    areFixedIndicesEqual(nextFixedIndices, currentFixedIndices)
                ) {
                    return;
                }

                setState((prev) => ({
                    displayConfig: {
                        ...(prev.displayConfig || getDisplayConfigDefaults()),
                        displayDims: nextDims,
                        fixedIndices: nextFixedIndices,
                        stagedDisplayDims: nextDims,
                        stagedFixedIndices: nextFixedIndices,
                        playingFixedDim: null,
                    },
                    matrixFullEnabled: false,
                    lineFullEnabled: false,
                    heatmapFullEnabled: false,
                }));
                clearFixedIndexPlaybackTimer();
                fixedIndexPlaybackDim = null;
                syncAllFixedIndexPlaybackDom();

                if (
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset"
                ) {
                    schedulePreviewReload(snapshot.selectedPath);
                }
            },

            resetDisplayConfigFromPreview() {
                const snapshot = getState();
                const shape = normalizeShape(snapshot.preview?.shape);
                if (shape.length < 2) {
                    return;
                }

                const defaultDims =
                    normalizeDisplayDimsForShape(snapshot.preview?.display_dims, shape) || getDefaultDisplayDims(shape);
                const nextFixedIndices = buildNextFixedIndices(
                    normalizeFixedIndicesForShape(snapshot.preview?.fixed_indices, shape, defaultDims || []),
                    defaultDims || [],
                    shape
                );

                setState((prev) => ({
                    displayConfig: {
                        ...(prev.displayConfig || getDisplayConfigDefaults()),
                        stagedDisplayDims: defaultDims,
                        stagedFixedIndices: nextFixedIndices,
                        playingFixedDim: null,
                    },
                    matrixFullEnabled: false,
                    lineFullEnabled: false,
                    heatmapFullEnabled: false,
                }));
                clearFixedIndexPlaybackTimer();
                fixedIndexPlaybackDim = null;
                syncAllFixedIndexPlaybackDom();
            },

        };
    }
    if (typeof createDisplayConfigActions !== "undefined") {
        moduleState.createDisplayConfigActions = createDisplayConfigActions;
        global.createDisplayConfigActions = createDisplayConfigActions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/displayConfigActions");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Loads metadata and preview data with dedupe, stale-update safety, and warmed preview selection logic.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/dataActions.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/dataActions.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.dataActions");
    function unpackDeps(deps) {
        const { actions, getState, setState, api, utils } = deps;
        const { getFiles, refreshFiles, getFileChildren, getFileMeta, getFilePreview } = api;
        const {
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = utils;

        return {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        };
    }
    function createDataActions(deps) {
        const {
            getState,
            setState,
            getFileMeta,
            getFilePreview,
            getDisplayConfigDefaults,
            normalizePath,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
        } = unpackDeps(deps);

        // First paint is intentionally lighter; repeated views can ask for a denser preview.
        const PREVIEW_MAX_SIZE_FIRST = 160;
        const PREVIEW_MAX_SIZE_STEADY = 256;
        const PREVIEW_DETAIL = "fast";
        // Request-key promise deduplication avoids duplicate network calls during quick UI churn
        const previewRequestPromises = new Map();
        // Tracks selections that already received at least one preview response ("warmed" = second call may use larger max_size)
        const warmedPreviewSelections = new Set();

        function resolvePreviewMode(displayTab) {
            if (displayTab === "line") {
                return "line";
            }
            if (displayTab === "heatmap" || displayTab === "image") {
                return "heatmap";
            }
            return "table";
        }

        function buildPreviewSelectionKey(
            fileKey,
            path,
            mode,
            displayDimsParam,
            fixedIndicesParam,
            etag,
            maxSize,
            detail
        ) {
            return [
                fileKey || "no-file",
                path || "/",
                mode || "auto",
                displayDimsParam || "none",
                fixedIndicesParam || "none",
                etag || "no-etag",
                maxSize ?? "default",
                detail || "full",
            ].join("|");
        }

        function buildWarmSelectionKey(fileKey, path, mode, displayDimsParam, fixedIndicesParam, etag, detail) {
            return [
                fileKey || "no-file",
                path || "/",
                mode || "auto",
                displayDimsParam || "none",
                fixedIndicesParam || "none",
                etag || "no-etag",
                detail || "full",
            ].join("|");
        }

        function applyPreviewResponse(latest, targetPath, response, requestKey) {
            // Keep staged/applied display config valid for the current shape after each preview response.
            const shape = normalizeShape(response?.shape);
            const prevConfig = latest.displayConfig || getDisplayConfigDefaults();

            const nextAppliedDims =
                normalizeDisplayDimsForShape(prevConfig.displayDims, shape) ||
                normalizeDisplayDimsForShape(response?.display_dims, shape) ||
                getDefaultDisplayDims(shape);

            const currentAppliedFixed = normalizeFixedIndicesForShape(
                prevConfig.fixedIndices,
                shape,
                nextAppliedDims || []
            );
            const responseFixed = normalizeFixedIndicesForShape(
                response?.fixed_indices,
                shape,
                nextAppliedDims || []
            );
            const baseAppliedFixed =
                Object.keys(currentAppliedFixed).length > 0 ? currentAppliedFixed : responseFixed;
            const nextAppliedFixed = buildNextFixedIndices(baseAppliedFixed, nextAppliedDims || [], shape);

            const nextStagedDims =
                normalizeDisplayDimsForShape(prevConfig.stagedDisplayDims, shape) || nextAppliedDims;
            const stagedPendingDims = !areDisplayDimsEqual(nextStagedDims, nextAppliedDims);
            const currentStagedFixed = normalizeFixedIndicesForShape(
                prevConfig.stagedFixedIndices,
                shape,
                nextStagedDims || []
            );
            const stagedPendingFixed = !areFixedIndicesEqual(currentStagedFixed, nextAppliedFixed);
            const nextStagedFixed = buildNextFixedIndices(
                (stagedPendingDims || stagedPendingFixed) && Object.keys(currentStagedFixed).length > 0
                    ? currentStagedFixed
                    : nextAppliedFixed,
                nextStagedDims || [],
                shape
            );

            setState((prev) => ({
                preview: response,
                previewLoading: false,
                previewError: null,
                previewRequestKey: requestKey,
                previewRequestInFlight: false,
                displayConfig: {
                    ...(prev.displayConfig || getDisplayConfigDefaults()),
                    displayDims: nextAppliedDims,
                    fixedIndices: nextAppliedFixed,
                    stagedDisplayDims: nextStagedDims,
                    stagedFixedIndices: nextStagedFixed,
                },
                cacheResponses: {
                    ...prev.cacheResponses,
                    preview: {
                        ...(prev.cacheResponses?.preview || {}),
                        [targetPath]: response,
                    },
                },
            }));
        }

        return {
            async loadMetadata(path = null) {
                const snapshot = getState();
                const targetPath = normalizePath(path || snapshot.selectedPath);

                if (!snapshot.selectedFile) {
                    return null;
                }

                setState({
                    metadataLoading: true,
                    metadataError: null,
                });

                try {
                    const response = await getFileMeta(snapshot.selectedFile, targetPath, {
                        etag: snapshot.selectedFileEtag || undefined,
                    });
                    const metadata = response.metadata || null;
                    const latest = getState();

                    // Metadata is sidebar-owned in the SPA shell, so only the file/path match matters now.
                    if (
                        latest.selectedFile === snapshot.selectedFile &&
                        latest.selectedPath === targetPath
                    ) {
                        setState((prev) => ({
                            metadata,
                            metadataLoading: false,
                            metadataError: null,
                            cacheResponses: {
                                ...prev.cacheResponses,
                                meta: {
                                    ...(prev.cacheResponses?.meta || {}),
                                    [targetPath]: metadata,
                                },
                            },
                        }));
                    }

                    return metadata;
                } catch (error) {
                    const latest = getState();
                    if (
                        latest.selectedFile === snapshot.selectedFile &&
                        latest.selectedPath === targetPath
                    ) {
                        setState({
                            metadataLoading: false,
                            metadataError: error.message || "Failed to load metadata",
                        });
                    }

                    throw error;
                }
            },

            async loadPreview(path = null) {
                const snapshot = getState();
                const targetPath = normalizePath(path || snapshot.selectedPath);

                if (!snapshot.selectedFile) {
                    return null;
                }

                const displayDimsParam = buildDisplayDimsParam(snapshot.displayConfig?.displayDims);
                const fixedIndicesParam = buildFixedIndicesParam(snapshot.displayConfig?.fixedIndices);
                const mode = resolvePreviewMode(snapshot.displayTab);
                const selectedFileEtag = snapshot.selectedFileEtag || null;
                const warmSelectionKey = buildWarmSelectionKey(
                    snapshot.selectedFile,
                    targetPath,
                    mode,
                    displayDimsParam,
                    fixedIndicesParam,
                    selectedFileEtag,
                    PREVIEW_DETAIL
                );
                const maxSize = warmedPreviewSelections.has(warmSelectionKey)
                    ? PREVIEW_MAX_SIZE_STEADY
                    : PREVIEW_MAX_SIZE_FIRST;
                const previewParams = {
                    mode,
                    max_size: maxSize,
                    detail: PREVIEW_DETAIL,
                    include_stats: 0,
                };

                if (displayDimsParam) {
                    previewParams.display_dims = displayDimsParam;
                }

                if (fixedIndicesParam) {
                    previewParams.fixed_indices = fixedIndicesParam;
                }

                if (selectedFileEtag) {
                    previewParams.etag = selectedFileEtag;
                }

                const requestKey = buildPreviewSelectionKey(
                    snapshot.selectedFile,
                    targetPath,
                    mode,
                    displayDimsParam,
                    fixedIndicesParam,
                    selectedFileEtag,
                    maxSize,
                    PREVIEW_DETAIL
                );

                if (snapshot.preview && snapshot.previewRequestKey === requestKey && !snapshot.previewError) {
                    return snapshot.preview;
                }

                const existingPromise = previewRequestPromises.get(requestKey);
                if (existingPromise) {
                    return existingPromise;
                }

                const hasMatchingPreview = snapshot.preview && snapshot.previewRequestKey === requestKey;

                setState({
                    previewLoading: !hasMatchingPreview,
                    previewError: null,
                    previewRequestKey: requestKey,
                    previewRequestInFlight: true,
                    matrixFullEnabled: false,
                    lineFullEnabled: false,
                    heatmapFullEnabled: false,
                });

                let requestPromise;
                requestPromise = (async () => {
                    try {
                        const response = await getFilePreview(snapshot.selectedFile, targetPath, previewParams, {
                            cancelPrevious: true,
                            staleWhileRefresh: true,
                            onBackgroundUpdate: (freshResponse) => {
                                // Background refresh can finish after navigation; only apply if selection is still current.
                                const latest = getState();
                                const canApplyBackground =
                                    latest.selectedFile === snapshot.selectedFile &&
                                    latest.selectedPath === targetPath &&
                                    latest.viewMode === "display" &&
                                    latest.previewRequestKey === requestKey;

                                if (canApplyBackground) {
                                    warmedPreviewSelections.add(warmSelectionKey);
                                    applyPreviewResponse(latest, targetPath, freshResponse, requestKey);
                                }
                            },
                        });
                        const latest = getState();

                        // Main-response stale guard: prevents old requests from overwriting a newer selection.
                        if (
                            latest.selectedFile === snapshot.selectedFile &&
                            latest.selectedPath === targetPath &&
                            latest.viewMode === "display" &&
                            latest.previewRequestKey === requestKey
                        ) {
                            warmedPreviewSelections.add(warmSelectionKey);
                            applyPreviewResponse(latest, targetPath, response, requestKey);
                        }

                        return response;
                    } catch (error) {
                        const latest = getState();
                        if (
                            latest.selectedFile === snapshot.selectedFile &&
                            latest.selectedPath === targetPath &&
                            latest.viewMode === "display" &&
                            latest.previewRequestKey === requestKey
                        ) {
                            setState({
                                previewLoading: false,
                                previewRequestInFlight: false,
                                previewError:
                                    error?.isAbort || error?.code === "ABORTED"
                                        ? null
                                        : error.message || "Failed to load preview",
                            });
                        }

                        if (error?.isAbort || error?.code === "ABORTED") {
                            return null;
                        }

                        throw error;
                    } finally {
                        if (previewRequestPromises.get(requestKey) === requestPromise) {
                            previewRequestPromises.delete(requestKey);
                        }
                    }
                })();

                previewRequestPromises.set(requestKey, requestPromise);
                return requestPromise;
            },
        };
    }
    if (typeof createDataActions !== "undefined") {
        moduleState.createDataActions = createDataActions;
        global.createDataActions = createDataActions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/dataActions");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Validates and manages line comparison dataset selection with dtype and shape compatibility rules.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers/compareActions.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers/compareActions.");
        return;
    }
    var moduleState = ensurePath(ns, "state.reducers.compareActions");
    function unpackDeps(deps) {
        const { actions, getState, setState, api, utils } = deps;
        const { getFiles, refreshFiles, getFileChildren, getFileMeta, getFilePreview } = api;
        const {
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        } = utils;

        return {
            actions,
            getState,
            setState,
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
            normalizePath,
            getAncestorPaths,
            getNodeName,
            toSafeInteger,
            getDisplayConfigDefaults,
            normalizeShape,
            getDefaultDisplayDims,
            normalizeDisplayDimsForShape,
            normalizeFixedIndicesForShape,
            buildNextFixedIndices,
            buildDisplayDimsParam,
            buildFixedIndicesParam,
            areDisplayDimsEqual,
            areFixedIndicesEqual,
            resolveDisplayDimsFromConfig,
            getNextAvailableDim,
        };
    }

    // Maximum number of overlay series allowed in the line compare view
    const MAX_LINE_COMPARE_SERIES = 4;

    // Checks whether a dtype string represents a numeric type compatible with line chart plotting
    function isNumericDtype(dtype) {
        const normalized = String(dtype || "").trim().toLowerCase();
        if (!normalized || normalized.includes("complex")) {
            return false;
        }
        return (
            normalized.includes("float") ||
            normalized.includes("int") ||
            normalized.includes("uint") ||
            normalized.includes("bool")
        );
    }

    // Returns true if two shape arrays are element-wise identical; used to enforce series compatibility
    function shapesMatch(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        return a.every((entry, index) => Number(entry) === Number(b[index]));
    }
    function createCompareActions(deps) {
        const { getState, setState, normalizePath, getNodeName, normalizeShape, toSafeInteger } =
            unpackDeps(deps);

        function buildStatus(tone, message) {
            return {
                tone: tone === "error" ? "error" : "info",
                message: String(message || "").trim(),
                timestamp: Date.now(),
            };
        }

        function parseShape(value) {
            if (Array.isArray(value)) {
                return normalizeShape(value);
            }
            if (typeof value !== "string") {
                return [];
            }
            return value
                .split(",")
                .map((entry) => toSafeInteger(entry, null))
                .filter((entry) => Number.isFinite(entry) && entry >= 0);
        }

        function normalizeCandidate(candidate) {
            const raw = candidate && typeof candidate === "object" ? candidate : {};
            const path = normalizePath(raw.path || "/");
            const shape = parseShape(raw.shape);
            const ndimFromShape = shape.length;
            const ndim = Math.max(0, toSafeInteger(raw.ndim, ndimFromShape));
            const dtype = String(raw.dtype || "").trim();
            const type = String(raw.type || "").toLowerCase();
            const name = String(raw.name || getNodeName(path) || path);
            return {
                path,
                shape,
                ndim,
                dtype,
                type,
                name,
            };
        }

        function lookupDatasetDescriptor(state, path) {
            if (!(state.childrenCache instanceof Map)) {
                return null;
            }

            const normalizedPath = normalizePath(path);
            for (const children of state.childrenCache.values()) {
                if (!Array.isArray(children)) {
                    continue;
                }

                const hit = children.find(
                    (entry) => normalizePath(entry?.path || "/") === normalizedPath && entry?.type === "dataset"
                );
                if (hit) {
                    return normalizeCandidate({
                        path: hit.path,
                        shape: hit.shape,
                        ndim: hit.ndim,
                        dtype: hit.dtype,
                        type: hit.type,
                        name: hit.name,
                    });
                }
            }
            return null;
        }

        function resolveBaseDescriptor(state) {
            const selectedPath = normalizePath(state.selectedPath || "/");
            const preview =
                state.preview && normalizePath(state.preview.path || "/") === selectedPath ? state.preview : null;

            if (preview) {
                return normalizeCandidate({
                    path: selectedPath,
                    shape: preview.shape,
                    ndim: preview.ndim,
                    dtype: preview.dtype,
                    type: "dataset",
                    name: getNodeName(selectedPath),
                });
            }

            return lookupDatasetDescriptor(state, selectedPath);
        }

        function validateCandidate(base, candidate) {
            if (!candidate || candidate.type !== "dataset") {
                return "Only dataset nodes can be compared.";
            }

            if (!candidate.path || candidate.path === "/") {
                return "Invalid dataset path for comparison.";
            }

            if (candidate.path === base.path) {
                return "Base dataset is already plotted.";
            }

            if (!isNumericDtype(base.dtype)) {
                return "Base dataset is not numeric and cannot be compared.";
            }

            if (!isNumericDtype(candidate.dtype)) {
                return `${candidate.name} is not numeric and cannot be compared.`;
            }

            if (!Number.isFinite(base.ndim) || !Number.isFinite(candidate.ndim)) {
                return "Dataset dimensionality metadata is missing.";
            }

            if (base.ndim !== candidate.ndim) {
                return `${candidate.name} has ${candidate.ndim}D while base is ${base.ndim}D.`;
            }

            if (!Array.isArray(base.shape) || !Array.isArray(candidate.shape)) {
                return "Dataset shape metadata is missing.";
            }

            if (!shapesMatch(base.shape, candidate.shape)) {
                return `${candidate.name} shape [${candidate.shape.join(" x ")}] does not match base [${base.shape.join(
                    " x "
                )}].`;
            }

            return null;
        }

        return {
            toggleLineCompare(value = null) {
                const snapshot = getState();
                const nextValue = typeof value === "boolean" ? value : !snapshot.lineCompareEnabled;
                setState({
                    lineCompareEnabled: nextValue,
                    lineCompareStatus: null,
                });
            },

            clearLineCompare() {
                setState({
                    lineCompareItems: [],
                    lineCompareStatus: buildStatus("info", "Comparison selection cleared."),
                });
            },

            removeLineCompareDataset(path) {
                const normalizedPath = normalizePath(path || "/");
                setState((prev) => {
                    const currentItems = Array.isArray(prev.lineCompareItems) ? prev.lineCompareItems : [];
                    const nextItems = currentItems.filter(
                        (entry) => normalizePath(entry?.path || "/") !== normalizedPath
                    );
                    return {
                        lineCompareItems: nextItems,
                        lineCompareStatus: buildStatus("info", "Dataset removed from comparison."),
                    };
                });
            },

            dismissLineCompareStatus() {
                setState({ lineCompareStatus: null });
            },

            addLineCompareDataset(candidate) {
                const snapshot = getState();
                if (snapshot.route !== "viewer" || snapshot.viewMode !== "display" || snapshot.displayTab !== "line") {
                    setState({
                        lineCompareStatus: buildStatus("error", "Comparison is only available in line display mode."),
                    });
                    return;
                }

                if (!snapshot.lineCompareEnabled) {
                    setState({
                        lineCompareStatus: buildStatus("error", "Enable compare mode before adding datasets."),
                    });
                    return;
                }

                const normalizedCandidate = normalizeCandidate(candidate);
                const currentItems = Array.isArray(snapshot.lineCompareItems) ? snapshot.lineCompareItems : [];
                if (
                    currentItems.some(
                        (entry) => normalizePath(entry?.path || "/") === normalizePath(normalizedCandidate.path)
                    )
                ) {
                    setState({
                        lineCompareStatus: buildStatus("info", `${normalizedCandidate.name} is already selected.`),
                    });
                    return;
                }

                if (currentItems.length >= MAX_LINE_COMPARE_SERIES) {
                    setState({
                        lineCompareStatus: buildStatus(
                            "error",
                            `Up to ${MAX_LINE_COMPARE_SERIES} datasets can be compared at once.`
                        ),
                    });
                    return;
                }

                const baseDescriptor = resolveBaseDescriptor(snapshot);
                if (!baseDescriptor) {
                    setState({
                        lineCompareStatus: buildStatus("error", "Load the base dataset preview before comparing."),
                    });
                    return;
                }

                const reason = validateCandidate(baseDescriptor, normalizedCandidate);
                if (reason) {
                    setState({
                        lineCompareStatus: buildStatus("error", reason),
                    });
                    return;
                }

                setState((prev) => {
                    const nextItems = Array.isArray(prev.lineCompareItems) ? [...prev.lineCompareItems] : [];
                    nextItems.push({
                        path: normalizedCandidate.path,
                        name: normalizedCandidate.name,
                        dtype: normalizedCandidate.dtype,
                        ndim: normalizedCandidate.ndim,
                        shape: normalizedCandidate.shape,
                        type: "dataset",
                    });

                    return {
                        lineCompareItems: nextItems,
                        lineCompareStatus: buildStatus(
                            "info",
                            `${normalizedCandidate.name} added for comparison (${nextItems.length}/${MAX_LINE_COMPARE_SERIES}).`
                        ),
                    };
                });
            },
        };
    }
    if (typeof createCompareActions !== "undefined") {
        moduleState.createCompareActions = createCompareActions;
        global.createCompareActions = createCompareActions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers/compareActions");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Composes all action factories into the shared actions API consumed by views and runtimes.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for state/reducers.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading state/reducers.");
        return;
    }
    var moduleState = ensurePath(ns, "state");
    var utils =
        ns.state && ns.state.reducers && ns.state.reducers.utils
            ? ns.state.reducers.utils
            : null;
    if (!utils) {
        console.error("[HDFViewer] Missing dependency state/reducers/utils for state/reducers.");
        return;
    }
    const actions = {};

    // deps bundles the shared store primitives, API methods, and utils so action factories receive them via injection
    const deps = {
        actions,
        getState,
        setState,
        api: {
            getFiles,
            refreshFiles,
            getFileChildren,
            getFileMeta,
            getFilePreview,
        },
        utils,
    };

    // Merge all action factory outputs into a single `actions` object so callers use one consistent API surface
    Object.assign(
        actions,
        createFileActions(deps),
        createTreeActions(deps),
        createViewActions(deps),
        createDisplayConfigActions(deps),
        createDataActions(deps),
        createCompareActions(deps)
    );
    if (typeof actions !== "undefined") {
        moduleState.actions = actions;
        global.actions = actions;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("state/reducers");
    }
})(typeof window !== "undefined" ? window : globalThis);




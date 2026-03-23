// Viewer HTML module: Defines shared chart/table constants and helper functions used by panel renderers and runtimes.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/shared.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/shared.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.shared");

    // --- Matrix grid layout constants ---
    const MATRIX_ROW_HEIGHT = 28;        // px per data row in the virtual scroll grid
    const MATRIX_COL_WIDTH = 96;         // px per data column
    const MATRIX_HEADER_HEIGHT = 28;     // px for the sticky column-index header row
    const MATRIX_INDEX_WIDTH = 60;       // px for the sticky row-index column
    const MATRIX_OVERSCAN = 4;           // extra rows/cols rendered outside the viewport to reduce blank flashes during scroll
    const MATRIX_BLOCK_CACHE = new LruCache(1600); // LRU cache for fetched matrix blocks, keyed by offset+step
    const MATRIX_PENDING = new Set();   // tracks in-flight block fetch keys to avoid duplicate requests

    // --- Line chart constants ---
    const LINE_VIEW_CACHE = new LruCache(240);          // LRU cache for fetched line windows
    const LINE_FETCH_DEBOUNCE_MS = 220;                 // ms quiet period before firing a line window fetch on pan/zoom
    const LINE_MIN_VIEW_SPAN = 64;                      // minimum visible data points in the line view window
    const LINE_SVG_WIDTH = 980;                         // logical SVG coordinate space width
    const LINE_SVG_HEIGHT = 340;                        // logical SVG coordinate space height
    const LINE_DEFAULT_QUALITY = "auto";                // default quality mode for line fetch
    const LINE_DEFAULT_OVERVIEW_MAX_POINTS = 5000;      // overview fetch point budget
    const LINE_EXACT_MAX_POINTS = 20000;                // exact quality fetch point budget
    const LINE_WINDOW_OPTIONS = [256, 512, 1000, 2000, 5000, 10000, 20000]; // selectable window sizes in the toolbar
    const LINE_KEYBOARD_PAN_RATIO = 0.25;               // fraction of window to shift per keyboard arrow press

    function toSafeInteger(value, fallback = null) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.trunc(parsed);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normalizeLineQuality(value) {
        const normalized = String(value || "").toLowerCase();
        if (normalized === "overview" || normalized === "exact" || normalized === "auto") {
            return normalized;
        }
        return LINE_DEFAULT_QUALITY;
    }

    function normalizeShape(shape) {
        if (!Array.isArray(shape)) {
            return [];
        }

        return shape.map((size) => Math.max(0, toSafeInteger(size, 0)));
    }

    function getDefaultDisplayDims(shape) {
        return shape.length >= 2 ? [0, 1] : null;
    }

    // Normalizes a 2-element displayDims array for a given shape; ensures axes are in range and not equal
    function normalizeDisplayDims(displayDims, shape) {
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

    // Normalizes fixedIndices by removing display axes, clamping to valid bounds, and setting defaults for hidden dims
    function normalizeFixedIndices(fixedIndices, shape, displayDims = []) {
        // displayDims axes must not appear in fixedIndices - they are the slice plane axes
        const hidden = new Set(Array.isArray(displayDims) ? displayDims : []);
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
                hidden.has(dim)
            ) {
                return;
            }

            const max = Math.max(0, shape[dim] - 1);
            normalized[dim] = clamp(index, 0, max);
        });

        return normalized;
    }

    function buildNextFixedIndices(currentIndices, displayDims, shape) {
        const dims = Array.isArray(displayDims) ? displayDims : [];
        const next = normalizeFixedIndices(currentIndices, shape, dims);
        const hidden = new Set(dims);

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

            next[dim] = clamp(toSafeInteger(next[dim], fallback), 0, max);
        });

        return next;
    }

    function areDimsEqual(a, b) {
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
            return key === otherKey && Number(left[key]) === Number(right[key]);
        });
    }

    function buildDisplayDimsParam(displayDims) {
        if (!Array.isArray(displayDims) || displayDims.length !== 2) {
            return "";
        }

        return `${displayDims[0]},${displayDims[1]}`;
    }

    function buildFixedIndicesParam(fixedIndices) {
        if (!fixedIndices || typeof fixedIndices !== "object") {
            return "";
        }

        const entries = Object.entries(fixedIndices)
            .map(([dim, index]) => [toSafeInteger(dim, null), toSafeInteger(index, null)])
            .filter(([dim, index]) => dim !== null && index !== null)
            .sort(([a], [b]) => a - b);

        if (!entries.length) {
            return "";
        }

        return entries.map(([dim, index]) => `${dim}=${index}`).join(",");
    }

    function formatValue(value) {
        if (Array.isArray(value)) {
            return value.join(" x ");
        }

        if (value === null || value === undefined || value === "") {
            return "--";
        }

        if (typeof value === "object") {
            return JSON.stringify(value);
        }

        return String(value);
    }

    function formatCell(value, notation = "auto") {
        if (value === null || value === undefined) {
            return "--";
        }

        const asNumber = Number(value);
        if (Number.isFinite(asNumber)) {
            if (notation === "exact") {
                return String(value);
            }

            if (notation === "scientific") {
                return asNumber.toExponential(4);
            }

            const abs = Math.abs(asNumber);
            if (abs !== 0 && (abs >= 1e6 || abs < 1e-4)) {
                return asNumber.toExponential(3);
            }

            return asNumber.toLocaleString(undefined, { maximumFractionDigits: 6 });
        }

        return String(value);
    }

    function formatTypeDescription(typeInfo) {
        if (!typeInfo || typeof typeInfo === "string") {
            return typeInfo || "Unknown";
        }

        const parts = [];
        if (typeInfo.class) parts.push(typeInfo.class);
        if (typeInfo.signed !== undefined) parts.push(typeInfo.signed ? "signed" : "unsigned");
        if (typeInfo.size) parts.push(`${typeInfo.size}-bit`);
        if (typeInfo.endianness) parts.push(typeInfo.endianness);

        return parts.join(", ");
    }

    let axisLabelMeasureContext = null;

    function measureAxisLabelWidth(text) {
        const value = String(text ?? "");
        if (!value) {
            return 0;
        }

        if (typeof document === "undefined") {
            return value.length * 7;
        }

        if (!axisLabelMeasureContext) {
            const canvas = document.createElement("canvas");
            axisLabelMeasureContext = canvas.getContext("2d");
        }

        if (!axisLabelMeasureContext) {
            return value.length * 7;
        }

        axisLabelMeasureContext.font =
            "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
        return axisLabelMeasureContext.measureText(value).width;
    }

    function resolveDisplayControls(state, preview) {
        const shape = normalizeShape(preview?.shape);
        const config = state.displayConfig || {};

        const appliedDisplayDims =
            normalizeDisplayDims(config.displayDims, shape) ||
            normalizeDisplayDims(preview?.display_dims, shape) ||
            getDefaultDisplayDims(shape);
        const stagedDisplayDims =
            normalizeDisplayDims(config.stagedDisplayDims, shape) || appliedDisplayDims;

        const appliedFixedIndices = buildNextFixedIndices(
            normalizeFixedIndices(config.fixedIndices, shape, appliedDisplayDims || []),
            appliedDisplayDims || [],
            shape
        );

        const stagedBase =
            Object.keys(config.stagedFixedIndices || {}).length > 0
                ? config.stagedFixedIndices
                : appliedFixedIndices;
        const stagedFixedIndices = buildNextFixedIndices(
            normalizeFixedIndices(stagedBase, shape, stagedDisplayDims || []),
            stagedDisplayDims || [],
            shape
        );

        const hasPendingChanges =
            !areDimsEqual(stagedDisplayDims, appliedDisplayDims) ||
            !areFixedIndicesEqual(stagedFixedIndices, appliedFixedIndices);

        return {
            shape,
            appliedDisplayDims,
            appliedFixedIndices,
            stagedDisplayDims,
            stagedFixedIndices,
            hasPendingChanges,
        };
    }
    if (typeof MATRIX_ROW_HEIGHT !== "undefined") {
        moduleState.MATRIX_ROW_HEIGHT = MATRIX_ROW_HEIGHT;
        global.MATRIX_ROW_HEIGHT = MATRIX_ROW_HEIGHT;
    }
    if (typeof MATRIX_COL_WIDTH !== "undefined") {
        moduleState.MATRIX_COL_WIDTH = MATRIX_COL_WIDTH;
        global.MATRIX_COL_WIDTH = MATRIX_COL_WIDTH;
    }
    if (typeof MATRIX_HEADER_HEIGHT !== "undefined") {
        moduleState.MATRIX_HEADER_HEIGHT = MATRIX_HEADER_HEIGHT;
        global.MATRIX_HEADER_HEIGHT = MATRIX_HEADER_HEIGHT;
    }
    if (typeof MATRIX_INDEX_WIDTH !== "undefined") {
        moduleState.MATRIX_INDEX_WIDTH = MATRIX_INDEX_WIDTH;
        global.MATRIX_INDEX_WIDTH = MATRIX_INDEX_WIDTH;
    }
    if (typeof MATRIX_OVERSCAN !== "undefined") {
        moduleState.MATRIX_OVERSCAN = MATRIX_OVERSCAN;
        global.MATRIX_OVERSCAN = MATRIX_OVERSCAN;
    }
    if (typeof MATRIX_BLOCK_CACHE !== "undefined") {
        moduleState.MATRIX_BLOCK_CACHE = MATRIX_BLOCK_CACHE;
        global.MATRIX_BLOCK_CACHE = MATRIX_BLOCK_CACHE;
    }
    if (typeof MATRIX_PENDING !== "undefined") {
        moduleState.MATRIX_PENDING = MATRIX_PENDING;
        global.MATRIX_PENDING = MATRIX_PENDING;
    }
    if (typeof LINE_VIEW_CACHE !== "undefined") {
        moduleState.LINE_VIEW_CACHE = LINE_VIEW_CACHE;
        global.LINE_VIEW_CACHE = LINE_VIEW_CACHE;
    }
    if (typeof LINE_FETCH_DEBOUNCE_MS !== "undefined") {
        moduleState.LINE_FETCH_DEBOUNCE_MS = LINE_FETCH_DEBOUNCE_MS;
        global.LINE_FETCH_DEBOUNCE_MS = LINE_FETCH_DEBOUNCE_MS;
    }
    if (typeof LINE_MIN_VIEW_SPAN !== "undefined") {
        moduleState.LINE_MIN_VIEW_SPAN = LINE_MIN_VIEW_SPAN;
        global.LINE_MIN_VIEW_SPAN = LINE_MIN_VIEW_SPAN;
    }
    if (typeof LINE_SVG_WIDTH !== "undefined") {
        moduleState.LINE_SVG_WIDTH = LINE_SVG_WIDTH;
        global.LINE_SVG_WIDTH = LINE_SVG_WIDTH;
    }
    if (typeof LINE_SVG_HEIGHT !== "undefined") {
        moduleState.LINE_SVG_HEIGHT = LINE_SVG_HEIGHT;
        global.LINE_SVG_HEIGHT = LINE_SVG_HEIGHT;
    }
    if (typeof LINE_DEFAULT_QUALITY !== "undefined") {
        moduleState.LINE_DEFAULT_QUALITY = LINE_DEFAULT_QUALITY;
        global.LINE_DEFAULT_QUALITY = LINE_DEFAULT_QUALITY;
    }
    if (typeof LINE_DEFAULT_OVERVIEW_MAX_POINTS !== "undefined") {
        moduleState.LINE_DEFAULT_OVERVIEW_MAX_POINTS = LINE_DEFAULT_OVERVIEW_MAX_POINTS;
        global.LINE_DEFAULT_OVERVIEW_MAX_POINTS = LINE_DEFAULT_OVERVIEW_MAX_POINTS;
    }
    if (typeof LINE_EXACT_MAX_POINTS !== "undefined") {
        moduleState.LINE_EXACT_MAX_POINTS = LINE_EXACT_MAX_POINTS;
        global.LINE_EXACT_MAX_POINTS = LINE_EXACT_MAX_POINTS;
    }
    if (typeof LINE_WINDOW_OPTIONS !== "undefined") {
        moduleState.LINE_WINDOW_OPTIONS = LINE_WINDOW_OPTIONS;
        global.LINE_WINDOW_OPTIONS = LINE_WINDOW_OPTIONS;
    }
    if (typeof LINE_KEYBOARD_PAN_RATIO !== "undefined") {
        moduleState.LINE_KEYBOARD_PAN_RATIO = LINE_KEYBOARD_PAN_RATIO;
        global.LINE_KEYBOARD_PAN_RATIO = LINE_KEYBOARD_PAN_RATIO;
    }
    if (typeof toSafeInteger !== "undefined") {
        moduleState.toSafeInteger = toSafeInteger;
        global.toSafeInteger = toSafeInteger;
    }
    if (typeof clamp !== "undefined") {
        moduleState.clamp = clamp;
        global.clamp = clamp;
    }
    if (typeof normalizeLineQuality !== "undefined") {
        moduleState.normalizeLineQuality = normalizeLineQuality;
        global.normalizeLineQuality = normalizeLineQuality;
    }
    if (typeof normalizeShape !== "undefined") {
        moduleState.normalizeShape = normalizeShape;
        global.normalizeShape = normalizeShape;
    }
    if (typeof getDefaultDisplayDims !== "undefined") {
        moduleState.getDefaultDisplayDims = getDefaultDisplayDims;
        global.getDefaultDisplayDims = getDefaultDisplayDims;
    }
    if (typeof normalizeDisplayDims !== "undefined") {
        moduleState.normalizeDisplayDims = normalizeDisplayDims;
        global.normalizeDisplayDims = normalizeDisplayDims;
    }
    if (typeof normalizeFixedIndices !== "undefined") {
        moduleState.normalizeFixedIndices = normalizeFixedIndices;
        global.normalizeFixedIndices = normalizeFixedIndices;
    }
    if (typeof buildNextFixedIndices !== "undefined") {
        moduleState.buildNextFixedIndices = buildNextFixedIndices;
        global.buildNextFixedIndices = buildNextFixedIndices;
    }
    if (typeof areDimsEqual !== "undefined") {
        moduleState.areDimsEqual = areDimsEqual;
        global.areDimsEqual = areDimsEqual;
    }
    if (typeof areFixedIndicesEqual !== "undefined") {
        moduleState.areFixedIndicesEqual = areFixedIndicesEqual;
        global.areFixedIndicesEqual = areFixedIndicesEqual;
    }
    if (typeof buildDisplayDimsParam !== "undefined") {
        moduleState.buildDisplayDimsParam = buildDisplayDimsParam;
        global.buildDisplayDimsParam = buildDisplayDimsParam;
    }
    if (typeof buildFixedIndicesParam !== "undefined") {
        moduleState.buildFixedIndicesParam = buildFixedIndicesParam;
        global.buildFixedIndicesParam = buildFixedIndicesParam;
    }
    if (typeof formatValue !== "undefined") {
        moduleState.formatValue = formatValue;
        global.formatValue = formatValue;
    }
    if (typeof formatCell !== "undefined") {
        moduleState.formatCell = formatCell;
        global.formatCell = formatCell;
    }
    if (typeof formatTypeDescription !== "undefined") {
        moduleState.formatTypeDescription = formatTypeDescription;
        global.formatTypeDescription = formatTypeDescription;
    }
    if (typeof measureAxisLabelWidth !== "undefined") {
        moduleState.measureAxisLabelWidth = measureAxisLabelWidth;
        global.measureAxisLabelWidth = measureAxisLabelWidth;
    }
    if (typeof resolveDisplayControls !== "undefined") {
        moduleState.resolveDisplayControls = resolveDisplayControls;
        global.resolveDisplayControls = resolveDisplayControls;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/shared");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Builds runtime selection keys and resolves matrix/line/heatmap runtime config from state and preview.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/render/config.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/render/config.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.render.config");

    // Builds a unique string key for a line selection (file + path + displayDims + fixedIndices + lineIndex)
    // Used to determine whether the runtime needs to refetch data after a state change
    function buildLineSelectionKey(fileKey, path, displayDimsParam, fixedIndicesParam, lineIndex) {
        return [
            fileKey || "no-file",
            path || "/",
            displayDimsParam || "none",
            fixedIndicesParam || "none",
            lineIndex ?? "auto",
        ].join("|");
    }

    // Resolves the full line runtime config from state and preview; returns supported=false if dataset is not plottable
    function resolveLineRuntimeConfig(state, preview) {
        const controls = resolveDisplayControls(state, preview);
        const shape = controls.shape;
        const dims = controls.appliedDisplayDims;
        const fixedIndices = controls.appliedFixedIndices || {};

        if (!shape.length) {
            return {
                supported: false,
                totalPoints: 0,
                rowCount: 0,
                displayDimsParam: "",
                fixedIndicesParam: "",
                lineIndex: null,
                selectionKey: "",
            };
        }

        if (shape.length === 1) {
            const totalPoints = Math.max(0, toSafeInteger(shape[0], 0));
            const selectionKey = buildLineSelectionKey(
                state.selectedFile,
                state.selectedPath,
                "",
                "",
                null
            );

            return {
                supported: totalPoints > 0,
                totalPoints,
                rowCount: 1,
                displayDimsParam: "",
                fixedIndicesParam: "",
                lineIndex: null,
                selectionKey,
            };
        }

        if (!Array.isArray(dims) || dims.length !== 2) {
            return {
                supported: false,
                totalPoints: 0,
                rowCount: 0,
                displayDimsParam: "",
                fixedIndicesParam: "",
                lineIndex: null,
                selectionKey: "",
            };
        }

        const rowDim = dims[0];
        const colDim = dims[1];
        const rowCount = Math.max(0, toSafeInteger(shape[rowDim], 0));
        const totalPoints = Math.max(0, toSafeInteger(shape[colDim], 0));
        const lineIndex = rowCount > 0 ? Math.floor(rowCount / 2) : null;
        const displayDimsParam = buildDisplayDimsParam(dims);
        const fixedIndicesParam = buildFixedIndicesParam(fixedIndices);
        const selectionKey = buildLineSelectionKey(
            state.selectedFile,
            state.selectedPath,
            displayDimsParam,
            fixedIndicesParam,
            lineIndex
        );

        return {
            supported: rowCount > 0 && totalPoints > 0,
            totalPoints,
            rowCount,
            displayDimsParam,
            fixedIndicesParam,
            lineIndex,
            selectionKey,
        };
    }

    function buildMatrixSelectionKey(fileKey, path, displayDimsParam, fixedIndicesParam) {
        return [
            fileKey || "no-file",
            path || "/",
            displayDimsParam || "none",
            fixedIndicesParam || "none",
        ].join("|");
    }

    function buildMatrixBlockKey(selectionKey, rowOffset, colOffset, rowLimit, colLimit) {
        return `${selectionKey}|r${rowOffset}|c${colOffset}|rl${rowLimit}|cl${colLimit}|rs1|cs1`;
    }

    function buildHeatmapSelectionKey(fileKey, path, displayDimsParam, fixedIndicesParam) {
        return [
            fileKey || "no-file",
            path || "/",
            displayDimsParam || "none",
            fixedIndicesParam || "none",
        ].join("|");
    }

    function resolveHeatmapRuntimeConfig(state, preview) {
        const controls = resolveDisplayControls(state, preview);
        const shape = controls.shape;
        const displayDims = controls.appliedDisplayDims;
        const fixedIndices = controls.appliedFixedIndices || {};
        const dimensionLabels = Array.isArray(preview?.dimension_labels) ? preview.dimension_labels : [];

        if (!Array.isArray(displayDims) || displayDims.length !== 2 || shape.length < 2) {
            return {
                supported: false,
                rows: 0,
                cols: 0,
                displayDimsParam: "",
                fixedIndicesParam: "",
                selectionKey: "",
                shape,
                displayDims: [],
                fixedIndices: {},
                dimensionLabels,
            };
        }

        const rowDim = displayDims[0];
        const colDim = displayDims[1];
        const rows = Math.max(0, toSafeInteger(shape[rowDim], 0));
        const cols = Math.max(0, toSafeInteger(shape[colDim], 0));
        const displayDimsParam = buildDisplayDimsParam(displayDims);
        const fixedIndicesParam = buildFixedIndicesParam(fixedIndices);
        const selectionKey = buildHeatmapSelectionKey(
            state.selectedFile,
            state.selectedPath,
            displayDimsParam,
            fixedIndicesParam
        );

        return {
            supported: true,
            rows,
            cols,
            displayDimsParam,
            fixedIndicesParam,
            selectionKey,
            shape,
            displayDims,
            fixedIndices,
            dimensionLabels,
        };
    }

    function resolveMatrixRuntimeConfig(state, preview) {
        const controls = resolveDisplayControls(state, preview);
        const shape = controls.shape;
        const displayDims = controls.appliedDisplayDims;
        const fixedIndices = controls.appliedFixedIndices || {};

        if (!Array.isArray(displayDims) || displayDims.length !== 2 || shape.length < 2) {
            return {
                supported: false,
                rows: 0,
                cols: 0,
                blockRows: 160,
                blockCols: 40,
                displayDimsParam: "",
                fixedIndicesParam: "",
                selectionKey: "",
            };
        }

        const rowDim = displayDims[0];
        const colDim = displayDims[1];
        const rows = Math.max(0, toSafeInteger(shape[rowDim], 0));
        const cols = Math.max(0, toSafeInteger(shape[colDim], 0));
        const blockRows = Math.max(1, Math.min(2000, toSafeInteger(state.matrixBlockSize?.rows, 160)));
        const blockCols = Math.max(1, Math.min(2000, toSafeInteger(state.matrixBlockSize?.cols, 40)));
        const displayDimsParam = buildDisplayDimsParam(displayDims);
        const fixedIndicesParam = buildFixedIndicesParam(fixedIndices);
        const selectionKey = buildMatrixSelectionKey(
            state.selectedFile,
            state.selectedPath,
            displayDimsParam,
            fixedIndicesParam
        );

        return {
            supported: true,
            rows,
            cols,
            blockRows,
            blockCols,
            displayDimsParam,
            fixedIndicesParam,
            selectionKey,
        };
    }
    if (typeof buildLineSelectionKey !== "undefined") {
        moduleState.buildLineSelectionKey = buildLineSelectionKey;
        global.buildLineSelectionKey = buildLineSelectionKey;
    }
    if (typeof resolveLineRuntimeConfig !== "undefined") {
        moduleState.resolveLineRuntimeConfig = resolveLineRuntimeConfig;
        global.resolveLineRuntimeConfig = resolveLineRuntimeConfig;
    }
    if (typeof buildMatrixSelectionKey !== "undefined") {
        moduleState.buildMatrixSelectionKey = buildMatrixSelectionKey;
        global.buildMatrixSelectionKey = buildMatrixSelectionKey;
    }
    if (typeof buildMatrixBlockKey !== "undefined") {
        moduleState.buildMatrixBlockKey = buildMatrixBlockKey;
        global.buildMatrixBlockKey = buildMatrixBlockKey;
    }
    if (typeof buildHeatmapSelectionKey !== "undefined") {
        moduleState.buildHeatmapSelectionKey = buildHeatmapSelectionKey;
        global.buildHeatmapSelectionKey = buildHeatmapSelectionKey;
    }
    if (typeof resolveHeatmapRuntimeConfig !== "undefined") {
        moduleState.resolveHeatmapRuntimeConfig = resolveHeatmapRuntimeConfig;
        global.resolveHeatmapRuntimeConfig = resolveHeatmapRuntimeConfig;
    }
    if (typeof resolveMatrixRuntimeConfig !== "undefined") {
        moduleState.resolveMatrixRuntimeConfig = resolveMatrixRuntimeConfig;
        global.resolveMatrixRuntimeConfig = resolveMatrixRuntimeConfig;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/render/config");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Renders fast preview HTML/SVG for table, line, and sampled heatmap modes before full runtimes load.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/render/previews.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/render/previews.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.render.previews");

    // Renders a scrollable HTML table preview from the preview.table payload
    // 1-D datasets use a single Index | Value column; 2-D datasets use a multi-column row grid
    function renderTablePreview(preview, notation = "auto") {
        const table = preview?.table;
        if (!table || typeof table !== "object") {
            return '<div class="panel-state"><div class="state-text">Table preview not available.</div></div>';
        }

        // Attempt to source 1-D values from multiple possible payload locations
        const oneDValuesFromPlot = Array.isArray(preview?.plot?.y)
            ? preview.plot.y
            : Array.isArray(preview?.profile?.y)
                ? preview.profile.y
                : Array.isArray(preview?.data)
                    ? preview.data
                    : [];

        if (table.kind === "1d") {
            const values = Array.isArray(table.values)
                ? table.values
                : Array.isArray(table.data)
                    ? table.data
                    : oneDValuesFromPlot;
            if (!values.length) {
                return '<div class="panel-state"><div class="state-text">No 1D values available in preview response.</div></div>';
            }

            const rows = values.slice(0, 200).map((value, index) => {
                return `
        <tr>
          <td class="row-index">${index}</td>
          <td>${escapeHtml(formatCell(value, notation))}</td>
        </tr>
      `;
            });

            return `
      <div class="preview-table-wrapper">
        <table class="preview-table">
          <thead>
            <tr>
              <th>Index</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;
        }

        const data = table.kind === "2d"
            ? (Array.isArray(table.data) ? table.data : [])
            : Array.isArray(preview?.plot?.data)
                ? preview.plot.data
                : (Array.isArray(preview?.data) ? preview.data : []);

        if (!data.length) {
            return '<div class="panel-state"><div class="state-text">No table rows available in preview response.</div></div>';
        }

        const rows = data.slice(0, 100).map((row, rowIndex) => {
            const cells = (Array.isArray(row) ? row : [row])
                .slice(0, 40)
                .map((value) => `<td>${escapeHtml(formatCell(value, notation))}</td>`)
                .join("");

            return `
      <tr>
        <td class="row-index">${rowIndex}</td>
        ${cells}
      </tr>
    `;
        });

        const firstRow = Array.isArray(data[0]) ? data[0] : [data[0]];
        const colCount = firstRow.length;
        const headCells = Array.from({ length: Math.min(colCount, 40) }, (_, index) => `<th>${index}</th>`).join("");

        return `
    <div class="preview-table-wrapper">
      <table class="preview-table">
        <thead>
          <tr>
            <th>#</th>
            ${headCells}
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
  `;
    }

    function getLinePoints(preview) {
        const source = preview?.profile || preview?.plot || {};
        let yRaw = [];

        if (Array.isArray(source.y)) {
            yRaw = source.y;
        } else if (Array.isArray(source.values)) {
            yRaw = source.values;
        } else if (Array.isArray(source.data)) {
            yRaw = source.data;
        } else if (Array.isArray(preview?.table?.values)) {
            yRaw = preview.table.values;
        } else if (Array.isArray(preview?.table?.data)) {
            yRaw = Array.isArray(preview.table.data[0]) ? preview.table.data[0] : preview.table.data;
        } else if (Array.isArray(preview?.data)) {
            yRaw = preview.data;
        }

        if (!Array.isArray(yRaw) || !yRaw.length) {
            return [];
        }

        const xRaw = Array.isArray(source.x) && source.x.length === yRaw.length
            ? source.x
            : yRaw.map((_, index) => index);

        return yRaw
            .map((yValue, index) => ({
                x: Number(xRaw[index]),
                y: Number(yValue),
            }))
            .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    }

    function renderLinePreview(preview, options = {}) {
        const points = getLinePoints(preview);
        const lineGrid = options.lineGrid !== false;
        const lineAspect = ["line", "point", "both"].includes(options.lineAspect)
            ? options.lineAspect
            : "line";

        if (points.length < 2) {
            return '<div class="panel-state"><div class="state-text">No numeric line preview is available for this selection.</div></div>';
        }

        const width = 760;
        const height = 320;

        const xValues = points.map((point) => point.x);
        const yValues = points.map((point) => point.y);
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        const minY = Math.min(...yValues);
        const maxY = Math.max(...yValues);
        const spanX = maxX - minX || 1;
        const spanY = maxY - minY || 1;

        const tickCount = 6;
        const xTickValues = Array.from({ length: tickCount }, (_, idx) => {
            const ratio = idx / Math.max(1, tickCount - 1);
            return minX + ratio * spanX;
        });
        const yTickValues = Array.from({ length: tickCount }, (_, idx) => {
            const ratio = idx / Math.max(1, tickCount - 1);
            return maxY - ratio * spanY;
        });
        const xTickLabelsText = xTickValues.map((value) => formatCell(value));
        const yTickLabelsText = yTickValues.map((value) => formatCell(value));
        const maxYLabelWidth = yTickLabelsText.reduce(
            (maxWidth, label) => Math.max(maxWidth, measureAxisLabelWidth(label)),
            0
        );
        const firstXHalf = xTickLabelsText.length
            ? measureAxisLabelWidth(xTickLabelsText[0]) / 2
            : 0;
        const lastXHalf = xTickLabelsText.length
            ? measureAxisLabelWidth(xTickLabelsText[xTickLabelsText.length - 1]) / 2
            : 0;

        const padding = {
            top: 24,
            right: clamp(Math.ceil(lastXHalf + 12), 22, Math.floor(width * 0.22)),
            bottom: 38,
            left: clamp(
                Math.ceil(Math.max(maxYLabelWidth + 14, firstXHalf + 8, 58)),
                58,
                Math.floor(width * 0.32)
            ),
        };
        const chartWidth = Math.max(120, width - padding.left - padding.right);
        const chartHeight = Math.max(120, height - padding.top - padding.bottom);
        const yAxisTitleX = Math.max(12, Math.round(padding.left * 0.28));

        const toChartPoint = (point) => {
            const x = padding.left + ((point.x - minX) / spanX) * chartWidth;
            const y = padding.top + chartHeight - ((point.y - minY) / spanY) * chartHeight;
            return { x, y };
        };

        const path = points
            .map((point, index) => {
                const chartPoint = toChartPoint(point);
                return `${index === 0 ? "M" : "L"}${chartPoint.x.toFixed(2)},${chartPoint.y.toFixed(2)}`;
            })
            .join(" ");

        const sampleStep = points.length > 120 ? Math.ceil(points.length / 120) : 1;
        const markers = points
            .filter((_, index) => index % sampleStep === 0)
            .map((point) => {
                const chartPoint = toChartPoint(point);
                return `<circle cx="${chartPoint.x.toFixed(2)}" cy="${chartPoint.y.toFixed(2)}" r="1.9"></circle>`;
            })
            .join("");

        const gridLines = Array.from({ length: tickCount }, (_, idx) => {
            const ratio = idx / Math.max(1, tickCount - 1);
            const x = padding.left + ratio * chartWidth;
            const y = padding.top + ratio * chartHeight;
            return {
                vertical: `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${padding.top + chartHeight
                    }"></line>`,
                horizontal: `<line x1="${padding.left}" y1="${y}" x2="${padding.left + chartWidth
                    }" y2="${y}"></line>`,
            };
        });

        const xTickLabels = xTickLabelsText
            .map((label, idx) => {
                const ratio = idx / Math.max(1, tickCount - 1);
                const x = padding.left + ratio * chartWidth;
                return `<text x="${x}" y="${padding.top + chartHeight + 18}" text-anchor="middle">${escapeHtml(
                    label
                )}</text>`;
            })
            .join("");
        const yTickLabels = yTickLabelsText
            .map((label, idx) => {
                const ratio = idx / Math.max(1, tickCount - 1);
                const y = padding.top + ratio * chartHeight;
                return `<text x="${padding.left - 10}" y="${y + 4}" text-anchor="end">${escapeHtml(
                    label
                )}</text>`;
            })
            .join("");

        return `
    <div class="line-chart-shell">
      <div class="line-chart-toolbar">
        <div class="line-tool-group">
          <button type="button" class="line-tool-btn active">Preview</button>
        </div>
        <div class="line-zoom-label">Points: ${points.length}</div>
      </div>
      <div class="line-chart-stage">
        <div class="line-chart-canvas">
          <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="Line preview">
            <rect x="0" y="0" width="${width}" height="${height}" class="line-chart-bg"></rect>
            <g class="line-grid">${lineGrid ? gridLines.map((line) => line.vertical + line.horizontal).join("") : ""}</g>
            <g class="line-axis">
              <line
                x1="${padding.left}"
                y1="${padding.top + chartHeight}"
                x2="${padding.left + chartWidth}"
                y2="${padding.top + chartHeight}"
              ></line>
              <line
                x1="${padding.left}"
                y1="${padding.top}"
                x2="${padding.left}"
                y2="${padding.top + chartHeight}"
              ></line>
            </g>
            <g class="line-axis-labels">
              ${xTickLabels}
              ${yTickLabels}
            </g>
            <g class="line-axis-titles">
              <text class="line-axis-title line-axis-title-x" x="${padding.left + chartWidth / 2
            }" y="${height - 6}" text-anchor="middle">Index</text>
              <text
                class="line-axis-title line-axis-title-y"
                x="${yAxisTitleX}"
                y="${padding.top + chartHeight / 2}"
                text-anchor="middle"
                transform="rotate(-90, ${yAxisTitleX}, ${padding.top + chartHeight / 2})"
              >
                Value
              </text>
            </g>
            ${lineAspect === "point" ? "" : `<path class="line-path" d="${path}"></path>`}
            ${lineAspect === "line" ? "" : `<g class="line-points">${markers}</g>`}
          </svg>
        </div>
      </div>
      <div class="line-stats">
        <span>min: ${escapeHtml(formatCell(minY))}</span>
        <span>max: ${escapeHtml(formatCell(maxY))}</span>
        <span>span: ${escapeHtml(formatCell(maxY - minY))}</span>
      </div>
    </div>
  `;
    }

    function getHeatmapRows(preview) {
        if (Array.isArray(preview?.plot?.data)) {
            return preview.plot.data;
        }

        if (Array.isArray(preview?.table?.data)) {
            return preview.table.data;
        }

        if (Array.isArray(preview?.data)) {
            return preview.data;
        }

        return [];
    }

    const HEATMAP_PREVIEW_MAX_ROWS = 48;
    const HEATMAP_PREVIEW_MAX_COLS = 48;

    function buildSampledHeatmapRows(rawRows, maxRows = HEATMAP_PREVIEW_MAX_ROWS, maxCols = HEATMAP_PREVIEW_MAX_COLS) {
        const sourceRows = Array.isArray(rawRows) ? rawRows.filter((row) => Array.isArray(row)) : [];
        if (!sourceRows.length) {
            return [];
        }

        const sourceRowCount = sourceRows.length;
        const sourceColCount = sourceRows.reduce(
            (maxCount, row) => Math.max(maxCount, Array.isArray(row) ? row.length : 0),
            0
        );
        if (!sourceColCount) {
            return [];
        }

        const rowStep = Math.max(1, Math.ceil(sourceRowCount / maxRows));
        const colStep = Math.max(1, Math.ceil(sourceColCount / maxCols));
        const sampledRows = [];

        for (let rowIndex = 0; rowIndex < sourceRowCount && sampledRows.length < maxRows; rowIndex += rowStep) {
            const sourceRow = sourceRows[rowIndex] || [];
            const sampledRow = [];

            for (let colIndex = 0; colIndex < sourceColCount && sampledRow.length < maxCols; colIndex += colStep) {
                sampledRow.push(colIndex < sourceRow.length ? sourceRow[colIndex] : null);
            }

            sampledRows.push(sampledRow);
        }

        return sampledRows;
    }

    const HEATMAP_PREVIEW_COLOR_STOPS = Object.freeze({
        grayscale: [
            [0, 0, 0],
            [64, 64, 64],
            [128, 128, 128],
            [192, 192, 192],
            [255, 255, 255],
        ],
        viridis: [
            [68, 1, 84],
            [59, 82, 139],
            [33, 145, 140],
            [94, 201, 98],
            [253, 231, 37],
        ],
        plasma: [
            [13, 8, 135],
            [126, 3, 167],
            [203, 71, 119],
            [248, 149, 64],
            [240, 249, 33],
        ],
        inferno: [
            [0, 0, 4],
            [87, 15, 109],
            [187, 55, 84],
            [249, 142, 8],
            [252, 255, 164],
        ],
        magma: [
            [0, 0, 4],
            [73, 15, 109],
            [151, 45, 123],
            [221, 82, 72],
            [252, 253, 191],
        ],
        cool: [
            [0, 255, 255],
            [63, 191, 255],
            [127, 127, 255],
            [191, 63, 255],
            [255, 0, 255],
        ],
        hot: [
            [0, 0, 0],
            [128, 0, 0],
            [255, 64, 0],
            [255, 200, 0],
            [255, 255, 255],
        ],
    });

    function getHeatColorStops(name) {
        return HEATMAP_PREVIEW_COLOR_STOPS[name] || HEATMAP_PREVIEW_COLOR_STOPS.viridis;
    }

    function interpolateHeatColor(stops, ratio) {
        const clamped = clamp(ratio, 0, 1);
        const index = clamped * (stops.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const fraction = index - lower;
        if (lower === upper) {
            return stops[lower];
        }
        const [r1, g1, b1] = stops[lower];
        const [r2, g2, b2] = stops[upper];
        return [
            Math.round(r1 + (r2 - r1) * fraction),
            Math.round(g1 + (g2 - g1) * fraction),
            Math.round(b1 + (b2 - b1) * fraction),
        ];
    }

    function getHeatColor(value, min, max, stops) {
        if (!Number.isFinite(value)) {
            return "#CBD5E1";
        }
        const ratio = max <= min ? 0.5 : clamp((value - min) / (max - min), 0, 1);
        const [r, g, b] = interpolateHeatColor(stops, ratio);
        return `rgb(${r}, ${g}, ${b})`;
    }

    function buildHeatmapTicks(size, maxTicks = 6) {
        const length = Math.max(0, Number(size) || 0);
        if (length <= 0) {
            return [];
        }
        if (length === 1) {
            return [0];
        }
        const target = Math.max(2, Math.min(maxTicks, length));
        const ticks = new Set([0, length - 1]);
        for (let index = 1; index < target - 1; index += 1) {
            ticks.add(Math.round((index / (target - 1)) * (length - 1)));
        }
        return Array.from(ticks).sort((a, b) => a - b);
    }

    function formatHeatmapScaleValue(value) {
        if (!Number.isFinite(value)) {
            return "--";
        }
        if (Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-3 && value !== 0)) {
            return value.toExponential(2);
        }
        return value.toLocaleString(undefined, {
            maximumFractionDigits: Math.abs(value) >= 10 ? 1 : 3,
        });
    }

    function estimateImageHistogramQuantile(histogram, quantile) {
        if (!histogram || !Array.isArray(histogram.bins) || histogram.count <= 0) {
            return null;
        }

        const q = clamp(Number(quantile), 0, 1);
        if (!(histogram.max > histogram.min)) {
            return histogram.min;
        }

        const target = q * Math.max(0, histogram.count - 1);
        let cumulative = 0;
        for (let index = 0; index < histogram.bins.length; index += 1) {
            const binCount = Math.max(0, Number(histogram.bins[index]) || 0);
            if (binCount <= 0) {
                continue;
            }
            const nextCumulative = cumulative + binCount;
            if (target <= nextCumulative - 1 || index === histogram.bins.length - 1) {
                const localOffset = clamp((target - cumulative) / binCount, 0, 1);
                const binStart = histogram.min + (index / histogram.binCount) * (histogram.max - histogram.min);
                return binStart + localOffset * histogram.binWidth;
            }
            cumulative = nextCumulative;
        }

        return histogram.max;
    }

    function buildImageHistogramData(valuesInput, options = {}) {
        const values =
            valuesInput && typeof valuesInput.length === "number"
                ? valuesInput
                : [];

        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        let mean = 0;
        let m2 = 0;

        for (let index = 0; index < values.length; index += 1) {
            const numeric = Number(values[index]);
            if (!Number.isFinite(numeric)) {
                continue;
            }

            count += 1;
            min = Math.min(min, numeric);
            max = Math.max(max, numeric);
            const delta = numeric - mean;
            mean += delta / count;
            m2 += delta * (numeric - mean);
        }

        if (!count) {
            return null;
        }

        if (!(max > min)) {
            max = min + 1;
        }

        const requestedBinCount = Math.round(Number(options.binCount) || 0);
        const binCount = Math.max(1, Math.min(256, requestedBinCount || 256));
        const span = max - min;
        const binWidth = span / Math.max(1, binCount);
        const bins = Array.from({ length: binCount }, () => 0);

        for (let index = 0; index < values.length; index += 1) {
            const numeric = Number(values[index]);
            if (!Number.isFinite(numeric)) {
                continue;
            }
            const ratio = span <= 0 ? 0 : (numeric - min) / span;
            const binIndex = clamp(Math.floor(ratio * binCount), 0, binCount - 1);
            bins[binIndex] += 1;
        }

        let peakCount = 0;
        let peakIndex = 0;
        for (let index = 0; index < bins.length; index += 1) {
            if (bins[index] > peakCount) {
                peakCount = bins[index];
                peakIndex = index;
            }
        }

        const histogram = {
            count,
            min,
            max,
            mean,
            stdDev: count > 1 ? Math.sqrt(m2 / count) : 0,
            bins,
            binCount,
            binWidth,
            peakCount,
            peakIndex,
            peakStart: min + peakIndex * binWidth,
            peakEnd: min + (peakIndex + 1) * binWidth,
            peakValue: min + (peakIndex + 0.5) * binWidth,
        };

        histogram.median = estimateImageHistogramQuantile(histogram, 0.5);
        return histogram;
    }

    function renderImageHistogramToolIcon(kind) {
        if (kind === "pan") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1v14M1 8h14M8 1 6.3 2.7M8 1l1.7 1.7M8 15l-1.7-1.7M8 15l1.7-1.7M1 8l1.7-1.7M1 8l1.7 1.7M15 8l-1.7-1.7M15 8l-1.7 1.7"></path>
      </svg>
    `;
        }
        if (kind === "zoom-in") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5"></circle>
        <path d="M10.4 10.4 14 14M7 5v4M5 7h4"></path>
      </svg>
    `;
        }
        if (kind === "zoom-out") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5"></circle>
        <path d="M10.4 10.4 14 14M5 7h4"></path>
      </svg>
    `;
        }
        if (kind === "reset") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.2 5.4A5 5 0 1 1 3 8M3 3v3h3"></path>
      </svg>
    `;
        }
        if (kind === "fullscreen") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"></path>
      </svg>
    `;
        }
        return "";
    }

    function renderImageHistogramToolButton(label, dataAttr, kind) {
        return `
    <button
      type="button"
      class="line-tool-btn line-tool-btn-icon"
      ${dataAttr}="true"
      aria-label="${label}"
      title="${label}"
    >
      ${renderImageHistogramToolIcon(kind)}
    </button>
  `;
    }

    function createImageHistogramPayload(histogram, options = {}) {
        const title = options.title || "Histogram";
        const subtitle = options.subtitle || "Intensity distribution for the current image slice";
        const ariaLabel = options.ariaLabel || "Image histogram";
        const emptyMessage = options.emptyMessage || "Histogram is unavailable for this image.";
        const normalizedHistogram =
            histogram && Array.isArray(histogram.bins) && histogram.bins.length
                ? {
                    count: Math.max(0, Number(histogram.count) || 0),
                    min: Number(histogram.min) || 0,
                    max: Number(histogram.max) || 0,
                    mean: Number(histogram.mean) || 0,
                    median: Number(histogram.median) || 0,
                    stdDev: Number(histogram.stdDev) || 0,
                    peakValue: Number(histogram.peakValue) || 0,
                    peakCount: Math.max(0, Number(histogram.peakCount) || 0),
                    peakIndex: Math.max(0, Number(histogram.peakIndex) || 0),
                    binCount: Math.max(1, Number(histogram.binCount) || histogram.bins.length || 1),
                    binWidth: Number(histogram.binWidth) || 0,
                    bins: histogram.bins.map((count) => Math.max(0, Number(count) || 0)),
                }
                : null;

        return {
            title,
            subtitle,
            ariaLabel,
            emptyMessage,
            histogram: normalizedHistogram,
        };
    }

    function renderImageHistogramShellMarkup(payload) {
        const safePayload = payload && typeof payload === "object" ? payload : createImageHistogramPayload(null);
        const histogram = safePayload.histogram;
        const title = safePayload.title || "Histogram";
        const subtitle = safePayload.subtitle || "Intensity distribution for the current image slice";
        const ariaLabel = safePayload.ariaLabel || "Image histogram";
        const badgeText = histogram && histogram.binCount ? `${histogram.binCount} bins` : "-- bins";
        const encodedPayload = escapeHtml(JSON.stringify(safePayload));
        return `
    <div
      class="line-chart-shell image-histogram-shell"
      data-image-histogram-shell="true"
      data-image-histogram-payload="${encodedPayload}"
    >
      <div class="image-histogram-header">
        <div>
          <div class="image-histogram-title" data-image-histogram-title="true">${escapeHtml(title)}</div>
          <div class="image-histogram-subtitle" data-image-histogram-subtitle="true">${escapeHtml(subtitle)}</div>
        </div>
        <span class="image-histogram-badge" data-image-histogram-badge="true">${escapeHtml(badgeText)}</span>
      </div>
      <div class="line-chart-toolbar image-histogram-toolbar">
        <div class="line-tool-group">
          <span class="line-zoom-label" data-image-histogram-zoom-label="true">100%</span>
          ${renderImageHistogramToolButton("Fullscreen", "data-image-histogram-fullscreen-toggle", "fullscreen")}
          <span class="line-zoom-label" data-image-histogram-range-label="true">Range: --</span>
        </div>
      </div>
      <div class="line-chart-stage">
        <div
          class="line-chart-canvas image-histogram-canvas"
          data-image-histogram-canvas="true"
          tabindex="0"
          role="application"
          aria-label="${escapeHtml(ariaLabel)}"
        >
          <svg
            class="image-histogram-svg"
            data-image-histogram-svg="true"
            viewBox="0 0 760 220"
            preserveAspectRatio="none"
            role="img"
            aria-label="${escapeHtml(ariaLabel)}"
          ></svg>
          <div class="line-hover image-histogram-hover" data-image-histogram-hover="true" hidden></div>
        </div>
      </div>
      <div class="image-histogram-empty" data-image-histogram-empty="true" hidden></div>
      <div class="image-histogram-stats">
        <span data-image-histogram-stat-mean="true">mean: --</span>
        <span data-image-histogram-stat-median="true">median: --</span>
        <span data-image-histogram-stat-std="true">std: --</span>
        <span data-image-histogram-stat-peak="true">peak: --</span>
      </div>
    </div>
  `;
    }

    function renderImageHistogramEmptyMarkup(message, options = {}) {
        return renderImageHistogramShellMarkup(
            createImageHistogramPayload(null, {
                ...options,
                emptyMessage: message || options.emptyMessage || "Histogram is unavailable for this image.",
            })
        );
    }

    function renderImageHistogramMarkup(histogram, options = {}) {
        return renderImageHistogramShellMarkup(createImageHistogramPayload(histogram, options));
    }

    function renderHeatmapPreview(preview, options = {}) {
        const colormap = options.heatmapColormap || "viridis";
        const showGrid = options.heatmapGrid !== false;
        const colorStops = getHeatColorStops(colormap);
        const rawRows = buildSampledHeatmapRows(getHeatmapRows(preview));

        if (!rawRows.length) {
            return '<div class="panel-state"><div class="state-text">No matrix preview is available for heatmap rendering.</div></div>';
        }

        const colCount = rawRows.reduce(
            (maxCount, row) => Math.max(maxCount, Array.isArray(row) ? row.length : 0),
            0
        );
        if (!colCount) {
            return '<div class="panel-state"><div class="state-text">Heatmap preview has no columns.</div></div>';
        }

        const rowCount = rawRows.length;
        const normalizedRows = rawRows.map((row) =>
            Array.from({ length: colCount }, (_, index) => (index < row.length ? row[index] : null))
        );
        const previewValues = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
            const row = normalizedRows[rowIndex];
            for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
                previewValues.push(row[colIndex]);
            }
        }
        const histogramData = buildImageHistogramData(previewValues);
        if (!histogramData) {
            return '<div class="panel-state"><div class="state-text">Heatmap preview requires numeric values.</div></div>';
        }
        const min = histogramData.min;
        const max = histogramData.max;

        const width = 760;
        const height = 420;
        const paddingLeft = 46;
        const paddingTop = 24;
        const paddingBottom = 34;
        const colorBarWidth = 18;
        const colorBarGap = 16;
        const colorBarLabelWidth = 56;
        const chartWidth = Math.max(
            120,
            width - paddingLeft - colorBarWidth - colorBarGap - colorBarLabelWidth - 12
        );
        const chartHeight = Math.max(120, height - paddingTop - paddingBottom);
        const chartX = paddingLeft;
        const chartY = paddingTop;
        const colorBarX = chartX + chartWidth + colorBarGap;
        const colorBarY = chartY;
        const cellWidth = chartWidth / Math.max(1, colCount);
        const cellHeight = chartHeight / Math.max(1, rowCount);

        const gradientId = `heatmap-preview-gradient-${rowCount}-${colCount}-${Math.round(
            min * 1000
        )}-${Math.round(max * 1000)}`.replace(/[^A-Za-z0-9_-]/g, "");
        const gradientStops = colorStops
            .map((color, index) => {
                const offset = index / Math.max(1, colorStops.length - 1);
                return `<stop offset="${(offset * 100).toFixed(2)}%" stop-color="rgb(${color[0]}, ${color[1]}, ${color[2]})"></stop>`;
            })
            .join("");

        const cellStroke = showGrid && cellWidth >= 4 && cellHeight >= 4 ? "rgba(255,255,255,0.35)" : "none";
        const cellStrokeWidth = cellStroke === "none" ? 0 : 0.5;
        const cellRects = normalizedRows
            .map((row, rowIndex) => {
                return row
                    .map((value, colIndex) => {
                        const numeric = Number(value);
                        const fill = getHeatColor(numeric, min, max, colorStops);
                        const x = chartX + colIndex * cellWidth;
                        const y = chartY + rowIndex * cellHeight;
                        return `
            <rect
              x="${x.toFixed(3)}"
              y="${y.toFixed(3)}"
              width="${cellWidth.toFixed(3)}"
              height="${cellHeight.toFixed(3)}"
              fill="${fill}"
              stroke="${cellStroke}"
              stroke-width="${cellStrokeWidth}"
            ></rect>
          `;
                    })
                    .join("");
            })
            .join("");

        const xTicks = buildHeatmapTicks(colCount);
        const yTicks = buildHeatmapTicks(rowCount);
        const xTickLabels = xTicks
            .map((col) => {
                const ratio = colCount <= 1 ? 0.5 : col / (colCount - 1);
                const x = chartX + ratio * chartWidth;
                return `<text x="${x.toFixed(2)}" y="${(chartY + chartHeight + 16).toFixed(2)}" text-anchor="middle">${col}</text>`;
            })
            .join("");
        const yTickLabels = yTicks
            .map((row) => {
                const ratio = rowCount <= 1 ? 0.5 : row / (rowCount - 1);
                const y = chartY + ratio * chartHeight + 4;
                const label = Math.max(0, rowCount - 1 - row);
                return `<text x="${(chartX - 10).toFixed(2)}" y="${y.toFixed(2)}" text-anchor="end">${label}</text>`;
            })
            .join("");
        const histogramMarkup = options.includeHistogram === true
            ? renderImageHistogramMarkup(histogramData, {
                title: options.histogramTitle || "Histogram",
                subtitle: options.histogramSubtitle || "Sampled grayscale distribution for the preview slice",
                ariaLabel: options.histogramAriaLabel || "Preview image histogram",
            })
            : "";

        return `
    <div class="line-chart-shell heatmap-chart-shell heatmap-preview-chart-shell">
      <div class="line-chart-toolbar heatmap-chart-toolbar">
        <div class="line-tool-group">
          <span class="line-tool-label">Preview (Sampled)</span>
        </div>
        <div class="line-tool-group">
          <span class="line-zoom-label">Grid: ${rowCount.toLocaleString()} x ${colCount.toLocaleString()}</span>
        </div>
      </div>
      <div class="line-chart-stage">
        <svg
          class="line-chart-canvas heatmap-chart-canvas heatmap-preview-svg"
          viewBox="0 0 ${width} ${height}"
          role="img"
          aria-label="Heatmap preview"
        >
          <defs>
            <linearGradient id="${gradientId}" x1="0%" y1="100%" x2="0%" y2="0%">
              ${gradientStops}
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="${width}" height="${height}" class="line-chart-bg"></rect>
          <rect
            x="${chartX}"
            y="${chartY}"
            width="${chartWidth}"
            height="${chartHeight}"
            fill="#FFFFFF"
            stroke="#D9E2F2"
            stroke-width="1"
          ></rect>
          ${cellRects}
          <g class="line-axis-labels">${xTickLabels}${yTickLabels}</g>
          <rect
            x="${colorBarX}"
            y="${colorBarY}"
            width="${colorBarWidth}"
            height="${chartHeight}"
            fill="url(#${gradientId})"
            stroke="#D9E2F2"
            stroke-width="1"
          ></rect>
          <g class="line-axis-labels">
            <text x="${colorBarX + colorBarWidth + 7}" y="${colorBarY + 9}" text-anchor="start">${escapeHtml(
            formatHeatmapScaleValue(max)
        )}</text>
            <text x="${colorBarX + colorBarWidth + 7}" y="${colorBarY + chartHeight / 2 + 3}" text-anchor="start">${escapeHtml(
            formatHeatmapScaleValue((min + max) / 2)
        )}</text>
            <text x="${colorBarX + colorBarWidth + 7}" y="${colorBarY + chartHeight - 2}" text-anchor="start">${escapeHtml(
            formatHeatmapScaleValue(min)
        )}</text>
          </g>
        </svg>
      </div>
      ${histogramMarkup}
      <div class="line-stats">
        <span>min: ${escapeHtml(formatCell(min))}</span>
        <span>max: ${escapeHtml(formatCell(max))}</span>
        <span>size: ${(rowCount * colCount).toLocaleString()} cells</span>
      </div>
    </div>
  `;
    }
    if (typeof renderTablePreview !== "undefined") {
        moduleState.renderTablePreview = renderTablePreview;
        global.renderTablePreview = renderTablePreview;
    }
    if (typeof renderLinePreview !== "undefined") {
        moduleState.renderLinePreview = renderLinePreview;
        global.renderLinePreview = renderLinePreview;
    }
    if (typeof renderHeatmapPreview !== "undefined") {
        moduleState.renderHeatmapPreview = renderHeatmapPreview;
        global.renderHeatmapPreview = renderHeatmapPreview;
    }
    if (typeof buildImageHistogramData !== "undefined") {
        moduleState.buildImageHistogramData = buildImageHistogramData;
        global.buildImageHistogramData = buildImageHistogramData;
    }
    if (typeof renderImageHistogramMarkup !== "undefined") {
        moduleState.renderImageHistogramMarkup = renderImageHistogramMarkup;
        global.renderImageHistogramMarkup = renderImageHistogramMarkup;
    }
    if (typeof renderImageHistogramEmptyMarkup !== "undefined") {
        moduleState.renderImageHistogramEmptyMarkup = renderImageHistogramEmptyMarkup;
        global.renderImageHistogramEmptyMarkup = renderImageHistogramEmptyMarkup;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/render/previews");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Renders dimension selectors and keeps optional fixed-index controls for multidimensional dataset slicing.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/render/dimensionControls.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/render/dimensionControls.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.render.dimensionControls");

    // Feature flag: exposes per-dimension index sliders for non-displayed axes in 3D+ dataset views.
    const SHOW_FIXED_INDEX_CONTROLS = true;

    function getDimensionDisplayName(dimensionLabels, dim) {
        const label = Array.isArray(dimensionLabels) && typeof dimensionLabels[dim] === "string"
            ? dimensionLabels[dim].trim()
            : "";
        return label || `D${dim}`;
    }

    function renderFixedIndexControls(options = {}) {
        const shape = normalizeShape(options.shape);
        const displayDims = Array.isArray(options.displayDims) ? options.displayDims : [];
        const fixedIndices = options.fixedIndices && typeof options.fixedIndices === "object" ? options.fixedIndices : {};
        const dimensionLabels = Array.isArray(options.dimensionLabels) ? options.dimensionLabels : [];
        const playingFixedDim = toSafeInteger(options.playingFixedDim, null);
        const showPlayback = options.showPlayback === true;
        const canAutoplayHiddenDims = options.canAutoplayHiddenDims === true;
        const wrapperClassName = typeof options.wrapperClassName === "string" ? options.wrapperClassName.trim() : "";
        const containerClassName = typeof options.containerClassName === "string" && options.containerClassName.trim()
            ? options.containerClassName.trim()
            : "dim-sliders";
        const controlClassName = typeof options.controlClassName === "string" && options.controlClassName.trim()
            ? options.controlClassName.trim()
            : "";
        const title = typeof options.title === "string" ? options.title.trim() : "";
        const titleClassName = typeof options.titleClassName === "string" && options.titleClassName.trim()
            ? options.titleClassName.trim()
            : "dim-controls-heading";

        if (shape.length < 3 || displayDims.length < 2) {
            return "";
        }

        const controlMarkup = shape
            .map((size, dim) => {
                if (displayDims.includes(dim)) {
                    return "";
                }

                const max = Math.max(0, size - 1);
                const current = Number.isFinite(fixedIndices[dim]) ? fixedIndices[dim] : Math.floor(size / 2);
                const isPlaying = playingFixedDim === dim;
                const playbackDisabled = !canAutoplayHiddenDims || max < 1;
                const dimName = getDimensionDisplayName(dimensionLabels, dim);
                const controlClasses = ["dim-slider"];
                if (controlClassName) {
                    controlClasses.push(controlClassName);
                }
                const playbackMarkup = showPlayback
                    ? `
                  <div class="dim-slider-playback" data-fixed-playback-available="${playbackDisabled ? "0" : "1"}">
                    <div class="dim-playback-buttons" role="group" aria-label="${escapeHtml(dimName)} playback controls">
                      <button
                        type="button"
                        class="dim-play-icon-btn ${!isPlaying && !playbackDisabled ? "active" : ""}"
                        data-fixed-index-play-action="start"
                        data-fixed-dim="${dim}"
                        data-fixed-size="${size}"
                        aria-label="Play ${escapeHtml(dimName)}"
                        title="Play ${escapeHtml(dimName)}"
                        ${playbackDisabled ? "disabled" : ""}
                      >
                        <svg class="dim-play-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                          <path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"></path>
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="dim-play-icon-btn ${isPlaying ? "active" : ""}"
                        data-fixed-index-play-action="stop"
                        data-fixed-dim="${dim}"
                        data-fixed-size="${size}"
                        aria-label="Pause ${escapeHtml(dimName)}"
                        title="Pause ${escapeHtml(dimName)}"
                        ${playbackDisabled ? "disabled" : ""}
                      >
                        <svg class="dim-play-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                          <rect x="3.6" y="2.8" width="3.2" height="10.4" rx="0.9" fill="currentColor"></rect>
                          <rect x="9.2" y="2.8" width="3.2" height="10.4" rx="0.9" fill="currentColor"></rect>
                        </svg>
                      </button>
                    </div>
                    <span
                      class="dim-play-status"
                      data-fixed-index-status="true"
                      data-fixed-status-dim="${dim}"
                    >
                      Index ${current} / ${max}
                    </span>
                  </div>
                `
                    : "";

                return `
                <div
                  class="${escapeHtml(controlClasses.join(" "))}"
                  data-fixed-index-control="${dim}"
                  data-fixed-playback-available="${playbackDisabled ? "0" : "1"}"
                >
                  <label>${escapeHtml(dimName)} index</label>
                  <div class="slider-row">
                    <input
                      type="range"
                      min="0"
                      max="${max}"
                      value="${current}"
                      data-fixed-index-range="true"
                      data-fixed-dim="${dim}"
                      data-fixed-size="${size}"
                    />
                    <input
                      type="number"
                      min="0"
                      max="${max}"
                      value="${current}"
                      data-fixed-index-number="true"
                      data-fixed-dim="${dim}"
                      data-fixed-size="${size}"
                    />
                  </div>
                  ${playbackMarkup}
                </div>
              `;
            })
            .join("");

        if (!controlMarkup) {
            return "";
        }

        const content = `
        <div class="${escapeHtml(containerClassName)}">
          ${controlMarkup}
        </div>
      `;

        if (!wrapperClassName) {
            return content;
        }

        return `
        <div class="${escapeHtml(wrapperClassName)}">
          ${title ? `<div class="${escapeHtml(titleClassName)}">${escapeHtml(title)}</div>` : ""}
          ${content}
        </div>
      `;
    }

    // Entry point: for ndim < 2 there are no selectable axes, so nothing is rendered
    function renderDimensionControls(state, preview) {
        const ndim = Number(preview?.ndim || 0);
        if (ndim < 2) {
            return "";
        }

        const controls = resolveDisplayControls(state, preview);
        const shape = controls.shape;
        const appliedDims = controls.appliedDisplayDims || getDefaultDisplayDims(shape);
        const stagedDims = controls.stagedDisplayDims || appliedDims || [0, 1];
        const stagedFixed = controls.stagedFixedIndices || {};
        const dimensionLabels = Array.isArray(preview?.dimension_labels) ? preview.dimension_labels : [];
        const playingFixedDim = toSafeInteger(state.displayConfig?.playingFixedDim, null);
        const showAutoplayControls = state.displayTab === "heatmap" || state.displayTab === "image";
        const canAutoplayHiddenDims =
            showAutoplayControls && state.heatmapFullEnabled === true;

        if (!appliedDims || !stagedDims) {
            return "";
        }

        function getDimDisplayName(dim) {
            return getDimensionDisplayName(dimensionLabels, dim);
        }

        function formatDimPair(dims) {
            return `${getDimDisplayName(dims[0])} x ${getDimDisplayName(dims[1])}`;
        }

        const dimLabel = formatDimPair(appliedDims);
        const pendingLabel = formatDimPair(stagedDims);

        if (ndim === 2) {
            const xDim = stagedDims[1];
            const yDim = stagedDims[0];

            return `
      <aside class="preview-sidebar">
        <button type="button" class="sidebar-collapse-btn" data-sidebar-toggle="true">
          <svg class="sidebar-collapse-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Dimensions</span>
          <span class="dim-value-inline">${escapeHtml(dimLabel)}</span>
        </button>
        <div class="sidebar-body">
        <div class="dimension-summary">
          <span class="dim-label">Display dims</span>
          <span class="dim-value">${escapeHtml(dimLabel)}</span>
        </div>
        <div class="axis-toggle">
          <div class="axis-row">
            <span class="axis-label">x</span>
            <div class="axis-options">
              ${[0, 1]
                    .map(
                        (dim) => `
                    <button
                      type="button"
                      class="axis-btn ${xDim === dim ? "active" : ""}"
                      data-axis-change="x"
                      data-axis-dim="${dim}"
                    >
                      ${escapeHtml(getDimDisplayName(dim))}
                    </button>
                  `
                    )
                    .join("")}
            </div>
          </div>
          <div class="axis-row">
            <span class="axis-label">y</span>
            <div class="axis-options">
              ${[0, 1]
                    .map(
                        (dim) => `
                    <button
                      type="button"
                      class="axis-btn ${yDim === dim ? "active" : ""}"
                      data-axis-change="y"
                      data-axis-dim="${dim}"
                    >
                      ${escapeHtml(getDimDisplayName(dim))}
                    </button>
                  `
                    )
                    .join("")}
            </div>
          </div>
        </div>
        </div>
      </aside>
    `;
        }

        const dimOptions = shape.map((size, idx) => ({ idx, size }));
        const xOptions = dimOptions;
        const yOptions = dimOptions.filter((option) => option.idx !== stagedDims[0]);
        const safeYDim = yOptions.some((option) => option.idx === stagedDims[1])
            ? stagedDims[1]
            : yOptions[0]?.idx;
        const fixedIndexControls = SHOW_FIXED_INDEX_CONTROLS
            ? renderFixedIndexControls({
                shape,
                displayDims: stagedDims,
                fixedIndices: stagedFixed,
                dimensionLabels,
                playingFixedDim,
                showPlayback: showAutoplayControls,
                canAutoplayHiddenDims,
            })
            : "";

        return `
    <aside class="preview-sidebar">
      <button type="button" class="sidebar-collapse-btn" data-sidebar-toggle="true">
        <svg class="sidebar-collapse-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Dimensions</span>
        <span class="dim-value-inline">${escapeHtml(dimLabel)}</span>
      </button>
      <div class="sidebar-body">
      <div class="dimension-summary">
        <span class="dim-label">Display dims</span>
        <span class="dim-value">${escapeHtml(dimLabel)}</span>
        ${controls.hasPendingChanges
                ? `<span class="dim-pending">Pending: ${escapeHtml(pendingLabel)} (click Set)</span>`
                : ""
            }
      </div>

      <div class="dimension-controls">
        <div class="dim-group">
          <label>Display dim A</label>
          <select data-display-dim-select="true" data-dim-index="0">
            ${xOptions
                .map(
                    (option) => `
                  <option value="${option.idx}" ${stagedDims[0] === option.idx ? "selected" : ""}>
                    ${escapeHtml(getDimDisplayName(option.idx))} (size ${option.size})
                  </option>
                `
                )
                .join("")}
          </select>
        </div>

        <div class="dim-group">
          <label>Display dim B</label>
          <select data-display-dim-select="true" data-dim-index="1">
            ${yOptions
                .map(
                    (option) => `
                  <option value="${option.idx}" ${safeYDim === option.idx ? "selected" : ""}>
                    ${escapeHtml(getDimDisplayName(option.idx))} (size ${option.size})
                  </option>
                `
                )
                .join("")}
          </select>
        </div>

        ${fixedIndexControls}

        <div class="dim-controls-buttons">
          <button type="button" class="dim-set-btn" data-dim-apply="true">Set</button>
          <button type="button" class="dim-reset-btn" data-dim-reset="true">Reset</button>
        </div>
      </div>
      </div>
    </aside>
  `;
    }
    if (typeof renderFixedIndexControls !== "undefined") {
        moduleState.renderFixedIndexControls = renderFixedIndexControls;
        global.renderFixedIndexControls = renderFixedIndexControls;
    }
    if (typeof renderDimensionControls !== "undefined") {
        moduleState.renderDimensionControls = renderDimensionControls;
        global.renderDimensionControls = renderDimensionControls;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/render/dimensionControls");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Builds display and inspect sections, toolbars, and virtual runtime shells with data attributes.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/render/sections.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/render/sections.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.render.sections");

    // Feature flag: when true, the Heatmap tab renders the same histogram panel used by Image.
    const SHOW_HEATMAP_HISTOGRAM = false;

    // Feature flag: when true, hidden-dimension playback controls are rendered inside the Heatmap/Image panel shell.
    const SHOW_HEATMAP_PANEL_PLAYBACK_CONTROLS = false;

    // Renders the correct SVG icon for a toolbar button based on its kind string
    function renderToolIcon(kind) {
        if (kind === "pan") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1v14M1 8h14M8 1 6.3 2.7M8 1l1.7 1.7M8 15l-1.7-1.7M8 15l1.7-1.7M1 8l1.7-1.7M1 8l1.7 1.7M15 8l-1.7-1.7M15 8l-1.7 1.7"></path>
      </svg>
    `;
        }
        if (kind === "zoom-in") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5"></circle>
        <path d="M10.4 10.4 14 14M7 5v4M5 7h4"></path>
      </svg>
    `;
        }
        if (kind === "zoom-click") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5"></circle>
        <path d="M10.4 10.4 14 14M7 5v4M5 7h4"></path>
        <path d="M2.2 2.2 4.2 4.2"></path>
      </svg>
    `;
        }
        if (kind === "plot") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="5.5"></circle>
        <path d="M8 4.6v6.8M4.6 8h6.8"></path>
      </svg>
    `;
        }
        if (kind === "intensity") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4 4h8M8 2v4"></path>
        <path d="M4 12h8"></path>
      </svg>
    `;
        }
        if (kind === "zoom-out") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5"></circle>
        <path d="M10.4 10.4 14 14M5 7h4"></path>
      </svg>
    `;
        }
        if (kind === "reset") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.2 5.4A5 5 0 1 1 3 8M3 3v3h3"></path>
      </svg>
    `;
        }
        if (kind === "fullscreen") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"></path>
      </svg>
    `;
        }
        if (kind === "close") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4 4l8 8M12 4l-8 8"></path>
      </svg>
    `;
        }
        return "";
    }

    function renderIconToolButton(label, dataAttr, kind) {
        return `
    <button
      type="button"
      class="line-tool-btn line-tool-btn-icon"
      ${dataAttr}="true"
      aria-label="${label}"
      title="${label}"
    >
      ${renderToolIcon(kind)}
    </button>
  `;
    }

    function renderVirtualLineShell(state, config, preview) {
        const compareItems = Array.isArray(state.lineCompareItems)
            ? state.lineCompareItems
                .filter(
                    (entry) =>
                        entry &&
                        typeof entry === "object" &&
                        String(entry.path || "") &&
                        String(entry.path || "") !== String(state.selectedPath || "")
                )
                .map((entry) => ({
                    path: String(entry.path || ""),
                    name: String(entry.name || entry.path || ""),
                    dtype: String(entry.dtype || ""),
                    ndim: Number(entry.ndim),
                    shape: Array.isArray(entry.shape) ? entry.shape : [],
                }))
            : [];
        const compareItemsPayload = encodeURIComponent(JSON.stringify(compareItems));
        const baseShape = Array.isArray(preview?.shape) ? preview.shape.join(",") : "";
        const baseNdim = Number.isFinite(Number(preview?.ndim))
            ? Number(preview.ndim)
            : Array.isArray(preview?.shape)
                ? preview.shape.length
                : 0;
        const baseDtype = preview?.dtype || "";
        return `
    <div
      class="line-chart-shell line-chart-shell-full"
      data-line-shell="true"
      data-line-file-key="${escapeHtml(state.selectedFile || "")}"
      data-line-file-etag="${escapeHtml(state.selectedFileEtag || "")}"
      data-line-path="${escapeHtml(state.selectedPath || "/")}"
      data-line-display-dims="${escapeHtml(config.displayDimsParam || "")}"
      data-line-fixed-indices="${escapeHtml(config.fixedIndicesParam || "")}"
      data-line-selection-key="${escapeHtml(config.selectionKey || "")}"
      data-line-total-points="${config.totalPoints}"
      data-line-index="${config.lineIndex ?? ""}"
      data-line-compare-items="${escapeHtml(compareItemsPayload)}"
      data-line-base-shape="${escapeHtml(baseShape)}"
      data-line-base-ndim="${baseNdim}"
      data-line-base-dtype="${escapeHtml(baseDtype)}"
      data-line-notation="${escapeHtml(state.notation || "auto")}"
      data-line-grid="${state.lineGrid ? "1" : "0"}"
      data-line-aspect="${escapeHtml(state.lineAspect || "line")}"
      data-line-quality="${LINE_DEFAULT_QUALITY}"
      data-line-overview-max-points="${LINE_DEFAULT_OVERVIEW_MAX_POINTS}"
      data-line-exact-max-points="${LINE_EXACT_MAX_POINTS}"
    >
      <div class="line-chart-toolbar">
        <div class="line-tool-group">
          ${renderIconToolButton("Hand", "data-line-pan-toggle", "pan")}
          ${renderIconToolButton("Zoom on click", "data-line-zoom-click-toggle", "zoom-click")}
          ${renderIconToolButton("Zoom in", "data-line-zoom-in", "zoom-in")}
          ${renderIconToolButton("Zoom out", "data-line-zoom-out", "zoom-out")}
          ${renderIconToolButton("Reset view", "data-line-reset-view", "reset")}
        </div>
        <div class="line-tool-group">
          <button
            type="button"
            class="line-tool-btn"
            data-line-jump-start="true"
            title="Start: takes you to the start of the plot."
            aria-label="Start: takes you to the start of the plot."
          >Start</button>
          <button
            type="button"
            class="line-tool-btn"
            data-line-step-prev="true"
            title="Prev: switches to the previous selected point."
            aria-label="Prev: switches to the previous selected point."
          >Prev</button>
          <button
            type="button"
            class="line-tool-btn"
            data-line-step-next="true"
            title="Next: switches to the next selected point."
            aria-label="Next: switches to the next selected point."
          >Next</button>
          <button
            type="button"
            class="line-tool-btn"
            data-line-jump-end="true"
            title="End: takes you to the end of the plot."
            aria-label="End: takes you to the end of the plot."
          >End</button>
        </div>
        <div class="line-tool-group">
          <span class="line-zoom-label" data-line-zoom-label="true">100%</span>
          ${renderIconToolButton("Fullscreen", "data-line-fullscreen-toggle", "fullscreen")}
          <span class="line-zoom-label" data-line-range-label="true">Range: --</span>
        </div>
      </div>
      <div class="line-chart-stage">
        <div class="line-chart-canvas" data-line-canvas="true" tabindex="0" role="application" aria-label="Line chart">
          <svg
            viewBox="0 0 ${LINE_SVG_WIDTH} ${LINE_SVG_HEIGHT}"
            width="100%"
            height="100%"
            role="img"
            aria-label="Full line view"
            data-line-svg="true"
          ></svg>
          <div class="line-hover" data-line-hover="true" hidden></div>
        </div>
      </div>
      <div class="line-stats">
        <span data-line-stat-min="true">min: --</span>
        <span data-line-stat-max="true">max: --</span>
        <span data-line-stat-span="true">span: --</span>
      </div>
      <div class="line-legend" data-line-legend="true" hidden></div>
    </div>
  `;
    }

    function renderLineSection(state, preview) {
        const config = resolveLineRuntimeConfig(state, preview);
        const canLoadFull = config.supported && config.totalPoints > 0;
        const isEnabled = state.lineFullEnabled === true && canLoadFull;

        const statusText = !config.supported
            ? config.rowCount === 0
                ? "Line full view requires at least 1 row in the selected Y dimension."
                : "Line full view is unavailable for this dataset."
            : config.totalPoints <= 0
                ? "No values available for line rendering."
                : isEnabled
                    ? "Wheel to zoom. Use Hand to pan."
                    : "Preview mode. Click Load full line.";
        const statusTone = !config.supported || config.totalPoints <= 0 ? "error" : "info";
        const statusClass = `data-status ${statusTone === "error" ? "error" : "info"}`;
        const compareEnabled = state.lineCompareEnabled === true;
        const compareItems = Array.isArray(state.lineCompareItems)
            ? state.lineCompareItems.filter(
                (entry) => String(entry?.path || "") && String(entry?.path || "") !== String(state.selectedPath || "")
            )
            : [];
        const compareStatus =
            state.lineCompareStatus &&
                typeof state.lineCompareStatus === "object" &&
                state.lineCompareStatus.message
                ? state.lineCompareStatus
                : null;
        const compareStatusClass = compareStatus
            ? `line-compare-status ${compareStatus.tone === "error" ? "error" : "info"}`
            : "";
        const canUseCompare = canLoadFull;

        const content = isEnabled
            ? renderVirtualLineShell(state, config, preview)
            : renderLinePreview(preview, {
                lineGrid: state.lineGrid,
                lineAspect: state.lineAspect,
            });

        return `
    <div class="data-section">
      <div class="data-actions">
        <button
          type="button"
          class="data-btn"
          data-line-enable="true"
          ${!canLoadFull || isEnabled ? "disabled" : ""}
        >
          Load full line
        </button>
        <button
          type="button"
          class="data-btn ${compareEnabled ? "active" : ""}"
          data-line-compare-toggle="true"
          ${canUseCompare ? "" : "disabled"}
        >
          Compare ${compareEnabled ? "On" : "Off"}
        </button>
        <button
          type="button"
          class="data-btn"
          data-line-compare-clear="true"
          ${compareItems.length > 0 ? "" : "disabled"}
        >
          Clear compare
        </button>
        <span class="${statusClass}" data-line-status="true">${escapeHtml(statusText)}</span>
      </div>
      <div class="line-compare-panel">
        <div class="line-compare-panel-label">
          ${compareEnabled
                ? "Compare mode enabled. Use dataset row Compare buttons in the tree."
                : "Enable compare mode to select extra datasets from the tree."
            }
        </div>
        <div class="line-compare-chip-list">
          ${compareItems.length > 0
                ? compareItems
                    .map(
                        (entry) => `
                <span class="line-compare-chip">
                  <span class="line-compare-chip-label" title="${escapeHtml(
                            String(entry.path || "")
                        )}">${escapeHtml(String(entry.name || entry.path || ""))}</span>
                  <button
                    type="button"
                    class="line-compare-chip-remove"
                    data-line-compare-remove="${escapeHtml(String(entry.path || ""))}"
                    aria-label="Remove ${escapeHtml(String(entry.name || entry.path || ""))} from compare"
                    title="Remove"
                  >
                    x
                  </button>
                </span>
              `
                    )
                    .join("")
                : `<span class="line-compare-empty">No comparison datasets selected.</span>`
            }
        </div>
        ${compareStatus
                ? `<div class="${compareStatusClass}">
                <span>${escapeHtml(String(compareStatus.message || ""))}</span>
                <button type="button" class="line-compare-status-dismiss" data-line-compare-dismiss="true">Dismiss</button>
              </div>`
                : ""
            }
      </div>
      ${content}
    </div>
  `;
    }

    function renderVirtualMatrixShell(state, config) {
        const totalWidth = MATRIX_INDEX_WIDTH + config.cols * MATRIX_COL_WIDTH;
        const totalHeight = MATRIX_HEADER_HEIGHT + config.rows * MATRIX_ROW_HEIGHT;

        return `
    <div
      class="matrix-table-shell"
      data-matrix-shell="true"
      data-matrix-rows="${config.rows}"
      data-matrix-cols="${config.cols}"
      data-matrix-block-rows="${config.blockRows}"
      data-matrix-block-cols="${config.blockCols}"
      data-matrix-file-key="${escapeHtml(state.selectedFile || "")}"
      data-matrix-file-etag="${escapeHtml(state.selectedFileEtag || "")}"
      data-matrix-path="${escapeHtml(state.selectedPath || "/")}"
      data-matrix-display-dims="${escapeHtml(config.displayDimsParam || "")}"
      data-matrix-fixed-indices="${escapeHtml(config.fixedIndicesParam || "")}"
      data-matrix-selection-key="${escapeHtml(config.selectionKey || "")}"
      data-matrix-notation="${escapeHtml(state.notation || "auto")}"
    >
      <div class="matrix-table" data-matrix-table="true">
        <div class="matrix-spacer" style="width:${totalWidth}px;height:${totalHeight}px;"></div>
        <div class="matrix-header" style="width:${totalWidth}px;height:${MATRIX_HEADER_HEIGHT}px;">
          <div class="matrix-header-corner" style="width:${MATRIX_INDEX_WIDTH}px;"></div>
          <div
            class="matrix-header-cells"
            data-matrix-header-cells="true"
            style="width:${config.cols * MATRIX_COL_WIDTH}px;height:${MATRIX_HEADER_HEIGHT}px;"
          ></div>
        </div>
        <div
          class="matrix-index"
          data-matrix-index="true"
          style="width:${MATRIX_INDEX_WIDTH}px;height:${config.rows * MATRIX_ROW_HEIGHT}px;"
        ></div>
        <div
          class="matrix-cells"
          data-matrix-cells="true"
          style="width:${config.cols * MATRIX_COL_WIDTH}px;height:${config.rows * MATRIX_ROW_HEIGHT}px;"
        ></div>
      </div>
    </div>
  `;
    }

    function renderMatrixSection(state, preview) {
        const config = resolveMatrixRuntimeConfig(state, preview);
        const canLoadFull = config.supported && config.rows > 0 && config.cols > 0;
        const isEnabled = state.matrixFullEnabled === true && canLoadFull;

        const statusText = !config.supported
            ? "Full matrix view requires at least 2 dimensions."
            : config.rows <= 0 || config.cols <= 0
                ? "No values available for the selected display dims."
                : isEnabled
                    ? "Streaming blocks as you scroll."
                    : "Preview mode. Click Load full view.";
        const statusTone = !config.supported || config.rows <= 0 || config.cols <= 0 ? "error" : "info";
        const statusClass = `data-status ${statusTone === "error" ? "error" : "info"}`;

        const content = isEnabled
            ? renderVirtualMatrixShell(state, config)
            : renderTablePreview(preview, state.notation || "auto");

        return `
    <div class="data-section">
      <div class="data-actions">
        <button
          type="button"
          class="data-btn"
          data-matrix-enable="true"
          ${!canLoadFull || isEnabled ? "disabled" : ""}
        >
          Load full view
        </button>
        <span class="${statusClass}" data-matrix-status="true">${escapeHtml(statusText)}</span>
      </div>
      ${content}
    </div>
  `;
    }

    function renderVirtualHeatmapShell(state, config, options = {}) {
        const isImageMode = (state.displayTab || "line") === "image";
        const includeHistogram = options && options.includeHistogram === true;
        const panelPlaybackControls =
            SHOW_HEATMAP_PANEL_PLAYBACK_CONTROLS === true &&
            typeof global.renderFixedIndexControls === "function"
                ? global.renderFixedIndexControls({
                    shape: config.shape,
                    displayDims: config.displayDims,
                    fixedIndices: config.fixedIndices,
                    dimensionLabels: config.dimensionLabels,
                    playingFixedDim: toSafeInteger(state.displayConfig?.playingFixedDim, null),
                    showPlayback: true,
                    canAutoplayHiddenDims: state.heatmapFullEnabled === true,
                    wrapperClassName: "heatmap-panel-controls",
                    containerClassName: "dim-sliders heatmap-panel-dim-sliders",
                    controlClassName: "heatmap-panel-dim-slider",
                    title: "Slice controls",
                    titleClassName: "heatmap-panel-controls-title",
                })
                : "";
        const resolvedColormap =
            isImageMode
                ? "grayscale"
                : state.heatmapColormap || "viridis";
        const histogramPlaceholderMessage = isImageMode
            ? "Histogram updates with the current image slice."
            : "Histogram updates with the current heatmap slice.";
        const histogramPlaceholder =
            typeof global.renderImageHistogramEmptyMarkup === "function"
                ? global.renderImageHistogramEmptyMarkup(histogramPlaceholderMessage, {
                    title: "Histogram",
                    subtitle: isImageMode
                        ? "Displayed grayscale distribution for the current slice"
                        : "Displayed value distribution for the current slice",
                    ariaLabel: isImageMode ? "Image histogram" : "Heatmap histogram",
                })
                : `
        <div class="image-histogram-panel">
          <div class="image-histogram-empty">${escapeHtml(histogramPlaceholderMessage)}</div>
        </div>
      `;
        return `
    <div
      class="line-chart-shell heatmap-chart-shell"
      data-heatmap-shell="true"
      data-heatmap-mode="${isImageMode ? "image" : "heatmap"}"
      data-heatmap-file-key="${escapeHtml(state.selectedFile || "")}"
      data-heatmap-file-etag="${escapeHtml(state.selectedFileEtag || "")}"
      data-heatmap-path="${escapeHtml(state.selectedPath || "/")}"
      data-heatmap-display-dims="${escapeHtml(config.displayDimsParam || "")}"
      data-heatmap-fixed-indices="${escapeHtml(config.fixedIndicesParam || "")}"
      data-heatmap-selection-key="${escapeHtml(config.selectionKey || "")}"
      data-heatmap-colormap="${escapeHtml(resolvedColormap)}"
      data-heatmap-grid="${state.heatmapGrid ? "1" : "0"}"
      data-heatmap-line-notation="${escapeHtml(state.notation || "auto")}"
      data-heatmap-line-grid="${state.lineGrid ? "1" : "0"}"
      data-heatmap-line-aspect="${escapeHtml(state.lineAspect || "line")}"
    >
      <div class="line-chart-toolbar heatmap-chart-toolbar">
        <div class="line-tool-group">
          ${renderIconToolButton("Hand", "data-heatmap-pan-toggle", "pan")}
          ${renderIconToolButton("Plotting", "data-heatmap-plot-toggle", "plot")}
          ${renderIconToolButton("Intensity", "data-heatmap-intensity-toggle", "intensity")}
          ${renderIconToolButton("Zoom in", "data-heatmap-zoom-in", "zoom-in")}
          ${renderIconToolButton("Zoom out", "data-heatmap-zoom-out", "zoom-out")}
          ${renderIconToolButton("Reset view", "data-heatmap-reset-view", "reset")}
        </div>
        <div class="line-tool-group">
          <span class="line-zoom-label" data-heatmap-zoom-label="true">100%</span>
          ${renderIconToolButton("Fullscreen", "data-heatmap-fullscreen-toggle", "fullscreen")}
          <span class="line-zoom-label" data-heatmap-range-label="true">Grid: --</span>
        </div>
      </div>
      ${panelPlaybackControls}
      <div class="line-chart-stage">
        <div
          class="line-chart-canvas heatmap-chart-canvas"
          data-heatmap-canvas="true"
          tabindex="0"
          role="application"
          aria-label="${isImageMode ? "Grayscale image view" : "Heatmap chart"}"
        >
          <canvas class="heatmap-canvas" data-heatmap-surface="true"></canvas>
          ${`
          <div
            class="heatmap-intensity-overlay"
            data-heatmap-intensity-overlay="true"
            hidden
            aria-hidden="true"
          >
            <div
              class="heatmap-intensity-mask heatmap-intensity-mask-upper"
              data-heatmap-intensity-mask="upper"
            ></div>
            <div class="heatmap-intensity-window" data-heatmap-intensity-window="true"></div>
            <div
              class="heatmap-intensity-mask heatmap-intensity-mask-lower"
              data-heatmap-intensity-mask="lower"
            ></div>
            <button
              type="button"
              class="heatmap-intensity-handle heatmap-intensity-handle-max"
              data-heatmap-intensity-handle="max"
              aria-label="Upper intensity bound"
              title="Upper intensity bound"
            ></button>
            <button
              type="button"
              class="heatmap-intensity-handle heatmap-intensity-handle-min"
              data-heatmap-intensity-handle="min"
              aria-label="Lower intensity bound"
              title="Lower intensity bound"
            ></button>
          </div>
          `}
          <div class="line-hover" data-heatmap-hover="true" hidden></div>
        </div>
      </div>
      <div class="heatmap-linked-plot" data-heatmap-linked-plot="true" hidden>
        <div class="heatmap-linked-plot-header">
          <div class="heatmap-linked-plot-title" data-heatmap-linked-title="true">
            Plot mode: click a heatmap cell to inspect row and column profiles.
          </div>
          <div class="heatmap-linked-plot-actions">
            ${renderIconToolButton("Close plot", "data-heatmap-plot-close", "close")}
          </div>
        </div>
        <div class="heatmap-linked-plot-shell-host" data-heatmap-linked-shell-host="true"></div>
      </div>
      ${includeHistogram
                ? `
      <div data-image-histogram-root="true">
        ${histogramPlaceholder}
      </div>
      `
                : ""}
      <div class="line-stats">
        <span data-heatmap-stat-min="true">min: --</span>
        <span data-heatmap-stat-max="true">max: --</span>
        <span data-heatmap-stat-range="true">size: --</span>
      </div>
    </div>
  `;
    }

    function renderHeatmapSection(state, preview) {
        const config = resolveHeatmapRuntimeConfig(state, preview);
        const canLoadHighRes = config.supported && config.rows > 0 && config.cols > 0;
        const isEnabled = state.heatmapFullEnabled === true && canLoadHighRes;
        const resolvedColormap =
            (state.displayTab || "line") === "image"
                ? "grayscale"
                : state.heatmapColormap || "viridis";

        const statusText = !config.supported
            ? "Heatmap high-res view requires at least 2 dimensions."
            : config.rows <= 0 || config.cols <= 0
                ? "No values available for the selected display dims."
                : isEnabled
                    ? "Wheel to zoom. Use Hand to pan."
                    : "Preview mode. Click Load high-res.";
        const statusTone = !config.supported || config.rows <= 0 || config.cols <= 0 ? "error" : "info";
        const statusClass = `data-status ${statusTone === "error" ? "error" : "info"}`;

        const content = isEnabled
            ? renderVirtualHeatmapShell(state, config, { includeHistogram: SHOW_HEATMAP_HISTOGRAM })
            : renderHeatmapPreview(preview, {
                heatmapColormap: resolvedColormap,
                heatmapGrid: state.heatmapGrid,
                includeHistogram: SHOW_HEATMAP_HISTOGRAM,
                histogramTitle: "Histogram",
                histogramSubtitle: "Sampled value distribution for the preview slice",
                histogramAriaLabel: "Preview heatmap histogram",
            });

        return `
    <div class="data-section">
      <div class="data-actions">
        <button
          type="button"
          class="data-btn"
          data-heatmap-enable="true"
          ${!canLoadHighRes || isEnabled ? "disabled" : ""}
        >
          Load high-res
        </button>
        <span class="${statusClass}" data-heatmap-status="true">${escapeHtml(statusText)}</span>
      </div>
      ${content}
    </div>
  `;
    }

    function renderImageSection(state, preview) {
        const config = resolveHeatmapRuntimeConfig(state, preview);
        const canLoadHighRes = config.supported && config.rows > 0 && config.cols > 0;
        const isEnabled = state.heatmapFullEnabled === true && canLoadHighRes;

        const statusText = !config.supported
            ? "Heatmap high-res view requires at least 2 dimensions."
            : config.rows <= 0 || config.cols <= 0
                ? "No values available for the selected display dims."
                : isEnabled
                    ? "Wheel to zoom. Use Hand to pan."
                    : "Preview mode. Click Load high-res.";
        const statusTone = !config.supported || config.rows <= 0 || config.cols <= 0 ? "error" : "info";
        const statusClass = `data-status ${statusTone === "error" ? "error" : "info"}`;

        const content = isEnabled
            ? renderVirtualHeatmapShell(state, config, { includeHistogram: true })
            : renderHeatmapPreview(preview, {
                heatmapColormap: "grayscale",
                heatmapGrid: state.heatmapGrid,
                includeHistogram: true,
                histogramTitle: "Histogram",
                histogramSubtitle: "Sampled grayscale distribution for the preview slice",
                histogramAriaLabel: "Preview image histogram",
            });

        return `
    <div class="data-section">
      <div class="data-actions">
        <button
          type="button"
          class="data-btn"
          data-heatmap-enable="true"
          ${!canLoadHighRes || isEnabled ? "disabled" : ""}
        >
          Load high-res
        </button>
        <span class="${statusClass}" data-heatmap-status="true">${escapeHtml(statusText)}</span>
      </div>
      ${content}
    </div>
  `;
    }

    function renderDisplayContent(state) {
        const hasSelection = state.selectedNodeType === "dataset" && state.selectedPath !== "/";
        const activeTab = state.displayTab || "line";
        const preview = state.preview;

        if (!hasSelection) {
            return `
      <div class="panel-state">
        <div class="state-text">Select a dataset from the tree to view a preview.</div>
      </div>
    `;
        }

        if (state.previewLoading) {
            return `
      <div class="panel-state">
        <div class="loading-spinner"></div>
        <div class="state-text">Loading preview...</div>
      </div>
    `;
        }

        if (state.previewError) {
            return `
      <div class="panel-state error">
        <div class="state-text error-text">${escapeHtml(state.previewError)}</div>
      </div>
    `;
        }

        if (!preview) {
            return `
      <div class="panel-state">
        <div class="state-text">No preview available yet.</div>
      </div>
    `;
        }

        let dataSection = renderMatrixSection(state, preview);
        if (activeTab === "line") {
            dataSection = renderLineSection(state, preview);
        } else if (activeTab === "image") {
            dataSection = renderImageSection(state, preview);
        } else if (activeTab === "heatmap") {
            dataSection = renderHeatmapSection(state, preview);
        }

        const isLineFixedLayout = activeTab === "line" && state.lineFullEnabled === true;

        return `
    <div class="preview-shell ${isLineFixedLayout ? "preview-shell-line-fixed" : ""}">
      <div class="preview-layout ${activeTab === "line" ? "is-line" : ""}">
        ${renderDimensionControls(state, preview)}
        <div class="preview-content">
          ${dataSection}
        </div>
      </div>
    </div>
  `;
    }

    function renderMetadataPanelContent(state, options) {
        // The SPA sidebar and any legacy inspect callers both consume this markup,
        // so keep metadata presentation logic centralized here.
        const opts = options && typeof options === "object" ? options : {};
        const wrapperClass = opts.wrapperClass ? ` ${opts.wrapperClass}` : "";
        const hasSelection =
            state.selectedPath !== "/" ||
            state.metadataLoading ||
            Boolean(state.metadata) ||
            Boolean(state.metadataError);

        if (!hasSelection) {
            return `
      <div class="panel-state${wrapperClass}">
        <div class="state-text">Select an item from the tree to view its metadata.</div>
      </div>
    `;
        }

        if (state.metadataLoading) {
            return `
      <div class="panel-state${wrapperClass}">
        <div class="loading-spinner"></div>
        <div class="state-text">Loading metadata...</div>
      </div>
    `;
        }

        if (state.metadataError) {
            return `
      <div class="panel-state error${wrapperClass}">
        <div class="state-text error-text">${escapeHtml(state.metadataError)}</div>
      </div>
    `;
        }

        const meta = state.metadata;
        if (!meta) {
            return `
      <div class="panel-state${wrapperClass}">
        <div class="state-text">No metadata available.</div>
      </div>
    `;
        }

        const infoRows = [
            ["Name", meta.name || "(root)", false],
            ["Path", meta.path || state.selectedPath, true],
            ["Kind", meta.kind || state.selectedNodeType || "--", false],
        ];

        if (meta.num_children !== undefined) {
            infoRows.push(["Children", meta.num_children, false]);
        }

        if (meta.type) {
            infoRows.push(["Type", formatTypeDescription(meta.type), false]);
        }

        if (meta.shape) {
            infoRows.push(["Shape", `[${formatValue(meta.shape)}]`, true]);
        }

        if (meta.ndim !== undefined) {
            infoRows.push(["Dimensions", `${meta.ndim}D`, false]);
        }

        if (meta.size !== undefined) {
            infoRows.push(["Total Elements", Number(meta.size).toLocaleString(), false]);
        }

        if (meta.dtype) {
            infoRows.push(["DType", meta.dtype, true]);
        }

        if (meta.chunks) {
            infoRows.push(["Chunks", `[${formatValue(meta.chunks)}]`, true]);
        }

        if (meta.compression) {
            infoRows.push([
                "Compression",
                `${meta.compression}${meta.compression_opts ? ` (level ${meta.compression_opts})` : ""}`,
                false,
            ]);
        }

        return `
    <div class="metadata-simple${wrapperClass}">
      ${infoRows
                .map(
                    ([label, value, mono]) => `
            <div class="info-row">
              <span class="info-label">${escapeHtml(String(label))}</span>
              <span class="info-value ${mono ? "mono" : ""}">${escapeHtml(String(value))}</span>
            </div>
          `
                )
                .join("")}
      <div class="info-section-title">Raw JSON</div>
      <pre class="json-view">${escapeHtml(JSON.stringify(meta, null, 2))}</pre>
    </div>
  `;
    }

    function renderInspectContent(state) {
        return renderMetadataPanelContent(state);
    }
    if (typeof renderDisplayContent !== "undefined") {
        moduleState.renderDisplayContent = renderDisplayContent;
        global.renderDisplayContent = renderDisplayContent;
    }
    if (typeof renderMetadataPanelContent !== "undefined") {
        moduleState.renderMetadataPanelContent = renderMetadataPanelContent;
        global.renderMetadataPanelContent = renderMetadataPanelContent;
    }
    if (typeof renderInspectContent !== "undefined") {
        moduleState.renderInspectContent = renderInspectContent;
        global.renderInspectContent = renderInspectContent;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/render/sections");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Assembles the viewer panel wrapper and chooses inspect or display section rendering.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/render.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/render.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.render");

    // Top-level render entry point: the SPA shell now keeps the main area display-only; metadata lives in the sidebar.
    function renderViewerPanel(state) {
        const isLineFixedPage =
            (state.displayTab || "line") === "line" &&
            state.lineFullEnabled === true;

        return `
    <div class="viewer-panel is-display">
      <div class="panel-canvas ${isLineFixedPage ? "panel-canvas-line-fixed" : ""}">
        ${renderDisplayContent(state)}
      </div>
    </div>
  `;
    }
    if (typeof renderViewerPanel !== "undefined") {
        moduleState.renderViewerPanel = renderViewerPanel;
        global.renderViewerPanel = renderViewerPanel;
    }
    if (typeof buildLineSelectionKey !== "undefined") {
        moduleState.buildLineSelectionKey = buildLineSelectionKey;
        global.buildLineSelectionKey = buildLineSelectionKey;
    }
    if (typeof buildMatrixSelectionKey !== "undefined") {
        moduleState.buildMatrixSelectionKey = buildMatrixSelectionKey;
        global.buildMatrixSelectionKey = buildMatrixSelectionKey;
    }
    if (typeof buildMatrixBlockKey !== "undefined") {
        moduleState.buildMatrixBlockKey = buildMatrixBlockKey;
        global.buildMatrixBlockKey = buildMatrixBlockKey;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/render");
    }
})(typeof window !== "undefined" ? window : globalThis);




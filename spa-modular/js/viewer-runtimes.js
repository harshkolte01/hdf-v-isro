// Viewer HTML module: Manages runtime cleanup registries and shared DOM utilities for matrix, line, and heatmap runtimes.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime/common.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime/common.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime.common");

    // Cleanup registries: each runtime adds a cleanup function on init; clearViewerRuntimeBindings calls them all then clears
    const MATRIX_RUNTIME_CLEANUPS = new Set();
    const LINE_RUNTIME_CLEANUPS = new Set();
    const HEATMAP_RUNTIME_CLEANUPS = new Set();
    const IMAGE_HISTOGRAM_RUNTIME_CLEANUPS = new Set();

    // Calls every registered cleanup closure and clears all three sets
    // Invoked before every full re-render to prevent stale event listeners accumulating on recycled DOM nodes
    function clearViewerRuntimeBindings() {
        MATRIX_RUNTIME_CLEANUPS.forEach((cleanup) => {
            try {
                cleanup();
            } catch (_error) {
                // ignore cleanup errors for detached nodes
            }
        });
        MATRIX_RUNTIME_CLEANUPS.clear();

        LINE_RUNTIME_CLEANUPS.forEach((cleanup) => {
            try {
                cleanup();
            } catch (_error) {
                // ignore cleanup errors for detached nodes
            }
        });
        LINE_RUNTIME_CLEANUPS.clear();

        HEATMAP_RUNTIME_CLEANUPS.forEach((cleanup) => {
            try {
                cleanup();
            } catch (_error) {
                // ignore cleanup errors for detached nodes
            }
        });
        HEATMAP_RUNTIME_CLEANUPS.clear();

        IMAGE_HISTOGRAM_RUNTIME_CLEANUPS.forEach((cleanup) => {
            try {
                cleanup();
            } catch (_error) {
                // ignore cleanup errors for detached nodes
            }
        });
        IMAGE_HISTOGRAM_RUNTIME_CLEANUPS.clear();
    }

    // Ensures a DOM pool stays at exactly `count` elements with className; creates or removes nodes as needed
    function ensureNodePool(container, pool, count, className) {
        while (pool.length < count) {
            const node = document.createElement("div");
            node.className = className;
            container.appendChild(node);
            pool.push(node);
        }

        while (pool.length > count) {
            const node = pool.pop();
            if (node) {
                node.remove();
            }
        }
    }

    // Sets text and tone class on a status element inside the matrix shell
    function setMatrixStatus(statusElement, message, tone = "info") {
        if (!statusElement) {
            return;
        }

        statusElement.textContent = message;
        statusElement.classList.remove("error", "info");
        if (tone === "error") {
            statusElement.classList.add("error");
        } else if (tone === "info") {
            statusElement.classList.add("info");
        }
    }
    if (typeof MATRIX_RUNTIME_CLEANUPS !== "undefined") {
        moduleState.MATRIX_RUNTIME_CLEANUPS = MATRIX_RUNTIME_CLEANUPS;
        global.MATRIX_RUNTIME_CLEANUPS = MATRIX_RUNTIME_CLEANUPS;
    }
    if (typeof LINE_RUNTIME_CLEANUPS !== "undefined") {
        moduleState.LINE_RUNTIME_CLEANUPS = LINE_RUNTIME_CLEANUPS;
        global.LINE_RUNTIME_CLEANUPS = LINE_RUNTIME_CLEANUPS;
    }
    if (typeof HEATMAP_RUNTIME_CLEANUPS !== "undefined") {
        moduleState.HEATMAP_RUNTIME_CLEANUPS = HEATMAP_RUNTIME_CLEANUPS;
        global.HEATMAP_RUNTIME_CLEANUPS = HEATMAP_RUNTIME_CLEANUPS;
    }
    if (typeof IMAGE_HISTOGRAM_RUNTIME_CLEANUPS !== "undefined") {
        moduleState.IMAGE_HISTOGRAM_RUNTIME_CLEANUPS = IMAGE_HISTOGRAM_RUNTIME_CLEANUPS;
        global.IMAGE_HISTOGRAM_RUNTIME_CLEANUPS = IMAGE_HISTOGRAM_RUNTIME_CLEANUPS;
    }
    if (typeof clearViewerRuntimeBindings !== "undefined") {
        moduleState.clearViewerRuntimeBindings = clearViewerRuntimeBindings;
        global.clearViewerRuntimeBindings = clearViewerRuntimeBindings;
    }
    if (typeof ensureNodePool !== "undefined") {
        moduleState.ensureNodePool = ensureNodePool;
        global.ensureNodePool = ensureNodePool;
    }
    if (typeof setMatrixStatus !== "undefined") {
        moduleState.setMatrixStatus = setMatrixStatus;
        global.setMatrixStatus = setMatrixStatus;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime/common");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Implements virtualized matrix block streaming, viewport rendering, and matrix CSV export actions.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime/matrixRuntime.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime/matrixRuntime.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime.matrixRuntime");

    // Max concurrent block fetch requests to avoid flooding the backend on large table scrolls
    const MATRIX_MAX_PARALLEL_REQUESTS = 4;

    // Returns a cached block or null; block key encodes all offset/limit parameters
    function getCachedMatrixBlock(runtime, rowOffset, colOffset, rowLimit, colLimit) {
        const blockKey = buildMatrixBlockKey(
            runtime.selectionKey,
            rowOffset,
            colOffset,
            rowLimit,
            colLimit
        );
        return MATRIX_BLOCK_CACHE.get(blockKey) || null;
    }

    // Looks up the cached value for a single cell by computing its block and then indexing into block.data
    function getMatrixCellValue(runtime, row, col) {
        // Compute the block-aligned top-left corner for this cell
        const rowOffset = Math.floor(row / runtime.blockRows) * runtime.blockRows;
        const colOffset = Math.floor(col / runtime.blockCols) * runtime.blockCols;
        const rowLimit = Math.min(runtime.blockRows, runtime.rows - rowOffset);
        const colLimit = Math.min(runtime.blockCols, runtime.cols - colOffset);
        const block = getCachedMatrixBlock(runtime, rowOffset, colOffset, rowLimit, colLimit);

        if (!block || !Array.isArray(block.data)) {
            return null;
        }

        const resolvedRowOffset = toSafeInteger(block.row_offset, rowOffset);
        const resolvedColOffset = toSafeInteger(block.col_offset, colOffset);
        const localRow = row - resolvedRowOffset;
        const localCol = col - resolvedColOffset;
        return block.data?.[localRow]?.[localCol] ?? null;
    }

    // Bootstraps a single matrix runtime from data-* attributes baked into the shell HTML at render time
    function initializeMatrixRuntime(shell) {
        // Guard: skip if this shell has already been wired (prevents double-init on repeat renders)
        if (!shell || shell.dataset.matrixBound === "true") {
            return;
        }

        const table = shell.querySelector("[data-matrix-table]");
        const headerCellsLayer = shell.querySelector("[data-matrix-header-cells]");
        const indexLayer = shell.querySelector("[data-matrix-index]");
        const cellsLayer = shell.querySelector("[data-matrix-cells]");
        const statusElement =
            shell.closest(".data-section")?.querySelector("[data-matrix-status]") || null;

        if (!table || !headerCellsLayer || !indexLayer || !cellsLayer) {
            return;
        }

        const rows = Math.max(0, toSafeInteger(shell.dataset.matrixRows, 0));
        const cols = Math.max(0, toSafeInteger(shell.dataset.matrixCols, 0));
        const blockRows = Math.max(1, toSafeInteger(shell.dataset.matrixBlockRows, 160));
        const blockCols = Math.max(1, toSafeInteger(shell.dataset.matrixBlockCols, 40));
        const fileKey = shell.dataset.matrixFileKey || "";
        const fileEtag = shell.dataset.matrixFileEtag || "";
        const path = shell.dataset.matrixPath || "/";
        const displayDims = shell.dataset.matrixDisplayDims || "";
        const fixedIndices = shell.dataset.matrixFixedIndices || "";
        const selectionKey =
            shell.dataset.matrixSelectionKey ||
            buildMatrixSelectionKey(fileKey, path, displayDims, fixedIndices);
        const notation = shell.dataset.matrixNotation || "auto";

        if (!rows || !cols || !fileKey) {
            setMatrixStatus(statusElement, "No matrix data available.", "error");
            return;
        }

        shell.dataset.matrixBound = "true";

        const runtime = {
            rows,
            cols,
            blockRows,
            blockCols,
            fileKey,
            fileEtag,
            path,
            displayDims,
            fixedIndices,
            selectionKey,
            notation,
            pendingCount: 0,
            activeRequestCount: 0,
            loadedBlocks: 0,
            destroyed: false,
            rafToken: null,
            blockQueue: [],
            queuedBlockKeys: new Set(),
            activeCancelKeys: new Set(),
            headerPool: [],
            rowIndexPool: [],
            cellPool: [],
        };

        const visible = {
            rowStart: 0,
            rowEnd: 0,
            colStart: 0,
            colEnd: 0,
        };

        const clampIndex = (value, min, max) => Math.max(min, Math.min(max, value));

        function queueRender() {
            if (runtime.destroyed || runtime.rafToken !== null) {
                return;
            }

            // Render work is collapsed to one frame to keep scroll smooth.
            runtime.rafToken = requestAnimationFrame(() => {
                runtime.rafToken = null;
                renderViewport();
            });
        }

        function updateStatusFromRuntime() {
            if (runtime.pendingCount > 0 || runtime.blockQueue.length > 0) {
                setMatrixStatus(statusElement, "Loading blocks...", "info");
                return;
            }

            setMatrixStatus(
                statusElement,
                runtime.loadedBlocks > 0
                    ? `Loaded ${runtime.loadedBlocks} block${runtime.loadedBlocks > 1 ? "s" : ""}.`
                    : "Scroll to stream blocks.",
                "info"
            );
        }

        function enqueueBlock(rowOffset, colOffset, rowLimit, colLimit) {
            const safeRowLimit = Math.min(rowLimit, Math.max(0, runtime.rows - rowOffset));
            const safeColLimit = Math.min(colLimit, Math.max(0, runtime.cols - colOffset));

            if (safeRowLimit <= 0 || safeColLimit <= 0) {
                return;
            }

            const blockKey = buildMatrixBlockKey(
                runtime.selectionKey,
                rowOffset,
                colOffset,
                safeRowLimit,
                safeColLimit
            );

            if (
                MATRIX_BLOCK_CACHE.get(blockKey) ||
                MATRIX_PENDING.has(blockKey) ||
                runtime.queuedBlockKeys.has(blockKey)
            ) {
                return;
            }

            runtime.queuedBlockKeys.add(blockKey);
            runtime.blockQueue.push({
                blockKey,
                rowOffset,
                colOffset,
                rowLimit: safeRowLimit,
                colLimit: safeColLimit,
            });
        }

        async function requestBlock(task) {
            const blockKey = task.blockKey;
            MATRIX_PENDING.add(blockKey);
            runtime.pendingCount += 1;
            runtime.activeRequestCount += 1;
            updateStatusFromRuntime();

            const { rowOffset, colOffset, rowLimit: safeRowLimit, colLimit: safeColLimit } = task;
            const cancelKey = `matrix:${runtime.selectionKey}:${rowOffset}:${colOffset}:${safeRowLimit}:${safeColLimit}`;
            runtime.activeCancelKeys.add(cancelKey);

            const params = {
                mode: "matrix",
                row_offset: rowOffset,
                row_limit: safeRowLimit,
                col_offset: colOffset,
                col_limit: safeColLimit,
            };

            if (runtime.displayDims) {
                params.display_dims = runtime.displayDims;
            }

            if (runtime.fixedIndices) {
                params.fixed_indices = runtime.fixedIndices;
            }

            if (runtime.fileEtag) {
                params.etag = runtime.fileEtag;
            }

            try {
                const response = await getFileData(runtime.fileKey, runtime.path, params, {
                    cancelPrevious: false,
                    cancelKey,
                });

                MATRIX_BLOCK_CACHE.set(blockKey, response);
                runtime.loadedBlocks += 1;

                if (!runtime.destroyed) {
                    queueRender();
                }
            } catch (error) {
                if (!runtime.destroyed && !(error?.isAbort || error?.code === "ABORTED")) {
                    setMatrixStatus(
                        statusElement,
                        error?.message || "Failed to load matrix block.",
                        "error"
                    );
                }
            } finally {
                MATRIX_PENDING.delete(blockKey);
                runtime.pendingCount = Math.max(0, runtime.pendingCount - 1);
                runtime.activeRequestCount = Math.max(0, runtime.activeRequestCount - 1);
                runtime.activeCancelKeys.delete(cancelKey);
                if (!runtime.destroyed) {
                    updateStatusFromRuntime();
                    pumpBlockQueue();
                }
            }
        }

        function pumpBlockQueue() {
            if (runtime.destroyed) {
                return;
            }

            while (
                runtime.activeRequestCount < MATRIX_MAX_PARALLEL_REQUESTS &&
                runtime.blockQueue.length > 0
            ) {
                const nextTask = runtime.blockQueue.shift();
                if (!nextTask) {
                    continue;
                }
                runtime.queuedBlockKeys.delete(nextTask.blockKey);
                void requestBlock(nextTask);
            }
        }

        function requestVisibleBlocks() {
            // Rebuild requested block set from current viewport + overscan region.
            runtime.blockQueue = [];
            runtime.queuedBlockKeys.clear();

            const blockRowStart = Math.floor(visible.rowStart / runtime.blockRows) * runtime.blockRows;
            const blockRowEnd = Math.floor(visible.rowEnd / runtime.blockRows) * runtime.blockRows;
            const blockColStart = Math.floor(visible.colStart / runtime.blockCols) * runtime.blockCols;
            const blockColEnd = Math.floor(visible.colEnd / runtime.blockCols) * runtime.blockCols;

            for (let row = blockRowStart; row <= blockRowEnd; row += runtime.blockRows) {
                const rowLimit = Math.min(runtime.blockRows, runtime.rows - row);
                for (let col = blockColStart; col <= blockColEnd; col += runtime.blockCols) {
                    const colLimit = Math.min(runtime.blockCols, runtime.cols - col);
                    enqueueBlock(row, col, rowLimit, colLimit);
                }
            }

            updateStatusFromRuntime();
            pumpBlockQueue();
        }

        function renderViewport() {
            if (runtime.destroyed) {
                return;
            }

            const viewportWidth = table.clientWidth;
            const viewportHeight = table.clientHeight;
            const scrollTop = table.scrollTop;
            const scrollLeft = table.scrollLeft;

            const contentScrollTop = Math.max(0, scrollTop - MATRIX_HEADER_HEIGHT);
            const contentScrollLeft = Math.max(0, scrollLeft - MATRIX_INDEX_WIDTH);
            const contentHeight = Math.max(0, viewportHeight - MATRIX_HEADER_HEIGHT);
            const contentWidth = Math.max(0, viewportWidth - MATRIX_INDEX_WIDTH);

            // Visible window in matrix cell coordinates (with overscan so fast scroll has preloaded cells).
            visible.rowStart = Math.max(
                0,
                Math.floor(contentScrollTop / MATRIX_ROW_HEIGHT) - MATRIX_OVERSCAN
            );
            visible.rowEnd = Math.min(
                runtime.rows - 1,
                Math.floor((contentScrollTop + contentHeight) / MATRIX_ROW_HEIGHT) + MATRIX_OVERSCAN
            );
            visible.colStart = Math.max(
                0,
                Math.floor(contentScrollLeft / MATRIX_COL_WIDTH) - MATRIX_OVERSCAN
            );
            visible.colEnd = Math.min(
                runtime.cols - 1,
                Math.floor((contentScrollLeft + contentWidth) / MATRIX_COL_WIDTH) + MATRIX_OVERSCAN
            );

            requestVisibleBlocks();

            const visibleCols = [];
            for (let col = visible.colStart; col <= visible.colEnd; col += 1) {
                visibleCols.push(col);
            }

            const visibleRows = [];
            for (let row = visible.rowStart; row <= visible.rowEnd; row += 1) {
                visibleRows.push(row);
            }

            ensureNodePool(
                headerCellsLayer,
                runtime.headerPool,
                visibleCols.length,
                "matrix-cell matrix-cell-header"
            );
            visibleCols.forEach((col, index) => {
                const node = runtime.headerPool[index];
                node.style.left = `${col * MATRIX_COL_WIDTH}px`;
                node.style.width = `${MATRIX_COL_WIDTH}px`;
                node.style.height = `${MATRIX_HEADER_HEIGHT}px`;
                node.textContent = String(col);
            });

            indexLayer.style.transform = "";
            ensureNodePool(
                indexLayer,
                runtime.rowIndexPool,
                visibleRows.length,
                "matrix-cell matrix-cell-index"
            );
            visibleRows.forEach((row, index) => {
                const node = runtime.rowIndexPool[index];
                node.style.left = "0px";
                node.style.top = `${row * MATRIX_ROW_HEIGHT}px`;
                node.style.width = `${MATRIX_INDEX_WIDTH}px`;
                node.style.height = `${MATRIX_ROW_HEIGHT}px`;
                node.textContent = String(row);
            });

            const totalCellCount = visibleRows.length * visibleCols.length;
            ensureNodePool(cellsLayer, runtime.cellPool, totalCellCount, "matrix-cell");

            let cursor = 0;
            visibleRows.forEach((row) => {
                visibleCols.forEach((col) => {
                    const node = runtime.cellPool[cursor];
                    cursor += 1;

                    node.style.top = `${row * MATRIX_ROW_HEIGHT}px`;
                    node.style.left = `${col * MATRIX_COL_WIDTH}px`;
                    node.style.width = `${MATRIX_COL_WIDTH}px`;
                    node.style.height = `${MATRIX_ROW_HEIGHT}px`;

                    const value = getMatrixCellValue(runtime, row, col);
                    node.textContent = value === null ? "--" : formatCell(value, runtime.notation);
                });
            });
        }

        function getViewportBounds() {
            if (runtime.rows <= 0 || runtime.cols <= 0) {
                return null;
            }

            const viewportWidth = table.clientWidth;
            const viewportHeight = table.clientHeight;
            const scrollTop = table.scrollTop;
            const scrollLeft = table.scrollLeft;

            const contentScrollTop = Math.max(0, scrollTop - MATRIX_HEADER_HEIGHT);
            const contentScrollLeft = Math.max(0, scrollLeft - MATRIX_INDEX_WIDTH);
            const contentHeight = Math.max(0, viewportHeight - MATRIX_HEADER_HEIGHT);
            const contentWidth = Math.max(0, viewportWidth - MATRIX_INDEX_WIDTH);

            const rowStart = clampIndex(Math.floor(contentScrollTop / MATRIX_ROW_HEIGHT), 0, runtime.rows - 1);
            const rowEnd = clampIndex(
                Math.floor((contentScrollTop + Math.max(1, contentHeight) - 1) / MATRIX_ROW_HEIGHT),
                rowStart,
                runtime.rows - 1
            );
            const colStart = clampIndex(Math.floor(contentScrollLeft / MATRIX_COL_WIDTH), 0, runtime.cols - 1);
            const colEnd = clampIndex(
                Math.floor((contentScrollLeft + Math.max(1, contentWidth) - 1) / MATRIX_COL_WIDTH),
                colStart,
                runtime.cols - 1
            );

            return {
                rowStart,
                rowEnd,
                colStart,
                colEnd,
            };
        }

        async function ensureBlocksForRange(rowStart, rowEnd, colStart, colEnd) {
            if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd) || !Number.isFinite(colStart) || !Number.isFinite(colEnd)) {
                return;
            }

            // Export path fetches missing blocks directly so CSV contains fully resolved viewport values.
            const requests = [];
            const paramsBase = {
                mode: "matrix",
            };
            if (runtime.displayDims) {
                paramsBase.display_dims = runtime.displayDims;
            }
            if (runtime.fixedIndices) {
                paramsBase.fixed_indices = runtime.fixedIndices;
            }
            if (runtime.fileEtag) {
                paramsBase.etag = runtime.fileEtag;
            }

            const startRowBlock = Math.floor(rowStart / runtime.blockRows) * runtime.blockRows;
            const endRowBlock = Math.floor(rowEnd / runtime.blockRows) * runtime.blockRows;
            const startColBlock = Math.floor(colStart / runtime.blockCols) * runtime.blockCols;
            const endColBlock = Math.floor(colEnd / runtime.blockCols) * runtime.blockCols;

            for (let rowOffset = startRowBlock; rowOffset <= endRowBlock; rowOffset += runtime.blockRows) {
                const rowLimit = Math.min(runtime.blockRows, runtime.rows - rowOffset);
                for (let colOffset = startColBlock; colOffset <= endColBlock; colOffset += runtime.blockCols) {
                    const colLimit = Math.min(runtime.blockCols, runtime.cols - colOffset);
                    if (rowLimit <= 0 || colLimit <= 0) {
                        continue;
                    }

                    const blockKey = buildMatrixBlockKey(
                        runtime.selectionKey,
                        rowOffset,
                        colOffset,
                        rowLimit,
                        colLimit
                    );

                    if (MATRIX_BLOCK_CACHE.get(blockKey)) {
                        continue;
                    }

                    const params = {
                        ...paramsBase,
                        row_offset: rowOffset,
                        row_limit: rowLimit,
                        col_offset: colOffset,
                        col_limit: colLimit,
                    };
                    const cancelKey = `matrix-export:${runtime.selectionKey}:${rowOffset}:${colOffset}:${rowLimit}:${colLimit}`;
                    requests.push(
                        getFileData(runtime.fileKey, runtime.path, params, {
                            cancelPrevious: false,
                            cancelKey,
                        }).then((payload) => {
                            MATRIX_BLOCK_CACHE.set(blockKey, payload);
                        })
                    );
                }
            }

            if (requests.length > 0) {
                await Promise.all(requests);
            }
        }

        async function exportCsvDisplayed() {
            if (runtime.destroyed) {
                throw new Error("Matrix runtime is no longer active.");
            }

            const bounds = getViewportBounds();
            if (!bounds) {
                throw new Error("No matrix viewport available for export.");
            }

            setMatrixStatus(statusElement, "Preparing displayed matrix CSV...", "info");
            await ensureBlocksForRange(bounds.rowStart, bounds.rowEnd, bounds.colStart, bounds.colEnd);

            const header = ["row\\col"];
            for (let col = bounds.colStart; col <= bounds.colEnd; col += 1) {
                header.push(col);
            }

            const rows = [toCsvRow(header)];
            for (let row = bounds.rowStart; row <= bounds.rowEnd; row += 1) {
                const values = [row];
                for (let col = bounds.colStart; col <= bounds.colEnd; col += 1) {
                    const value = getMatrixCellValue(runtime, row, col);
                    values.push(value === null ? "" : value);
                }
                rows.push(toCsvRow(values));
            }

            const filename = buildExportFilename({
                fileKey: runtime.fileKey,
                path: runtime.path,
                tab: "matrix",
                scope: "displayed",
                extension: "csv",
            });
            const blob = createCsvBlob(rows, true);
            triggerBlobDownload(blob, filename);
            setMatrixStatus(
                statusElement,
                `Exported displayed matrix CSV (${(bounds.rowEnd - bounds.rowStart + 1).toLocaleString()} x ${(
                    bounds.colEnd - bounds.colStart + 1
                ).toLocaleString()}).`,
                "info"
            );
        }

        async function exportCsvFull() {
            if (runtime.destroyed) {
                throw new Error("Matrix runtime is no longer active.");
            }

            const query = {
                path: runtime.path,
                mode: "matrix",
            };
            if (runtime.displayDims) {
                query.display_dims = runtime.displayDims;
            }
            if (runtime.fixedIndices) {
                query.fixed_indices = runtime.fixedIndices;
            }
            if (runtime.fileEtag) {
                query.etag = runtime.fileEtag;
            }

            const url = buildCsvExportUrl(runtime.fileKey, query);
            triggerUrlDownload(url);
            setMatrixStatus(statusElement, "Full matrix CSV download started.", "info");
        }

        shell.__exportApi = {
            exportCsvDisplayed,
            exportCsvFull,
        };

        const onScroll = () => {
            queueRender();
        };
        table.addEventListener("scroll", onScroll, { passive: true });

        let resizeObserver = null;
        const onWindowResize = () => {
            queueRender();
        };

        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(onWindowResize);
            resizeObserver.observe(table);
        } else {
            window.addEventListener("resize", onWindowResize);
        }

        updateStatusFromRuntime();
        queueRender();

        const cleanup = () => {
            runtime.destroyed = true;
            runtime.blockQueue = [];
            runtime.queuedBlockKeys.clear();
            runtime.activeCancelKeys.forEach((cancelKey) => {
                cancelPendingRequest(cancelKey, "matrix-runtime-disposed");
            });
            runtime.activeCancelKeys.clear();
            table.removeEventListener("scroll", onScroll);
            if (resizeObserver) {
                resizeObserver.disconnect();
            } else {
                window.removeEventListener("resize", onWindowResize);
            }
            if (runtime.rafToken !== null) {
                cancelAnimationFrame(runtime.rafToken);
                runtime.rafToken = null;
            }
            if (shell.__exportApi) {
                delete shell.__exportApi;
            }
        };

        MATRIX_RUNTIME_CLEANUPS.add(cleanup);
    }
    if (typeof initializeMatrixRuntime !== "undefined") {
        moduleState.initializeMatrixRuntime = initializeMatrixRuntime;
        global.initializeMatrixRuntime = initializeMatrixRuntime;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime/matrixRuntime");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Implements interactive line runtime with zoom/pan/click-zoom, compare overlays, and export support.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime/lineRuntime.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime/lineRuntime.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime.lineRuntime");

    // How long in ms a fullscreen restore target stays alive after the view exits fullscreen mode
    const LINE_FULLSCREEN_RESTORE_TTL_MS = 1200;
    // Fixed stroke colors for compare overlay series (index 0 = primary, 1-4 = additional series)
    const LINE_COMPARE_COLORS = ["#DC2626", "#16A34A", "#D97706", "#0EA5E9", "#334155"];
    let lineFullscreenRestore = null;

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

    // Parses a comma-separated shape string from a data-* attribute back into an integer array
    function parseShapeParam(value) {
        return String(value || "")
            .split(",")
            .map((entry) => Number(entry))
            .filter((entry) => Number.isFinite(entry) && entry >= 0);
    }

    // Decodes and validates the JSON-encoded compare items payload stored in a data-* attribute
    function parseCompareItemsPayload(rawValue, currentPath) {
        if (!rawValue) {
            return [];
        }

        try {
            const decoded = decodeURIComponent(String(rawValue));
            const parsed = JSON.parse(decoded);
            if (!Array.isArray(parsed)) {
                return [];
            }

            const seen = new Set();
            const normalized = [];
            parsed.forEach((entry) => {
                if (!entry || typeof entry !== "object") {
                    return;
                }

                const path = String(entry.path || "").trim();
                if (!path || path === currentPath || seen.has(path)) {
                    return;
                }

                seen.add(path);
                normalized.push({
                    path,
                    name: String(entry.name || path),
                    dtype: String(entry.dtype || ""),
                    ndim: Number(entry.ndim),
                    shape: Array.isArray(entry.shape)
                        ? entry.shape
                            .map((value) => Number(value))
                            .filter((value) => Number.isFinite(value) && value >= 0)
                        : [],
                });
            });

            return normalized;
        } catch (_error) {
            return [];
        }
    }

    function rememberLineFullscreen(selectionKey) {
        if (!selectionKey) {
            lineFullscreenRestore = null;
            return;
        }
        lineFullscreenRestore = {
            key: selectionKey,
            expiresAt: Date.now() + LINE_FULLSCREEN_RESTORE_TTL_MS,
        };
    }

    function consumeLineFullscreenRestore(selectionKey) {
        if (!lineFullscreenRestore || !selectionKey) {
            return false;
        }
        const { key, expiresAt } = lineFullscreenRestore;
        lineFullscreenRestore = null;
        return key === selectionKey && Date.now() <= expiresAt;
    }
    function initializeLineRuntime(shell) {
        if (!shell) {
            return null;
        }
        if (shell.dataset.lineBound === "true") {
            return typeof shell.__lineRuntimeCleanup === "function"
                ? shell.__lineRuntimeCleanup
                : null;
        }

        const canvas = shell.querySelector("[data-line-canvas]");
        const svg = shell.querySelector("[data-line-svg]");
        const rangeLabel = shell.querySelector("[data-line-range-label]");
        const zoomLabel = shell.querySelector("[data-line-zoom-label]");
        const hoverElement = shell.querySelector("[data-line-hover]");
        const minStat = shell.querySelector("[data-line-stat-min]");
        const maxStat = shell.querySelector("[data-line-stat-max]");
        const spanStat = shell.querySelector("[data-line-stat-span]");
        const panToggleButton = shell.querySelector("[data-line-pan-toggle]");
        const zoomClickToggleButton = shell.querySelector("[data-line-zoom-click-toggle]");
        const zoomInButton = shell.querySelector("[data-line-zoom-in]");
        const zoomOutButton = shell.querySelector("[data-line-zoom-out]");
        const resetButton = shell.querySelector("[data-line-reset-view]");
        const jumpStartButton = shell.querySelector("[data-line-jump-start]");
        const stepPrevButton = shell.querySelector("[data-line-step-prev]");
        const stepNextButton = shell.querySelector("[data-line-step-next]");
        const jumpEndButton = shell.querySelector("[data-line-jump-end]");
        const qualitySelect = shell.querySelector("[data-line-quality-select]");
        const windowSelect = shell.querySelector("[data-line-window-select]");
        const jumpInput = shell.querySelector("[data-line-jump-input]");
        const jumpToIndexButton = shell.querySelector("[data-line-jump-to-index]");
        const fullscreenButton = shell.querySelector("[data-line-fullscreen-toggle]");
        const legendElement = shell.querySelector("[data-line-legend]");
        const statusElement =
            shell.closest(".data-section")?.querySelector("[data-line-status]") || null;

        if (!canvas || !svg) {
            return null;
        }

        const fileKey = shell.dataset.lineFileKey || "";
        const fileEtag = shell.dataset.lineFileEtag || "";
        const path = shell.dataset.linePath || "/";
        const displayDims = shell.dataset.lineDisplayDims || "";
        const fixedIndices = shell.dataset.lineFixedIndices || "";
        const notation = shell.dataset.lineNotation || "auto";
        const lineGrid = shell.dataset.lineGrid !== "0";
        const lineAspect = shell.dataset.lineAspect || "line";
        const initialQuality = normalizeLineQuality(shell.dataset.lineQuality);
        const overviewMaxPoints = Math.max(
            1,
            toSafeInteger(shell.dataset.lineOverviewMaxPoints, LINE_DEFAULT_OVERVIEW_MAX_POINTS)
        );
        const exactMaxPoints = Math.max(
            1,
            toSafeInteger(shell.dataset.lineExactMaxPoints, LINE_EXACT_MAX_POINTS)
        );
        const selectionKey =
            shell.dataset.lineSelectionKey ||
            buildLineSelectionKey(fileKey, path, displayDims, fixedIndices, null);
        const totalPoints = Math.max(0, toSafeInteger(shell.dataset.lineTotalPoints, 0));
        const parsedLineIndex = toSafeInteger(shell.dataset.lineIndex, null);
        const lineIndex = Number.isFinite(parsedLineIndex) ? parsedLineIndex : null;
        const parsedLineDim = (shell.dataset.lineDim || "").trim().toLowerCase();
        const lineDim =
            lineIndex === null ? null : parsedLineDim === "col" ? "col" : "row";
        const parsedSelectedPoint = toSafeInteger(shell.dataset.lineSelectedPoint, null);
        const selectedPointX = Number.isFinite(parsedSelectedPoint) ? parsedSelectedPoint : null;
        const compareItems = parseCompareItemsPayload(shell.dataset.lineCompareItems || "", path);
        const baseShape = parseShapeParam(shell.dataset.lineBaseShape || "");
        const baseNdim = Math.max(
            0,
            toSafeInteger(shell.dataset.lineBaseNdim, baseShape.length || 0)
        );
        const baseDtype = String(shell.dataset.lineBaseDtype || "").trim();
        const inlineHeatmapLinked = shell.classList.contains("heatmap-inline-line-shell");

        if (!fileKey || totalPoints <= 0) {
            setMatrixStatus(statusElement, "No line data available.", "error");
            return null;
        }

        shell.dataset.lineBound = "true";

        const runtime = {
            fileKey,
            fileEtag,
            path,
            displayDims,
            fixedIndices,
            notation,
            lineGrid,
            lineAspect,
            selectionKey,
            totalPoints,
            lineIndex,
            lineDim,
            selectedPointX,
            qualityRequested: initialQuality,
            qualityApplied: initialQuality,
            overviewMaxPoints,
            exactMaxPoints,
            requestedPoints: 0,
            returnedPoints: 0,
            lineStep: 1,
            minSpan: Math.max(1, Math.min(LINE_MIN_VIEW_SPAN, totalPoints)),
            viewStart: 0,
            viewSpan: totalPoints,
            fetchTimer: null,
            requestSeq: 0,
            destroyed: false,
            panEnabled: false,
            zoomClickEnabled: false,
            isPanning: false,
            panPointerId: null,
            panStartX: 0,
            panStartViewStart: 0,
            clickZoomPointerId: null,
            clickZoomStartX: 0,
            clickZoomStartY: 0,
            clickZoomMoved: false,
            pendingZoomFocusX: null,
            points: [],
            compareSeries: [],
            renderedSeries: [],
            compareItems,
            failedCompareTargets: [],
            baseShape,
            baseNdim,
            baseDtype,
            frame: null,
            hoverDot: null,
            zoomFocusX: null,
            fullscreenActive: false,
        };

        if (consumeLineFullscreenRestore(selectionKey)) {
            runtime.fullscreenActive = true;
        }

        function getMaxSpanForQuality() {
            if (runtime.qualityRequested === "exact") {
                return Math.max(1, Math.min(runtime.totalPoints, runtime.exactMaxPoints));
            }
            return runtime.totalPoints;
        }

        function clampViewport(start, span) {
            const maxSpan = getMaxSpanForQuality();
            const minSpan = Math.min(runtime.minSpan, maxSpan);
            const safeSpan = clamp(toSafeInteger(span, maxSpan), minSpan, maxSpan);
            const maxStart = Math.max(0, runtime.totalPoints - safeSpan);
            const safeStart = clamp(toSafeInteger(start, 0), 0, maxStart);
            return { start: safeStart, span: safeSpan };
        }

        function persistViewState() {
            LINE_VIEW_CACHE.set(runtime.selectionKey, {
                start: runtime.viewStart,
                span: runtime.viewSpan,
                panEnabled: runtime.panEnabled === true,
                zoomClickEnabled: runtime.zoomClickEnabled === true,
                qualityRequested: runtime.qualityRequested,
                zoomFocusX: Number.isFinite(runtime.zoomFocusX) ? runtime.zoomFocusX : null,
            });
        }

        const cachedView = LINE_VIEW_CACHE.get(runtime.selectionKey);
        if (cachedView && typeof cachedView === "object") {
            runtime.qualityRequested = normalizeLineQuality(
                cachedView.qualityRequested || runtime.qualityRequested
            );
            const restored = clampViewport(cachedView.start, cachedView.span);
            runtime.viewStart = restored.start;
            runtime.viewSpan = restored.span;
            runtime.panEnabled = cachedView.panEnabled === true;
            runtime.zoomClickEnabled = cachedView.zoomClickEnabled === true;
            runtime.zoomFocusX = Number.isFinite(cachedView.zoomFocusX) ? cachedView.zoomFocusX : null;
            if (runtime.panEnabled && runtime.zoomClickEnabled) {
                runtime.zoomClickEnabled = false;
            }
        }

        function getZoomPercent() {
            if (runtime.totalPoints <= 0) {
                return 100;
            }

            const ratio = runtime.totalPoints / Math.max(1, runtime.viewSpan);
            return Math.max(100, Math.round(ratio * 100));
        }

        function updateZoomLabel() {
            if (!zoomLabel) {
                return;
            }

            zoomLabel.textContent = `${getZoomPercent()}%`;
        }

        function updateRangeLabel(pointCount = null) {
            if (!rangeLabel) {
                return;
            }

            const rangeEnd = Math.max(runtime.viewStart, runtime.viewStart + runtime.viewSpan - 1);
            const baseText = `Range: ${runtime.viewStart.toLocaleString()} - ${rangeEnd.toLocaleString()} of ${Math.max(
                0,
                runtime.totalPoints - 1
            ).toLocaleString()}`;
            rangeLabel.textContent =
                typeof pointCount === "number" && pointCount >= 0
                    ? `${baseText} | ${pointCount.toLocaleString()} points`
                    : baseText;
        }

        function syncQualityControl() {
            if (!qualitySelect) {
                return;
            }
            if (document.activeElement === qualitySelect) {
                return;
            }
            qualitySelect.value = runtime.qualityRequested;
        }

        function syncWindowControl() {
            if (!windowSelect) {
                return;
            }

            const exactMode = runtime.qualityRequested === "exact";
            Array.from(windowSelect.options).forEach((option) => {
                const value = Math.max(1, toSafeInteger(option.value, 1));
                option.disabled = exactMode && value > runtime.exactMaxPoints;
            });

            if (document.activeElement === windowSelect) {
                return;
            }

            const selected = String(runtime.viewSpan);
            const hasExact = Array.from(windowSelect.options).some((option) => option.value === selected);
            if (hasExact) {
                windowSelect.value = selected;
            }
        }

        function syncJumpInput() {
            if (!jumpInput) {
                return;
            }
            jumpInput.min = "0";
            jumpInput.max = String(Math.max(0, runtime.totalPoints - 1));
            if (document.activeElement === jumpInput) {
                return;
            }

            const current = toSafeInteger(jumpInput.value, null);
            if (current === null) {
                return;
            }

            const clamped = clamp(current, 0, Math.max(0, runtime.totalPoints - 1));
            if (clamped !== current) {
                jumpInput.value = String(clamped);
            }
        }

        function hideHover() {
            if (hoverElement) {
                hoverElement.hidden = true;
            }

            if (runtime.hoverDot) {
                runtime.hoverDot.setAttribute("cx", "-9999");
                runtime.hoverDot.setAttribute("cy", "-9999");
                runtime.hoverDot.style.display = "none";
            }
        }

        let inlineScrollSnapshot = null;
        let inlineScrollSnapshotCapturedAt = 0;

        function isInlineControlTarget(event) {
            if (!inlineHeatmapLinked || !event?.target || typeof event.target.closest !== "function") {
                return false;
            }
            const control = event.target.closest(
                "button.line-tool-btn, select.line-tool-select, input.line-tool-input"
            );
            return Boolean(control && shell.contains(control));
        }

        function collectScrollableAncestors(node) {
            if (typeof window === "undefined" || !node) {
                return [];
            }
            const entries = [];
            let current = node.parentElement;
            while (current) {
                const style = window.getComputedStyle(current);
                const overflowY = (style.overflowY || "").toLowerCase();
                const overflowX = (style.overflowX || "").toLowerCase();
                const canScrollY =
                    (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
                    current.scrollHeight > current.clientHeight + 1;
                const canScrollX =
                    (overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") &&
                    current.scrollWidth > current.clientWidth + 1;
                if (canScrollY || canScrollX) {
                    entries.push({
                        kind: "element",
                        target: current,
                        top: current.scrollTop,
                        left: current.scrollLeft,
                    });
                }
                current = current.parentElement;
            }

            const scrollingElement =
                typeof document !== "undefined" && document.scrollingElement
                    ? document.scrollingElement
                    : null;
            if (scrollingElement) {
                entries.push({
                    kind: "document",
                    target: scrollingElement,
                    top: scrollingElement.scrollTop,
                    left: scrollingElement.scrollLeft,
                });
            }
            return entries;
        }

        function restoreScrollableAncestors(snapshot) {
            if (!Array.isArray(snapshot) || snapshot.length < 1) {
                return;
            }
            snapshot.forEach((entry) => {
                if (!entry || !entry.target) {
                    return;
                }
                if (entry.kind === "document") {
                    entry.target.scrollTop = entry.top;
                    entry.target.scrollLeft = entry.left;
                    return;
                }
                if (entry.kind === "element" && entry.target.isConnected) {
                    entry.target.scrollTop = entry.top;
                    entry.target.scrollLeft = entry.left;
                }
            });
        }

        function getActiveInlineScrollSnapshot(maxAgeMs = 2200) {
            if (!Array.isArray(inlineScrollSnapshot) || inlineScrollSnapshot.length < 1) {
                return null;
            }
            const age = Date.now() - inlineScrollSnapshotCapturedAt;
            if (age > maxAgeMs) {
                inlineScrollSnapshot = null;
                inlineScrollSnapshotCapturedAt = 0;
                return null;
            }
            return inlineScrollSnapshot;
        }

        function scheduleInlineScrollRestore(snapshot) {
            if (!Array.isArray(snapshot) || snapshot.length < 1) {
                return;
            }
            const runRestore = () => restoreScrollableAncestors(snapshot);
            runRestore();
            if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(runRestore);
            }
            [0, 60, 140, 260, 420, 700].forEach((delay) => {
                setTimeout(runRestore, delay);
            });
        }

        function snapshotInlineScroll(event) {
            if (!isInlineControlTarget(event)) {
                return;
            }
            inlineScrollSnapshot = collectScrollableAncestors(event.target);
            inlineScrollSnapshotCapturedAt = Date.now();
        }

        function restoreInlineScroll(event) {
            if (!isInlineControlTarget(event)) {
                return;
            }
            const snapshot =
                getActiveInlineScrollSnapshot() || collectScrollableAncestors(event.target);
            scheduleInlineScrollRestore(snapshot);
        }

        function clearTextSelection() {
            if (typeof window === "undefined" || typeof window.getSelection !== "function") {
                return;
            }
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                selection.removeAllRanges();
            }
        }

        function syncPanState() {
            canvas.classList.toggle("is-pan", runtime.panEnabled);
            canvas.classList.toggle("is-grabbing", runtime.isPanning);

            if (panToggleButton) {
                panToggleButton.classList.toggle("active", runtime.panEnabled);
            }
        }

        function syncZoomClickState() {
            canvas.classList.toggle("is-zoom-click", runtime.zoomClickEnabled);
            if (zoomClickToggleButton) {
                const label = runtime.zoomClickEnabled ? "Disable zoom on click" : "Zoom on click";
                zoomClickToggleButton.classList.toggle("active", runtime.zoomClickEnabled);
                zoomClickToggleButton.setAttribute("aria-label", label);
                zoomClickToggleButton.setAttribute("title", label);
            }
        }

        function clearClickZoomPointerTracking(event = null) {
            if (
                event &&
                Number.isFinite(runtime.clickZoomPointerId) &&
                runtime.clickZoomPointerId !== event.pointerId
            ) {
                return;
            }
            const activePointerId = runtime.clickZoomPointerId;
            runtime.clickZoomPointerId = null;
            runtime.clickZoomStartX = 0;
            runtime.clickZoomStartY = 0;
            runtime.clickZoomMoved = false;
            if (
                Number.isFinite(activePointerId) &&
                canvas.hasPointerCapture(activePointerId)
            ) {
                canvas.releasePointerCapture(activePointerId);
            }
        }

        function setDocumentFullscreenLock(locked) {
            if (typeof document === "undefined" || !document.body) {
                return;
            }
            document.body.classList.toggle("line-panel-fullscreen-active", locked);
        }

        function rerenderAfterFullscreenChange() {
            if (runtime.destroyed) {
                return;
            }
            if (runtime.points && runtime.points.length >= 2) {
                requestAnimationFrame(() => renderSeries(runtime.points, runtime.compareSeries));
            }
        }

        function syncFullscreenState() {
            const isFullscreen = runtime.fullscreenActive;
            shell.classList.toggle("is-fullscreen", isFullscreen);
            if (fullscreenButton) {
                const label = isFullscreen ? "Exit fullscreen" : "Fullscreen";
                fullscreenButton.setAttribute("aria-label", label);
                fullscreenButton.setAttribute("title", label);
                fullscreenButton.classList.toggle("active", isFullscreen);
            }
            setDocumentFullscreenLock(isFullscreen);
        }

        function updateStats(minValue, maxValue) {
            if (minStat) {
                minStat.textContent = `min: ${formatCell(minValue, runtime.notation)}`;
            }
            if (maxStat) {
                maxStat.textContent = `max: ${formatCell(maxValue, runtime.notation)}`;
            }
            if (spanStat) {
                spanStat.textContent = `span: ${formatCell(maxValue - minValue, runtime.notation)}`;
            }
        }

        function getCompareColor(index) {
            return LINE_COMPARE_COLORS[index % LINE_COMPARE_COLORS.length];
        }

        function shapesMatch(left, right) {
            if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
                return false;
            }
            return left.every((entry, index) => Number(entry) === Number(right[index]));
        }

        function updateLegend(seriesList = [], failedTargets = []) {
            if (!legendElement) {
                return;
            }

            const normalizedSeries = Array.isArray(seriesList) ? seriesList : [];
            const normalizedFailures = Array.isArray(failedTargets) ? failedTargets : [];

            if (normalizedSeries.length <= 1 && normalizedFailures.length < 1) {
                legendElement.hidden = true;
                legendElement.innerHTML = "";
                return;
            }

            const seriesMarkup = normalizedSeries
                .map((series) => {
                    const path = String(series.path || "");
                    const label = String(series.label || path || "Series");
                    const color = String(series.color || "#2563EB");
                    const suffix = series.isBase ? " (base)" : "";
                    return `
          <span class="line-legend-item" title="${escapeHtml(path || label)}">
            <span class="line-legend-swatch" style="background:${escapeHtml(color)}"></span>
            <span class="line-legend-text">${escapeHtml(label + suffix)}</span>
          </span>
        `;
                })
                .join("");

            const failedMarkup = normalizedFailures
                .map((entry) => {
                    const label = String(entry?.label || entry?.path || "Series");
                    const reason = String(entry?.reason || "Failed to load");
                    return `
          <span class="line-legend-item line-legend-item-failed" title="${escapeHtml(reason)}">
            <span class="line-legend-swatch line-legend-swatch-failed"></span>
            <span class="line-legend-text">${escapeHtml(label)} (${escapeHtml(reason)})</span>
          </span>
        `;
                })
                .join("");

            legendElement.hidden = false;
            legendElement.innerHTML = `${seriesMarkup}${failedMarkup}`;
        }

        function getSvgDimensions() {
            const rect = canvas.getBoundingClientRect();
            const w = Math.max(300, Math.round(rect.width) || LINE_SVG_WIDTH);
            const h = Math.max(200, Math.round(rect.height) || LINE_SVG_HEIGHT);
            return { width: w, height: h };
        }

        function resolveZoomFocusPoint(points) {
            if (!Array.isArray(points) || points.length < 1 || !Number.isFinite(runtime.zoomFocusX)) {
                return null;
            }

            let nearestPoint = points[0];
            let nearestDistance = Math.abs(points[0].x - runtime.zoomFocusX);
            for (let index = 1; index < points.length; index += 1) {
                const candidate = points[index];
                const distance = Math.abs(candidate.x - runtime.zoomFocusX);
                if (distance < nearestDistance) {
                    nearestPoint = candidate;
                    nearestDistance = distance;
                }
            }

            return nearestPoint;
        }

        function resolveSelectedPoint(points) {
            if (!Array.isArray(points) || points.length < 1 || !Number.isFinite(runtime.selectedPointX)) {
                return null;
            }

            let nearestPoint = points[0];
            let nearestDistance = Math.abs(points[0].x - runtime.selectedPointX);
            for (let index = 1; index < points.length; index += 1) {
                const candidate = points[index];
                const distance = Math.abs(candidate.x - runtime.selectedPointX);
                if (distance < nearestDistance) {
                    nearestPoint = candidate;
                    nearestDistance = distance;
                }
            }

            return nearestPoint;
        }

        function renderSeries(basePoints, compareSeries = []) {
            const { width, height } = getSvgDimensions();
            svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
            const basePadding = { top: 20, right: 18, bottom: 34, left: 48 };
            const baseChartWidth = width - basePadding.left - basePadding.right;
            const baseChartHeight = height - basePadding.top - basePadding.bottom;

            const safeBasePoints = Array.isArray(basePoints) ? basePoints : [];
            const safeCompareSeries = Array.isArray(compareSeries)
                ? compareSeries.filter((entry) => entry && Array.isArray(entry.points) && entry.points.length > 0)
                : [];

            runtime.points = safeBasePoints;
            runtime.compareSeries = safeCompareSeries;
            runtime.renderedSeries = [
                {
                    isBase: true,
                    path: runtime.path,
                    label: "Base",
                    color: "#2563EB",
                    points: safeBasePoints,
                },
                ...safeCompareSeries,
            ];
            runtime.frame = null;
            runtime.hoverDot = null;

            const domainPoints = runtime.renderedSeries.flatMap((entry) =>
                Array.isArray(entry.points) ? entry.points : []
            );

            if (!Array.isArray(safeBasePoints) || safeBasePoints.length < 2 || domainPoints.length < 2) {
                if (minStat) minStat.textContent = "min: --";
                if (maxStat) maxStat.textContent = "max: --";
                if (spanStat) spanStat.textContent = "span: --";
                svg.innerHTML = `
        <rect x="0" y="0" width="${width}" height="${height}" class="line-chart-bg"></rect>
        <g class="line-axis">
          <line x1="${basePadding.left}" y1="${basePadding.top + baseChartHeight}" x2="${basePadding.left + baseChartWidth
                    }" y2="${basePadding.top + baseChartHeight}"></line>
          <line x1="${basePadding.left}" y1="${basePadding.top}" x2="${basePadding.left}" y2="${basePadding.top + baseChartHeight
                    }"></line>
        </g>
        <text x="${basePadding.left + 8}" y="${basePadding.top + 18
                    }" class="line-empty-msg">No numeric points in this range.</text>
      `;
                updateLegend(runtime.renderedSeries, runtime.failedCompareTargets);
                hideHover();
                return;
            }

            const xValues = domainPoints.map((point) => point.x);
            const yValues = domainPoints.map((point) => point.y);
            const rawMinX = Math.min(...xValues);
            const rawMaxX = Math.max(...xValues);
            const rawMinY = Math.min(...yValues);
            const rawMaxY = Math.max(...yValues);
            const rawSpanX = rawMaxX - rawMinX;
            const rawSpanY = rawMaxY - rawMinY;
            const domainPadX = rawSpanX === 0 ? 1 : rawSpanX * 0.02;
            const domainPadY = rawSpanY === 0 ? Math.max(Math.abs(rawMinY) * 0.1, 1) : rawSpanY * 0.08;
            const minX = rawMinX - domainPadX;
            const maxX = rawMaxX + domainPadX;
            const minY = rawMinY - domainPadY;
            const maxY = rawMaxY + domainPadY;
            const spanX = maxX - minX || 1;
            const spanY = maxY - minY || 1;

            const tickCount = 6;
            const tickValues = Array.from({ length: tickCount }, (_, idx) => {
                const ratio = idx / Math.max(1, tickCount - 1);
                return {
                    ratio,
                    xValue: minX + ratio * spanX,
                    yValue: maxY - ratio * spanY,
                };
            });
            const xTickLabelsText = tickValues.map((tick) => formatCell(tick.xValue, runtime.notation));
            const yTickLabelsText = tickValues.map((tick) => formatCell(tick.yValue, runtime.notation));
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
                top: 20,
                right: clamp(Math.ceil(lastXHalf + 12), 20, Math.floor(width * 0.22)),
                bottom: 34,
                left: clamp(
                    Math.ceil(Math.max(maxYLabelWidth + 16, firstXHalf + 10, 62)),
                    62,
                    Math.floor(width * 0.34)
                ),
            };
            const chartWidth = Math.max(140, width - padding.left - padding.right);
            const chartHeight = Math.max(140, height - padding.top - padding.bottom);
            const yAxisTitleX = Math.max(12, Math.round(padding.left * 0.3));

            runtime.frame = {
                width,
                height,
                padding,
                chartWidth,
                chartHeight,
                minX,
                maxX,
                minY,
                maxY,
                spanX,
                spanY,
            };

            updateStats(rawMinY, rawMaxY);

            const toX = (value) => padding.left + ((value - minX) / spanX) * chartWidth;
            const toY = (value) => padding.top + chartHeight - ((value - minY) / spanY) * chartHeight;

            const ticks = tickValues.map((tick) => {
                const x = padding.left + tick.ratio * chartWidth;
                const y = padding.top + tick.ratio * chartHeight;
                return {
                    ratio: tick.ratio,
                    x,
                    y,
                    xValue: tick.xValue,
                    yValue: tick.yValue,
                };
            });

            const gridLines = ticks
                .map(
                    (tick) => `
          <line x1="${tick.x}" y1="${padding.top}" x2="${tick.x}" y2="${padding.top + chartHeight}"></line>
          <line x1="${padding.left}" y1="${tick.y}" x2="${padding.left + chartWidth}" y2="${tick.y}"></line>
        `
                )
                .join("");

            const xTickLabels = ticks
                .map((tick, idx) => {
                    const label = xTickLabelsText[idx] || formatCell(tick.xValue, runtime.notation);
                    return `<text x="${tick.x}" y="${padding.top + chartHeight + 18}" text-anchor="middle">${escapeHtml(
                        label
                    )}</text>`;
                })
                .join("");
            const yTickLabels = ticks
                .map((tick, idx) => {
                    const label = yTickLabelsText[idx] || formatCell(tick.yValue, runtime.notation);
                    return `<text x="${padding.left - 10}" y="${tick.y + 4}" text-anchor="end">${escapeHtml(
                        label
                    )}</text>`;
                })
                .join("");

            const showLine = runtime.lineAspect !== "point";
            const showPoints = runtime.lineAspect !== "line";
            const focusPoint = resolveZoomFocusPoint(safeBasePoints);
            const selectedPoint = resolveSelectedPoint(safeBasePoints);

            const seriesMarkup = runtime.renderedSeries
                .map((series, index) => {
                    const points = Array.isArray(series.points) ? series.points : [];
                    if (points.length < 2) {
                        return "";
                    }

                    const color = String(series.color || (series.isBase ? "#2563EB" : getCompareColor(index)));
                    const path = points
                        .map(
                            (point, pointIndex) =>
                                `${pointIndex === 0 ? "M" : "L"}${toX(point.x).toFixed(2)},${toY(point.y).toFixed(2)}`
                        )
                        .join(" ");
                    const sampleEvery = Math.max(1, Math.ceil(points.length / 450));
                    const markers = points
                        .filter((_, pointIndex) => pointIndex % sampleEvery === 0)
                        .map(
                            (point) =>
                                `<circle cx="${toX(point.x).toFixed(2)}" cy="${toY(point.y).toFixed(
                                    2
                                )}" r="${series.isBase ? 1.9 : 1.5}" style="fill:${escapeHtml(color)}"></circle>`
                        )
                        .join("");

                    return `
          <g class="line-series ${series.isBase ? "line-series-base" : "line-series-compare"}">
            ${showLine
                            ? `<path class="line-path ${series.isBase ? "line-path-base" : "line-path-compare"}" style="stroke:${escapeHtml(
                                color
                            )}" d="${path}"></path>`
                            : ""
                        }
            ${showPoints ? `<g class="line-points">${markers}</g>` : ""}
          </g>
        `;
                })
                .join("");

            const focusMarkup = focusPoint
                ? `<g class="line-zoom-focus" data-line-zoom-focus="true">
      <line class="line-zoom-focus-line" x1="${toX(focusPoint.x).toFixed(2)}" y1="${padding.top}" x2="${toX(
                    focusPoint.x
                ).toFixed(2)}" y2="${padding.top + chartHeight}"></line>
      <circle class="line-zoom-focus-halo" cx="${toX(focusPoint.x).toFixed(2)}" cy="${toY(
                    focusPoint.y
                ).toFixed(2)}" r="9"></circle>
      <circle class="line-zoom-focus-dot" cx="${toX(focusPoint.x).toFixed(2)}" cy="${toY(
                    focusPoint.y
                ).toFixed(2)}" r="4.5"></circle>
    </g>`
                : "";
            const selectedMarkup = selectedPoint
                ? `<g class="line-selected-point" data-line-selected-point="true">
      <line class="line-selected-point-line" x1="${toX(selectedPoint.x).toFixed(2)}" y1="${padding.top}" x2="${toX(
                    selectedPoint.x
                ).toFixed(2)}" y2="${padding.top + chartHeight}"></line>
      <circle class="line-selected-point-halo" cx="${toX(selectedPoint.x).toFixed(2)}" cy="${toY(
                    selectedPoint.y
                ).toFixed(2)}" r="10"></circle>
      <circle class="line-selected-point-dot" cx="${toX(selectedPoint.x).toFixed(2)}" cy="${toY(
                    selectedPoint.y
                ).toFixed(2)}" r="5"></circle>
    </g>`
                : "";

            svg.innerHTML = `
      <rect x="0" y="0" width="${width}" height="${height}" class="line-chart-bg"></rect>
      <g class="line-grid">${runtime.lineGrid ? gridLines : ""}</g>
      <g class="line-axis">
        <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}"></line>
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}"></line>
      </g>
      <g class="line-axis-labels">
        ${xTickLabels}
        ${yTickLabels}
      </g>
      <g class="line-axis-titles">
        <text class="line-axis-title line-axis-title-x" x="${padding.left + chartWidth / 2}" y="${height - 6}" text-anchor="middle">Index</text>
        <text class="line-axis-title line-axis-title-y" x="${yAxisTitleX}" y="${padding.top + chartHeight / 2
                }" text-anchor="middle" transform="rotate(-90, ${yAxisTitleX}, ${padding.top + chartHeight / 2
                })">Value</text>
      </g>
      ${seriesMarkup}
      ${selectedMarkup}
      ${focusMarkup}
      <circle class="line-hover-dot" data-line-hover-dot="true" cx="-9999" cy="-9999" r="4"></circle>
    `;
            runtime.hoverDot = svg.querySelector("[data-line-hover-dot]");
            updateLegend(runtime.renderedSeries, runtime.failedCompareTargets);
            hideHover();
        }

        function scheduleFetch() {
            if (runtime.destroyed) {
                return;
            }

            if (runtime.fetchTimer !== null) {
                clearTimeout(runtime.fetchTimer);
            }

            // Debounce viewport changes so wheel/pan bursts issue one data request.
            runtime.fetchTimer = setTimeout(() => {
                runtime.fetchTimer = null;
                void fetchLineRange();
            }, LINE_FETCH_DEBOUNCE_MS);
        }

        async function fetchLineRange() {
            if (runtime.destroyed) {
                return;
            }

            const requestId = ++runtime.requestSeq;
            const offset = runtime.viewStart;
            const limit = runtime.viewSpan;

            setMatrixStatus(statusElement, "Loading line range...", "info");

            const params = {
                mode: "line",
                quality: runtime.qualityRequested,
                max_points: runtime.overviewMaxPoints,
                line_offset: offset,
                line_limit: limit,
            };

            if (runtime.displayDims) {
                params.display_dims = runtime.displayDims;
            }

            if (runtime.fixedIndices) {
                params.fixed_indices = runtime.fixedIndices;
            }

            if (runtime.lineIndex !== null) {
                if (runtime.lineDim === "row" || runtime.lineDim === "col") {
                    params.line_dim = runtime.lineDim;
                }
                params.line_index = runtime.lineIndex;
            }

            if (runtime.fileEtag) {
                params.etag = runtime.fileEtag;
            }

            try {
                const comparePrecheckFailures = [];
                const compareTargets = [];
                const baseNumericKnown = runtime.baseDtype ? isNumericDtype(runtime.baseDtype) : true;
                // Validate compare targets before requesting data so mismatches show explicit reasons.
                runtime.compareItems.forEach((item) => {
                    const comparePath = String(item?.path || "").trim();
                    if (!comparePath || comparePath === runtime.path) {
                        return;
                    }

                    const compareLabel = String(item?.name || comparePath);
                    const compareDtype = String(item?.dtype || "");
                    const compareShape = Array.isArray(item?.shape)
                        ? item.shape
                            .map((entry) => Number(entry))
                            .filter((entry) => Number.isFinite(entry) && entry >= 0)
                        : [];
                    const compareNdim = Number(item?.ndim);

                    if (!baseNumericKnown) {
                        comparePrecheckFailures.push({
                            path: comparePath,
                            label: compareLabel,
                            reason: "base non-numeric",
                        });
                        return;
                    }

                    if (compareDtype && !isNumericDtype(compareDtype)) {
                        comparePrecheckFailures.push({
                            path: comparePath,
                            label: compareLabel,
                            reason: "non-numeric",
                        });
                        return;
                    }

                    if (
                        runtime.baseNdim > 0 &&
                        Number.isFinite(compareNdim) &&
                        compareNdim !== runtime.baseNdim
                    ) {
                        comparePrecheckFailures.push({
                            path: comparePath,
                            label: compareLabel,
                            reason: "ndim mismatch",
                        });
                        return;
                    }

                    if (
                        runtime.baseShape.length > 0 &&
                        compareShape.length > 0 &&
                        !shapesMatch(runtime.baseShape, compareShape)
                    ) {
                        comparePrecheckFailures.push({
                            path: comparePath,
                            label: compareLabel,
                            reason: "shape mismatch",
                        });
                        return;
                    }

                    compareTargets.push({
                        path: comparePath,
                        label: compareLabel,
                        isBase: false,
                        color: getCompareColor(compareTargets.length),
                    });
                });

                const requestTargets = [
                    {
                        path: runtime.path,
                        label: "Base",
                        isBase: true,
                        color: "#2563EB",
                    },
                    ...compareTargets,
                ];

                // Base and compare ranges are fetched together; compare failures do not block base rendering.
                const settledResponses = await Promise.allSettled(
                    requestTargets.map((target) =>
                        getFileData(runtime.fileKey, target.path, params, {
                            cancelPrevious: true,
                            cancelKey: `${runtime.selectionKey}|${target.path}`,
                        })
                    )
                );

                if (runtime.destroyed || requestId !== runtime.requestSeq) {
                    return;
                }

                const baseOutcome = settledResponses[0];
                if (!baseOutcome || baseOutcome.status !== "fulfilled") {
                    const baseError = baseOutcome?.reason;
                    if (baseError?.isAbort || baseError?.code === "ABORTED") {
                        return;
                    }
                    throw baseError || new Error("Failed to load base line dataset.");
                }

                const response = baseOutcome.value;
                runtime.qualityApplied = normalizeLineQuality(response?.quality_applied || runtime.qualityRequested);
                runtime.requestedPoints = Math.max(0, toSafeInteger(response?.requested_points, limit));
                runtime.returnedPoints = Math.max(
                    0,
                    toSafeInteger(response?.returned_points, Array.isArray(response?.data) ? response.data.length : 0)
                );

                const toPoints = (payload, fallbackOffset = offset) => {
                    const step = Math.max(
                        1,
                        toSafeInteger(payload?.line_step, toSafeInteger(payload?.downsample_info?.step, 1))
                    );
                    const responseOffset = Math.max(0, toSafeInteger(payload?.line_offset, fallbackOffset));
                    const values = Array.isArray(payload?.data) ? payload.data : [];
                    const points = values
                        .map((value, index) => ({
                            x: responseOffset + index * step,
                            y: Number(value),
                        }))
                        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

                    return { step, points };
                };

                const baseSeries = toPoints(response, offset);
                runtime.lineStep = baseSeries.step;

                const failedTargets = [...comparePrecheckFailures];
                const compareSeries = [];
                settledResponses.slice(1).forEach((outcome, index) => {
                    const target = requestTargets[index + 1];
                    if (!target) {
                        return;
                    }

                    if (!outcome || outcome.status !== "fulfilled") {
                        const reason = outcome?.reason;
                        if (reason?.isAbort || reason?.code === "ABORTED") {
                            return;
                        }
                        failedTargets.push({
                            path: target.path,
                            label: target.label,
                            reason: reason?.message || "request failed",
                        });
                        return;
                    }

                    const comparePayload = outcome.value;
                    const comparePoints = toPoints(comparePayload, offset).points;
                    if (comparePoints.length < 2) {
                        failedTargets.push({
                            path: target.path,
                            label: target.label,
                            reason: "insufficient points",
                        });
                        return;
                    }

                    compareSeries.push({
                        isBase: false,
                        path: target.path,
                        label: target.label,
                        color: target.color,
                        points: comparePoints,
                    });
                });

                runtime.failedCompareTargets = failedTargets;
                runtime.compareSeries = compareSeries;

                if (Number.isFinite(runtime.pendingZoomFocusX)) {
                    runtime.zoomFocusX = runtime.pendingZoomFocusX;
                }
                runtime.pendingZoomFocusX = null;

                updateRangeLabel(baseSeries.points.length);
                updateZoomLabel();
                renderSeries(baseSeries.points, compareSeries);
                if (inlineHeatmapLinked) {
                    const snapshot = getActiveInlineScrollSnapshot();
                    if (snapshot) {
                        scheduleInlineScrollRestore(snapshot);
                    }
                }

                const compareCount = requestTargets.length - 1;
                const compareLoadedText =
                    compareCount > 0
                        ? ` | compare ${compareSeries.length}/${compareCount}${failedTargets.length > 0 ? ` (${failedTargets.length} skipped)` : ""}`
                        : "";
                setMatrixStatus(
                    statusElement,
                    `${runtime.qualityApplied === "exact" ? "Exact" : "Overview"} loaded ${baseSeries.points.length.toLocaleString()} points (step ${runtime.lineStep}).${compareLoadedText}`,
                    "info"
                );
            } catch (error) {
                if (runtime.destroyed) {
                    return;
                }

                if (error?.isAbort || error?.code === "ABORTED") {
                    return;
                }

                runtime.failedCompareTargets = [];
                runtime.compareSeries = [];
                updateLegend([], []);
                setMatrixStatus(statusElement, error?.message || "Failed to load line range.", "error");
            }
        }

        function getComparePathsForExport() {
            const seen = new Set();
            const comparePaths = [];
            runtime.compareItems.forEach((item) => {
                const pathValue = String(item?.path || "").trim();
                if (!pathValue || pathValue === runtime.path || seen.has(pathValue)) {
                    return;
                }
                seen.add(pathValue);
                comparePaths.push(pathValue);
            });
            return comparePaths;
        }

        async function exportCsvDisplayed() {
            if (runtime.destroyed) {
                throw new Error("Line runtime is no longer active.");
            }

            if (!Array.isArray(runtime.points) || runtime.points.length < 1) {
                await fetchLineRange();
            }

            const basePoints = Array.isArray(runtime.points) ? runtime.points : [];
            if (basePoints.length < 1) {
                throw new Error("No line points available for CSV export.");
            }

            const compareSeries = Array.isArray(runtime.compareSeries) ? runtime.compareSeries : [];
            const compareValueMaps = compareSeries.map((series) => {
                const map = new Map();
                (Array.isArray(series?.points) ? series.points : []).forEach((point) => {
                    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
                        map.set(point.x, point.y);
                    }
                });
                return map;
            });

            const header = ["index", "base", ...compareSeries.map((series, index) => series?.label || `compare_${index + 1}`)];
            const rows = [toCsvRow(header)];
            basePoints.forEach((point) => {
                const rowValues = [point.x, point.y];
                compareValueMaps.forEach((map) => {
                    rowValues.push(map.has(point.x) ? map.get(point.x) : "");
                });
                rows.push(toCsvRow(rowValues));
            });

            const filename = buildExportFilename({
                fileKey: runtime.fileKey,
                path: runtime.path,
                tab: "line",
                scope: "displayed",
                extension: "csv",
            });
            const blob = createCsvBlob(rows, true);
            triggerBlobDownload(blob, filename);
            setMatrixStatus(
                statusElement,
                `Displayed line CSV exported (${basePoints.length.toLocaleString()} rows).`,
                "info"
            );
        }

        async function exportCsvFull() {
            if (runtime.destroyed) {
                throw new Error("Line runtime is no longer active.");
            }

            const query = {
                path: runtime.path,
                mode: "line",
            };
            if (runtime.displayDims) {
                query.display_dims = runtime.displayDims;
            }
            if (runtime.fixedIndices) {
                query.fixed_indices = runtime.fixedIndices;
            }
            if (runtime.fileEtag) {
                query.etag = runtime.fileEtag;
            }
            if (runtime.lineDim === "row" || runtime.lineDim === "col") {
                query.line_dim = runtime.lineDim;
            }
            if (runtime.lineIndex !== null && runtime.lineIndex !== undefined) {
                query.line_index = runtime.lineIndex;
            }

            const comparePaths = getComparePathsForExport();
            if (comparePaths.length > 0) {
                query.compare_paths = comparePaths.join(",");
            }

            const url = buildCsvExportUrl(runtime.fileKey, query);
            triggerUrlDownload(url);
            setMatrixStatus(statusElement, "Full line CSV download started.", "info");
        }

        async function exportPng() {
            if (runtime.destroyed) {
                throw new Error("Line runtime is no longer active.");
            }
            if (!svg) {
                throw new Error("Line chart SVG not available for PNG export.");
            }
            const pngBlob = await svgElementToPngBlob(svg, {
                background: "#FFFFFF",
                scale: 2,
            });
            const filename = buildExportFilename({
                fileKey: runtime.fileKey,
                path: runtime.path,
                tab: "line",
                scope: "current",
                extension: "png",
            });
            triggerBlobDownload(pngBlob, filename);
            setMatrixStatus(statusElement, "Line PNG exported.", "info");
        }

        // Export menu in viewerView reads this runtime-provided API.
        shell.__exportApi = {
            exportCsvDisplayed,
            exportCsvFull,
            exportPng,
        };

        function updateViewport(start, span, immediate = false) {
            const next = clampViewport(start, span);
            const changed = next.start !== runtime.viewStart || next.span !== runtime.viewSpan;
            runtime.viewStart = next.start;
            runtime.viewSpan = next.span;
            updateRangeLabel();
            updateZoomLabel();
            syncWindowControl();
            syncJumpInput();
            persistViewState();

            if (!changed) {
                return false;
            }

            if (immediate) {
                void fetchLineRange();
                return true;
            }

            scheduleFetch();
            return true;
        }

        function zoomBy(factor, anchorRatio = 0.5) {
            const nextSpan = Math.round(runtime.viewSpan * factor);
            if (nextSpan === runtime.viewSpan) {
                return;
            }

            const maxSpan = getMaxSpanForQuality();
            const minSpan = Math.min(runtime.minSpan, maxSpan);
            const clampedSpan = clamp(nextSpan, minSpan, maxSpan);
            const focus = runtime.viewStart + Math.round(anchorRatio * runtime.viewSpan);
            const nextStart = focus - Math.round(anchorRatio * clampedSpan);
            updateViewport(nextStart, clampedSpan, false);
        }

        function onWheel(event) {
            if (runtime.totalPoints <= 1) {
                return;
            }

            event.preventDefault();

            const rect = canvas.getBoundingClientRect();
            const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
            const factor = event.deltaY < 0 ? 0.88 : 1.12;
            zoomBy(factor, ratio);
        }

        function zoomIntoPointAtClientPosition(clientX, clientY) {
            if (!runtime.frame || runtime.points.length < 2) {
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const frame = runtime.frame;
            const svgX = ((clientX - rect.left) / Math.max(rect.width, 1)) * frame.width;
            const svgY = ((clientY - rect.top) / Math.max(rect.height, 1)) * frame.height;
            const ratioX = (svgX - frame.padding.left) / frame.chartWidth;
            const ratioY = (svgY - frame.padding.top) / frame.chartHeight;
            if (ratioX < 0 || ratioX > 1 || ratioY < 0 || ratioY > 1) {
                return;
            }

            const pointIndex = clamp(
                Math.round(ratioX * (runtime.points.length - 1)),
                0,
                runtime.points.length - 1
            );
            const point = runtime.points[pointIndex];
            if (!point || !Number.isFinite(point.x)) {
                return;
            }

            runtime.zoomFocusX = point.x;
            runtime.pendingZoomFocusX = point.x;
            const maxSpan = getMaxSpanForQuality();
            const targetSpan = Math.min(runtime.minSpan, maxSpan);
            const nextStart = point.x - Math.floor(targetSpan / 2);
            const changed = updateViewport(nextStart, targetSpan, true);
            if (!changed) {
                renderSeries(runtime.points, runtime.compareSeries);
            }
        }

        function onPointerDown(event) {
            const isMousePointer = !event.pointerType || event.pointerType === "mouse";
            if (isMousePointer && event.button !== 0) {
                return;
            }

            if (
                runtime.panEnabled &&
                runtime.totalPoints > runtime.viewSpan
            ) {
                event.preventDefault();
                clearTextSelection();
                runtime.isPanning = true;
                runtime.panPointerId = event.pointerId;
                runtime.panStartX = event.clientX;
                runtime.panStartViewStart = runtime.viewStart;
                syncPanState();
                canvas.setPointerCapture(event.pointerId);
                return;
            }

            if (runtime.zoomClickEnabled) {
                event.preventDefault();
                runtime.clickZoomPointerId = event.pointerId;
                runtime.clickZoomStartX = event.clientX;
                runtime.clickZoomStartY = event.clientY;
                runtime.clickZoomMoved = false;
                canvas.setPointerCapture(event.pointerId);
            }
        }

        function onPointerMove(event) {
            if (runtime.panEnabled && runtime.isPanning && runtime.panPointerId === event.pointerId) {
                event.preventDefault();
                clearTextSelection();
                const rect = canvas.getBoundingClientRect();
                const deltaPixels = event.clientX - runtime.panStartX;
                const deltaIndex = Math.round((deltaPixels / Math.max(rect.width, 1)) * runtime.viewSpan);
                const nextStart = runtime.panStartViewStart - deltaIndex;
                updateViewport(nextStart, runtime.viewSpan, false);
                return;
            }

            if (
                runtime.zoomClickEnabled &&
                Number.isFinite(runtime.clickZoomPointerId) &&
                runtime.clickZoomPointerId === event.pointerId &&
                !runtime.clickZoomMoved
            ) {
                const deltaX = event.clientX - runtime.clickZoomStartX;
                const deltaY = event.clientY - runtime.clickZoomStartY;
                runtime.clickZoomMoved = deltaX * deltaX + deltaY * deltaY > 25;
            }

            if (!runtime.frame || runtime.points.length < 2) {
                hideHover();
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const frame = runtime.frame;
            const svgX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * frame.width;
            const svgY = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * frame.height;
            const ratioX = (svgX - frame.padding.left) / frame.chartWidth;
            const ratioY = (svgY - frame.padding.top) / frame.chartHeight;

            if (ratioX < 0 || ratioX > 1 || ratioY < 0 || ratioY > 1) {
                hideHover();
                return;
            }

            const pointIndex = clamp(
                Math.round(ratioX * (runtime.points.length - 1)),
                0,
                runtime.points.length - 1
            );
            const point = runtime.points[pointIndex];
            const cx = frame.padding.left + ((point.x - frame.minX) / frame.spanX) * frame.chartWidth;
            const cy = frame.padding.top + frame.chartHeight - ((point.y - frame.minY) / frame.spanY) * frame.chartHeight;

            if (runtime.hoverDot) {
                runtime.hoverDot.setAttribute("cx", cx.toFixed(2));
                runtime.hoverDot.setAttribute("cy", cy.toFixed(2));
                runtime.hoverDot.style.display = "";
            }

            if (hoverElement) {
                hoverElement.hidden = false;
                hoverElement.innerHTML = `
        <div>Index: ${escapeHtml(formatCell(point.x, "exact"))}</div>
        <div>Value: ${escapeHtml(formatCell(point.y, runtime.notation))}</div>
      `;
            }
        }

        function onPointerUp(event) {
            if (
                runtime.zoomClickEnabled &&
                Number.isFinite(runtime.clickZoomPointerId) &&
                runtime.clickZoomPointerId === event.pointerId
            ) {
                const shouldZoom = !runtime.clickZoomMoved;
                const clientX = event.clientX;
                const clientY = event.clientY;
                clearClickZoomPointerTracking(event);
                if (shouldZoom) {
                    event.preventDefault();
                    zoomIntoPointAtClientPosition(clientX, clientY);
                }
                return;
            }
            endPan(event);
        }

        function onPointerCancel(event) {
            clearClickZoomPointerTracking(event);
            endPan(event);
        }

        function endPan(event) {
            if (!runtime.isPanning) {
                return;
            }

            if (event && runtime.panPointerId !== event.pointerId) {
                return;
            }

            runtime.isPanning = false;
            const activePointerId = runtime.panPointerId;
            runtime.panPointerId = null;
            syncPanState();

            if (
                Number.isFinite(activePointerId) &&
                canvas.hasPointerCapture(activePointerId)
            ) {
                canvas.releasePointerCapture(activePointerId);
            }
        }

        function onPointerLeave() {
            clearClickZoomPointerTracking();
            hideHover();
            if (runtime.isPanning) {
                endPan();
            }
            clearClickZoomPointerTracking();
        }

        function onTogglePan() {
            runtime.panEnabled = !runtime.panEnabled;
            if (!runtime.panEnabled && runtime.isPanning) {
                endPan();
            }
            if (runtime.panEnabled) {
                runtime.zoomClickEnabled = false;
                clearClickZoomPointerTracking();
                clearTextSelection();
            }
            syncPanState();
            syncZoomClickState();
            persistViewState();
        }

        function onToggleClickZoom() {
            runtime.zoomClickEnabled = !runtime.zoomClickEnabled;
            if (runtime.zoomClickEnabled) {
                if (runtime.isPanning) {
                    endPan();
                }
                runtime.panEnabled = false;
                clearTextSelection();
            }
            clearClickZoomPointerTracking();
            syncPanState();
            syncZoomClickState();
            persistViewState();
        }

        function onZoomIn() {
            zoomBy(1 / 1.15, 0.5);
        }

        function onZoomOut() {
            zoomBy(1.15, 0.5);
        }

        function shiftWindow(direction) {
            if (!Number.isFinite(direction) || direction === 0) {
                return;
            }
            const delta = Math.max(1, Math.round(runtime.viewSpan * direction));
            updateViewport(runtime.viewStart + delta, runtime.viewSpan, true);
        }

        function onJumpStart() {
            updateViewport(0, runtime.viewSpan, true);
        }

        function onJumpEnd() {
            updateViewport(runtime.totalPoints - runtime.viewSpan, runtime.viewSpan, true);
        }

        function onStepPrev() {
            shiftWindow(-1);
        }

        function onStepNext() {
            shiftWindow(1);
        }

        function setQuality(nextQuality) {
            runtime.qualityRequested = normalizeLineQuality(nextQuality);
            runtime.qualityApplied = runtime.qualityRequested;
            syncQualityControl();
            const maxSpan = getMaxSpanForQuality();
            updateViewport(runtime.viewStart, Math.min(runtime.viewSpan, maxSpan), true);
        }

        function onQualityChange() {
            if (!qualitySelect) {
                return;
            }
            setQuality(qualitySelect.value);
        }

        function onWindowChange() {
            if (!windowSelect) {
                return;
            }
            const requested = Math.max(1, toSafeInteger(windowSelect.value, runtime.viewSpan));
            updateViewport(runtime.viewStart, requested, true);
        }

        function onJumpToIndex() {
            if (!jumpInput) {
                return;
            }
            const parsed = toSafeInteger(jumpInput.value, null);
            if (parsed === null) {
                return;
            }

            const target = clamp(parsed, 0, Math.max(0, runtime.totalPoints - 1));
            jumpInput.value = String(target);
            const nextStart = target - Math.floor(runtime.viewSpan / 2);
            updateViewport(nextStart, runtime.viewSpan, true);
        }

        function onJumpInputKeyDown(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                onJumpToIndex();
            }
        }

        function onKeyDown(event) {
            if (event.defaultPrevented) {
                return;
            }

            const key = event.key;
            if (key === "ArrowLeft") {
                event.preventDefault();
                shiftWindow(-LINE_KEYBOARD_PAN_RATIO);
                return;
            }
            if (key === "ArrowRight") {
                event.preventDefault();
                shiftWindow(LINE_KEYBOARD_PAN_RATIO);
                return;
            }
            if (key === "Home") {
                event.preventDefault();
                onJumpStart();
                return;
            }
            if (key === "End") {
                event.preventDefault();
                onJumpEnd();
                return;
            }
            if (key === "+" || key === "=") {
                event.preventDefault();
                onZoomIn();
                return;
            }
            if (key === "-" || key === "_") {
                event.preventDefault();
                onZoomOut();
            }
        }

        const onReset = () => {
            runtime.zoomClickEnabled = false;
            runtime.zoomFocusX = null;
            runtime.pendingZoomFocusX = null;
            clearClickZoomPointerTracking();
            syncZoomClickState();
            const maxSpan = getMaxSpanForQuality();
            const changed = updateViewport(0, maxSpan, true);
            if (!changed) {
                renderSeries(runtime.points, runtime.compareSeries);
            }
        };

        function onToggleFullscreen() {
            runtime.fullscreenActive = !runtime.fullscreenActive;
            if (!runtime.fullscreenActive) {
                lineFullscreenRestore = null;
            }
            syncFullscreenState();
            rerenderAfterFullscreenChange();
        }

        function onFullscreenEsc(event) {
            if (event.key === "Escape" && runtime.fullscreenActive) {
                event.preventDefault();
                event.stopPropagation();
                runtime.fullscreenActive = false;
                lineFullscreenRestore = null;
                syncFullscreenState();
                rerenderAfterFullscreenChange();
            }
        }

        function exitPanelFullscreen() {
            if (!runtime.fullscreenActive) {
                return;
            }
            runtime.fullscreenActive = false;
            syncFullscreenState();
            rerenderAfterFullscreenChange();
        }

        const onFullscreenButtonClick = (event) => {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
            onToggleFullscreen();
        };

        if (hoverElement) {
            hoverElement.hidden = true;
        }

        syncPanState();
        syncZoomClickState();
        syncFullscreenState();
        syncQualityControl();
        syncWindowControl();
        syncJumpInput();
        updateRangeLabel();
        updateZoomLabel();
        persistViewState();
        setMatrixStatus(statusElement, "Loading initial line range...", "info");
        void fetchLineRange();

        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", onPointerCancel);
        canvas.addEventListener("pointerleave", onPointerLeave);
        canvas.addEventListener("keydown", onKeyDown);
        if (panToggleButton) {
            panToggleButton.addEventListener("click", onTogglePan);
        }
        if (zoomClickToggleButton) {
            zoomClickToggleButton.addEventListener("click", onToggleClickZoom);
        }
        if (zoomInButton) {
            zoomInButton.addEventListener("click", onZoomIn);
        }
        if (zoomOutButton) {
            zoomOutButton.addEventListener("click", onZoomOut);
        }
        if (resetButton) {
            resetButton.addEventListener("click", onReset);
        }
        if (jumpStartButton) {
            jumpStartButton.addEventListener("click", onJumpStart);
        }
        if (stepPrevButton) {
            stepPrevButton.addEventListener("click", onStepPrev);
        }
        if (stepNextButton) {
            stepNextButton.addEventListener("click", onStepNext);
        }
        if (jumpEndButton) {
            jumpEndButton.addEventListener("click", onJumpEnd);
        }
        if (qualitySelect) {
            qualitySelect.addEventListener("change", onQualityChange);
        }
        if (windowSelect) {
            windowSelect.addEventListener("change", onWindowChange);
        }
        if (jumpToIndexButton) {
            jumpToIndexButton.addEventListener("click", onJumpToIndex);
        }
        if (jumpInput) {
            jumpInput.addEventListener("keydown", onJumpInputKeyDown);
        }
        if (fullscreenButton) {
            fullscreenButton.addEventListener("click", onFullscreenButtonClick);
        }
        if (inlineHeatmapLinked) {
            shell.addEventListener("pointerdown", snapshotInlineScroll, true);
            shell.addEventListener("click", restoreInlineScroll, true);
            shell.addEventListener("change", restoreInlineScroll, true);
        }
        document.addEventListener("keydown", onFullscreenEsc);

        /* ResizeObserver: re-render chart when container resizes */
        let resizeTimer = null;
        const onResize = () => {
            if (runtime.destroyed) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!runtime.destroyed && runtime.points && runtime.points.length >= 2) {
                    renderSeries(runtime.points, runtime.compareSeries);
                }
            }, 150);
        };
        let resizeObserver = null;
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(onResize);
            resizeObserver.observe(canvas);
        } else {
            window.addEventListener("resize", onResize);
        }

        const cleanup = () => {
            if (runtime.destroyed) {
                LINE_RUNTIME_CLEANUPS.delete(cleanup);
                if (shell.__lineRuntimeCleanup === cleanup) {
                    delete shell.__lineRuntimeCleanup;
                }
                if (shell.__exportApi) {
                    delete shell.__exportApi;
                }
                delete shell.dataset.lineBound;
                return;
            }
            persistViewState();
            runtime.destroyed = true;
            inlineScrollSnapshot = null;
            inlineScrollSnapshotCapturedAt = 0;
            hideHover();
            if (resizeObserver) {
                resizeObserver.disconnect();
            } else {
                window.removeEventListener("resize", onResize);
            }
            clearTimeout(resizeTimer);
            if (runtime.fetchTimer !== null) {
                clearTimeout(runtime.fetchTimer);
                runtime.fetchTimer = null;
            }
            if (runtime.isPanning) {
                endPan();
            }
            clearClickZoomPointerTracking();
            canvas.removeEventListener("wheel", onWheel);
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointermove", onPointerMove);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", onPointerCancel);
            canvas.removeEventListener("pointerleave", onPointerLeave);
            canvas.removeEventListener("keydown", onKeyDown);
            if (panToggleButton) {
                panToggleButton.removeEventListener("click", onTogglePan);
            }
            if (zoomClickToggleButton) {
                zoomClickToggleButton.removeEventListener("click", onToggleClickZoom);
            }
            if (zoomInButton) {
                zoomInButton.removeEventListener("click", onZoomIn);
            }
            if (zoomOutButton) {
                zoomOutButton.removeEventListener("click", onZoomOut);
            }
            if (resetButton) {
                resetButton.removeEventListener("click", onReset);
            }
            if (jumpStartButton) {
                jumpStartButton.removeEventListener("click", onJumpStart);
            }
            if (jumpEndButton) {
                jumpEndButton.removeEventListener("click", onJumpEnd);
            }
            if (stepPrevButton) {
                stepPrevButton.removeEventListener("click", onStepPrev);
            }
            if (stepNextButton) {
                stepNextButton.removeEventListener("click", onStepNext);
            }
            if (qualitySelect) {
                qualitySelect.removeEventListener("change", onQualityChange);
            }
            if (windowSelect) {
                windowSelect.removeEventListener("change", onWindowChange);
            }
            if (jumpToIndexButton) {
                jumpToIndexButton.removeEventListener("click", onJumpToIndex);
            }
            if (jumpInput) {
                jumpInput.removeEventListener("keydown", onJumpInputKeyDown);
            }
            if (fullscreenButton) {
                fullscreenButton.removeEventListener("click", onFullscreenButtonClick);
            }
            if (inlineHeatmapLinked) {
                shell.removeEventListener("pointerdown", snapshotInlineScroll, true);
                shell.removeEventListener("click", restoreInlineScroll, true);
                shell.removeEventListener("change", restoreInlineScroll, true);
            }
            document.removeEventListener("keydown", onFullscreenEsc);
            if (runtime.fullscreenActive) {
                rememberLineFullscreen(runtime.selectionKey);
            }
            const shouldUnlockDocument =
                runtime.fullscreenActive || shell.classList.contains("is-fullscreen");
            exitPanelFullscreen();
            runtime.fullscreenActive = false;
            if (shouldUnlockDocument) {
                setDocumentFullscreenLock(false);
            }
            shell.classList.remove("is-fullscreen");
            LINE_RUNTIME_CLEANUPS.delete(cleanup);
            if (shell.__lineRuntimeCleanup === cleanup) {
                delete shell.__lineRuntimeCleanup;
            }
            if (shell.__exportApi) {
                delete shell.__exportApi;
            }
            delete shell.dataset.lineBound;
        };

        shell.__lineRuntimeCleanup = cleanup;
        LINE_RUNTIME_CLEANUPS.add(cleanup);
        return cleanup;
    }
    if (typeof initializeLineRuntime !== "undefined") {
        moduleState.initializeLineRuntime = initializeLineRuntime;
        global.initializeLineRuntime = initializeLineRuntime;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime/lineRuntime");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Implements canvas heatmap runtime with zoom/pan/plot mode, linked line plot, and export support.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime/heatmapRuntime.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime/heatmapRuntime.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime.heatmapRuntime");

    // --- Heatmap canvas constants ---
    const HEATMAP_MAX_SIZE = 1024;              // maximum downsampled canvas dimension (px)
    const HEATMAP_MIN_ZOOM = 1;                 // 1x = fit-to-window
    const HEATMAP_MAX_ZOOM = 8;                 // maximum zoom magnification
    const HEATMAP_PAN_START_ZOOM = 1.2;         // panning is only active above this zoom level
    const HEATMAP_SELECTION_UPDATE_DEBOUNCE_MS = 140;
    const HEATMAP_SELECTION_CACHE_LIMIT = 12;   // max cached heatmap datasets before oldest is evicted
    const HEATMAP_SELECTION_DATA_CACHE = new Map();  // raw data cache keyed by selection string
    const HEATMAP_SELECTION_VIEW_CACHE = new Map();  // rendered ImageData cache keyed by selection+colormap
    const HEATMAP_FULLSCREEN_RESTORE_TTL_MS = 1200;  // ms a restore target stays live after fullscreen exit
    let heatmapFullscreenRestore = null;
    const previewRenderModule = ns.components?.viewerPanel?.render?.previews || null;
    const buildImageHistogramData =
        typeof previewRenderModule?.buildImageHistogramData === "function"
            ? previewRenderModule.buildImageHistogramData
            : typeof global.buildImageHistogramData === "function"
                ? global.buildImageHistogramData
                : null;
    const renderImageHistogramMarkup =
        typeof previewRenderModule?.renderImageHistogramMarkup === "function"
            ? previewRenderModule.renderImageHistogramMarkup
            : typeof global.renderImageHistogramMarkup === "function"
                ? global.renderImageHistogramMarkup
                : null;
    const renderImageHistogramEmptyMarkup =
        typeof previewRenderModule?.renderImageHistogramEmptyMarkup === "function"
            ? previewRenderModule.renderImageHistogramEmptyMarkup
            : typeof global.renderImageHistogramEmptyMarkup === "function"
                ? global.renderImageHistogramEmptyMarkup
                : null;

    // Per-colormap RGB stop arrays used by the linear interpolation colormap pipeline for pixel rendering
    const HEATMAP_COLOR_STOPS = Object.freeze({
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

    function getColorStops(name) {
        return HEATMAP_COLOR_STOPS[name] || HEATMAP_COLOR_STOPS.viridis;
    }

    function interpolateColor(stops, ratio) {
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

    function buildTicks(size, count = 6) {
        const total = Math.max(0, Number(size) || 0);
        if (total <= 0) {
            return [];
        }
        if (total === 1) {
            return [0];
        }
        const target = Math.max(2, Math.min(count, total));
        const ticks = new Set([0, total - 1]);
        for (let index = 1; index < target - 1; index += 1) {
            ticks.add(Math.round((index / (target - 1)) * (total - 1)));
        }
        return Array.from(ticks).sort((a, b) => a - b);
    }

    /**
     * Build tick marks for the currently visible viewport portion of an axis.
     * @param {number} totalSize  Total number of cells on this axis (rows or cols)
     * @param {number} panOffset  runtime.panX or runtime.panY (negative when panned)
     * @param {number} zoom       runtime.zoom
     * @param {number} chartSpan  layout.chartWidth or layout.chartHeight
     * @param {number} count      desired number of ticks
     * @returns {{dataIndex: number, screenRatio: number}[]}  dataIndex = cell index, screenRatio = 0..1 position on chart axis
     */
    function buildViewportTicks(totalSize, panOffset, zoom, chartSpan, count = 6) {
        if (totalSize <= 0 || chartSpan <= 0) return [];
        // visible data range in cell coordinates
        const startCell = (-panOffset / (chartSpan * zoom)) * totalSize;
        const visibleCells = totalSize / zoom;
        const endCell = startCell + visibleCells;
        // clamp to data bounds
        const s = Math.max(0, startCell);
        const e = Math.min(totalSize - 1, endCell);
        if (s >= e) return [{ dataIndex: Math.round(s), screenRatio: 0.5 }];
        // nice tick spacing
        const span = e - s;
        const raw = span / Math.max(1, count - 1);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const candidates = [1, 2, 5, 10];
        let step = mag;
        for (const c of candidates) {
            if (c * mag >= raw) { step = c * mag; break; }
        }
        step = Math.max(1, Math.round(step));
        const first = Math.ceil(s / step) * step;
        const ticks = [];
        for (let v = first; v <= e; v += step) {
            // screen position ratio (0..1) within the chart area
            const ratio = totalSize <= 1 ? 0.5 : v / (totalSize - 1);
            // screen position accounting for zoom + pan
            const screenPos = ratio * chartSpan * zoom + panOffset;
            const screenRatio = screenPos / chartSpan;
            if (screenRatio >= -0.01 && screenRatio <= 1.01) {
                ticks.push({ dataIndex: Math.round(v), screenRatio: clamp(screenRatio, 0, 1) });
            }
        }
        return ticks;
    }

    function formatScaleValue(value) {
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

    function toFiniteNumber(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) {
                return null;
            }
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : null;
        }

        return null;
    }

    function toDisplayRow(totalRows, rowIndex) {
        const rows = Math.max(0, Number(totalRows) || 0);
        const row = Math.max(0, Number(rowIndex) || 0);
        if (rows <= 0) {
            return 0;
        }
        return Math.max(0, rows - 1 - row);
    }

    function normalizeHeatmapGrid(data) {
        if (!Array.isArray(data) || !data.length || !Array.isArray(data[0])) {
            return null;
        }

        const rows = data.length;
        const cols = data[0].length;
        if (!cols) {
            return null;
        }

        const values = new Float64Array(rows * cols);
        let hasFiniteValue = false;
        let min = Infinity;
        let max = -Infinity;
        let cursor = 0;

        for (let row = 0; row < rows; row += 1) {
            const sourceRow = Array.isArray(data[row]) ? data[row] : [];
            for (let col = 0; col < cols; col += 1) {
                const numeric = Number(sourceRow[col]);
                if (Number.isFinite(numeric)) {
                    values[cursor] = numeric;
                    hasFiniteValue = true;
                    min = Math.min(min, numeric);
                    max = Math.max(max, numeric);
                } else {
                    values[cursor] = Number.NaN;
                }
                cursor += 1;
            }
        }

        if (!hasFiniteValue) {
            min = 0;
            max = 1;
        }
        if (min === max) {
            max = min + 1;
        }

        return {
            rows,
            cols,
            values,
            min,
            max,
        };
    }

    const LUT_SIZE = 256;
    const _lutCache = new Map();

    function buildColorLUT(colormap) {
        const key = colormap;
        if (_lutCache.has(key)) return _lutCache.get(key);

        const stops = getColorStops(colormap);
        // Flat Uint8Array: [R0,G0,B0, R1,G1,B1, ...] for 256 entries
        const lut = new Uint8Array(LUT_SIZE * 3);
        for (let i = 0; i < LUT_SIZE; i += 1) {
            const ratio = i / (LUT_SIZE - 1);
            const index = ratio * (stops.length - 1);
            const lower = Math.floor(index);
            const upper = Math.min(lower + 1, stops.length - 1);
            const frac = index - lower;
            const [r1, g1, b1] = stops[lower];
            const [r2, g2, b2] = stops[upper];
            const off = i * 3;
            lut[off] = (r1 + (r2 - r1) * frac + 0.5) | 0;
            lut[off + 1] = (g1 + (g2 - g1) * frac + 0.5) | 0;
            lut[off + 2] = (b1 + (b2 - b1) * frac + 0.5) | 0;
        }
        _lutCache.set(key, lut);
        return lut;
    }

    function createHeatmapBitmap(grid, min, max, colormap) {
        const surface = document.createElement("canvas");
        surface.width = grid.cols;
        surface.height = grid.rows;
        const context = surface.getContext("2d");
        if (!context) {
            return null;
        }

        const imageData = context.createImageData(grid.cols, grid.rows);
        const pixels = imageData.data;
        const lut = buildColorLUT(colormap);
        const range = max - min || 1;
        const scale = (LUT_SIZE - 1) / range;
        const values = grid.values;
        const len = values.length;

        for (let i = 0; i < len; i += 1) {
            const v = values[i];
            // LUT index: clamp 0..255
            const lutIdx = Number.isFinite(v)
                ? Math.max(0, Math.min(LUT_SIZE - 1, ((v - min) * scale + 0.5) | 0))
                : 0;
            const lutOff = lutIdx * 3;
            const pOff = i << 2;           // i * 4
            pixels[pOff] = lut[lutOff];
            pixels[pOff + 1] = lut[lutOff + 1];
            pixels[pOff + 2] = lut[lutOff + 2];
            pixels[pOff + 3] = 255;
        }

        context.putImageData(imageData, 0, 0);
        return surface;
    }

    function rememberHeatmapFullscreen(selectionKey) {
        if (!selectionKey) {
            heatmapFullscreenRestore = null;
            return;
        }
        heatmapFullscreenRestore = {
            key: selectionKey,
            expiresAt: Date.now() + HEATMAP_FULLSCREEN_RESTORE_TTL_MS,
        };
    }

    function consumeHeatmapFullscreenRestore(selectionKey) {
        if (!heatmapFullscreenRestore || !selectionKey) {
            return false;
        }
        const { key, expiresAt } = heatmapFullscreenRestore;
        heatmapFullscreenRestore = null;
        return key === selectionKey && Date.now() <= expiresAt;
    }

    function getLayout(width, height) {
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

        return {
            chartX,
            chartY,
            chartWidth,
            chartHeight,
            colorBarX,
            colorBarY,
            colorBarWidth,
        };
    }

    function renderLineToolIcon(kind) {
        if (kind === "pan") {
            return `
      <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1v14M1 8h14M8 1 6.3 2.7M8 1l1.7 1.7M8 15l-1.7-1.7M8 15l1.7-1.7M1 8l1.7-1.7M1 8l1.7 1.7M15 8l-1.7-1.7M15 8l-1.7 1.7"></path>
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

    function renderLineIconToolButton(label, dataAttr, kind) {
        return `
    <button
      type="button"
      class="line-tool-btn line-tool-btn-icon"
      ${dataAttr}="true"
      aria-label="${label}"
      title="${label}"
    >
      ${renderLineToolIcon(kind)}
    </button>
  `;
    }

    function renderLinkedLineShellMarkup(config) {
        return `
    <div
      class="line-chart-shell line-chart-shell-full heatmap-inline-line-shell"
      data-line-shell="true"
      data-line-file-key="${escapeHtml(config.fileKey || "")}"
      data-line-file-etag="${escapeHtml(config.fileEtag || "")}"
      data-line-path="${escapeHtml(config.path || "/")}"
      data-line-display-dims="${escapeHtml(config.displayDims || "")}"
      data-line-fixed-indices="${escapeHtml(config.fixedIndices || "")}"
      data-line-selection-key="${escapeHtml(config.selectionKey || "")}"
      data-line-total-points="${config.totalPoints}"
      data-line-index="${config.lineIndex}"
      data-line-dim="${escapeHtml(config.lineDim || "row")}"
      data-line-selected-point="${Number.isFinite(config.selectedPointIndex) ? config.selectedPointIndex : ""}"
      data-line-notation="${escapeHtml(config.notation || "auto")}"
      data-line-grid="${config.lineGrid ? "1" : "0"}"
      data-line-aspect="${escapeHtml(config.lineAspect || "line")}"
      data-line-quality="${LINE_DEFAULT_QUALITY}"
      data-line-overview-max-points="${LINE_DEFAULT_OVERVIEW_MAX_POINTS}"
      data-line-exact-max-points="${LINE_EXACT_MAX_POINTS}"
    >
      <div class="line-chart-toolbar">
        <div class="line-tool-group">
          ${renderLineIconToolButton("Hand", "data-line-pan-toggle", "pan")}
          ${renderLineIconToolButton("Zoom on click", "data-line-zoom-click-toggle", "zoom-click")}
          ${renderLineIconToolButton("Zoom in", "data-line-zoom-in", "zoom-in")}
          ${renderLineIconToolButton("Zoom out", "data-line-zoom-out", "zoom-out")}
          ${renderLineIconToolButton("Reset view", "data-line-reset-view", "reset")}
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
          ${renderLineIconToolButton("Fullscreen", "data-line-fullscreen-toggle", "fullscreen")}
          <span class="line-zoom-label" data-line-range-label="true">Range: --</span>
        </div>
      </div>
      <div class="line-chart-stage">
        <div class="line-chart-canvas" data-line-canvas="true" tabindex="0" role="application" aria-label="Line chart">
          <svg
            viewBox="0 0 1024 420"
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
    </div>
  `;
    }

    function renderLinkedLinePanelMarkup(title, config) {
        return `
    <div class="heatmap-linked-line-panel">
      <div class="heatmap-linked-line-panel-title">${escapeHtml(title || "Linked profile")}</div>
      ${renderLinkedLineShellMarkup(config)}
    </div>
  `;
    }

    function initializeHeatmapRuntime(shell) {
        if (!shell || shell.dataset.heatmapBound === "true") {
            return;
        }

        const canvasHost = shell.querySelector("[data-heatmap-canvas]");
        const canvas = shell.querySelector("[data-heatmap-surface]");
        const tooltip = shell.querySelector("[data-heatmap-hover]");
        const panToggleButton = shell.querySelector("[data-heatmap-pan-toggle]");
        const plotToggleButton = shell.querySelector("[data-heatmap-plot-toggle]");
        const intensityToggleButton = shell.querySelector("[data-heatmap-intensity-toggle]");
        const zoomInButton = shell.querySelector("[data-heatmap-zoom-in]");
        const zoomOutButton = shell.querySelector("[data-heatmap-zoom-out]");
        const resetButton = shell.querySelector("[data-heatmap-reset-view]");
        const fullscreenButton = shell.querySelector("[data-heatmap-fullscreen-toggle]");
        const zoomLabel = shell.querySelector("[data-heatmap-zoom-label]");
        const rangeLabel = shell.querySelector("[data-heatmap-range-label]");
        const minStat = shell.querySelector("[data-heatmap-stat-min]");
        const maxStat = shell.querySelector("[data-heatmap-stat-max]");
        const rangeStat = shell.querySelector("[data-heatmap-stat-range]");
        const histogramRoot = shell.querySelector("[data-image-histogram-root]");
        const intensityOverlay = shell.querySelector("[data-heatmap-intensity-overlay]");
        const intensityWindow = shell.querySelector("[data-heatmap-intensity-window]");
        const intensityUpperMask = shell.querySelector('[data-heatmap-intensity-mask="upper"]');
        const intensityLowerMask = shell.querySelector('[data-heatmap-intensity-mask="lower"]');
        const intensityMinHandle = shell.querySelector('[data-heatmap-intensity-handle="min"]');
        const intensityMaxHandle = shell.querySelector('[data-heatmap-intensity-handle="max"]');
        let linkedPlotPanel = shell.querySelector("[data-heatmap-linked-plot]");
        let linkedPlotTitle = shell.querySelector("[data-heatmap-linked-title]");
        let linkedPlotShellHost = shell.querySelector("[data-heatmap-linked-shell-host]");
        let linkedPlotRowButton = shell.querySelector('[data-heatmap-plot-axis="row"]');
        let linkedPlotColButton = shell.querySelector('[data-heatmap-plot-axis="col"]');
        let linkedPlotCloseButton = shell.querySelector("[data-heatmap-plot-close]");
        const statusElement =
            shell.closest(".data-section")?.querySelector("[data-heatmap-status]") || null;

        if (!canvasHost || !canvas) {
            return;
        }

        const fileKey = shell.dataset.heatmapFileKey || "";
        const fileEtag = shell.dataset.heatmapFileEtag || "";
        const path = shell.dataset.heatmapPath || "/";
        const heatmapMode = shell.dataset.heatmapMode || "heatmap";
        const isImageMode = heatmapMode === "image";
        const displayDims = shell.dataset.heatmapDisplayDims || "";
        const fixedIndices = shell.dataset.heatmapFixedIndices || "";
        const selectionKey =
            shell.dataset.heatmapSelectionKey ||
            buildHeatmapSelectionKey(fileKey, path, displayDims, fixedIndices);
        const cacheKey = `${selectionKey}|${fileEtag || "no-etag"}`;
        const colormap = shell.dataset.heatmapColormap || "viridis";
        const showGrid = shell.dataset.heatmapGrid !== "0";
        const lineNotation = shell.dataset.heatmapLineNotation || "auto";
        const lineGrid = shell.dataset.heatmapLineGrid !== "0";
        const lineAspect = shell.dataset.heatmapLineAspect || "line";
        const histogramAriaLabel = isImageMode ? "Image histogram" : "Heatmap histogram";
        const histogramBaseSubtitle = isImageMode
            ? "Intensity distribution for the current image slice"
            : "Value distribution for the current heatmap slice";
        const histogramPreviewSubtitle = isImageMode
            ? "Preview grayscale distribution for the current slice"
            : "Preview value distribution for the current slice";
        const histogramHighResSubtitle = isImageMode
            ? "Displayed grayscale distribution for the current slice"
            : "Displayed value distribution for the current slice";

        if (!fileKey) {
            setMatrixStatus(statusElement, "No heatmap data available.", "error");
            return;
        }

        if (!linkedPlotPanel || !linkedPlotTitle || !linkedPlotShellHost) {
            const linkedPanelMarkup = `
      <div class="heatmap-linked-plot" data-heatmap-linked-plot="true" hidden>
        <div class="heatmap-linked-plot-header">
          <div class="heatmap-linked-plot-title" data-heatmap-linked-title="true">
            Plot mode: click a heatmap cell to inspect row and column profiles.
          </div>
          <div class="heatmap-linked-plot-actions">
            <button
              type="button"
              class="line-tool-btn line-tool-btn-icon"
              data-heatmap-plot-close="true"
              aria-label="Close plot"
              title="Close plot"
            >
              <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 4l8 8M12 4l-8 8"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="heatmap-linked-plot-shell-host" data-heatmap-linked-shell-host="true"></div>
      </div>
    `;
            const statsNode = shell.querySelector(".line-stats");
            if (statsNode) {
                statsNode.insertAdjacentHTML("beforebegin", linkedPanelMarkup);
            } else {
                shell.insertAdjacentHTML("beforeend", linkedPanelMarkup);
            }
            linkedPlotPanel = shell.querySelector("[data-heatmap-linked-plot]");
            linkedPlotTitle = shell.querySelector("[data-heatmap-linked-title]");
            linkedPlotShellHost = shell.querySelector("[data-heatmap-linked-shell-host]");
            linkedPlotRowButton = shell.querySelector('[data-heatmap-plot-axis="row"]');
            linkedPlotColButton = shell.querySelector('[data-heatmap-plot-axis="col"]');
            linkedPlotCloseButton = shell.querySelector("[data-heatmap-plot-close]");
        }

        shell.dataset.heatmapBound = "true";

        const runtime = {
            fileKey,
            fileEtag,
            path,
            displayDims,
            fixedIndices,
            selectionKey,
            cacheKey,
            colormap,
            showGrid,
            zoom: 1,
            panX: 0,
            panY: 0,
            panEnabled: false,
            plottingEnabled: false,
            isPanning: false,
            panPointerId: null,
            panStartX: 0,
            panStartY: 0,
            panStartOffsetX: 0,
            panStartOffsetY: 0,
            rows: 0,
            cols: 0,
            values: null,
            min: 0,
            max: 1,
            bitmap: null,
            maxSizeClamped: false,
            effectiveMaxSize: HEATMAP_MAX_SIZE,
            layout: null,
            hover: null,
            hoverDisplayRow: null,
            selectedCell: null,
            plotAxis: "row",
            linkedPlotOpen: false,
            linkedLineCleanup: null,
            activeCancelKeys: new Set(),
            destroyed: false,
            loadedPhase: "preview",
            fullscreenActive: false,
            loadSequence: 0,
            intensityEnabled: false,
            intensityMin: null,
            intensityMax: null,
            intensityDragHandle: null,
            intensityPointerId: null,
            intensityDragTarget: null,
        };
        let pendingSelectionUpdate = null;
        let selectionUpdateTimer = null;

        if (consumeHeatmapFullscreenRestore(selectionKey)) {
            runtime.fullscreenActive = true;
        }

        function updateLabels() {
            if (zoomLabel) {
                zoomLabel.textContent = `${Math.round(runtime.zoom * 100)}%`;
            }
            if (rangeLabel) {
                rangeLabel.textContent =
                    runtime.rows > 0 && runtime.cols > 0
                        ? `Grid: ${runtime.rows.toLocaleString()} x ${runtime.cols.toLocaleString()}`
                        : "Grid: --";
            }
            if (minStat) {
                minStat.textContent = `min: ${formatCell(runtime.min)}`;
            }
            if (maxStat) {
                maxStat.textContent = `max: ${formatCell(runtime.max)}`;
            }
            if (rangeStat) {
                rangeStat.textContent =
                    runtime.rows > 0 && runtime.cols > 0
                        ? `size: ${(runtime.rows * runtime.cols).toLocaleString()} cells`
                        : "size: --";
            }
        }

        function getRawIntensityBounds() {
            const rawMin = Number.isFinite(runtime.min) ? runtime.min : 0;
            let rawMax = Number.isFinite(runtime.max) ? runtime.max : rawMin + 1;
            if (!(rawMax > rawMin)) {
                rawMax = rawMin + 1;
            }
            return { rawMin, rawMax };
        }

        function getIntensityMinimumGap(rawMin, rawMax) {
            return Math.max((rawMax - rawMin) / 1024, 1e-6);
        }

        function syncIntensityRangeToData() {
            const { rawMin, rawMax } = getRawIntensityBounds();
            if (!runtime.intensityEnabled) {
                runtime.intensityMin = rawMin;
                runtime.intensityMax = rawMax;
                return {
                    rawMin,
                    rawMax,
                    displayMin: rawMin,
                    displayMax: rawMax,
                };
            }

            const minGap = getIntensityMinimumGap(rawMin, rawMax);
            let nextMin = Number.isFinite(runtime.intensityMin) ? runtime.intensityMin : rawMin;
            let nextMax = Number.isFinite(runtime.intensityMax) ? runtime.intensityMax : rawMax;
            nextMin = clamp(nextMin, rawMin, rawMax - minGap);
            nextMax = clamp(nextMax, nextMin + minGap, rawMax);
            runtime.intensityMin = nextMin;
            runtime.intensityMax = nextMax;

            return {
                rawMin,
                rawMax,
                displayMin: nextMin,
                displayMax: nextMax,
            };
        }

        function syncIntensityToggleState() {
            const canAdjustIntensity =
                runtime.rows > 0 &&
                runtime.cols > 0 &&
                Number.isFinite(runtime.min) &&
                Number.isFinite(runtime.max) &&
                runtime.max > runtime.min;

            if (intensityToggleButton) {
                intensityToggleButton.disabled = !canAdjustIntensity;
                intensityToggleButton.classList.toggle("active", runtime.intensityEnabled && canAdjustIntensity);
                const label = runtime.intensityEnabled ? "Disable intensity window" : "Intensity";
                intensityToggleButton.setAttribute("aria-label", label);
                intensityToggleButton.setAttribute("title", label);
            }
            if (intensityOverlay) {
                intensityOverlay.hidden = !(canAdjustIntensity && runtime.intensityEnabled && runtime.layout);
            }
        }

        function updateIntensityOverlay() {
            if (!intensityOverlay) {
                return;
            }
            syncIntensityToggleState();
            if (intensityOverlay.hidden || !runtime.layout) {
                return;
            }

            const { rawMin, rawMax, displayMin, displayMax } = syncIntensityRangeToData();
            const valueRange = rawMax - rawMin || 1;
            const layout = runtime.layout;
            const barLeft = layout.colorBarX;
            const barTop = layout.colorBarY;
            const barWidth = layout.colorBarWidth;
            const barHeight = layout.chartHeight;
            const upperY = barTop + ((rawMax - displayMax) / valueRange) * barHeight;
            const lowerY = barTop + ((rawMax - displayMin) / valueRange) * barHeight;
            const windowHeight = Math.max(2, lowerY - upperY);
            const handleX = barLeft + barWidth / 2;
            const upperMaskHeight = Math.max(0, upperY - barTop);
            const lowerMaskTop = clamp(lowerY, barTop, barTop + barHeight);
            const lowerMaskHeight = Math.max(0, barTop + barHeight - lowerMaskTop);

            if (intensityUpperMask) {
                intensityUpperMask.style.left = `${barLeft}px`;
                intensityUpperMask.style.top = `${barTop}px`;
                intensityUpperMask.style.width = `${barWidth}px`;
                intensityUpperMask.style.height = `${upperMaskHeight}px`;
            }
            if (intensityLowerMask) {
                intensityLowerMask.style.left = `${barLeft}px`;
                intensityLowerMask.style.top = `${lowerMaskTop}px`;
                intensityLowerMask.style.width = `${barWidth}px`;
                intensityLowerMask.style.height = `${lowerMaskHeight}px`;
            }
            if (intensityWindow) {
                intensityWindow.style.left = `${barLeft}px`;
                intensityWindow.style.top = `${upperY}px`;
                intensityWindow.style.width = `${barWidth}px`;
                intensityWindow.style.height = `${windowHeight}px`;
            }
            if (intensityMaxHandle) {
                intensityMaxHandle.style.left = `${handleX}px`;
                intensityMaxHandle.style.top = `${upperY}px`;
                intensityMaxHandle.setAttribute("title", `Upper intensity: ${formatScaleValue(displayMax)}`);
                intensityMaxHandle.setAttribute("aria-label", `Upper intensity: ${formatScaleValue(displayMax)}`);
            }
            if (intensityMinHandle) {
                intensityMinHandle.style.left = `${handleX}px`;
                intensityMinHandle.style.top = `${lowerY}px`;
                intensityMinHandle.setAttribute("title", `Lower intensity: ${formatScaleValue(displayMin)}`);
                intensityMinHandle.setAttribute("aria-label", `Lower intensity: ${formatScaleValue(displayMin)}`);
            }
        }

        function rebuildHeatmapBitmap() {
            if (!(runtime.values instanceof Float64Array) || runtime.rows <= 0 || runtime.cols <= 0) {
                runtime.bitmap = null;
                syncIntensityToggleState();
                updateIntensityOverlay();
                return false;
            }

            const { displayMin, displayMax } = syncIntensityRangeToData();
            const bitmap = createHeatmapBitmap(
                {
                    rows: runtime.rows,
                    cols: runtime.cols,
                    values: runtime.values,
                },
                displayMin,
                displayMax,
                runtime.colormap
            );
            if (!bitmap) {
                return false;
            }
            runtime.bitmap = bitmap;
            syncIntensityToggleState();
            return true;
        }

        function getImageHistogramApi() {
            if (!histogramRoot) {
                return null;
            }
            const histogramShell = histogramRoot.querySelector("[data-image-histogram-shell]");
            if (!histogramShell) {
                return null;
            }
            if (
                !histogramShell.__imageHistogramRuntimeApi &&
                typeof initializeImageHistogramRuntime === "function"
            ) {
                initializeImageHistogramRuntime(histogramShell);
            }
            return histogramShell.__imageHistogramRuntimeApi || null;
        }

        function setImageHistogramEmptyState(message) {
            if (!histogramRoot) {
                return;
            }
            const histogramApi = getImageHistogramApi();
            if (histogramApi && typeof histogramApi.setMessage === "function") {
                histogramApi.setMessage(message, {
                    title: "Histogram",
                    subtitle: histogramBaseSubtitle,
                    ariaLabel: histogramAriaLabel,
                });
                return;
            }
            if (typeof renderImageHistogramEmptyMarkup === "function") {
                histogramRoot.innerHTML = renderImageHistogramEmptyMarkup(message, {
                    title: "Histogram",
                    subtitle: histogramBaseSubtitle,
                    ariaLabel: histogramAriaLabel,
                });
                const nextHistogramApi = getImageHistogramApi();
                if (nextHistogramApi && typeof nextHistogramApi.setMessage === "function") {
                    nextHistogramApi.setMessage(message, {
                        title: "Histogram",
                        subtitle: histogramBaseSubtitle,
                        ariaLabel: histogramAriaLabel,
                    });
                }
            }
        }

        function updateImageHistogram() {
            if (!histogramRoot) {
                return;
            }
            if (
                typeof buildImageHistogramData !== "function" ||
                typeof renderImageHistogramMarkup !== "function"
            ) {
                setImageHistogramEmptyState("Histogram is unavailable in this build.");
                return;
            }
            const histogram = buildImageHistogramData(runtime.values, { binCount: 256 });
            if (!histogram) {
                setImageHistogramEmptyState("Histogram is unavailable for the current image slice.");
                return;
            }
            const histogramSubtitle =
                runtime.loadedPhase === "highres"
                    ? histogramHighResSubtitle
                    : histogramPreviewSubtitle;
            const histogramApi = getImageHistogramApi();
            if (histogramApi && typeof histogramApi.updateData === "function") {
                histogramApi.updateData(histogram, {
                    title: "Histogram",
                    subtitle: histogramSubtitle,
                    ariaLabel: histogramAriaLabel,
                    preserveViewState: true,
                });
                return;
            }
            histogramRoot.innerHTML = renderImageHistogramMarkup(histogram, {
                title: "Histogram",
                subtitle: histogramSubtitle,
                ariaLabel: histogramAriaLabel,
            });
            const nextHistogramApi = getImageHistogramApi();
            if (nextHistogramApi && typeof nextHistogramApi.updateData === "function") {
                nextHistogramApi.updateData(histogram, {
                    title: "Histogram",
                    subtitle: histogramSubtitle,
                    ariaLabel: histogramAriaLabel,
                    preserveViewState: true,
                });
            }
        }

        function persistViewState() {
            const persistedCell =
                runtime.selectedCell &&
                    Number.isFinite(runtime.selectedCell.row) &&
                    Number.isFinite(runtime.selectedCell.col)
                    ? {
                        row: runtime.selectedCell.row,
                        col: runtime.selectedCell.col,
                    }
                    : null;
            HEATMAP_SELECTION_VIEW_CACHE.set(runtime.cacheKey, {
                zoom: runtime.zoom,
                panX: runtime.panX,
                panY: runtime.panY,
                panEnabled: runtime.panEnabled === true,
                plottingEnabled: runtime.plottingEnabled === true,
                plotAxis: runtime.plotAxis === "col" ? "col" : "row",
                linkedPlotOpen: runtime.linkedPlotOpen === true && persistedCell !== null,
                selectedCell: persistedCell,
                intensityEnabled: runtime.intensityEnabled === true,
                intensityMin: runtime.intensityMin,
                intensityMax: runtime.intensityMax,
            });
            if (HEATMAP_SELECTION_VIEW_CACHE.size > HEATMAP_SELECTION_CACHE_LIMIT) {
                const oldestKey = HEATMAP_SELECTION_VIEW_CACHE.keys().next().value;
                if (oldestKey) {
                    HEATMAP_SELECTION_VIEW_CACHE.delete(oldestKey);
                }
            }
        }

        function buildLoadedStatusText(phase = runtime.loadedPhase) {
            const prefix = phase === "highres" ? "High-res heatmap loaded" : "Preview heatmap loaded";
            let statusText = `${prefix} (${runtime.rows.toLocaleString()} x ${runtime.cols.toLocaleString()}).`;
            statusText += " Wheel to zoom. Use Hand to pan.";
            if (runtime.maxSizeClamped && phase === "highres") {
                statusText += ` Clamped to ${runtime.effectiveMaxSize}.`;
            }
            return statusText;
        }

        function clampPanForZoom(panX, panY, zoomLevel = runtime.zoom) {
            const layout = runtime.layout;
            if (!layout || zoomLevel <= HEATMAP_MIN_ZOOM) {
                return { x: 0, y: 0 };
            }
            const minX = layout.chartWidth - layout.chartWidth * zoomLevel;
            const minY = layout.chartHeight - layout.chartHeight * zoomLevel;
            return {
                x: clamp(panX, minX, 0),
                y: clamp(panY, minY, 0),
            };
        }

        function restoreCachedHeatmapData() {
            // Rehydrate last rendered bitmap data and viewport so quick back/forth selection feels instant.
            const cachedData = HEATMAP_SELECTION_DATA_CACHE.get(runtime.cacheKey);
            if (!cachedData) {
                return false;
            }

            const grid = {
                rows: Math.max(0, Number(cachedData.rows) || 0),
                cols: Math.max(0, Number(cachedData.cols) || 0),
                values: cachedData.values,
            };
            if (!grid.rows || !grid.cols || !(grid.values instanceof Float64Array)) {
                return false;
            }

            const cachedMin = Number(cachedData.min);
            const cachedMax = Number(cachedData.max);
            const min = Number.isFinite(cachedMin) ? cachedMin : 0;
            const max = Number.isFinite(cachedMax) && cachedMax !== min ? cachedMax : min + 1;

            runtime.rows = grid.rows;
            runtime.cols = grid.cols;
            runtime.values = grid.values;
            runtime.min = min;
            runtime.max = max;
            runtime.maxSizeClamped = cachedData.maxSizeClamped === true;
            runtime.effectiveMaxSize = Number(cachedData.effectiveMaxSize) || HEATMAP_MAX_SIZE;
            runtime.loadedPhase = cachedData.phase === "highres" ? "highres" : "preview";

            // View cache stores interaction state (zoom/pan/plot mode/selection), separate from pixel data cache.
            const cachedView = HEATMAP_SELECTION_VIEW_CACHE.get(runtime.cacheKey);
            if (cachedView && typeof cachedView === "object") {
                runtime.zoom = clamp(Number(cachedView.zoom) || HEATMAP_MIN_ZOOM, HEATMAP_MIN_ZOOM, HEATMAP_MAX_ZOOM);
                runtime.panX = Number(cachedView.panX) || 0;
                runtime.panY = Number(cachedView.panY) || 0;
                runtime.panEnabled = cachedView.panEnabled === true;
                runtime.plottingEnabled = cachedView.plottingEnabled === true;
                runtime.plotAxis = cachedView.plotAxis === "col" ? "col" : "row";
                runtime.selectedCell = normalizeSelectedCell(cachedView.selectedCell);
                runtime.linkedPlotOpen = cachedView.linkedPlotOpen === true && runtime.selectedCell !== null;
                runtime.intensityEnabled = cachedView.intensityEnabled === true;
                runtime.intensityMin = toFiniteNumber(cachedView.intensityMin);
                runtime.intensityMax = toFiniteNumber(cachedView.intensityMax);
            } else {
                runtime.zoom = HEATMAP_MIN_ZOOM;
                runtime.panX = 0;
                runtime.panY = 0;
                runtime.plottingEnabled = false;
                runtime.plotAxis = "row";
                runtime.selectedCell = null;
                runtime.linkedPlotOpen = false;
                runtime.intensityEnabled = false;
                runtime.intensityMin = min;
                runtime.intensityMax = max;
            }

            if (!rebuildHeatmapBitmap()) {
                return false;
            }

            hideTooltip();
            updateLabels();
            setPanState();
            updateImageHistogram();
            renderHeatmap();

            const clampedPan = clampPanForZoom(runtime.panX, runtime.panY, runtime.zoom);
            runtime.panX = clampedPan.x;
            runtime.panY = clampedPan.y;
            renderHeatmap();
            persistViewState();

            if (runtime.linkedPlotOpen && runtime.selectedCell) {
                renderLinkedPlotLine();
            }

            setMatrixStatus(statusElement, buildLoadedStatusText(runtime.loadedPhase), "info");
            return true;
        }

        function setLinkedPlotTitle(cell = runtime.selectedCell) {
            if (!linkedPlotTitle) {
                return;
            }

            if (!cell) {
                linkedPlotTitle.textContent = "Plot mode: click a heatmap cell to inspect row and column profiles.";
                return;
            }

            linkedPlotTitle.textContent = `Selected Y ${cell.displayRow}, Col ${cell.col} | Value ${formatCell(
                cell.value,
                "auto"
            )} | Showing row and column profiles`;
        }

        function syncLinkedPlotLayoutState() {
            const linkedVisible = Boolean(linkedPlotPanel && linkedPlotPanel.hidden === false);
            shell.classList.toggle("has-linked-plot", linkedVisible);
        }

        function syncPlotAxisButtons() {
            if (linkedPlotRowButton) {
                linkedPlotRowButton.classList.toggle("active", runtime.plotAxis === "row");
            }
            if (linkedPlotColButton) {
                linkedPlotColButton.classList.toggle("active", runtime.plotAxis === "col");
            }
        }

        function clearLinkedLineRuntime() {
            if (typeof runtime.linkedLineCleanup === "function") {
                try {
                    runtime.linkedLineCleanup();
                } catch (_error) {
                    // ignore cleanup errors for detached nodes
                }
            }
            runtime.linkedLineCleanup = null;
            if (linkedPlotShellHost) {
                linkedPlotShellHost.innerHTML = "";
            }
        }

        function closeLinkedPlot() {
            runtime.selectedCell = null;
            runtime.linkedPlotOpen = false;
            clearLinkedLineRuntime();
            if (linkedPlotPanel) {
                linkedPlotPanel.hidden = true;
                linkedPlotPanel.classList.remove("is-visible");
            }
            syncLinkedPlotLayoutState();
            setLinkedPlotTitle(null);
            syncPlotAxisButtons();
            renderHeatmap();
        }

        function openLinkedPlot() {
            runtime.linkedPlotOpen = true;
            if (linkedPlotPanel) {
                linkedPlotPanel.hidden = false;
                linkedPlotPanel.classList.add("is-visible");
            }
            syncLinkedPlotLayoutState();
        }

        function isScrollableY(element) {
            if (typeof window === "undefined" || !element) {
                return false;
            }
            const style = window.getComputedStyle(element);
            const overflowY = (style.overflowY || "").toLowerCase();
            const canScrollY =
                overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
            return canScrollY && element.scrollHeight > element.clientHeight + 1;
        }

        function resolveLinkedPlotScrollHost() {
            let current = linkedPlotPanel ? linkedPlotPanel.parentElement : null;
            while (current) {
                if (isScrollableY(current)) {
                    return current;
                }
                current = current.parentElement;
            }
            if (typeof document !== "undefined" && document.scrollingElement) {
                return document.scrollingElement;
            }
            return null;
        }

        function scrollLinkedPlotIntoView(smooth = true) {
            if (
                runtime.destroyed ||
                runtime.fullscreenActive ||
                !linkedPlotPanel ||
                linkedPlotPanel.hidden
            ) {
                return;
            }

            const scrollHost = resolveLinkedPlotScrollHost();
            const rootScroller =
                typeof document !== "undefined"
                    ? document.scrollingElement || document.documentElement || document.body
                    : null;
            if (scrollHost && scrollHost !== rootScroller) {
                const panelRect = linkedPlotPanel.getBoundingClientRect();
                const hostRect = scrollHost.getBoundingClientRect();
                const margin = 12;
                const outsideViewport =
                    panelRect.top < hostRect.top + margin || panelRect.bottom > hostRect.bottom - margin;
                if (!outsideViewport) {
                    return;
                }
                const targetTop = Math.max(
                    0,
                    scrollHost.scrollTop + (panelRect.top - hostRect.top) - margin
                );
                try {
                    scrollHost.scrollTo({
                        top: targetTop,
                        behavior: smooth ? "smooth" : "auto",
                    });
                } catch (_error) {
                    scrollHost.scrollTop = targetTop;
                }
                return;
            }

            try {
                linkedPlotPanel.scrollIntoView({
                    block: "start",
                    inline: "nearest",
                    behavior: smooth ? "smooth" : "auto",
                });
            } catch (_error) {
                linkedPlotPanel.scrollIntoView(true);
            }
        }

        function revealLinkedPlotIntoView() {
            scrollLinkedPlotIntoView(false);
            if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(() => scrollLinkedPlotIntoView(true));
            } else {
                scrollLinkedPlotIntoView(true);
            }
            setTimeout(() => scrollLinkedPlotIntoView(false), 220);
        }

        function normalizeSelectedCell(cell) {
            if (!cell) {
                return null;
            }
            const row = clamp(Number(cell.row), 0, Math.max(0, runtime.rows - 1));
            const col = clamp(Number(cell.col), 0, Math.max(0, runtime.cols - 1));
            const value =
                runtime.values && runtime.rows > 0 && runtime.cols > 0
                    ? runtime.values[row * runtime.cols + col]
                    : cell.value;
            return {
                row,
                col,
                value,
                displayRow: toDisplayRow(runtime.rows, row),
            };
        }

        function selectCellForPlot(cell) {
            const normalized = normalizeSelectedCell(cell);
            if (!normalized) {
                return false;
            }

            const isSameSelection =
                runtime.selectedCell &&
                runtime.selectedCell.row === normalized.row &&
                runtime.selectedCell.col === normalized.col &&
                linkedPlotPanel &&
                linkedPlotPanel.hidden === false;

            runtime.selectedCell = normalized;
            runtime.linkedPlotOpen = true;
            persistViewState();
            setMatrixStatus(
                statusElement,
                `Plot selected at Y ${normalized.displayRow}, Col ${normalized.col}. Loading row and column profiles...`,
                "info"
            );
            renderHeatmap();
            if (!isSameSelection) {
                renderLinkedPlotLine({ revealPanel: true });
            } else {
                setLinkedPlotTitle(runtime.selectedCell);
                syncPlotAxisButtons();
            }
            return true;
        }

        function resolveFallbackHoverCell() {
            if (!runtime.hover) {
                return null;
            }
            return {
                row: runtime.hover.row,
                col: runtime.hover.col,
                value: runtime.hover.value,
                displayRow: toDisplayRow(runtime.rows, runtime.hover.row),
            };
        }

        function renderLinkedPlotLine(options = {}) {
            if (!runtime.selectedCell || !linkedPlotShellHost) {
                return;
            }

            const selectedCell = runtime.selectedCell;
            if (
                !Number.isFinite(selectedCell.row) ||
                !Number.isFinite(selectedCell.col) ||
                runtime.rows <= 0 ||
                runtime.cols <= 0
            ) {
                return;
            }
            const lineConfigs = [
                {
                    title: `Row profile: Y ${selectedCell.displayRow} across columns`,
                    fileKey: runtime.fileKey,
                    fileEtag: runtime.fileEtag,
                    path: runtime.path,
                    displayDims: runtime.displayDims,
                    fixedIndices: runtime.fixedIndices,
                    selectionKey: [
                        runtime.selectionKey,
                        "heatmap-plot",
                        "row",
                        selectedCell.row,
                        selectedCell.col,
                    ].join("|"),
                    totalPoints: runtime.cols,
                    lineIndex: selectedCell.row,
                    lineDim: "row",
                    selectedPointIndex: selectedCell.col,
                    notation: lineNotation,
                    lineGrid,
                    lineAspect,
                },
                {
                    title: `Column profile: Col ${selectedCell.col} across Y`,
                    fileKey: runtime.fileKey,
                    fileEtag: runtime.fileEtag,
                    path: runtime.path,
                    displayDims: runtime.displayDims,
                    fixedIndices: runtime.fixedIndices,
                    selectionKey: [
                        runtime.selectionKey,
                        "heatmap-plot",
                        "col",
                        selectedCell.row,
                        selectedCell.col,
                    ].join("|"),
                    totalPoints: runtime.rows,
                    lineIndex: selectedCell.col,
                    lineDim: "col",
                    selectedPointIndex: selectedCell.row,
                    notation: lineNotation,
                    lineGrid,
                    lineAspect,
                },
            ];

            openLinkedPlot();
            setLinkedPlotTitle(selectedCell);
            syncPlotAxisButtons();
            clearLinkedLineRuntime();

            linkedPlotShellHost.innerHTML = lineConfigs
                .map((config) => renderLinkedLinePanelMarkup(config.title, config))
                .join("");

            const lineShells = Array.from(linkedPlotShellHost.querySelectorAll("[data-line-shell]"));
            if (lineShells.length !== lineConfigs.length) {
                setMatrixStatus(statusElement, "Failed to mount linked row and column chart panels.", "error");
                return;
            }
            const cleanups = [];
            lineShells.forEach((lineShell) => {
                const cleanup = initializeLineRuntime(lineShell);
                const resolvedCleanup =
                    typeof cleanup === "function"
                        ? cleanup
                        : typeof lineShell.__lineRuntimeCleanup === "function"
                            ? lineShell.__lineRuntimeCleanup
                            : null;
                if (typeof resolvedCleanup === "function") {
                    cleanups.push(resolvedCleanup);
                }
            });
            runtime.linkedLineCleanup = () => {
                cleanups.forEach((cleanup) => {
                    try {
                        cleanup();
                    } catch (_error) {
                        // ignore cleanup errors for detached linked charts
                    }
                });
            };
            persistViewState();
            if (options.revealPanel === true) {
                revealLinkedPlotIntoView();
            }
        }

        function setPanState() {
            canvasHost.classList.toggle("is-pan", runtime.panEnabled);
            canvasHost.classList.toggle("is-grabbing", runtime.isPanning);
            canvasHost.classList.toggle("is-plot", runtime.plottingEnabled);
            const cursor = runtime.isPanning
                ? "grabbing"
                : runtime.panEnabled
                    ? "grab"
                    : runtime.plottingEnabled
                        ? "crosshair"
                        : "default";
            canvasHost.style.cursor = cursor;
            canvas.style.cursor = cursor;
            if (panToggleButton) {
                panToggleButton.classList.toggle("active", runtime.panEnabled);
            }
            if (plotToggleButton) {
                plotToggleButton.classList.toggle("active", runtime.plottingEnabled);
                const label = runtime.plottingEnabled ? "Disable plotting" : "Plotting";
                plotToggleButton.setAttribute("aria-label", label);
                plotToggleButton.setAttribute("title", label);
            }
            syncIntensityToggleState();
        }

        function setDocumentFullscreenLock(locked) {
            if (typeof document === "undefined" || !document.body) {
                return;
            }
            document.body.classList.toggle("line-panel-fullscreen-active", locked);
        }

        function rerenderAfterFullscreenChange() {
            if (runtime.destroyed) {
                return;
            }
            renderHeatmap();
        }

        function syncFullscreenState() {
            const isFullscreen = runtime.fullscreenActive;
            shell.classList.toggle("is-fullscreen", isFullscreen);
            if (fullscreenButton) {
                const label = isFullscreen ? "Exit fullscreen" : "Fullscreen";
                fullscreenButton.setAttribute("aria-label", label);
                fullscreenButton.setAttribute("title", label);
                fullscreenButton.classList.toggle("active", isFullscreen);
            }
            setDocumentFullscreenLock(isFullscreen);
        }

        function hideTooltip() {
            if (tooltip) {
                tooltip.hidden = true;
            }
            runtime.hover = null;
            runtime.hoverDisplayRow = null;
        }

        function resizeCanvasForHost(context) {
            // Use canvas rect (content-box) instead of canvasHost rect to avoid
            // border-induced sizing/coordinate mismatch.
            const rect = canvas.getBoundingClientRect();
            const width = Math.max(320, Math.floor(rect.width || 320));
            const height = Math.max(240, Math.floor(rect.height || 240));
            const dpr = window.devicePixelRatio || 1;
            const targetWidth = Math.max(1, Math.floor(width * dpr));
            const targetHeight = Math.max(1, Math.floor(height * dpr));

            if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                canvas.width = targetWidth;
                canvas.height = targetHeight;
            }

            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            return { width, height };
        }

        function renderHeatmap() {
            if (runtime.destroyed) {
                return;
            }

            const context = canvas.getContext("2d");
            if (!context) {
                return;
            }

            const { width, height } = resizeCanvasForHost(context);
            const layout = getLayout(width, height);
            runtime.layout = layout;

            context.clearRect(0, 0, width, height);
            context.fillStyle = "#F8FAFF";
            context.fillRect(0, 0, width, height);
            context.fillStyle = "#FFFFFF";
            context.fillRect(layout.chartX, layout.chartY, layout.chartWidth, layout.chartHeight);

            if (runtime.bitmap) {
                const drawX = layout.chartX + runtime.panX;
                const drawY = layout.chartY + runtime.panY;
                const drawWidth = layout.chartWidth * runtime.zoom;
                const drawHeight = layout.chartHeight * runtime.zoom;

                context.save();
                context.beginPath();
                context.rect(layout.chartX, layout.chartY, layout.chartWidth, layout.chartHeight);
                context.clip();
                context.imageSmoothingEnabled = false;
                context.drawImage(runtime.bitmap, drawX, drawY, drawWidth, drawHeight);

                if (
                    runtime.showGrid &&
                    runtime.zoom >= 2 &&
                    runtime.rows > 0 &&
                    runtime.cols > 0 &&
                    runtime.rows <= 240 &&
                    runtime.cols <= 240
                ) {
                    const cellWidth = layout.chartWidth / runtime.cols;
                    const cellHeight = layout.chartHeight / runtime.rows;
                    context.save();
                    context.translate(drawX, drawY);
                    context.scale(runtime.zoom, runtime.zoom);
                    context.strokeStyle = "rgba(255,255,255,0.35)";
                    context.lineWidth = 1 / runtime.zoom;
                    for (let row = 0; row <= runtime.rows; row += 1) {
                        const y = row * cellHeight;
                        context.beginPath();
                        context.moveTo(0, y);
                        context.lineTo(layout.chartWidth, y);
                        context.stroke();
                    }
                    for (let col = 0; col <= runtime.cols; col += 1) {
                        const x = col * cellWidth;
                        context.beginPath();
                        context.moveTo(x, 0);
                        context.lineTo(x, layout.chartHeight);
                        context.stroke();
                    }
                    context.restore();
                }

                if (runtime.hover && runtime.rows > 0 && runtime.cols > 0) {
                    const cellWidth = (layout.chartWidth / runtime.cols) * runtime.zoom;
                    const cellHeight = (layout.chartHeight / runtime.rows) * runtime.zoom;
                    const x = drawX + runtime.hover.col * cellWidth;
                    const y = drawY + runtime.hover.row * cellHeight;
                    context.strokeStyle = "rgba(255,255,255,0.95)";
                    context.lineWidth = 1.25;
                    context.strokeRect(x, y, cellWidth, cellHeight);
                }

                if (runtime.selectedCell && runtime.rows > 0 && runtime.cols > 0) {
                    const cellWidth = (layout.chartWidth / runtime.cols) * runtime.zoom;
                    const cellHeight = (layout.chartHeight / runtime.rows) * runtime.zoom;
                    const x = drawX + runtime.selectedCell.col * cellWidth;
                    const y = drawY + runtime.selectedCell.row * cellHeight;
                    const chartLeft = layout.chartX;
                    const chartTop = layout.chartY;
                    const chartRight = layout.chartX + layout.chartWidth;
                    const chartBottom = layout.chartY + layout.chartHeight;
                    const rectRight = x + cellWidth;
                    const rectBottom = y + cellHeight;
                    const intersectsViewport =
                        rectRight >= chartLeft &&
                        x <= chartRight &&
                        rectBottom >= chartTop &&
                        y <= chartBottom;

                    if (intersectsViewport) {
                        const safeCellWidth = Math.max(1, cellWidth);
                        const safeCellHeight = Math.max(1, cellHeight);
                        const centerX = x + cellWidth / 2;
                        const centerY = y + cellHeight / 2;
                        const markerRadius = clamp(Math.min(cellWidth, cellHeight) * 0.5, 4, 9);
                        const markerCrossHalf = markerRadius + 3;
                        const showSelectionGuides = runtime.linkedPlotOpen || runtime.plottingEnabled;

                        if (showSelectionGuides) {
                            context.save();
                            context.setLineDash([6, 4]);
                            context.strokeStyle = "rgba(217,119,6,0.58)";
                            context.lineWidth = 1.1;
                            context.beginPath();
                            context.moveTo(centerX, chartTop);
                            context.lineTo(centerX, chartBottom);
                            context.moveTo(chartLeft, centerY);
                            context.lineTo(chartRight, centerY);
                            context.stroke();
                            context.restore();
                        }

                        // Keep the selected cell edge visible when the grid is very dense.
                        context.strokeStyle = "rgba(217,119,6,0.95)";
                        context.lineWidth = Math.max(1.4, 2 / Math.max(runtime.zoom, 1));
                        context.strokeRect(x, y, safeCellWidth, safeCellHeight);

                        // Draw a fixed-size center marker so selection remains visible at sub-pixel cell sizes.
                        context.strokeStyle = "rgba(255,255,255,0.92)";
                        context.lineWidth = 2.4;
                        context.beginPath();
                        context.arc(centerX, centerY, markerRadius + 1.2, 0, Math.PI * 2);
                        context.stroke();

                        context.strokeStyle = "rgba(217,119,6,0.98)";
                        context.lineWidth = 1.8;
                        context.beginPath();
                        context.arc(centerX, centerY, markerRadius, 0, Math.PI * 2);
                        context.stroke();

                        context.strokeStyle = "rgba(15,23,42,0.76)";
                        context.lineWidth = 1.2;
                        context.beginPath();
                        context.moveTo(centerX - markerCrossHalf, centerY);
                        context.lineTo(centerX + markerCrossHalf, centerY);
                        context.moveTo(centerX, centerY - markerCrossHalf);
                        context.lineTo(centerX, centerY + markerCrossHalf);
                        context.stroke();

                        context.fillStyle = "rgba(217,119,6,1)";
                        context.beginPath();
                        context.arc(centerX, centerY, 2.6, 0, Math.PI * 2);
                        context.fill();

                        if (runtime.linkedPlotOpen) {
                            const selectedBadge = `Sel Y ${runtime.selectedCell.displayRow}, C ${runtime.selectedCell.col}`;
                            const maxBadgeWidth = Math.max(72, layout.chartWidth - 8);
                            context.font = "700 10px 'Segoe UI', Arial, sans-serif";
                            const measured = Math.ceil(context.measureText(selectedBadge).width) + 14;
                            const badgeWidth = Math.min(maxBadgeWidth, Math.max(72, measured));
                            const badgeX = layout.chartX + 6;
                            const badgeY = layout.chartY + 6;
                            context.fillStyle = "rgba(15,23,42,0.78)";
                            context.fillRect(badgeX, badgeY, badgeWidth, 17);
                            context.fillStyle = "#FFFFFF";
                            context.textAlign = "left";
                            context.textBaseline = "middle";
                            context.fillText(selectedBadge, badgeX + 7, badgeY + 8.5);
                            context.textBaseline = "alphabetic";
                        }
                    }
                }
                context.restore();
            }

            context.strokeStyle = "#D9E2F2";
            context.lineWidth = 1;
            context.strokeRect(layout.chartX, layout.chartY, layout.chartWidth, layout.chartHeight);

            context.font = "600 10px 'Segoe UI', Arial, sans-serif";
            context.fillStyle = "#475569";
            context.textAlign = "center";
            // Viewport-aware axis ticks: update as user zooms/pans.
            const xTicks = runtime.zoom > 1
                ? buildViewportTicks(runtime.cols, runtime.panX, runtime.zoom, layout.chartWidth)
                : buildTicks(runtime.cols).map((col) => ({
                    dataIndex: col,
                    screenRatio: runtime.cols <= 1 ? 0.5 : col / (runtime.cols - 1),
                }));
            const yTicks = runtime.zoom > 1
                ? buildViewportTicks(runtime.rows, runtime.panY, runtime.zoom, layout.chartHeight)
                : buildTicks(runtime.rows).map((row) => ({
                    dataIndex: row,
                    screenRatio: runtime.rows <= 1 ? 0.5 : row / (runtime.rows - 1),
                }));
            xTicks.forEach((tick) => {
                const x = layout.chartX + tick.screenRatio * layout.chartWidth;
                context.fillText(String(tick.dataIndex), x, layout.chartY + layout.chartHeight + 14);
            });
            context.textAlign = "right";
            yTicks.forEach((tick) => {
                const y = layout.chartY + tick.screenRatio * layout.chartHeight + 3;
                const yLabel = toDisplayRow(runtime.rows, tick.dataIndex);
                context.fillText(String(yLabel), layout.chartX - 8, y);
            });

            const gradient = context.createLinearGradient(
                0,
                layout.colorBarY + layout.chartHeight,
                0,
                layout.colorBarY
            );
            const stops = getColorStops(runtime.colormap);
            stops.forEach((color, index) => {
                const offset = index / Math.max(1, stops.length - 1);
                gradient.addColorStop(offset, `rgb(${color[0]}, ${color[1]}, ${color[2]})`);
            });

            context.fillStyle = gradient;
            context.fillRect(
                layout.colorBarX,
                layout.colorBarY,
                layout.colorBarWidth,
                layout.chartHeight
            );
            context.strokeStyle = "#D9E2F2";
            context.strokeRect(
                layout.colorBarX,
                layout.colorBarY,
                layout.colorBarWidth,
                layout.chartHeight
            );

            context.textAlign = "left";
            context.fillStyle = "#475569";
            context.fillText(formatScaleValue(runtime.max), layout.colorBarX + layout.colorBarWidth + 6, layout.colorBarY + 8);
            context.fillText(
                formatScaleValue((runtime.min + runtime.max) / 2),
                layout.colorBarX + layout.colorBarWidth + 6,
                layout.colorBarY + layout.chartHeight / 2 + 3
            );
            context.fillText(
                formatScaleValue(runtime.min),
                layout.colorBarX + layout.colorBarWidth + 6,
                layout.colorBarY + layout.chartHeight - 2
            );
            updateIntensityOverlay();
        }

        function applyZoom(nextZoom, anchorX = null, anchorY = null) {
            const clampedZoom = clamp(nextZoom, HEATMAP_MIN_ZOOM, HEATMAP_MAX_ZOOM);
            if (Math.abs(clampedZoom - runtime.zoom) < 0.0005) {
                return;
            }

            const layout = runtime.layout;
            if (!layout) {
                runtime.zoom = clampedZoom;
                runtime.panX = 0;
                runtime.panY = 0;
                updateLabels();
                renderHeatmap();
                persistViewState();
                return;
            }

            const safeAnchorX = Number.isFinite(anchorX) ? anchorX : layout.chartWidth / 2;
            const safeAnchorY = Number.isFinite(anchorY) ? anchorY : layout.chartHeight / 2;
            const scale = clampedZoom / runtime.zoom;
            const nextPanX = safeAnchorX - (safeAnchorX - runtime.panX) * scale;
            const nextPanY = safeAnchorY - (safeAnchorY - runtime.panY) * scale;

            runtime.zoom = clampedZoom;
            const clampedPan = clampPanForZoom(nextPanX, nextPanY, clampedZoom);
            runtime.panX = clampedPan.x;
            runtime.panY = clampedPan.y;
            updateLabels();
            renderHeatmap();
            persistViewState();
        }

        function getRelativePoint(event) {
            // Use canvas rect so coordinates match exactly what is drawn on the
            // canvas, avoiding the 1px (or more) border offset from canvasHost.
            const rect = canvas.getBoundingClientRect();
            return {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            };
        }

        function resolveCellAtPoint(point) {
            const layout = runtime.layout;
            if (!layout || runtime.rows <= 0 || runtime.cols <= 0 || !runtime.values) {
                return null;
            }

            const localX = point.x - layout.chartX;
            const localY = point.y - layout.chartY;
            if (localX < 0 || localX > layout.chartWidth || localY < 0 || localY > layout.chartHeight) {
                return null;
            }

            const scaledX = (localX - runtime.panX) / runtime.zoom;
            const scaledY = (localY - runtime.panY) / runtime.zoom;
            if (
                scaledX < 0 ||
                scaledX > layout.chartWidth ||
                scaledY < 0 ||
                scaledY > layout.chartHeight
            ) {
                return null;
            }

            const col = clamp(Math.floor((scaledX / layout.chartWidth) * runtime.cols), 0, runtime.cols - 1);
            const row = clamp(Math.floor((scaledY / layout.chartHeight) * runtime.rows), 0, runtime.rows - 1);
            const value = runtime.values[row * runtime.cols + col];
            return {
                row,
                col,
                value,
                displayRow: toDisplayRow(runtime.rows, row),
            };
        }

        function updateHover(point) {
            const cell = resolveCellAtPoint(point);
            if (!cell) {
                hideTooltip();
                renderHeatmap();
                return;
            }

            runtime.hover = { row: cell.row, col: cell.col, value: cell.value };
            runtime.hoverDisplayRow = cell.displayRow;

            if (tooltip) {
                // Use canvas rect for tooltip clamping: keeps coordinates consistent.
                // with getRelativePoint() which is also canvas-relative.
                const canvasRect = canvas.getBoundingClientRect();
                const hasSelectedCell = runtime.selectedCell && Number.isFinite(runtime.selectedCell.row);
                const selectedDiffers =
                    hasSelectedCell &&
                    (runtime.selectedCell.row !== cell.row || runtime.selectedCell.col !== cell.col);
                const maxTooltipWidth = selectedDiffers ? 190 : 156;
                const maxTooltipHeight = selectedDiffers ? 90 : 72;
                const left = clamp(point.x + 12, 8, Math.max(8, canvasRect.width - maxTooltipWidth));
                const top = clamp(point.y + 12, 8, Math.max(8, canvasRect.height - maxTooltipHeight));
                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${top}px`;
                tooltip.style.right = "auto";
                tooltip.hidden = false;
                tooltip.innerHTML = `
        <div>Y: ${runtime.hoverDisplayRow}</div>
        <div>Col: ${cell.col}</div>
        <div>Value: ${formatCell(cell.value, "auto")}</div>
        ${selectedDiffers
                        ? `<div>Sel: Y ${runtime.selectedCell.displayRow}, C ${runtime.selectedCell.col}</div>`
                        : ""
                    }
      `;
            }

            renderHeatmap();
        }

        async function fetchHeatmapAtSize(maxSize, loadingMessage, options = {}) {
            if (runtime.destroyed) {
                return { loaded: false };
            }

            const preserveViewState = options && options.preserveViewState === true;
            const loadToken = Number.isFinite(Number(options?.loadToken)) ? Number(options.loadToken) : runtime.loadSequence;
            const preservedView = preserveViewState
                ? {
                    zoom: runtime.zoom,
                    panX: runtime.panX,
                    panY: runtime.panY,
                    panEnabled: runtime.panEnabled === true,
                    plottingEnabled: runtime.plottingEnabled === true,
                    plotAxis: runtime.plotAxis === "col" ? "col" : "row",
                    linkedPlotOpen: runtime.linkedPlotOpen === true,
                    intensityEnabled: runtime.intensityEnabled === true,
                    intensityMin: runtime.intensityMin,
                    intensityMax: runtime.intensityMax,
                }
                : null;

            if (loadingMessage) {
                setMatrixStatus(statusElement, loadingMessage, "info");
            }

            const requestedMaxSize = Math.max(1, Math.min(maxSize, HEATMAP_MAX_SIZE));
            const cancelKey = `heatmap:${runtime.selectionKey}:${requestedMaxSize}`;
            runtime.activeCancelKeys.add(cancelKey);

            const params = {
                mode: "heatmap",
                max_size: requestedMaxSize,
                include_stats: 0,
            };
            if (runtime.displayDims) {
                params.display_dims = runtime.displayDims;
            }
            if (runtime.fixedIndices) {
                params.fixed_indices = runtime.fixedIndices;
            }

            if (runtime.fileEtag) {
                params.etag = runtime.fileEtag;
            }

            try {
                const response = await getFileData(runtime.fileKey, runtime.path, params, {
                    cancelPrevious: true,
                    cancelKey,
                });

                if (runtime.destroyed || loadToken !== runtime.loadSequence) {
                    return { loaded: false };
                }

                const grid = normalizeHeatmapGrid(response?.data);
                if (!grid) {
                    throw new Error("No valid heatmap matrix returned from API");
                }

                const statsMin = toFiniteNumber(response?.stats?.min);
                const statsMax = toFiniteNumber(response?.stats?.max);
                const min = statsMin !== null ? statsMin : grid.min;
                let max = statsMax !== null ? statsMax : grid.max;
                if (!(max > min)) {
                    max = min + 1;
                }

                runtime.rows = grid.rows;
                runtime.cols = grid.cols;
                runtime.values = grid.values;
                runtime.min = min;
                runtime.max = max;
                if (preservedView) {
                    runtime.zoom = clamp(preservedView.zoom || HEATMAP_MIN_ZOOM, HEATMAP_MIN_ZOOM, HEATMAP_MAX_ZOOM);
                    runtime.panX = Number(preservedView.panX) || 0;
                    runtime.panY = Number(preservedView.panY) || 0;
                    runtime.panEnabled = preservedView.panEnabled === true;
                    runtime.plottingEnabled = preservedView.plottingEnabled === true;
                    runtime.plotAxis = preservedView.plotAxis === "col" ? "col" : "row";
                    runtime.linkedPlotOpen = preservedView.linkedPlotOpen === true && runtime.selectedCell !== null;
                    runtime.intensityEnabled = preservedView.intensityEnabled === true;
                    runtime.intensityMin = toFiniteNumber(preservedView.intensityMin);
                    runtime.intensityMax = toFiniteNumber(preservedView.intensityMax);
                } else {
                    runtime.zoom = HEATMAP_MIN_ZOOM;
                    runtime.panX = 0;
                    runtime.panY = 0;
                    if (!runtime.intensityEnabled) {
                        runtime.intensityMin = min;
                        runtime.intensityMax = max;
                    }
                }

                if (!rebuildHeatmapBitmap()) {
                    throw new Error("Failed to build heatmap canvas");
                }
                runtime.maxSizeClamped = response?.max_size_clamped === true;
                runtime.effectiveMaxSize = Number(response?.effective_max_size) || requestedMaxSize;
                runtime.loadedPhase = requestedMaxSize >= HEATMAP_MAX_SIZE ? "highres" : "preview";

                if (runtime.selectedCell && runtime.rows > 0 && runtime.cols > 0) {
                    const nextRow = clamp(runtime.selectedCell.row, 0, runtime.rows - 1);
                    const nextCol = clamp(runtime.selectedCell.col, 0, runtime.cols - 1);
                    const nextValue = runtime.values[nextRow * runtime.cols + nextCol];
                    runtime.selectedCell = {
                        row: nextRow,
                        col: nextCol,
                        value: nextValue,
                        displayRow: toDisplayRow(runtime.rows, nextRow),
                    };
                }

                HEATMAP_SELECTION_DATA_CACHE.set(runtime.cacheKey, {
                    rows: runtime.rows,
                    cols: runtime.cols,
                    values: runtime.values,
                    min: runtime.min,
                    max: runtime.max,
                    maxSizeClamped: runtime.maxSizeClamped,
                    effectiveMaxSize: runtime.effectiveMaxSize,
                    phase: runtime.loadedPhase,
                });
                if (HEATMAP_SELECTION_DATA_CACHE.size > HEATMAP_SELECTION_CACHE_LIMIT) {
                    const oldestKey = HEATMAP_SELECTION_DATA_CACHE.keys().next().value;
                    if (oldestKey) {
                        HEATMAP_SELECTION_DATA_CACHE.delete(oldestKey);
                    }
                }

                hideTooltip();
                updateLabels();
                updateImageHistogram();
                renderHeatmap();
                if (preservedView) {
                    const clampedPan = clampPanForZoom(runtime.panX, runtime.panY, runtime.zoom);
                    runtime.panX = clampedPan.x;
                    runtime.panY = clampedPan.y;
                    renderHeatmap();
                }
                persistViewState();
                if (runtime.selectedCell && linkedPlotPanel && !linkedPlotPanel.hidden) {
                    renderLinkedPlotLine();
                }

                setMatrixStatus(statusElement, buildLoadedStatusText(runtime.loadedPhase), "info");
                return { loaded: true };
            } catch (error) {
                if (runtime.destroyed) {
                    return { loaded: false };
                }
                if (error?.isAbort || error?.code === "ABORTED") {
                    return { loaded: false };
                }
                setMatrixStatus(statusElement, error?.message || "Failed to load high-res heatmap.", "error");
                return { loaded: false };
            } finally {
                runtime.activeCancelKeys.delete(cancelKey);
            }
        }

        async function loadHighResHeatmap(options = {}) {
            const preserveViewState = options && options.preserveViewState === true;
            const forceFullLoad = options && options.forceFullLoad === true;
            const loadToken = ++runtime.loadSequence;
            if (forceFullLoad) {
                const fullResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading full resolution...", {
                    preserveViewState,
                    loadToken,
                });
                return fullResult.loaded === true;
            }
            // Progressive loading: fast preview first (256), then full resolution (1024)
            const PREVIEW_SIZE = 256;
            const previewResult = await fetchHeatmapAtSize(PREVIEW_SIZE, "Loading heatmap preview...", {
                preserveViewState,
                loadToken,
            });
            if (runtime.destroyed || loadToken !== runtime.loadSequence) return false;
            if (previewResult.loaded && HEATMAP_MAX_SIZE > PREVIEW_SIZE) {
                // Small delay so the user sees the preview before the full load starts
                await new Promise((r) => setTimeout(r, 50));
                if (runtime.destroyed || loadToken !== runtime.loadSequence) return false;
                const fullResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading full resolution...", {
                    preserveViewState,
                    loadToken,
                });
                return fullResult.loaded === true;
            } else if (!previewResult.loaded) {
                // Fallback: try full size directly
                const fallbackResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading high-res heatmap...", {
                    preserveViewState,
                    loadToken,
                });
                return fallbackResult.loaded === true;
            }
            return previewResult.loaded === true;
        }

        async function exportCsvDisplayed() {
            if (runtime.destroyed) {
                throw new Error("Heatmap runtime is no longer active.");
            }
            if (!(runtime.values instanceof Float64Array) || runtime.rows <= 0 || runtime.cols <= 0) {
                throw new Error("No rendered heatmap grid available for CSV export.");
            }

            setMatrixStatus(statusElement, "Preparing displayed heatmap CSV...", "info");
            const header = ["row\\col"];
            for (let col = 0; col < runtime.cols; col += 1) {
                header.push(col);
            }
            const rows = [toCsvRow(header)];

            for (let row = 0; row < runtime.rows; row += 1) {
                const values = [row];
                const offset = row * runtime.cols;
                for (let col = 0; col < runtime.cols; col += 1) {
                    values.push(runtime.values[offset + col]);
                }
                rows.push(toCsvRow(values));
            }

            const filename = buildExportFilename({
                fileKey: runtime.fileKey,
                path: runtime.path,
                tab: "heatmap",
                scope: "displayed",
                extension: "csv",
            });
            const blob = createCsvBlob(rows, true);
            triggerBlobDownload(blob, filename);
            setMatrixStatus(
                statusElement,
                `Displayed heatmap CSV exported (${runtime.rows.toLocaleString()} x ${runtime.cols.toLocaleString()}).`,
                "info"
            );
        }

        async function exportCsvFull() {
            if (runtime.destroyed) {
                throw new Error("Heatmap runtime is no longer active.");
            }

            const query = {
                path: runtime.path,
                mode: "heatmap",
            };
            if (runtime.displayDims) {
                query.display_dims = runtime.displayDims;
            }
            if (runtime.fixedIndices) {
                query.fixed_indices = runtime.fixedIndices;
            }
            if (runtime.fileEtag) {
                query.etag = runtime.fileEtag;
            }

            const url = buildCsvExportUrl(runtime.fileKey, query);
            triggerUrlDownload(url);
            setMatrixStatus(statusElement, "Full heatmap CSV download started.", "info");
        }

        async function exportPng() {
            if (runtime.destroyed) {
                throw new Error("Heatmap runtime is no longer active.");
            }
            const pngBlob = await canvasElementToPngBlob(canvas);
            const filename = buildExportFilename({
                fileKey: runtime.fileKey,
                path: runtime.path,
                tab: "heatmap",
                scope: "current",
                extension: "png",
            });
            triggerBlobDownload(pngBlob, filename);
            setMatrixStatus(statusElement, "Heatmap PNG exported.", "info");
        }

        shell.__exportApi = {
            exportCsvDisplayed,
            exportCsvFull,
            exportPng,
        };

        function cancelInFlightRequests() {
            // Runtime owns cancel keys so teardown can stop pending async updates safely.
            runtime.activeCancelKeys.forEach((cancelKey) => {
                cancelPendingRequest(cancelKey, "heatmap-runtime-disposed");
            });
            runtime.activeCancelKeys.clear();
        }

        function clearPendingSelectionUpdate() {
            if (selectionUpdateTimer !== null) {
                clearTimeout(selectionUpdateTimer);
                selectionUpdateTimer = null;
            }
            pendingSelectionUpdate = null;
        }

        async function applySelectionUpdate(nextSelection, options = {}) {
            if (runtime.destroyed || !nextSelection || typeof nextSelection !== "object") {
                return false;
            }

            const nextDisplayDims =
                typeof nextSelection.displayDims === "string" ? nextSelection.displayDims : runtime.displayDims;
            const nextFixedIndices =
                typeof nextSelection.fixedIndices === "string" ? nextSelection.fixedIndices : runtime.fixedIndices;
            const nextSelectionKey = String(
                nextSelection.selectionKey ||
                buildHeatmapSelectionKey(runtime.fileKey, runtime.path, nextDisplayDims, nextFixedIndices)
            );
            const dimsChanged = nextDisplayDims !== runtime.displayDims;
            const fixedChanged = nextFixedIndices !== runtime.fixedIndices;
            const selectionChanged = nextSelectionKey !== runtime.selectionKey;
            if (!dimsChanged && !fixedChanged && !selectionChanged) {
                return true;
            }

            const preserveViewState = options.preserveViewState === true && !dimsChanged;
            const forceFullLoad = options.forceFullLoad === true;
            persistViewState();
            runtime.loadSequence += 1;
            cancelInFlightRequests();
            runtime.displayDims = nextDisplayDims || "";
            runtime.fixedIndices = nextFixedIndices || "";
            runtime.selectionKey = nextSelectionKey;
            runtime.cacheKey = `${runtime.selectionKey}|${runtime.fileEtag || "no-etag"}`;
            shell.dataset.heatmapDisplayDims = runtime.displayDims;
            shell.dataset.heatmapFixedIndices = runtime.fixedIndices;
            shell.dataset.heatmapSelectionKey = runtime.selectionKey;
            if (!preserveViewState) {
                runtime.intensityEnabled = false;
                runtime.intensityMin = null;
                runtime.intensityMax = null;
            }
            runtime.hover = null;
            runtime.hoverDisplayRow = null;
            hideTooltip();

            const restoredFromCache = restoreCachedHeatmapData();
            if (restoredFromCache) {
                if (runtime.loadedPhase !== "highres") {
                    const loadToken = runtime.loadSequence;
                    const fullFromCacheResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading full resolution...", {
                        preserveViewState,
                        loadToken,
                    });
                    return fullFromCacheResult.loaded === true;
                }
                return true;
            }

            setMatrixStatus(statusElement, "Updating heatmap slice...", "info");
            return await loadHighResHeatmap({ preserveViewState, forceFullLoad });
        }

        function queueSelectionUpdate(nextSelection, options = {}) {
            pendingSelectionUpdate = {
                nextSelection: nextSelection && typeof nextSelection === "object" ? { ...nextSelection } : {},
                options: { ...options },
            };

            if (options && options.immediate === true) {
                const immediateUpdate = pendingSelectionUpdate;
                clearPendingSelectionUpdate();
                return applySelectionUpdate(immediateUpdate.nextSelection, immediateUpdate.options);
            }

            if (selectionUpdateTimer !== null) {
                clearTimeout(selectionUpdateTimer);
            }

            return new Promise((resolve, reject) => {
                selectionUpdateTimer = setTimeout(() => {
                selectionUpdateTimer = null;
                const queuedUpdate = pendingSelectionUpdate;
                pendingSelectionUpdate = null;
                if (!queuedUpdate) {
                    resolve(false);
                    return;
                }
                Promise.resolve(applySelectionUpdate(queuedUpdate.nextSelection, queuedUpdate.options))
                    .then(resolve)
                    .catch(reject);
                }, HEATMAP_SELECTION_UPDATE_DEBOUNCE_MS);
            });
        }

        shell.__heatmapRuntimeApi = {
            updateSelection(nextSelection, options = {}) {
                return queueSelectionUpdate(nextSelection, options);
            },
        };

        if (histogramRoot) {
            setImageHistogramEmptyState("Histogram updates with the current image slice.");
        }

        function onWheel(event) {
            event.preventDefault();
            const point = getRelativePoint(event);
            const layout = runtime.layout;
            if (!layout) {
                return;
            }
            const anchorX = clamp(point.x - layout.chartX, 0, layout.chartWidth);
            const anchorY = clamp(point.y - layout.chartY, 0, layout.chartHeight);
            const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
            applyZoom(runtime.zoom * factor, anchorX, anchorY);
        }

        function onPointerDown(event) {
            const isMousePointer = !event.pointerType || event.pointerType === "mouse";
            if (isMousePointer && event.button !== 0) {
                return;
            }

            if (runtime.plottingEnabled && !runtime.panEnabled) {
                const point = getRelativePoint(event);
                const cell = resolveCellAtPoint(point) || resolveFallbackHoverCell();
                const selected = selectCellForPlot(cell);
                if (selected) {
                    event.preventDefault();
                }
                return;
            }

            if (!runtime.panEnabled) {
                return;
            }
            event.preventDefault();
            const point = getRelativePoint(event);
            runtime.isPanning = true;
            runtime.panPointerId = event.pointerId;
            runtime.panStartX = point.x;
            runtime.panStartY = point.y;
            runtime.panStartOffsetX = runtime.panX;
            runtime.panStartOffsetY = runtime.panY;
            setPanState();
            canvas.setPointerCapture(event.pointerId);
        }

        function onPointerMove(event) {
            const point = getRelativePoint(event);
            if (runtime.isPanning && runtime.panPointerId === event.pointerId) {
                event.preventDefault();
                const deltaX = point.x - runtime.panStartX;
                const deltaY = point.y - runtime.panStartY;
                const nextPan = clampPanForZoom(
                    runtime.panStartOffsetX + deltaX,
                    runtime.panStartOffsetY + deltaY,
                    runtime.zoom
                );
                runtime.panX = nextPan.x;
                runtime.panY = nextPan.y;
                renderHeatmap();
                persistViewState();
                return;
            }
            updateHover(point);
        }

        function stopPan(event = null) {
            if (!runtime.isPanning) {
                return;
            }
            if (event && runtime.panPointerId !== event.pointerId) {
                return;
            }
            const activePointer = runtime.panPointerId;
            runtime.isPanning = false;
            runtime.panPointerId = null;
            setPanState();
            if (Number.isFinite(activePointer) && canvas.hasPointerCapture(activePointer)) {
                canvas.releasePointerCapture(activePointer);
            }
        }

        function onPointerUp(event) {
            const wasPanning =
                runtime.isPanning &&
                Number.isFinite(runtime.panPointerId) &&
                runtime.panPointerId === event.pointerId;
            stopPan(event);

            if (wasPanning || !runtime.plottingEnabled || runtime.panEnabled) {
                return;
            }
            const isMousePointer = !event.pointerType || event.pointerType === "mouse";
            if (isMousePointer && event.button !== 0) {
                return;
            }

            const point = getRelativePoint(event);
            const cell = resolveCellAtPoint(point) || resolveFallbackHoverCell();
            selectCellForPlot(cell);
        }

        function onCanvasClick(event) {
            if (!runtime.plottingEnabled || runtime.panEnabled || runtime.isPanning) {
                return;
            }
            if (typeof event.button === "number" && event.button !== 0) {
                return;
            }

            const point = getRelativePoint(event);
            const cell = resolveCellAtPoint(point) || resolveFallbackHoverCell();
            selectCellForPlot(cell);
        }

        function onPointerLeave() {
            if (runtime.isPanning) {
                stopPan();
            }
            hideTooltip();
            renderHeatmap();
        }

        function onTogglePan() {
            runtime.panEnabled = !runtime.panEnabled;
            if (!runtime.panEnabled && runtime.isPanning) {
                stopPan();
            }
            if (runtime.panEnabled) {
                runtime.plottingEnabled = false;
            }
            if (runtime.panEnabled && runtime.zoom <= HEATMAP_MIN_ZOOM + 0.001) {
                applyZoom(HEATMAP_PAN_START_ZOOM);
            }
            setPanState();
            persistViewState();
        }

        function onTogglePlotMode() {
            runtime.plottingEnabled = !runtime.plottingEnabled;
            if (runtime.plottingEnabled) {
                runtime.panEnabled = false;
                if (runtime.isPanning) {
                    stopPan();
                }
                setMatrixStatus(
                    statusElement,
                    "Plot mode enabled. Click a heatmap cell to show row and column line profiles.",
                    "info"
                );
            } else {
                setMatrixStatus(statusElement, buildLoadedStatusText(runtime.loadedPhase), "info");
            }
            setPanState();
            persistViewState();
        }

        function updateIntensityFromPoint(point) {
            if (!runtime.intensityEnabled || !runtime.intensityDragHandle || !runtime.layout) {
                return;
            }
            const { rawMin, rawMax } = getRawIntensityBounds();
            const minGap = getIntensityMinimumGap(rawMin, rawMax);
            const ratio = clamp((point.y - runtime.layout.colorBarY) / runtime.layout.chartHeight, 0, 1);
            const nextValue = rawMax - ratio * (rawMax - rawMin);

            if (runtime.intensityDragHandle === "max") {
                const lowerBound = Number.isFinite(runtime.intensityMin) ? runtime.intensityMin + minGap : rawMin + minGap;
                runtime.intensityMax = clamp(nextValue, lowerBound, rawMax);
            } else {
                const upperBound = Number.isFinite(runtime.intensityMax) ? runtime.intensityMax - minGap : rawMax - minGap;
                runtime.intensityMin = clamp(nextValue, rawMin, upperBound);
            }

            rebuildHeatmapBitmap();
            renderHeatmap();
            persistViewState();
        }

        function stopIntensityDrag(event = null) {
            if (!runtime.intensityDragHandle) {
                return;
            }
            if (
                event &&
                Number.isFinite(runtime.intensityPointerId) &&
                runtime.intensityPointerId !== event.pointerId
            ) {
                return;
            }

            const pointerId = runtime.intensityPointerId;
            const dragTarget = runtime.intensityDragTarget;
            runtime.intensityDragHandle = null;
            runtime.intensityPointerId = null;
            runtime.intensityDragTarget = null;

            if (intensityMinHandle) {
                intensityMinHandle.classList.remove("is-active");
            }
            if (intensityMaxHandle) {
                intensityMaxHandle.classList.remove("is-active");
            }
            if (
                dragTarget &&
                Number.isFinite(pointerId) &&
                typeof dragTarget.hasPointerCapture === "function" &&
                dragTarget.hasPointerCapture(pointerId)
            ) {
                dragTarget.releasePointerCapture(pointerId);
            }
            persistViewState();
        }

        function onIntensityHandlePointerDown(event) {
            if (!runtime.intensityEnabled) {
                return;
            }
            const isMousePointer = !event.pointerType || event.pointerType === "mouse";
            if (isMousePointer && event.button !== 0) {
                return;
            }

            const handleKind =
                event.currentTarget?.dataset?.heatmapIntensityHandle === "max" ? "max" : "min";
            runtime.intensityDragHandle = handleKind;
            runtime.intensityPointerId = event.pointerId;
            runtime.intensityDragTarget = event.currentTarget;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.currentTarget?.setPointerCapture === "function") {
                event.currentTarget.setPointerCapture(event.pointerId);
            }
            event.currentTarget.classList.add("is-active");
            updateIntensityFromPoint(getRelativePoint(event));
        }

        function onIntensityHandlePointerMove(event) {
            if (
                !runtime.intensityDragHandle ||
                !Number.isFinite(runtime.intensityPointerId) ||
                runtime.intensityPointerId !== event.pointerId
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            updateIntensityFromPoint(getRelativePoint(event));
        }

        function onIntensityHandleClick(event) {
            if (!event) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
        }

        function onToggleIntensity(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            if (
                runtime.rows <= 0 ||
                runtime.cols <= 0 ||
                !Number.isFinite(runtime.min) ||
                !Number.isFinite(runtime.max) ||
                !(runtime.max > runtime.min)
            ) {
                return;
            }

            runtime.intensityEnabled = !runtime.intensityEnabled;
            stopIntensityDrag();
            if (runtime.intensityEnabled) {
                const { rawMin, rawMax } = getRawIntensityBounds();
                runtime.intensityMin = rawMin;
                runtime.intensityMax = rawMax;
                setMatrixStatus(
                    statusElement,
                    "Intensity window enabled. Drag the top and bottom color-bar handles to adjust the visible range.",
                    "info"
                );
            } else {
                runtime.intensityMin = runtime.min;
                runtime.intensityMax = runtime.max;
                setMatrixStatus(statusElement, buildLoadedStatusText(runtime.loadedPhase), "info");
            }
            rebuildHeatmapBitmap();
            renderHeatmap();
            persistViewState();
        }

        function onPlotToggleClick(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            onTogglePlotMode();
        }

        function onShellClick(event) {
            if (!event || event.defaultPrevented) {
                return;
            }
            const toggleButton = event.target?.closest?.("[data-heatmap-plot-toggle]");
            if (toggleButton && shell.contains(toggleButton)) {
                event.preventDefault();
                onTogglePlotMode();
            }
        }

        function onSelectRowAxis() {
            runtime.plotAxis = "row";
            syncPlotAxisButtons();
            persistViewState();
            if (runtime.selectedCell) {
                renderLinkedPlotLine();
            } else {
                setLinkedPlotTitle(null);
            }
        }

        function onSelectColAxis() {
            runtime.plotAxis = "col";
            syncPlotAxisButtons();
            persistViewState();
            if (runtime.selectedCell) {
                renderLinkedPlotLine();
            } else {
                setLinkedPlotTitle(null);
            }
        }

        function onCloseLinkedPlot(event) {
            if (event) {
                event.preventDefault();
            }
            closeLinkedPlot();
            persistViewState();
        }

        function onResetView() {
            if (runtime.isPanning) {
                stopPan();
            }
            runtime.zoom = HEATMAP_MIN_ZOOM;
            runtime.panX = 0;
            runtime.panY = 0;
            runtime.panEnabled = false;
            hideTooltip();
            setPanState();
            updateLabels();
            renderHeatmap();
            persistViewState();
        }

        function onZoomIn() {
            applyZoom(runtime.zoom * 1.15);
        }

        function onZoomOut() {
            applyZoom(runtime.zoom / 1.15);
        }

        function onToggleFullscreen() {
            runtime.fullscreenActive = !runtime.fullscreenActive;
            if (!runtime.fullscreenActive) {
                heatmapFullscreenRestore = null;
            }
            syncFullscreenState();
            rerenderAfterFullscreenChange();
        }

        function onFullscreenEsc(event) {
            if (event.key === "Escape" && runtime.fullscreenActive) {
                event.preventDefault();
                event.stopPropagation();
                runtime.fullscreenActive = false;
                heatmapFullscreenRestore = null;
                syncFullscreenState();
                rerenderAfterFullscreenChange();
            }
        }

        function exitPanelFullscreen() {
            if (!runtime.fullscreenActive) {
                return;
            }
            runtime.fullscreenActive = false;
            syncFullscreenState();
            rerenderAfterFullscreenChange();
        }

        const onFullscreenClick = (event) => {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
            onToggleFullscreen();
        };

        if (linkedPlotPanel) {
            linkedPlotPanel.hidden = true;
            linkedPlotPanel.classList.remove("is-visible");
        }
        syncLinkedPlotLayoutState();
        setLinkedPlotTitle(null);
        syncPlotAxisButtons();
        setPanState();
        syncFullscreenState();
        const restoredFromCache = restoreCachedHeatmapData();
        if (!restoredFromCache) {
            updateLabels();
            renderHeatmap();
            void loadHighResHeatmap();
        }

        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", stopPan);
        canvas.addEventListener("pointerleave", onPointerLeave);
        canvasHost.addEventListener("click", onCanvasClick);
        if (panToggleButton) panToggleButton.addEventListener("click", onTogglePan);
        if (plotToggleButton) plotToggleButton.addEventListener("click", onPlotToggleClick);
        if (intensityToggleButton) intensityToggleButton.addEventListener("click", onToggleIntensity);
        if (zoomInButton) zoomInButton.addEventListener("click", onZoomIn);
        if (zoomOutButton) zoomOutButton.addEventListener("click", onZoomOut);
        if (resetButton) resetButton.addEventListener("click", onResetView);
        if (fullscreenButton) fullscreenButton.addEventListener("click", onFullscreenClick);
        if (intensityMinHandle) {
            intensityMinHandle.addEventListener("pointerdown", onIntensityHandlePointerDown);
            intensityMinHandle.addEventListener("pointermove", onIntensityHandlePointerMove);
            intensityMinHandle.addEventListener("pointerup", stopIntensityDrag);
            intensityMinHandle.addEventListener("pointercancel", stopIntensityDrag);
            intensityMinHandle.addEventListener("click", onIntensityHandleClick);
        }
        if (intensityMaxHandle) {
            intensityMaxHandle.addEventListener("pointerdown", onIntensityHandlePointerDown);
            intensityMaxHandle.addEventListener("pointermove", onIntensityHandlePointerMove);
            intensityMaxHandle.addEventListener("pointerup", stopIntensityDrag);
            intensityMaxHandle.addEventListener("pointercancel", stopIntensityDrag);
            intensityMaxHandle.addEventListener("click", onIntensityHandleClick);
        }
        if (linkedPlotRowButton) linkedPlotRowButton.addEventListener("click", onSelectRowAxis);
        if (linkedPlotColButton) linkedPlotColButton.addEventListener("click", onSelectColAxis);
        if (linkedPlotCloseButton) linkedPlotCloseButton.addEventListener("click", onCloseLinkedPlot);
        shell.addEventListener("click", onShellClick);
        document.addEventListener("keydown", onFullscreenEsc);

        let resizeObserver = null;
        const onWindowResize = () => {
            renderHeatmap();
        };
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(onWindowResize);
            resizeObserver.observe(canvasHost);
        } else {
            window.addEventListener("resize", onWindowResize);
        }

        const cleanup = () => {
            persistViewState();
            runtime.destroyed = true;
            if (shell.__exportApi) {
                delete shell.__exportApi;
            }
            if (shell.__heatmapRuntimeApi) {
                delete shell.__heatmapRuntimeApi;
            }
            clearPendingSelectionUpdate();
            cancelInFlightRequests();
            closeLinkedPlot();
            canvas.removeEventListener("wheel", onWheel);
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointermove", onPointerMove);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", stopPan);
            canvas.removeEventListener("pointerleave", onPointerLeave);
            canvasHost.removeEventListener("click", onCanvasClick);
            if (panToggleButton) panToggleButton.removeEventListener("click", onTogglePan);
            if (plotToggleButton) plotToggleButton.removeEventListener("click", onPlotToggleClick);
            if (intensityToggleButton) intensityToggleButton.removeEventListener("click", onToggleIntensity);
            if (zoomInButton) zoomInButton.removeEventListener("click", onZoomIn);
            if (zoomOutButton) zoomOutButton.removeEventListener("click", onZoomOut);
            if (resetButton) resetButton.removeEventListener("click", onResetView);
            if (fullscreenButton) fullscreenButton.removeEventListener("click", onFullscreenClick);
            if (intensityMinHandle) {
                intensityMinHandle.removeEventListener("pointerdown", onIntensityHandlePointerDown);
                intensityMinHandle.removeEventListener("pointermove", onIntensityHandlePointerMove);
                intensityMinHandle.removeEventListener("pointerup", stopIntensityDrag);
                intensityMinHandle.removeEventListener("pointercancel", stopIntensityDrag);
                intensityMinHandle.removeEventListener("click", onIntensityHandleClick);
            }
            if (intensityMaxHandle) {
                intensityMaxHandle.removeEventListener("pointerdown", onIntensityHandlePointerDown);
                intensityMaxHandle.removeEventListener("pointermove", onIntensityHandlePointerMove);
                intensityMaxHandle.removeEventListener("pointerup", stopIntensityDrag);
                intensityMaxHandle.removeEventListener("pointercancel", stopIntensityDrag);
                intensityMaxHandle.removeEventListener("click", onIntensityHandleClick);
            }
            if (linkedPlotRowButton) linkedPlotRowButton.removeEventListener("click", onSelectRowAxis);
            if (linkedPlotColButton) linkedPlotColButton.removeEventListener("click", onSelectColAxis);
            if (linkedPlotCloseButton) linkedPlotCloseButton.removeEventListener("click", onCloseLinkedPlot);
            shell.removeEventListener("click", onShellClick);
            document.removeEventListener("keydown", onFullscreenEsc);
            stopIntensityDrag();
            if (runtime.fullscreenActive) {
                rememberHeatmapFullscreen(runtime.selectionKey);
            }
            exitPanelFullscreen();
            runtime.fullscreenActive = false;
            setDocumentFullscreenLock(false);
            shell.classList.remove("is-fullscreen");
            canvasHost.style.cursor = "";
            canvas.style.cursor = "";
            if (resizeObserver) {
                resizeObserver.disconnect();
            } else {
                window.removeEventListener("resize", onWindowResize);
            }
        };

        HEATMAP_RUNTIME_CLEANUPS.add(cleanup);
    }
    if (typeof initializeHeatmapRuntime !== "undefined") {
        moduleState.initializeHeatmapRuntime = initializeHeatmapRuntime;
        global.initializeHeatmapRuntime = initializeHeatmapRuntime;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime/heatmapRuntime");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Implements interactive grayscale histogram runtime with 1D zoom/pan and fullscreen support.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime/imageHistogramRuntime.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime/imageHistogramRuntime.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime.imageHistogramRuntime");

    const IMAGE_HISTOGRAM_VIEWBOX_WIDTH = 760;
    const IMAGE_HISTOGRAM_VIEWBOX_HEIGHT = 220;
    const IMAGE_HISTOGRAM_MIN_VISIBLE_BINS = 8;
    const IMAGE_HISTOGRAM_MIN_SPAN_FRACTION = 1 / 32;
    const IMAGE_HISTOGRAM_ZOOM_FACTOR = 1.2;
    const IMAGE_HISTOGRAM_RUNTIME_CLEANUPS =
        global.IMAGE_HISTOGRAM_RUNTIME_CLEANUPS instanceof Set
            ? global.IMAGE_HISTOGRAM_RUNTIME_CLEANUPS
            : new Set();

    function clampHistogramValue(value, min, max) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return min;
        }
        return Math.min(max, Math.max(min, numeric));
    }

    function formatHistogramScaleValue(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return "--";
        }
        if (Math.abs(numeric) >= 1e6 || (Math.abs(numeric) < 1e-3 && numeric !== 0)) {
            return numeric.toExponential(2);
        }
        return numeric.toLocaleString(undefined, {
            maximumFractionDigits: Math.abs(numeric) >= 10 ? 1 : 3,
        });
    }

    function parseImageHistogramPayload(shell) {
        if (!shell) {
            return {};
        }
        const raw = shell.dataset.imageHistogramPayload || "";
        if (!raw) {
            return {};
        }
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (_error) {
            return {};
        }
    }

    function normalizeImageHistogram(histogram) {
        if (!histogram || !Array.isArray(histogram.bins) || !histogram.bins.length) {
            return null;
        }
        const bins = histogram.bins.map((count) => Math.max(0, Number(count) || 0));
        const binCount = Math.max(1, Math.round(Number(histogram.binCount) || bins.length || 1));
        const count = Math.max(0, Number(histogram.count) || bins.reduce((sum, value) => sum + value, 0));
        const min = Number(histogram.min);
        let max = Number(histogram.max);
        const safeMin = Number.isFinite(min) ? min : 0;
        if (!Number.isFinite(max) || !(max > safeMin)) {
            max = safeMin + 1;
        }
        const binWidth = (max - safeMin) / Math.max(1, binCount);
        const peakCount = Math.max(0, Number(histogram.peakCount) || Math.max(...bins, 0));
        const peakValue = Number.isFinite(Number(histogram.peakValue))
            ? Number(histogram.peakValue)
            : safeMin + (Math.max(0, Number(histogram.peakIndex) || 0) + 0.5) * binWidth;

        return {
            count,
            min: safeMin,
            max,
            mean: Number(histogram.mean) || 0,
            median: Number(histogram.median) || 0,
            stdDev: Number(histogram.stdDev) || 0,
            peakValue,
            peakCount,
            binCount,
            binWidth,
            bins,
        };
    }

    function initializeImageHistogramRuntime(shell) {
        if (!shell || shell.dataset.imageHistogramBound === "true") {
            return;
        }

        const canvasHost = shell.querySelector("[data-image-histogram-canvas]");
        const svg = shell.querySelector("[data-image-histogram-svg]");
        const hover = shell.querySelector("[data-image-histogram-hover]");
        const emptyNode = shell.querySelector("[data-image-histogram-empty]");
        const titleNode = shell.querySelector("[data-image-histogram-title]");
        const subtitleNode = shell.querySelector("[data-image-histogram-subtitle]");
        const badgeNode = shell.querySelector("[data-image-histogram-badge]");
        const zoomLabel = shell.querySelector("[data-image-histogram-zoom-label]");
        const rangeLabel = shell.querySelector("[data-image-histogram-range-label]");
        const meanStat = shell.querySelector("[data-image-histogram-stat-mean]");
        const medianStat = shell.querySelector("[data-image-histogram-stat-median]");
        const stdStat = shell.querySelector("[data-image-histogram-stat-std]");
        const peakStat = shell.querySelector("[data-image-histogram-stat-peak]");
        const panToggleButton = shell.querySelector("[data-image-histogram-pan-toggle]");
        const zoomInButton = shell.querySelector("[data-image-histogram-zoom-in]");
        const zoomOutButton = shell.querySelector("[data-image-histogram-zoom-out]");
        const resetButton = shell.querySelector("[data-image-histogram-reset-view]");
        const fullscreenButton = shell.querySelector("[data-image-histogram-fullscreen-toggle]");

        if (!canvasHost || !svg) {
            return;
        }

        shell.dataset.imageHistogramBound = "true";

        const runtime = {
            histogram: null,
            title: "Histogram",
            subtitle: "Intensity distribution for the current image slice",
            ariaLabel: "Image histogram",
            emptyMessage: "Histogram is unavailable for this image.",
            fullDomainMin: 0,
            fullDomainMax: 1,
            domainMin: 0,
            domainMax: 1,
            panEnabled: false,
            isPanning: false,
            panPointerId: null,
            panStartX: 0,
            panStartDomainMin: 0,
            panStartDomainMax: 1,
            fullscreenActive: false,
            destroyed: false,
        };
        let controlScrollSnapshot = null;
        let controlScrollSnapshotCapturedAt = 0;

        function getFullDomainSpan() {
            return Math.max(1e-9, runtime.fullDomainMax - runtime.fullDomainMin);
        }

        function getVisibleDomainSpan() {
            return Math.max(1e-9, runtime.domainMax - runtime.domainMin);
        }

        function getMinimumVisibleSpan() {
            if (!runtime.histogram) {
                return 1;
            }
            const fullSpan = getFullDomainSpan();
            const binLimitedSpan = runtime.histogram.binWidth * IMAGE_HISTOGRAM_MIN_VISIBLE_BINS;
            return Math.max(fullSpan * IMAGE_HISTOGRAM_MIN_SPAN_FRACTION, binLimitedSpan);
        }

        function isToolbarControlTarget(event) {
            if (!event?.target || typeof event.target.closest !== "function") {
                return false;
            }
            const control = event.target.closest(
                "[data-image-histogram-pan-toggle],[data-image-histogram-zoom-in],[data-image-histogram-zoom-out],[data-image-histogram-reset-view],[data-image-histogram-fullscreen-toggle]"
            );
            return Boolean(control && shell.contains(control));
        }

        function collectScrollableAncestors(node) {
            if (typeof window === "undefined" || !node) {
                return [];
            }
            const entries = [];
            let current = node.parentElement;
            while (current) {
                const style = window.getComputedStyle(current);
                const overflowY = (style.overflowY || "").toLowerCase();
                const overflowX = (style.overflowX || "").toLowerCase();
                const canScrollY =
                    (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
                    current.scrollHeight > current.clientHeight + 1;
                const canScrollX =
                    (overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") &&
                    current.scrollWidth > current.clientWidth + 1;
                if (canScrollY || canScrollX) {
                    entries.push({
                        kind: "element",
                        target: current,
                        top: current.scrollTop,
                        left: current.scrollLeft,
                    });
                }
                current = current.parentElement;
            }

            const scrollingElement =
                typeof document !== "undefined" && document.scrollingElement
                    ? document.scrollingElement
                    : null;
            if (scrollingElement) {
                entries.push({
                    kind: "document",
                    target: scrollingElement,
                    top: scrollingElement.scrollTop,
                    left: scrollingElement.scrollLeft,
                });
            }
            return entries;
        }

        function restoreScrollableAncestors(snapshot) {
            if (!Array.isArray(snapshot) || snapshot.length < 1) {
                return;
            }
            snapshot.forEach((entry) => {
                if (!entry || !entry.target) {
                    return;
                }
                if (entry.kind === "document") {
                    entry.target.scrollTop = entry.top;
                    entry.target.scrollLeft = entry.left;
                    return;
                }
                if (entry.kind === "element" && entry.target.isConnected) {
                    entry.target.scrollTop = entry.top;
                    entry.target.scrollLeft = entry.left;
                }
            });
        }

        function getActiveControlScrollSnapshot(maxAgeMs = 2200) {
            if (!Array.isArray(controlScrollSnapshot) || controlScrollSnapshot.length < 1) {
                return null;
            }
            const age = Date.now() - controlScrollSnapshotCapturedAt;
            if (age > maxAgeMs) {
                controlScrollSnapshot = null;
                controlScrollSnapshotCapturedAt = 0;
                return null;
            }
            return controlScrollSnapshot;
        }

        function scheduleControlScrollRestore(snapshot) {
            if (!Array.isArray(snapshot) || snapshot.length < 1) {
                return;
            }
            const runRestore = () => restoreScrollableAncestors(snapshot);
            runRestore();
            if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(runRestore);
            }
            [0, 60, 140, 260, 420, 700].forEach((delay) => {
                setTimeout(runRestore, delay);
            });
        }

        function snapshotControlScroll(event) {
            if (!isToolbarControlTarget(event)) {
                return;
            }
            controlScrollSnapshot = collectScrollableAncestors(event.target);
            controlScrollSnapshotCapturedAt = Date.now();
        }

        function restoreControlScroll(event) {
            if (!isToolbarControlTarget(event)) {
                return;
            }
            const snapshot =
                getActiveControlScrollSnapshot() || collectScrollableAncestors(event.target);
            scheduleControlScrollRestore(snapshot);
        }

        function clampDomain(domainMin, domainMax) {
            const fullMin = runtime.fullDomainMin;
            const fullMax = runtime.fullDomainMax;
            const fullSpan = Math.max(1e-9, fullMax - fullMin);
            const minVisibleSpan = Math.min(fullSpan, getMinimumVisibleSpan());
            let nextMin = Number.isFinite(domainMin) ? domainMin : fullMin;
            let nextMax = Number.isFinite(domainMax) ? domainMax : fullMax;
            let nextSpan = nextMax - nextMin;

            if (!(nextSpan > 0)) {
                nextSpan = fullSpan;
                nextMin = fullMin;
                nextMax = fullMax;
            }

            if (nextSpan < minVisibleSpan) {
                const center = nextMin + nextSpan / 2;
                nextSpan = minVisibleSpan;
                nextMin = center - nextSpan / 2;
                nextMax = center + nextSpan / 2;
            }

            if (nextSpan >= fullSpan) {
                return { min: fullMin, max: fullMax };
            }

            if (nextMin < fullMin) {
                nextMin = fullMin;
                nextMax = nextMin + nextSpan;
            }
            if (nextMax > fullMax) {
                nextMax = fullMax;
                nextMin = nextMax - nextSpan;
            }

            return {
                min: clampHistogramValue(nextMin, fullMin, fullMax - minVisibleSpan),
                max: clampHistogramValue(nextMax, fullMin + minVisibleSpan, fullMax),
            };
        }

        function hideHover() {
            if (hover) {
                hover.hidden = true;
            }
        }

        function syncHeader() {
            if (titleNode) {
                titleNode.textContent = runtime.title;
            }
            if (subtitleNode) {
                subtitleNode.textContent = runtime.subtitle;
            }
            if (badgeNode) {
                badgeNode.textContent =
                    runtime.histogram && runtime.histogram.binCount
                        ? `${runtime.histogram.binCount} bins`
                        : "-- bins";
            }
            canvasHost.setAttribute("aria-label", runtime.ariaLabel);
            svg.setAttribute("aria-label", runtime.ariaLabel);
        }

        function syncStats() {
            if (!runtime.histogram) {
                if (meanStat) meanStat.textContent = "mean: --";
                if (medianStat) medianStat.textContent = "median: --";
                if (stdStat) stdStat.textContent = "std: --";
                if (peakStat) peakStat.textContent = "peak: --";
                return;
            }

            if (meanStat) meanStat.textContent = `mean: ${formatCell(runtime.histogram.mean)}`;
            if (medianStat) medianStat.textContent = `median: ${formatCell(runtime.histogram.median)}`;
            if (stdStat) stdStat.textContent = `std: ${formatCell(runtime.histogram.stdDev)}`;
            if (peakStat) peakStat.textContent = `peak: ${formatCell(runtime.histogram.peakValue)}`;
        }

        function syncControls() {
            canvasHost.classList.toggle("is-pan", runtime.panEnabled);
            canvasHost.classList.toggle("is-grabbing", runtime.isPanning);
            canvasHost.style.cursor = runtime.isPanning ? "grabbing" : runtime.panEnabled ? "grab" : "crosshair";

            if (panToggleButton) {
                panToggleButton.classList.toggle("active", runtime.panEnabled);
                panToggleButton.setAttribute("aria-label", runtime.panEnabled ? "Disable pan" : "Hand");
                panToggleButton.setAttribute("title", runtime.panEnabled ? "Disable pan" : "Hand");
            }
            if (fullscreenButton) {
                const label = runtime.fullscreenActive ? "Exit fullscreen" : "Fullscreen";
                fullscreenButton.classList.toggle("active", runtime.fullscreenActive);
                fullscreenButton.setAttribute("aria-label", label);
                fullscreenButton.setAttribute("title", label);
            }

            if (!runtime.histogram) {
                if (zoomLabel) zoomLabel.textContent = "100%";
                if (rangeLabel) rangeLabel.textContent = "Range: --";
                return;
            }

            const fullSpan = getFullDomainSpan();
            const visibleSpan = getVisibleDomainSpan();
            const zoomPercent = Math.max(100, Math.round((fullSpan / visibleSpan) * 100));
            if (zoomLabel) {
                zoomLabel.textContent = `${zoomPercent}%`;
            }
            if (rangeLabel) {
                rangeLabel.textContent = `Range: ${formatHistogramScaleValue(runtime.domainMin)} to ${formatHistogramScaleValue(runtime.domainMax)}`;
            }
        }

        function resetDomain(options = {}) {
            runtime.domainMin = runtime.fullDomainMin;
            runtime.domainMax = runtime.fullDomainMax;
            if (options.disablePan !== false) {
                runtime.panEnabled = false;
            }
        }

        function setEmptyMessage(message) {
            if (emptyNode) {
                emptyNode.textContent = message || runtime.emptyMessage;
                emptyNode.hidden = false;
            }
            hideHover();
        }

        function clearEmptyMessage() {
            if (emptyNode) {
                emptyNode.hidden = true;
                emptyNode.textContent = "";
            }
        }

        function render() {
            const width = IMAGE_HISTOGRAM_VIEWBOX_WIDTH;
            const height = IMAGE_HISTOGRAM_VIEWBOX_HEIGHT;
            const paddingLeft = 46;
            const paddingRight = 16;
            const paddingTop = 14;
            const paddingBottom = 34;
            const chartWidth = Math.max(140, width - paddingLeft - paddingRight);
            const chartHeight = Math.max(80, height - paddingTop - paddingBottom);
            const baselineY = paddingTop + chartHeight;
            svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

            if (!runtime.histogram) {
                svg.innerHTML = `
        <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="#F8FAFC" stroke="#D9E2F2"></rect>
      `;
                syncControls();
                syncStats();
                return;
            }

            clearEmptyMessage();
            const domainSpan = getVisibleDomainSpan();
            const visibleBins = [];
            let visiblePeakCount = 0;
            for (let index = 0; index < runtime.histogram.binCount; index += 1) {
                const count = runtime.histogram.bins[index] || 0;
                const binStart = runtime.histogram.min + index * runtime.histogram.binWidth;
                const binEnd =
                    index === runtime.histogram.binCount - 1
                        ? runtime.histogram.max
                        : binStart + runtime.histogram.binWidth;
                if (binEnd < runtime.domainMin || binStart > runtime.domainMax) {
                    continue;
                }
                visibleBins.push({ index, count, start: binStart, end: binEnd });
                visiblePeakCount = Math.max(visiblePeakCount, count);
            }
            visiblePeakCount = Math.max(1, visiblePeakCount);
            const midValue = runtime.domainMin + domainSpan / 2;

            const bars = visibleBins
                .map((bin) => {
                    if (bin.count <= 0) {
                        return "";
                    }
                    const x1 = paddingLeft + ((Math.max(bin.start, runtime.domainMin) - runtime.domainMin) / domainSpan) * chartWidth;
                    const x2 = paddingLeft + ((Math.min(bin.end, runtime.domainMax) - runtime.domainMin) / domainSpan) * chartWidth;
                    const barWidth = Math.max(0.9, x2 - x1 - 0.35);
                    const barHeight = (bin.count / visiblePeakCount) * chartHeight;
                    const y = baselineY - barHeight;
                    return `
          <rect
            x="${x1.toFixed(3)}"
            y="${y.toFixed(3)}"
            width="${barWidth.toFixed(3)}"
            height="${Math.max(1, barHeight).toFixed(3)}"
            rx="1.2"
            fill="#111111"
          ></rect>
        `;
                })
                .join("");

            svg.innerHTML = `
        <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="#F8FAFC" stroke="#D9E2F2"></rect>
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${baselineY}" stroke="rgba(71,85,105,0.28)" stroke-width="1"></line>
        <line x1="${paddingLeft}" y1="${baselineY}" x2="${paddingLeft + chartWidth}" y2="${baselineY}" stroke="rgba(71,85,105,0.28)" stroke-width="1"></line>
        <line
          x1="${paddingLeft}"
          y1="${paddingTop + chartHeight / 2}"
          x2="${paddingLeft + chartWidth}"
          y2="${paddingTop + chartHeight / 2}"
          stroke="rgba(148,163,184,0.18)"
          stroke-dasharray="4 4"
          stroke-width="1"
        ></line>
        ${bars}
        <g class="line-axis-labels">
          <text x="${paddingLeft - 6}" y="${paddingTop + 9}" text-anchor="end">${visiblePeakCount.toLocaleString()}</text>
          <text x="${paddingLeft - 6}" y="${baselineY + 4}" text-anchor="end">0</text>
          <text x="${paddingLeft}" y="${baselineY + 18}" text-anchor="start">${escapeHtml(
                formatHistogramScaleValue(runtime.domainMin)
            )}</text>
          <text x="${paddingLeft + chartWidth / 2}" y="${baselineY + 18}" text-anchor="middle">${escapeHtml(
                formatHistogramScaleValue(midValue)
            )}</text>
          <text x="${paddingLeft + chartWidth}" y="${baselineY + 18}" text-anchor="end">${escapeHtml(
                formatHistogramScaleValue(runtime.domainMax)
            )}</text>
        </g>
      `;

            syncControls();
            syncStats();
        }

        function setPayload(payload, options = {}) {
            const safePayload = payload && typeof payload === "object" ? payload : {};
            const nextHistogram = normalizeImageHistogram(safePayload.histogram);
            const previousFullMin = runtime.fullDomainMin;
            const previousFullMax = runtime.fullDomainMax;
            const previousDomainMin = runtime.domainMin;
            const previousDomainMax = runtime.domainMax;
            const preserveViewState = options.preserveViewState === true && runtime.histogram && nextHistogram;

            runtime.title = String(safePayload.title || options.title || runtime.title || "Histogram");
            runtime.subtitle = String(
                safePayload.subtitle || options.subtitle || runtime.subtitle || "Intensity distribution for the current image slice"
            );
            runtime.ariaLabel = String(safePayload.ariaLabel || options.ariaLabel || runtime.ariaLabel || "Image histogram");
            runtime.emptyMessage = String(
                safePayload.emptyMessage || options.emptyMessage || runtime.emptyMessage || "Histogram is unavailable for this image."
            );
            runtime.histogram = nextHistogram;

            if (runtime.histogram) {
                runtime.fullDomainMin = runtime.histogram.min;
                runtime.fullDomainMax = runtime.histogram.max;
                if (preserveViewState) {
                    const previousSpan = Math.max(1e-9, previousFullMax - previousFullMin);
                    const nextSpan = getFullDomainSpan();
                    const startRatio = clampHistogramValue((previousDomainMin - previousFullMin) / previousSpan, 0, 1);
                    const endRatio = clampHistogramValue((previousDomainMax - previousFullMin) / previousSpan, 0, 1);
                    const clamped = clampDomain(
                        runtime.fullDomainMin + startRatio * nextSpan,
                        runtime.fullDomainMin + endRatio * nextSpan
                    );
                    runtime.domainMin = clamped.min;
                    runtime.domainMax = clamped.max;
                } else {
                    resetDomain({ disablePan: false });
                }
            } else {
                runtime.fullDomainMin = 0;
                runtime.fullDomainMax = 1;
                runtime.domainMin = 0;
                runtime.domainMax = 1;
            }

            shell.dataset.imageHistogramPayload = JSON.stringify({
                title: runtime.title,
                subtitle: runtime.subtitle,
                ariaLabel: runtime.ariaLabel,
                emptyMessage: runtime.emptyMessage,
                histogram: runtime.histogram,
            });

            syncHeader();
            if (!runtime.histogram) {
                setEmptyMessage(runtime.emptyMessage);
            }
            render();
        }

        function resolveHoveredBin(point) {
            if (!runtime.histogram) {
                return null;
            }
            const rect = canvasHost.getBoundingClientRect();
            const paddingLeftRatio = 46 / IMAGE_HISTOGRAM_VIEWBOX_WIDTH;
            const paddingRightRatio = 16 / IMAGE_HISTOGRAM_VIEWBOX_WIDTH;
            const paddingTopRatio = 14 / IMAGE_HISTOGRAM_VIEWBOX_HEIGHT;
            const paddingBottomRatio = 34 / IMAGE_HISTOGRAM_VIEWBOX_HEIGHT;
            const chartLeft = rect.width * paddingLeftRatio;
            const chartRight = rect.width * (1 - paddingRightRatio);
            const chartTop = rect.height * paddingTopRatio;
            const chartBottom = rect.height * (1 - paddingBottomRatio);
            if (
                point.x < chartLeft ||
                point.x > chartRight ||
                point.y < chartTop ||
                point.y > chartBottom
            ) {
                return null;
            }

            const ratio = clampHistogramValue((point.x - chartLeft) / Math.max(1, chartRight - chartLeft), 0, 1);
            const value = runtime.domainMin + ratio * getVisibleDomainSpan();
            const fullSpan = getFullDomainSpan();
            const binIndex = clampHistogramValue(
                Math.floor(((value - runtime.histogram.min) / fullSpan) * runtime.histogram.binCount),
                0,
                runtime.histogram.binCount - 1
            );
            const start = runtime.histogram.min + binIndex * runtime.histogram.binWidth;
            const end =
                binIndex === runtime.histogram.binCount - 1
                    ? runtime.histogram.max
                    : start + runtime.histogram.binWidth;
            return {
                index: binIndex,
                start,
                end,
                count: runtime.histogram.bins[binIndex] || 0,
            };
        }

        function updateHover(point) {
            const hoveredBin = resolveHoveredBin(point);
            if (!hoveredBin) {
                hideHover();
                return;
            }
            if (hover) {
                const rect = canvasHost.getBoundingClientRect();
                hover.style.left = `${clampHistogramValue(point.x + 12, 8, Math.max(8, rect.width - 170))}px`;
                hover.style.top = `${clampHistogramValue(point.y + 12, 8, Math.max(8, rect.height - 80))}px`;
                hover.hidden = false;
                hover.innerHTML = `
        <div>Bin: ${hoveredBin.index}</div>
        <div>Range: ${formatHistogramScaleValue(hoveredBin.start)} to ${formatHistogramScaleValue(hoveredBin.end)}</div>
        <div>Count: ${hoveredBin.count.toLocaleString()}</div>
      `;
            }
        }

        function getRelativePoint(event) {
            const rect = canvasHost.getBoundingClientRect();
            return {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            };
        }

        function applyDomainZoom(factor, anchorRatio = 0.5) {
            if (!runtime.histogram) {
                return;
            }
            const currentSpan = getVisibleDomainSpan();
            const nextSpan = currentSpan / Math.max(0.01, factor);
            const safeAnchorRatio = clampHistogramValue(anchorRatio, 0, 1);
            const anchor = runtime.domainMin + safeAnchorRatio * currentSpan;
            const nextMin = anchor - safeAnchorRatio * nextSpan;
            const nextMax = nextMin + nextSpan;
            const clamped = clampDomain(nextMin, nextMax);
            runtime.domainMin = clamped.min;
            runtime.domainMax = clamped.max;
            hideHover();
            render();
        }

        function onWheel(event) {
            if (!runtime.histogram) {
                return;
            }
            event.preventDefault();
            const point = getRelativePoint(event);
            const rect = canvasHost.getBoundingClientRect();
            const anchorRatio = clampHistogramValue(point.x / Math.max(1, rect.width), 0, 1);
            const factor = event.deltaY < 0 ? IMAGE_HISTOGRAM_ZOOM_FACTOR : 1 / IMAGE_HISTOGRAM_ZOOM_FACTOR;
            applyDomainZoom(factor, anchorRatio);
        }

        function onPointerDown(event) {
            const isMousePointer = !event.pointerType || event.pointerType === "mouse";
            if (isMousePointer && event.button !== 0) {
                return;
            }
            if (!runtime.panEnabled || !runtime.histogram) {
                return;
            }
            event.preventDefault();
            const point = getRelativePoint(event);
            runtime.isPanning = true;
            runtime.panPointerId = event.pointerId;
            runtime.panStartX = point.x;
            runtime.panStartDomainMin = runtime.domainMin;
            runtime.panStartDomainMax = runtime.domainMax;
            canvasHost.setPointerCapture(event.pointerId);
            syncControls();
        }

        function stopPan(event = null) {
            if (!runtime.isPanning) {
                return;
            }
            if (event && runtime.panPointerId !== event.pointerId) {
                return;
            }
            const activePointerId = runtime.panPointerId;
            runtime.isPanning = false;
            runtime.panPointerId = null;
            if (Number.isFinite(activePointerId) && canvasHost.hasPointerCapture(activePointerId)) {
                canvasHost.releasePointerCapture(activePointerId);
            }
            syncControls();
        }

        function onPointerMove(event) {
            const point = getRelativePoint(event);
            if (runtime.isPanning && runtime.panPointerId === event.pointerId && runtime.histogram) {
                event.preventDefault();
                const rect = canvasHost.getBoundingClientRect();
                const deltaRatio = (point.x - runtime.panStartX) / Math.max(1, rect.width);
                const panSpan = runtime.panStartDomainMax - runtime.panStartDomainMin;
                const deltaDomain = deltaRatio * panSpan;
                const clamped = clampDomain(
                    runtime.panStartDomainMin - deltaDomain,
                    runtime.panStartDomainMax - deltaDomain
                );
                runtime.domainMin = clamped.min;
                runtime.domainMax = clamped.max;
                hideHover();
                render();
                return;
            }
            updateHover(point);
        }

        function onPointerUp(event) {
            stopPan(event);
            updateHover(getRelativePoint(event));
        }

        function onPointerLeave() {
            if (runtime.isPanning) {
                stopPan();
            }
            hideHover();
        }

        function onTogglePan() {
            runtime.panEnabled = !runtime.panEnabled;
            if (!runtime.panEnabled && runtime.isPanning) {
                stopPan();
            }
            syncControls();
        }

        function onZoomIn() {
            applyDomainZoom(IMAGE_HISTOGRAM_ZOOM_FACTOR, 0.5);
        }

        function onZoomOut() {
            applyDomainZoom(1 / IMAGE_HISTOGRAM_ZOOM_FACTOR, 0.5);
        }

        function onReset() {
            resetDomain();
            hideHover();
            render();
        }

        function syncFullscreenState() {
            shell.classList.toggle("is-fullscreen", runtime.fullscreenActive);
            syncControls();
        }

        function onToggleFullscreen(event) {
            if (event) {
                event.preventDefault();
            }
            runtime.fullscreenActive = !runtime.fullscreenActive;
            syncFullscreenState();
        }

        function onFullscreenEsc(event) {
            if (event.key === "Escape" && runtime.fullscreenActive) {
                event.preventDefault();
                event.stopPropagation();
                runtime.fullscreenActive = false;
                syncFullscreenState();
            }
        }

        const onFullscreenButtonClick = (event) => {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
            onToggleFullscreen();
        };

        shell.__imageHistogramRuntimeApi = {
            updateData(histogram, options = {}) {
                setPayload({
                    title: options.title || runtime.title,
                    subtitle: options.subtitle || runtime.subtitle,
                    ariaLabel: options.ariaLabel || runtime.ariaLabel,
                    emptyMessage: options.emptyMessage || runtime.emptyMessage,
                    histogram,
                }, options);
            },
            setMessage(message, options = {}) {
                setPayload({
                    title: options.title || runtime.title,
                    subtitle: options.subtitle || runtime.subtitle,
                    ariaLabel: options.ariaLabel || runtime.ariaLabel,
                    emptyMessage: message || options.emptyMessage || runtime.emptyMessage,
                    histogram: null,
                }, options);
            },
            togglePan() {
                onTogglePan();
            },
            zoomIn() {
                onZoomIn();
            },
            zoomOut() {
                onZoomOut();
            },
            resetView() {
                onReset();
            },
            toggleFullscreen() {
                onToggleFullscreen();
            },
        };

        canvasHost.addEventListener("wheel", onWheel, { passive: false });
        canvasHost.addEventListener("pointerdown", onPointerDown);
        canvasHost.addEventListener("pointermove", onPointerMove);
        canvasHost.addEventListener("pointerup", onPointerUp);
        canvasHost.addEventListener("pointercancel", stopPan);
        canvasHost.addEventListener("pointerleave", onPointerLeave);
        if (panToggleButton) {
            panToggleButton.addEventListener("click", onTogglePan);
        }
        if (zoomInButton) {
            zoomInButton.addEventListener("click", onZoomIn);
        }
        if (zoomOutButton) {
            zoomOutButton.addEventListener("click", onZoomOut);
        }
        if (resetButton) {
            resetButton.addEventListener("click", onReset);
        }
        if (fullscreenButton) {
            fullscreenButton.addEventListener("click", onFullscreenButtonClick);
        }
        shell.addEventListener("pointerdown", snapshotControlScroll, true);
        shell.addEventListener("click", restoreControlScroll, true);
        document.addEventListener("keydown", onFullscreenEsc);

        setPayload(parseImageHistogramPayload(shell));

        const cleanup = () => {
            if (runtime.destroyed) {
                return;
            }
            runtime.destroyed = true;
            hideHover();
            stopPan();
            canvasHost.removeEventListener("wheel", onWheel);
            canvasHost.removeEventListener("pointerdown", onPointerDown);
            canvasHost.removeEventListener("pointermove", onPointerMove);
            canvasHost.removeEventListener("pointerup", onPointerUp);
            canvasHost.removeEventListener("pointercancel", stopPan);
            canvasHost.removeEventListener("pointerleave", onPointerLeave);
            if (panToggleButton) {
                panToggleButton.removeEventListener("click", onTogglePan);
            }
            if (zoomInButton) {
                zoomInButton.removeEventListener("click", onZoomIn);
            }
            if (zoomOutButton) {
                zoomOutButton.removeEventListener("click", onZoomOut);
            }
            if (resetButton) {
                resetButton.removeEventListener("click", onReset);
            }
            if (fullscreenButton) {
                fullscreenButton.removeEventListener("click", onFullscreenButtonClick);
            }
            shell.removeEventListener("pointerdown", snapshotControlScroll, true);
            shell.removeEventListener("click", restoreControlScroll, true);
            document.removeEventListener("keydown", onFullscreenEsc);
            if (shell.__imageHistogramRuntimeApi) {
                delete shell.__imageHistogramRuntimeApi;
            }
            shell.classList.remove("is-fullscreen");
            canvasHost.style.cursor = "";
            delete shell.dataset.imageHistogramBound;
        };

        IMAGE_HISTOGRAM_RUNTIME_CLEANUPS.add(cleanup);
        return cleanup;
    }

    if (typeof initializeImageHistogramRuntime !== "undefined") {
        moduleState.initializeImageHistogramRuntime = initializeImageHistogramRuntime;
        global.initializeImageHistogramRuntime = initializeImageHistogramRuntime;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime/imageHistogramRuntime");
    }
})(typeof window !== "undefined" ? window : globalThis);


// Viewer HTML module: Delegates panel interaction events and initializes per-shell matrix, line, and heatmap runtimes.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime/bindEvents.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime/bindEvents.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime.bindEvents");

    var runtimeEventRoot = null;
    var runtimeActions = {};
    var disposeRuntimeEventBindings = null;

    function isMobileWidth() {
        return window.innerWidth <= 1024;
    }

    // Removes the current event listener registered on the panel root and resets module-level state
    function clearRuntimePanelBindings() {
        if (typeof disposeRuntimeEventBindings === "function") {
            try {
                disposeRuntimeEventBindings();
            } catch (_error) {
                // ignore cleanup errors on detached roots
            }
        }
        disposeRuntimeEventBindings = null;
        runtimeEventRoot = null;
    }

    // Single delegated click handler covering all panel interaction types (sidebar, axis, dim, matrix, line, compare, export, etc.)
    function bindRuntimeDelegatedEvents(root) {
        function syncFixedIndexPeerInputs(control, rawValue) {
            if (!(control instanceof Element)) {
                return rawValue;
            }

            var dimSlider = control.closest(".dim-slider");
            if (!dimSlider) {
                return rawValue;
            }

            var min = Number(control.getAttribute("min"));
            var max = Number(control.getAttribute("max"));
            var normalizedValue = Number(rawValue);
            if (!Number.isFinite(normalizedValue)) {
                normalizedValue = Number(control.value);
            }
            if (Number.isFinite(min)) {
                normalizedValue = Math.max(min, normalizedValue);
            }
            if (Number.isFinite(max)) {
                normalizedValue = Math.min(max, normalizedValue);
            }
            normalizedValue = Math.trunc(normalizedValue);

            dimSlider.querySelectorAll("[data-fixed-index-range], [data-fixed-index-number]").forEach(function (input) {
                if (!(input instanceof HTMLInputElement)) {
                    return;
                }
                if (input.value !== String(normalizedValue)) {
                    input.value = String(normalizedValue);
                }
            });

            return normalizedValue;
        }

        var onClick = function (event) {
            var target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            var sidebarToggle = target.closest("[data-sidebar-toggle]");
            if (sidebarToggle && root.contains(sidebarToggle)) {
                var sidebar = sidebarToggle.closest(".preview-sidebar");
                if (sidebar) {
                    sidebar.classList.toggle("collapsed");
                }
                return;
            }

            var axisChange = target.closest("[data-axis-change]");
            if (axisChange && root.contains(axisChange)) {
                if (typeof runtimeActions.setDisplayAxis === "function") {
                    var axis = axisChange.dataset.axisChange || "x";
                    var dim = Number(axisChange.dataset.axisDim);
                    runtimeActions.setDisplayAxis(axis, dim);
                }
                return;
            }

            var dimApply = target.closest("[data-dim-apply]");
            if (dimApply && root.contains(dimApply)) {
                if (typeof runtimeActions.applyDisplayConfig === "function") {
                    runtimeActions.applyDisplayConfig();
                }
                return;
            }

            var dimReset = target.closest("[data-dim-reset]");
            if (dimReset && root.contains(dimReset)) {
                if (typeof runtimeActions.resetDisplayConfigFromPreview === "function") {
                    runtimeActions.resetDisplayConfigFromPreview();
                }
                return;
            }

            var fixedIndexPlaybackButton = target.closest("[data-fixed-index-play-action]");
            if (fixedIndexPlaybackButton && root.contains(fixedIndexPlaybackButton)) {
                var playbackAction = fixedIndexPlaybackButton.dataset.fixedIndexPlayAction || "";
                var playDim = Number(fixedIndexPlaybackButton.dataset.fixedDim);
                var playSize = Number(fixedIndexPlaybackButton.dataset.fixedSize);

                if (playbackAction === "start" && typeof runtimeActions.startFixedIndexPlayback === "function") {
                    runtimeActions.startFixedIndexPlayback(playDim, playSize);
                } else if (playbackAction === "stop" && typeof runtimeActions.stopFixedIndexPlayback === "function") {
                    runtimeActions.stopFixedIndexPlayback(playDim);
                }
                return;
            }

            var matrixEnable = target.closest("[data-matrix-enable]");
            if (matrixEnable && root.contains(matrixEnable)) {
                if (typeof runtimeActions.enableMatrixFullView === "function") {
                    runtimeActions.enableMatrixFullView();
                }
                return;
            }

            var lineEnable = target.closest("[data-line-enable]");
            if (lineEnable && root.contains(lineEnable)) {
                if (isMobileWidth()) {
                    root.querySelectorAll(".preview-sidebar").forEach(function (sidebar) {
                        sidebar.classList.add("collapsed");
                    });
                }
                if (typeof runtimeActions.enableLineFullView === "function") {
                    runtimeActions.enableLineFullView();
                }
                return;
            }

            var compareToggle = target.closest("[data-line-compare-toggle]");
            if (compareToggle && root.contains(compareToggle)) {
                if (typeof runtimeActions.toggleLineCompare === "function") {
                    runtimeActions.toggleLineCompare();
                }
                return;
            }

            var compareRemove = target.closest("[data-line-compare-remove]");
            if (compareRemove && root.contains(compareRemove)) {
                if (typeof runtimeActions.removeLineCompareDataset === "function") {
                    runtimeActions.removeLineCompareDataset(compareRemove.dataset.lineCompareRemove || "/");
                }
                return;
            }

            var compareClear = target.closest("[data-line-compare-clear]");
            if (compareClear && root.contains(compareClear)) {
                if (typeof runtimeActions.clearLineCompare === "function") {
                    runtimeActions.clearLineCompare();
                }
                return;
            }

            var compareDismiss = target.closest("[data-line-compare-dismiss]");
            if (compareDismiss && root.contains(compareDismiss)) {
                if (typeof runtimeActions.dismissLineCompareStatus === "function") {
                    runtimeActions.dismissLineCompareStatus();
                }
                return;
            }

            var heatmapEnable = target.closest("[data-heatmap-enable]");
            if (heatmapEnable && root.contains(heatmapEnable)) {
                if (typeof runtimeActions.enableHeatmapFullView === "function") {
                    runtimeActions.enableHeatmapFullView();
                }
            }
        };

        var onChange = function (event) {
            var target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            var dimSelect = target.closest("[data-display-dim-select]");
            if (dimSelect && root.contains(dimSelect)) {
                if (typeof runtimeActions.setDisplayDim === "function") {
                    var index = Number(dimSelect.dataset.dimIndex);
                    var dim = Number(dimSelect.value);
                    runtimeActions.setDisplayDim(index, dim);
                }
                return;
            }

            var fixedNumber = target.closest("[data-fixed-index-number]");
            if (fixedNumber && root.contains(fixedNumber)) {
                if (typeof runtimeActions.stageFixedIndex === "function") {
                    var numDim = Number(fixedNumber.dataset.fixedDim);
                    var numSize = Number(fixedNumber.dataset.fixedSize);
                    var normalizedNumberValue = syncFixedIndexPeerInputs(fixedNumber, fixedNumber.value);
                    runtimeActions.stageFixedIndex(numDim, normalizedNumberValue, numSize, {
                        interaction: "change",
                    });
                }
            }
        };

        var onInput = function (event) {
            var target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            var fixedRange = target.closest("[data-fixed-index-range]");
            if (fixedRange && root.contains(fixedRange)) {
                if (typeof runtimeActions.stageFixedIndex === "function") {
                    var dim = Number(fixedRange.dataset.fixedDim);
                    var size = Number(fixedRange.dataset.fixedSize);
                    var normalizedRangeValue = syncFixedIndexPeerInputs(fixedRange, fixedRange.value);
                    runtimeActions.stageFixedIndex(dim, normalizedRangeValue, size, {
                        interaction: "input",
                    });
                }
            }
        };

        root.addEventListener("click", onClick);
        root.addEventListener("change", onChange);
        root.addEventListener("input", onInput);

        disposeRuntimeEventBindings = function disposeRuntimePanelEvents() {
            root.removeEventListener("click", onClick);
            root.removeEventListener("change", onChange);
            root.removeEventListener("input", onInput);
        };
    }

    function bindViewerPanelEvents(root, actions) {
        if (!root) {
            return;
        }

        runtimeActions = actions && typeof actions === "object" ? actions : {};

        if (runtimeEventRoot !== root || typeof disposeRuntimeEventBindings !== "function") {
            clearRuntimePanelBindings();
            runtimeEventRoot = root;
            bindRuntimeDelegatedEvents(root);
        }

        if (typeof clearViewerRuntimeBindings === "function") {
            clearViewerRuntimeBindings();
        }

        if (isMobileWidth()) {
            root.querySelectorAll(".preview-sidebar").forEach(function (sidebar) {
                sidebar.classList.add("collapsed");
            });
        }

        root.querySelectorAll("[data-matrix-shell]").forEach(function (shell) {
            if (typeof initializeMatrixRuntime === "function") {
                initializeMatrixRuntime(shell);
            }
        });

        root.querySelectorAll("[data-line-shell]").forEach(function (shell) {
            if (typeof initializeLineRuntime === "function") {
                initializeLineRuntime(shell);
            }
        });

        root.querySelectorAll("[data-image-histogram-shell]").forEach(function (shell) {
            if (typeof initializeImageHistogramRuntime === "function") {
                initializeImageHistogramRuntime(shell);
            }
        });

        root.querySelectorAll("[data-heatmap-shell]").forEach(function (shell) {
            if (typeof initializeHeatmapRuntime === "function") {
                initializeHeatmapRuntime(shell);
            }
        });
    }

    if (typeof bindViewerPanelEvents !== "undefined") {
        moduleState.bindViewerPanelEvents = bindViewerPanelEvents;
        global.bindViewerPanelEvents = bindViewerPanelEvents;
    }
    if (typeof clearRuntimePanelBindings !== "undefined") {
        moduleState.clearRuntimePanelBindings = clearRuntimePanelBindings;
        global.clearRuntimePanelBindings = clearRuntimePanelBindings;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime/bindEvents");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Provides runtime facade binding function used by higher-level viewer panel integration.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel/runtime.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel/runtime.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel.runtime");

    // Capture the real implementation from viewerPanel/runtime/bindEvents.js which was loaded just before this file
    var delegateBindViewerPanelEvents = global.bindViewerPanelEvents;

    // Re-publishes bindViewerPanelEvents as the authoritative global, shadowing the lower-level implementation
    function bindViewerPanelEvents(root, actions) {
        if (typeof delegateBindViewerPanelEvents !== "function") {
            console.error("[HDFViewer] Missing bindViewerPanelEvents for components/viewerPanel/runtime.");
            return;
        }
        return delegateBindViewerPanelEvents(root, actions);
    }
    if (typeof bindViewerPanelEvents !== "undefined") {
        moduleState.bindViewerPanelEvents = bindViewerPanelEvents;
        global.bindViewerPanelEvents = bindViewerPanelEvents;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel/runtime");
    }
})(typeof window !== "undefined" ? window : globalThis);




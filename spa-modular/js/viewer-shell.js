// Viewer HTML module: Exposes stable viewer-panel facade functions that delegate to render and runtime bind implementations.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/viewerPanel.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/viewerPanel.");
        return;
    }
    var moduleState = ensurePath(ns, "components.viewerPanel");

    // Capture the render and bind functions that were registered by the lower-level viewerPanel/render and viewerPanel/runtime submodules
    var delegateRenderViewerPanel = global.renderViewerPanel;
    var delegateBindViewerPanelEvents = global.bindViewerPanelEvents;

    // Facade: validates and delegates to the real render implementation loaded from viewerPanel/render.js
    function renderViewerPanel(state) {
        if (typeof delegateRenderViewerPanel !== "function") {
            console.error("[HDFViewer] Missing renderViewerPanel for components/viewerPanel.");
            return "";
        }
        return delegateRenderViewerPanel(state);
    }

    // Facade: validates and delegates to the real event bind implementation loaded from viewerPanel/runtime modules
    function bindViewerPanelEvents(root, actions) {
        if (typeof delegateBindViewerPanelEvents !== "function") {
            console.error("[HDFViewer] Missing bindViewerPanelEvents for components/viewerPanel.");
            return;
        }
        return delegateBindViewerPanelEvents(root, actions);
    }
    if (typeof renderViewerPanel !== "undefined") {
        moduleState.renderViewerPanel = renderViewerPanel;
        global.renderViewerPanel = renderViewerPanel;
    }
    if (typeof bindViewerPanelEvents !== "undefined") {
        moduleState.bindViewerPanelEvents = bindViewerPanelEvents;
        global.bindViewerPanelEvents = bindViewerPanelEvents;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/viewerPanel");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Renders the lazy tree sidebar and delegates tree selection, retry, toggle, and compare-add events.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for components/sidebarTree.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading components/sidebarTree.");
        return;
    }
    var moduleState = ensurePath(ns, "components.sidebarTree");

    // Returns the cached children array for a path, or null if not yet loaded
    function getChildren(state, path) {
        if (!(state.childrenCache instanceof Map)) {
            return null;
        }
        return state.childrenCache.has(path) ? state.childrenCache.get(path) : null;
    }

    function hasPath(state, path) {
        return state.childrenCache instanceof Map && state.childrenCache.has(path);
    }

    function isExpanded(state, path) {
        return state.expandedPaths instanceof Set && state.expandedPaths.has(path);
    }

    function isLoading(state, path) {
        return state.treeLoadingPaths instanceof Set && state.treeLoadingPaths.has(path);
    }

    function getError(state, path) {
        if (!(state.treeErrors instanceof Map)) {
            return null;
        }
        return state.treeErrors.get(path) || null;
    }

    function normalizePath(path) {
        if (!path || path === "/") {
            return "/";
        }
        const normalized = `/${String(path).replace(/^\/+/, "").replace(/\/+/g, "/")}`;
        return normalized.endsWith("/") && normalized.length > 1
            ? normalized.slice(0, -1)
            : normalized;
    }

    function normalizeShape(shape) {
        if (!Array.isArray(shape)) {
            return [];
        }
        return shape
            .map((entry) => Number(entry))
            .filter((entry) => Number.isFinite(entry) && entry >= 0);
    }

    // Checks whether a string dtype indicates a numeric type suitable for line chart plotting
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

    // Searches all cached children arrays to find a dataset node matching the given path
    // Used when the preview object is not yet available to determine compare-add eligibility
    function lookupDatasetFromCache(state, targetPath) {
        const normalizedTargetPath = normalizePath(targetPath);
        if (!(state.childrenCache instanceof Map)) {
            return null;
        }

        for (const children of state.childrenCache.values()) {
            if (!Array.isArray(children)) {
                continue;
            }

            const hit = children.find((entry) => {
                return entry?.type === "dataset" && normalizePath(entry?.path || "/") === normalizedTargetPath;
            });

            if (hit) {
                return {
                    path: normalizePath(hit.path || normalizedTargetPath),
                    dtype: String(hit.dtype || ""),
                    shape: normalizeShape(hit.shape),
                    ndim: Number(hit.ndim),
                };
            }
        }

        return null;
    }

    function getBaseDatasetForCompare(state) {
        const selectedPath = normalizePath(state.selectedPath || "/");
        if (selectedPath === "/") {
            return null;
        }

        const preview =
            state.preview && normalizePath(state.preview.path || "/") === selectedPath ? state.preview : null;
        if (preview) {
            const shape = normalizeShape(preview.shape);
            const ndim = Number.isFinite(Number(preview.ndim)) ? Number(preview.ndim) : shape.length;
            return {
                path: selectedPath,
                dtype: String(preview.dtype || ""),
                shape,
                ndim,
            };
        }

        return lookupDatasetFromCache(state, selectedPath);
    }

    function shapesMatch(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((entry, index) => Number(entry) === Number(right[index]));
    }

    function isDatasetCompatibleWithBase(baseDataset, candidateDataset) {
        if (!baseDataset || !candidateDataset) {
            return false;
        }
        if (!isNumericDtype(baseDataset.dtype) || !isNumericDtype(candidateDataset.dtype)) {
            return false;
        }
        if (!Number.isFinite(baseDataset.ndim) || !Number.isFinite(candidateDataset.ndim)) {
            return false;
        }
        if (baseDataset.ndim !== candidateDataset.ndim) {
            return false;
        }
        return shapesMatch(baseDataset.shape, candidateDataset.shape);
    }

    function renderStatus(state, path) {
        const loading = isLoading(state, path);
        const error = getError(state, path);

        if (loading) {
            return '<li class="tree-status">Loading...</li>';
        }

        if (error) {
            return `
      <li class="tree-status error">
        <span>${escapeHtml(error)}</span>
        <button class="tree-retry-btn" data-tree-retry-path="${escapeHtml(path)}" type="button">Retry</button>
      </li>
    `;
        }

        if (hasPath(state, path)) {
            const children = getChildren(state, path) || [];
            if (!children.length) {
                return '<li class="tree-status">No items</li>';
            }
        }

        return "";
    }

    function renderNode(node, state, compareContext = null) {
        const path = normalizePath(node.path || "/");
        const nodeType = node.type === "dataset" ? "dataset" : "group";
        const name = node.name || (path === "/" ? state.selectedFile || "root" : path.split("/").filter(Boolean).pop());
        const selected = state.selectedPath === path ? "active" : "";
        const expanded = nodeType === "group" && isExpanded(state, path);
        const loaded = nodeType === "group" && hasPath(state, path);
        const caretClass = [
            "tree-caret",
            nodeType === "group" ? "" : "is-leaf",
            expanded ? "is-open" : "",
        ]
            .filter(Boolean)
            .join(" ");
        const iconClass = nodeType === "group" ? "tree-icon is-group" : "tree-icon is-dataset";
        const count = Number(node.num_children) || 0;
        const compareMode = Boolean(compareContext?.enabled) && nodeType === "dataset";
        const candidateDataset = compareMode
            ? {
                path,
                dtype: String(node.dtype || ""),
                shape: normalizeShape(node.shape),
                ndim: Number(node.ndim),
            }
            : null;
        const comparePathSet = compareContext?.pathSet || new Set();
        const alreadyCompared = comparePathSet.has(path);
        const isBaseDataset = nodeType === "dataset" && state.selectedPath === path;
        const isCompatibleCandidate =
            compareMode && !isBaseDataset
                ? isDatasetCompatibleWithBase(compareContext?.baseDataset || null, candidateDataset)
                : false;
        const showCompareControl = compareMode && (isBaseDataset || alreadyCompared || isCompatibleCandidate);
        const compareButtonLabel = isBaseDataset ? "Base" : alreadyCompared ? "Added" : "Compare";
        const compareShape = Array.isArray(candidateDataset?.shape) ? candidateDataset.shape.join(",") : "";
        const compareDtype = node.dtype || "";
        const compareNdim = Number.isFinite(Number(candidateDataset?.ndim))
            ? Number(candidateDataset.ndim)
            : "";

        return `
    <li class="tree-node">
      <div class="tree-row-wrap">
        <button class="tree-row ${selected}" type="button"
            data-tree-select-path="${escapeHtml(path)}"
            data-tree-select-type="${escapeHtml(nodeType)}"
            data-tree-select-name="${escapeHtml(name)}"
          >
            ${nodeType === "group"
                ? `<span class="${caretClass}" data-tree-toggle-path="${escapeHtml(path)}"></span>`
                : `<span class="${caretClass}"></span>`
            }
            <span class="${iconClass}" aria-hidden="true"></span>
            <span class="tree-label">${escapeHtml(name)}</span>
            ${nodeType === "group" && count > 0 ? `<span class="tree-count">${count}</span>` : ""}
        </button>
        ${showCompareControl
                ? `<button
                  type="button"
                  class="tree-compare-btn ${isBaseDataset || alreadyCompared ? "is-disabled" : ""}"
                  data-tree-compare-add-path="${escapeHtml(path)}"
                  data-tree-compare-add-name="${escapeHtml(name)}"
                  data-tree-compare-add-type="${escapeHtml(nodeType)}"
                  data-tree-compare-add-dtype="${escapeHtml(compareDtype)}"
                  data-tree-compare-add-shape="${escapeHtml(compareShape)}"
                  data-tree-compare-add-ndim="${escapeHtml(compareNdim)}"
                  title="${isBaseDataset
                    ? "Base dataset currently plotted"
                    : alreadyCompared
                        ? "Already added to comparison"
                        : "Add dataset to line comparison"
                }"
                  ${isBaseDataset || alreadyCompared ? "disabled" : ""}
                >${compareButtonLabel}</button>`
                : ""
            }
      </div>
        ${nodeType === "group" && expanded
                ? `<ul class="tree-branch">${loaded
                    ? (getChildren(state, path) || [])
                        .map((child) => renderNode(child, state, compareContext))
                        .join("")
                    : ""
                }${renderStatus(state, path)}</ul>`
                : ""
            }
    </li>
  `;
    }

    function renderSidebarMetadata(state) {
        // Reuse the shared metadata markup so the sidebar stays aligned with the
        // metadata formatting logic already maintained in viewerPanel/render/sections.js.
        const fallback = `
    <div class="sidebar-metadata-panel">
      <div class="panel-state">
        <div class="state-text">Metadata panel is unavailable.</div>
      </div>
    </div>
  `;

        const content =
            typeof renderMetadataPanelContent === "function"
                ? renderMetadataPanelContent(state, { wrapperClass: "sidebar-metadata-content" })
                : fallback;

        return `
    <div id="metadata-panel" class="sidebar-section sidebar-section-metadata">
      <div class="section-label">Metadata</div>
      <div class="sidebar-panel-scroll sidebar-metadata-scroll">
        <div class="sidebar-metadata-panel">
          ${content}
        </div>
      </div>
    </div>
  `;
    }

    function renderSidebarTree(state) {
        const treeRoot = {
            type: "group",
            name: state.selectedFile || "root",
            path: "/",
            num_children: (getChildren(state, "/") || []).length,
        };
        const compareTreeScrollEnabled =
            state.route === "viewer" &&
            state.viewMode === "display" &&
            state.displayTab === "line" &&
            state.lineCompareEnabled === true;
        const compareItems = Array.isArray(state.lineCompareItems) ? state.lineCompareItems : [];
        const comparePathSet = new Set(
            compareItems.map((entry) => normalizePath(entry?.path || "/"))
        );
        const compareContext = {
            enabled: compareTreeScrollEnabled,
            baseDataset: compareTreeScrollEnabled ? getBaseDatasetForCompare(state) : null,
            pathSet: comparePathSet,
        };

        return `
    <aside id="viewer-sidebar" class="viewer-sidebar">
      <div id="tree-panel" class="sidebar-section sidebar-section-tree">
        <button class="sidebar-close-btn" id="sidebar-close-btn" type="button" aria-label="Close sidebar">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="4" y1="4" x2="14" y2="14"/><line x1="14" y1="4" x2="4" y2="14"/>
          </svg>
        </button>
        <div class="section-label">Structure</div>
        <div class="sidebar-tree ${compareTreeScrollEnabled ? "is-compare-mode" : ""}">
          <ul id="tree-list" class="tree-root">
            ${renderNode(treeRoot, state, compareContext)}
          </ul>
        </div>
        <div id="tree-status" class="tree-status" aria-live="polite"></div>
      </div>
      <!-- SPA-specific layout: metadata lives below the tree instead of in a main-pane inspect tab. -->
      ${renderSidebarMetadata(state)}
    </aside>
  `;
    }

    let sidebarTreeEventRoot = null;
    let sidebarTreeActions = {};
    let disposeSidebarTreeEvents = null;

    function clearSidebarTreeBindings() {
        if (typeof disposeSidebarTreeEvents === "function") {
            try {
                disposeSidebarTreeEvents();
            } catch (_error) {
                // ignore cleanup failures on detached roots
            }
        }
        disposeSidebarTreeEvents = null;
        sidebarTreeEventRoot = null;
    }

    function bindSidebarTreeEvents(root, actions) {
        if (!root) {
            return;
        }

        sidebarTreeActions = actions && typeof actions === "object" ? actions : {};
        if (sidebarTreeEventRoot === root && typeof disposeSidebarTreeEvents === "function") {
            return;
        }

        clearSidebarTreeBindings();
        sidebarTreeEventRoot = root;

        const onClick = (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const compareButton = target.closest("[data-tree-compare-add-path]");
            if (compareButton && root.contains(compareButton)) {
                event.preventDefault();
                event.stopPropagation();

                if (compareButton.disabled) {
                    return;
                }

                const shape = String(compareButton.dataset.treeCompareAddShape || "")
                    .split(",")
                    .map((entry) => Number(entry))
                    .filter((entry) => Number.isFinite(entry) && entry >= 0);

                if (typeof sidebarTreeActions.addLineCompareDataset === "function") {
                    sidebarTreeActions.addLineCompareDataset({
                        path: compareButton.dataset.treeCompareAddPath || "/",
                        name: compareButton.dataset.treeCompareAddName || "",
                        type: compareButton.dataset.treeCompareAddType || "dataset",
                        dtype: compareButton.dataset.treeCompareAddDtype || "",
                        ndim: Number(compareButton.dataset.treeCompareAddNdim),
                        shape,
                    });
                }
                return;
            }

            const toggleButton = target.closest("[data-tree-toggle-path]");
            if (toggleButton && root.contains(toggleButton)) {
                event.stopPropagation();
                if (typeof sidebarTreeActions.toggleTreePath === "function") {
                    sidebarTreeActions.toggleTreePath(toggleButton.dataset.treeTogglePath || "/");
                }
                return;
            }

            const retryButton = target.closest("[data-tree-retry-path]");
            if (retryButton && root.contains(retryButton)) {
                if (typeof sidebarTreeActions.loadTreeChildren === "function") {
                    void sidebarTreeActions.loadTreeChildren(retryButton.dataset.treeRetryPath || "/", {
                        force: true,
                    });
                }
                return;
            }

            const selectButton = target.closest("[data-tree-select-path]");
            if (selectButton && root.contains(selectButton)) {
                if (typeof sidebarTreeActions.selectTreeNode === "function") {
                    sidebarTreeActions.selectTreeNode({
                        path: selectButton.dataset.treeSelectPath || "/",
                        type: selectButton.dataset.treeSelectType || "group",
                        name: selectButton.dataset.treeSelectName || "",
                    });
                }
            }
        };

        root.addEventListener("click", onClick);
        disposeSidebarTreeEvents = function disposeSidebarTreeEventsImpl() {
            root.removeEventListener("click", onClick);
        };
    }
    if (typeof renderSidebarTree !== "undefined") {
        moduleState.renderSidebarTree = renderSidebarTree;
        global.renderSidebarTree = renderSidebarTree;
    }
    if (typeof bindSidebarTreeEvents !== "undefined") {
        moduleState.bindSidebarTreeEvents = bindSidebarTreeEvents;
        global.bindSidebarTreeEvents = bindSidebarTreeEvents;
    }
    if (typeof clearSidebarTreeBindings !== "undefined") {
        moduleState.clearSidebarTreeBindings = clearSidebarTreeBindings;
        global.clearSidebarTreeBindings = clearSidebarTreeBindings;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("components/sidebarTree");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Orchestrates static shell rendering, status updates, delegated UI events, and export dispatching.
(function (global) {
    "use strict";

    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for views/viewerView.");
        return;
    }

    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading views/viewerView.");
        return;
    }

    var moduleState = ensurePath(ns, "views.viewerView");
    var domRefs = ns.core && ns.core.domRefs ? ns.core.domRefs : null;

    if (!domRefs || typeof domRefs.collect !== "function" || typeof domRefs.validate !== "function") {
        console.error("[HDFViewer] Missing core/domRefs dependency for views/viewerView.");
        return;
    }

    var REQUIRED_DOM_IDS = Array.isArray(domRefs.REQUIRED_IDS) ? domRefs.REQUIRED_IDS : [];
    // Module-level state for the single delegated event listener on the shell root
    var disposeViewerViewBindings = null;
    var eventRoot = null;
    var eventActions = {};
    var disposeSidebarResizeBindings = null;
    var sidebarResizeRoot = null;
    // Guards against concurrent export button presses triggering duplicate downloads
    var exportRunning = false;
    var SIDEBAR_RESIZE_STORAGE_KEY = "hdf-viewer.sidebar-width";
    var SIDEBAR_RESIZE_MIN_RATIO = 0.15;
    var SIDEBAR_RESIZE_MAX_RATIO = 0.42;
    var SIDEBAR_RESIZE_MIN_PX = 240;
    var SIDEBAR_RESIZE_MAX_PX = 680;
    var SIDEBAR_RESIZE_STEP_PX = 20;

    // Returns escapeHtml from utils/format.js for XSS-safe rendering; falls back to an inline implementation
    function resolveEscapeHtml() {
        if (typeof escapeHtml === "function") {
            return escapeHtml;
        }
        return function fallbackEscape(value) {
            return String(value || "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");
        };
    }

    function collectDomRefs(rootDoc) {
        return domRefs.collect(rootDoc || document);
    }

    function validateViewerDomIds(rootDoc) {
        return domRefs.validate(rootDoc || document);
    }

    // Extracts innerHTML from the first child of an HTML string; used to strip wrappers added by component render functions
    function stripSingleRoot(html) {
        var markup = typeof html === "string" ? html.trim() : "";
        if (!markup) {
            return "";
        }

        var template = document.createElement("template");
        template.innerHTML = markup;
        var firstElement = template.content.firstElementChild;

        if (!firstElement) {
            return markup;
        }

        return firstElement.innerHTML;
    }

    // Removes the current event delegation listener and cleans up sidebar and panel runtime bindings
    function clearViewerViewBindings() {
        if (typeof disposeViewerViewBindings === "function") {
            try {
                disposeViewerViewBindings();
            } catch (_error) {
                // ignore cleanup errors from detached nodes
            }
        }

        disposeViewerViewBindings = null;
        eventRoot = null;
        eventActions = {};
        exportRunning = false;

        if (typeof disposeSidebarResizeBindings === "function") {
            try {
                disposeSidebarResizeBindings();
            } catch (_error) {
                // ignore cleanup errors from detached nodes
            }
        }
        disposeSidebarResizeBindings = null;
        sidebarResizeRoot = null;

        if (typeof clearSidebarTreeBindings === "function") {
            clearSidebarTreeBindings();
        }
        if (typeof clearRuntimePanelBindings === "function") {
            clearRuntimePanelBindings();
        }
    }

    // Async init hook called during boot; currently a no-op, reserved for future template pre-hydration logic
    async function initViewerViewTemplate() {
        return Promise.resolve();
    }

    function normalizePath(path) {
        if (!path || path === "/") {
            return "/";
        }

        var normalized = "/" + String(path).replace(/^\/+/, "").replace(/\/+$/g, "");
        return normalized || "/";
    }

    function getBreadcrumbSegments(path) {
        var normalized = normalizePath(path);
        var parts = normalized === "/" ? [] : normalized.split("/").filter(Boolean);
        var current = "";

        return parts.map(function (part) {
            current += "/" + part;
            return {
                label: part,
                path: current,
            };
        });
    }

    function renderViewerTopBar(state) {
        var esc = resolveEscapeHtml();
        var segments = getBreadcrumbSegments(state.selectedPath);
        var fileCrumbActive = segments.length === 0 ? "active" : "";

        return `
      <div class="topbar-left">
        <button id="sidebar-toggle-btn" class="sidebar-toggle-btn" type="button" aria-label="Toggle sidebar">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="3" y1="5" x2="17" y2="5"/>
            <line x1="3" y1="10" x2="17" y2="10"/>
            <line x1="3" y1="15" x2="17" y2="15"/>
          </svg>
        </button>
        <div class="topbar-path">
          <div class="breadcrumb-label">File location</div>
          <div id="breadcrumb-path" class="breadcrumb">
            <button id="breadcrumb-file" class="crumb crumb-btn ${fileCrumbActive}" data-breadcrumb-path="/" type="button">${esc(
            state.selectedFile || "No file selected"
        )}</button>
            ${segments
                .map(function (segment, index) {
                    var active = index === segments.length - 1 ? "active" : "";
                    return `<button class="crumb crumb-btn ${active}" data-breadcrumb-path="${esc(
                        segment.path
                    )}" type="button">${esc(segment.label)}</button>`;
                })
                .join("")}
          </div>
        </div>
      </div>

      <div class="topbar-right">
        <button id="viewer-back-btn" class="ghost-btn" type="button">
          <svg class="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 2 4 8 10 14"/></svg>
          <span class="btn-label">Back to files</span>
        </button>
        <button id="viewer-fullscreen-btn" class="ghost-btn" type="button" title="Toggle fullscreen">
          <svg class="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>
          <span class="btn-label">Fullscreen</span>
        </button>
      </div>
    `;
    }

    function renderExportMenu(target, disabled) {
        var esc = resolveEscapeHtml();
        var targetKey = String(target || "").trim().toLowerCase();
        var options =
            targetKey === "line" || targetKey === "heatmap" || targetKey === "image"
                ? [
                    { action: "csv-displayed", label: "CSV (Displayed)" },
                    { action: "csv-full", label: "CSV (Full)" },
                    { action: "png-current", label: "PNG (Current View)" },
                ]
                : [
                    { action: "csv-displayed", label: "CSV (Displayed)" },
                    { action: "csv-full", label: "CSV (Full)" },
                ];

        return `
      <div class="subbar-export-wrap" data-export-root="true">
        <button
          type="button"
          class="subbar-export"
          data-export-toggle="true"
          aria-haspopup="menu"
          aria-expanded="false"
          ${disabled ? "disabled" : ""}
        >
          Export
        </button>
        <div class="subbar-export-menu" data-export-menu="true" role="menu" aria-hidden="true">
          ${options
                .map(function (option) {
                    return `
                <button
                  type="button"
                  class="subbar-export-item"
                  data-export-target="${esc(targetKey || "matrix")}" 
                  data-export-action="${esc(option.action)}"
                  role="menuitem"
                  ${disabled ? "disabled" : ""}
                >
                  ${esc(option.label)}
                </button>
              `;
                })
                .join("")}
        </div>
      </div>
    `;
    }

    function renderPreviewToolbar(state) {
        var activeTab = state.displayTab || "line";
        var disabled = state.selectedNodeType !== "dataset" || state.previewLoading;
        var showHeatmap = Number((state.preview && state.preview.ndim) || 0) >= 2;

        return `
      <div id="subbar-tabs" class="subbar-tabs">
        <button type="button" class="subbar-tab ${activeTab === "table" ? "active" : ""}" data-display-tab="table" ${disabled ? "disabled" : ""
            }>Matrix</button>
        <button type="button" class="subbar-tab ${activeTab === "line" ? "active" : ""}" data-display-tab="line" ${disabled ? "disabled" : ""
            }>Line Graph</button>
        ${showHeatmap
                ? `<button type="button" class="subbar-tab ${activeTab === "image" ? "active" : ""
                }" data-display-tab="image" ${disabled ? "disabled" : ""}>Image</button>
        <button type="button" class="subbar-tab ${activeTab === "heatmap" ? "active" : ""
                }" data-display-tab="heatmap" ${disabled ? "disabled" : ""}>Heatmap</button>`
                : ""
            }
      </div>

      ${activeTab === "line"
                ? `<div id="subbar-actions" class="subbar-actions">
               <button type="button" class="subbar-toggle ${state.lineGrid ? "active" : ""
                }" data-line-grid-toggle="true" ${disabled ? "disabled" : ""}>Grid</button>
               <div class="aspect-group">
                 <span class="aspect-label">Aspect</span>
                 <div class="aspect-tabs">
                   ${["line", "point", "both"]
                    .map(function (value) {
                        return `<button type="button" class="aspect-tab ${state.lineAspect === value ? "active" : ""
                            }" data-line-aspect="${value}" ${disabled ? "disabled" : ""}>${value.charAt(0).toUpperCase() + value.slice(1)
                            }</button>`;
                    })
                    .join("")}
                 </div>
               </div>
               ${renderExportMenu("line", disabled)}
             </div>`
                : activeTab === "heatmap" || activeTab === "image"
                    ? `<div id="subbar-actions" class="subbar-actions">
               <button type="button" class="subbar-toggle ${state.heatmapGrid ? "active" : ""
                    }" data-heatmap-grid-toggle="true" ${disabled ? "disabled" : ""}>Grid</button>
               <div class="colormap-group">
                 <span class="colormap-label">Color</span>
                 <div class="colormap-tabs">
                   ${activeTab === "image"
                        ? `<button type="button" class="colormap-tab active" ${disabled ? "disabled" : ""}>Gray Scale</button>`
                        : ["viridis", "plasma", "inferno", "magma", "cool", "hot"]
                        .map(function (value) {
                            return `<button type="button" class="colormap-tab ${state.heatmapColormap === value ? "active" : ""
                                }" data-heatmap-colormap="${value}" ${disabled ? "disabled" : ""}>${value.charAt(0).toUpperCase() + value.slice(1)
                                }</button>`;
                        })
                        .join("")}
                 </div>
               </div>
               ${renderExportMenu(activeTab === "image" ? "image" : "heatmap", disabled)}
             </div>`
                    : `<div id="subbar-actions" class="subbar-actions">
               <div class="notation-group">
                 <span class="notation-label">Notation</span>
                 <div class="notation-tabs">
                   ${["auto", "scientific", "exact"]
                        .map(function (value) {
                            return `<button type="button" class="notation-tab ${state.notation === value ? "active" : ""
                                }" data-notation="${value}" ${disabled ? "disabled" : ""}>${value.charAt(0).toUpperCase() + value.slice(1)
                                }</button>`;
                        })
                        .join("")}
                 </div>
               </div>
               ${renderExportMenu("matrix", disabled)}
             </div>`
            }
    `;
    }

    var MISSING_FILE_VIEWER_MESSAGE = "Select the h5 file to open viewer.";

    function renderMissingFilePanel(_exampleUrl) {
        return `
      <div class="panel-state">
        <div class="state-text">${MISSING_FILE_VIEWER_MESSAGE}</div>
      </div>
    `;
    }

    function resolveTreeStatus(state, missingFile) {
        if (missingFile) {
            return { tone: "info", message: "" };
        }
        if (!state.selectedFile) {
            return { tone: "info", message: "No active file selected." };
        }

        var rootLoading =
            state.treeLoadingPaths instanceof Set && state.treeLoadingPaths.has("/");
        if (rootLoading) {
            return { tone: "info", message: "Loading tree..." };
        }

        var rootError =
            state.treeErrors instanceof Map ? state.treeErrors.get("/") : null;
        if (rootError) {
            return { tone: "error", message: String(rootError) };
        }

        return { tone: "info", message: "" };
    }

    function resolveDisplayStatus(state, missingFile) {
        if (missingFile) {
            return {
                tone: "info",
                message: "",
            };
        }

        if (state.previewError) {
            return { tone: "error", message: String(state.previewError) };
        }
        if (state.previewLoading) {
            return { tone: "info", message: "Loading preview..." };
        }

        return { tone: "info", message: "" };
    }

    function resolveInspectStatus(state, missingFile) {
        if (missingFile) {
            return {
                tone: "info",
                message: "",
            };
        }

        if (state.metadataError) {
            return { tone: "error", message: String(state.metadataError) };
        }
        if (state.metadataLoading) {
            return { tone: "info", message: "Loading metadata..." };
        }

        return { tone: "info", message: "" };
    }

    function resolveGlobalStatus(state, missingFile) {
        if (missingFile) {
            return {
                tone: "info",
                message: "",
            };
        }

        if (state.error) {
            return { tone: "error", message: String(state.error) };
        }

        return { tone: "info", message: "" };
    }

    function renderViewerView(state, options) {
        var opts = options && typeof options === "object" ? options : {};
        var validation = validateViewerDomIds(document);

        if (!validation.ok) {
            return "";
        }

        var refs = collectDomRefs(document);
        var missingFile = opts.missingFile === true;
        var treeStatus = resolveTreeStatus(state, missingFile);
        var displayStatus = resolveDisplayStatus(state, missingFile);
        var globalStatus = resolveGlobalStatus(state, missingFile);

        domRefs.toggleClass(refs.viewerApp, "sidebar-open", !!state.sidebarOpen);
        domRefs.toggleClass(refs.viewerApp, "sidebar-collapsed", !state.sidebarOpen);

        if (refs.sidebarBackdrop) {
            refs.sidebarBackdrop.style.display = state.sidebarOpen && !missingFile ? "" : "none";
        }

        if (typeof renderSidebarTree === "function") {
            domRefs.setHtml(refs.viewerSidebar, stripSingleRoot(renderSidebarTree(state)));
        }
        domRefs.setHtml(refs.viewerTopbar, renderViewerTopBar(state));

        // The SPA shell keeps the main area display-only, so the subbar follows
        // file availability rather than a display/inspect mode toggle.
        if (!missingFile) {
            domRefs.setHidden(refs.viewerSubbar, false);
            domRefs.setHtml(refs.viewerSubbar, renderPreviewToolbar(state));
        } else {
            domRefs.setHidden(refs.viewerSubbar, true);
            domRefs.setHtml(
                refs.viewerSubbar,
                '<div id="subbar-tabs" class="subbar-tabs"></div><div id="subbar-actions" class="subbar-actions"></div>'
            );
        }

        var panelInner =
            typeof renderViewerPanel === "function"
                ? stripSingleRoot(renderViewerPanel(state))
                : "";

        if (missingFile) {
            var missingPanel = renderMissingFilePanel(opts.deepLinkExample);
            domRefs.setHidden(refs.displayPane, false);
            domRefs.setHidden(refs.inspectPane, true);
            domRefs.setHtml(refs.displayPane, missingPanel);
            domRefs.setHtml(refs.inspectPane, "");
        } else {
            // Metadata is rendered inside the sidebar; the main pane always hosts display content.
            domRefs.setHidden(refs.displayPane, false);
            domRefs.setHidden(refs.inspectPane, true);
            domRefs.setHtml(refs.displayPane, panelInner);
            domRefs.setHtml(refs.inspectPane, "");
        }

        domRefs.setStatus(refs.treeStatus, treeStatus.message, treeStatus.tone);
        domRefs.setStatus(refs.displayStatus, displayStatus.message, displayStatus.tone);
        // Legacy inspect status element remains hidden so older DOM expectations still validate.
        domRefs.setStatus(refs.inspectStatus, "", "info");
        domRefs.setHidden(refs.inspectStatus, true);
        domRefs.setStatus(refs.globalStatus, globalStatus.message, globalStatus.tone);

        return "";
    }

    function closeAllExportMenus(root) {
        root.querySelectorAll("[data-export-root]").forEach(function (menuRoot) {
            var menu = menuRoot.querySelector("[data-export-menu]");
            var toggle = menuRoot.querySelector("[data-export-toggle]");
            if (menu) {
                menu.setAttribute("aria-hidden", "true");
            }
            if (toggle) {
                toggle.setAttribute("aria-expanded", "false");
            }
            menuRoot.classList.remove("is-open");
        });
    }

    function setExportRunning(root, running) {
        exportRunning = running === true;
        root.querySelectorAll("[data-export-action]").forEach(function (button) {
            var baseDisabled = button.dataset.exportBaseDisabled === "1";
            button.disabled = exportRunning || baseDisabled;
        });
    }

    function refreshExportButtonState(root) {
        root.querySelectorAll("[data-export-action]").forEach(function (button) {
            if (!button.dataset.exportBaseDisabled) {
                button.dataset.exportBaseDisabled = button.disabled ? "1" : "0";
            }
            var baseDisabled = button.dataset.exportBaseDisabled === "1";
            button.disabled = exportRunning || baseDisabled;
        });
    }

    function resolveExportShell(root, target) {
        var targetKey = String(target || "").toLowerCase();
        if (targetKey === "matrix") {
            return root.querySelector("[data-matrix-shell]");
        }
        if (targetKey === "line") {
            return root.querySelector("[data-line-shell]");
        }
        if (targetKey === "heatmap" || targetKey === "image") {
            return root.querySelector("[data-heatmap-shell]");
        }
        return null;
    }

    function resolveStatusElement(root, target) {
        var targetKey = String(target || "").toLowerCase();
        if (targetKey === "matrix") {
            return root.querySelector("[data-matrix-status]");
        }
        if (targetKey === "line") {
            return root.querySelector("[data-line-status]");
        }
        if (targetKey === "heatmap" || targetKey === "image") {
            return root.querySelector("[data-heatmap-status]");
        }
        return null;
    }

    function setExportStatus(root, target, message, tone) {
        var statusElement = resolveStatusElement(root, target);
        if (!statusElement) {
            return;
        }

        statusElement.textContent = message;
        statusElement.classList.remove("error", "info");
        if (tone === "error") {
            statusElement.classList.add("error");
        } else {
            statusElement.classList.add("info");
        }
    }

    function resolveExportHandler(exportApi, action) {
        if (!exportApi || typeof exportApi !== "object") {
            return null;
        }

        var normalizedAction = String(action || "");
        if (normalizedAction === "csv-displayed") {
            return exportApi.exportCsvDisplayed;
        }
        if (normalizedAction === "csv-full") {
            return exportApi.exportCsvFull;
        }
        if (normalizedAction === "png-current") {
            return exportApi.exportPng;
        }
        return null;
    }

    async function runExportAction(root, target, action) {
        var shell = resolveExportShell(root, target);
        var targetLabel =
            target === "matrix" ? "matrix view" : target === "line" ? "line chart" : target === "image" ? "image view" : "heatmap";

        if (!shell || !shell.__exportApi) {
            setExportStatus(root, target, "Load full " + targetLabel + " before exporting.", "error");
            return;
        }

        var handler = resolveExportHandler(shell.__exportApi, action);
        if (typeof handler !== "function") {
            setExportStatus(root, target, "Export option not available for " + targetLabel + ".", "error");
            return;
        }

        setExportStatus(root, target, "Preparing export...", "info");
        setExportRunning(root, true);
        try {
            await handler();
        } catch (error) {
            setExportStatus(root, target, (error && error.message) || "Export failed.", "error");
        } finally {
            setExportRunning(root, false);
        }
    }

    function getFullscreenTarget(root) {
        return document.getElementById("viewer-app") || root || document.documentElement;
    }

    function getSidebarResizeElements(root) {
        var rootDoc = root && root.ownerDocument ? root.ownerDocument : document;
        return {
            app: rootDoc.getElementById("viewer-app"),
            sidebar: rootDoc.getElementById("viewer-sidebar"),
            handle: rootDoc.getElementById("viewer-sidebar-resizer"),
        };
    }

    function isSidebarResizeDesktopViewport() {
        return typeof window !== "undefined" && window.innerWidth > 1024;
    }

    function getSidebarResizeBounds(viewportWidth) {
        var safeViewport = Math.max(1, Math.round(Number(viewportWidth) || 0));
        var minWidth = Math.max(SIDEBAR_RESIZE_MIN_PX, Math.round(safeViewport * SIDEBAR_RESIZE_MIN_RATIO));
        var maxWidth = Math.max(
            minWidth,
            Math.min(SIDEBAR_RESIZE_MAX_PX, Math.round(safeViewport * SIDEBAR_RESIZE_MAX_RATIO))
        );
        return {
            min: minWidth,
            max: maxWidth,
        };
    }

    function clampSidebarWidth(width, viewportWidth) {
        var bounds = getSidebarResizeBounds(viewportWidth);
        var safeWidth = Math.round(Number(width) || bounds.min);
        return Math.max(bounds.min, Math.min(bounds.max, safeWidth));
    }

    function getCurrentSidebarWidth(root) {
        var elements = getSidebarResizeElements(root);
        return elements.sidebar ? Math.round(elements.sidebar.getBoundingClientRect().width || 0) : 0;
    }

    function readStoredSidebarWidth() {
        try {
            var raw = window.localStorage.getItem(SIDEBAR_RESIZE_STORAGE_KEY);
            var parsed = Number(raw);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        } catch (_error) {
            return null;
        }
    }

    function persistSidebarWidth(width) {
        try {
            window.localStorage.setItem(SIDEBAR_RESIZE_STORAGE_KEY, String(Math.round(width)));
        } catch (_error) {
            // ignore storage failures
        }
    }

    function clearStoredSidebarWidth() {
        try {
            window.localStorage.removeItem(SIDEBAR_RESIZE_STORAGE_KEY);
        } catch (_error) {
            // ignore storage failures
        }
    }

    function setSidebarWidth(root, width, options) {
        var settings = options && typeof options === "object" ? options : {};
        var elements = getSidebarResizeElements(root);
        if (!elements.app) {
            return null;
        }
        var viewportWidth =
            elements.app.clientWidth ||
            (typeof window !== "undefined" ? window.innerWidth : 0) ||
            SIDEBAR_RESIZE_MIN_PX;
        var nextWidth = clampSidebarWidth(width, viewportWidth);
        elements.app.style.setProperty("--sidebar-width", nextWidth + "px");
        if (settings.persist === true) {
            persistSidebarWidth(nextWidth);
        }
        return nextWidth;
    }

    function resetSidebarWidth(root) {
        var elements = getSidebarResizeElements(root);
        if (!elements.app) {
            return;
        }
        elements.app.style.removeProperty("--sidebar-width");
        clearStoredSidebarWidth();
    }

    function syncSidebarResizeHandle(root) {
        var elements = getSidebarResizeElements(root);
        var app = elements.app;
        var handle = elements.handle;
        if (!app || !handle) {
            return;
        }
        var resizeEnabled = isSidebarResizeDesktopViewport() && !app.classList.contains("sidebar-collapsed");
        var viewportWidth =
            app.clientWidth ||
            (typeof window !== "undefined" ? window.innerWidth : 0) ||
            SIDEBAR_RESIZE_MIN_PX;
        var bounds = getSidebarResizeBounds(viewportWidth);
        var width = clampSidebarWidth(getCurrentSidebarWidth(root), viewportWidth);
        handle.classList.toggle("is-disabled", !resizeEnabled);
        handle.setAttribute("aria-hidden", resizeEnabled ? "false" : "true");
        handle.setAttribute("aria-valuemin", String(bounds.min));
        handle.setAttribute("aria-valuemax", String(bounds.max));
        handle.setAttribute("aria-valuenow", String(width));
        handle.setAttribute("aria-valuetext", width + " pixels");
        handle.tabIndex = resizeEnabled ? 0 : -1;
    }

    function bindSidebarResizeHandle(root) {
        if (!root) {
            return;
        }

        if (sidebarResizeRoot === root && typeof disposeSidebarResizeBindings === "function") {
            syncSidebarResizeHandle(root);
            return;
        }

        if (typeof disposeSidebarResizeBindings === "function") {
            disposeSidebarResizeBindings();
        }

        sidebarResizeRoot = root;
        var elements = getSidebarResizeElements(root);
        var app = elements.app;
        var handle = elements.handle;
        if (!app || !handle) {
            disposeSidebarResizeBindings = null;
            return;
        }

        var activePointerId = null;
        var dragStartX = 0;
        var dragStartWidth = 0;
        var storedWidth = readStoredSidebarWidth();
        if (storedWidth !== null) {
            setSidebarWidth(root, storedWidth, { persist: false });
        }
        syncSidebarResizeHandle(root);

        function stopResize(persistWidth) {
            if (activePointerId !== null && handle.hasPointerCapture && handle.hasPointerCapture(activePointerId)) {
                try {
                    handle.releasePointerCapture(activePointerId);
                } catch (_error) {
                    // ignore pointer release failures
                }
            }
            if (persistWidth === true) {
                persistSidebarWidth(getCurrentSidebarWidth(root));
            }
            activePointerId = null;
            app.classList.remove("is-sidebar-resizing");
            if (document.body) {
                document.body.classList.remove("sidebar-resizing");
            }
            handle.classList.remove("is-active");
            syncSidebarResizeHandle(root);
        }

        function onPointerMove(event) {
            if (activePointerId === null || event.pointerId !== activePointerId) {
                return;
            }
            event.preventDefault();
            var deltaX = event.clientX - dragStartX;
            setSidebarWidth(root, dragStartWidth + deltaX, { persist: false });
            syncSidebarResizeHandle(root);
        }

        function onPointerUp(event) {
            if (activePointerId === null || event.pointerId !== activePointerId) {
                return;
            }
            event.preventDefault();
            stopResize(true);
        }

        function onPointerCancel(event) {
            if (activePointerId === null || event.pointerId !== activePointerId) {
                return;
            }
            stopResize(false);
        }

        function onPointerDown(event) {
            if (!isSidebarResizeDesktopViewport() || app.classList.contains("sidebar-collapsed")) {
                return;
            }
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            activePointerId = event.pointerId;
            dragStartX = event.clientX;
            dragStartWidth = getCurrentSidebarWidth(root);
            app.classList.add("is-sidebar-resizing");
            if (document.body) {
                document.body.classList.add("sidebar-resizing");
            }
            handle.classList.add("is-active");
            if (handle.setPointerCapture) {
                try {
                    handle.setPointerCapture(event.pointerId);
                } catch (_error) {
                    // ignore pointer capture failures
                }
            }
        }

        function onKeyDown(event) {
            if (!isSidebarResizeDesktopViewport() || app.classList.contains("sidebar-collapsed")) {
                return;
            }
            var viewportWidth =
                app.clientWidth ||
                (typeof window !== "undefined" ? window.innerWidth : 0) ||
                SIDEBAR_RESIZE_MIN_PX;
            var bounds = getSidebarResizeBounds(viewportWidth);
            var currentWidth = getCurrentSidebarWidth(root);
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                setSidebarWidth(root, currentWidth - SIDEBAR_RESIZE_STEP_PX, { persist: true });
                syncSidebarResizeHandle(root);
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                setSidebarWidth(root, currentWidth + SIDEBAR_RESIZE_STEP_PX, { persist: true });
                syncSidebarResizeHandle(root);
                return;
            }
            if (event.key === "Home") {
                event.preventDefault();
                setSidebarWidth(root, bounds.min, { persist: true });
                syncSidebarResizeHandle(root);
                return;
            }
            if (event.key === "End") {
                event.preventDefault();
                setSidebarWidth(root, bounds.max, { persist: true });
                syncSidebarResizeHandle(root);
            }
        }

        function onDoubleClick(event) {
            if (!isSidebarResizeDesktopViewport() || app.classList.contains("sidebar-collapsed")) {
                return;
            }
            event.preventDefault();
            resetSidebarWidth(root);
            syncSidebarResizeHandle(root);
        }

        function onWindowResize() {
            if (app.style.getPropertyValue("--sidebar-width")) {
                setSidebarWidth(root, getCurrentSidebarWidth(root), { persist: false });
            }
            syncSidebarResizeHandle(root);
        }

        handle.addEventListener("pointerdown", onPointerDown);
        handle.addEventListener("keydown", onKeyDown);
        handle.addEventListener("dblclick", onDoubleClick);
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        window.addEventListener("resize", onWindowResize);

        disposeSidebarResizeBindings = function disposeSidebarResizeBindingsImpl() {
            stopResize(false);
            handle.removeEventListener("pointerdown", onPointerDown);
            handle.removeEventListener("keydown", onKeyDown);
            handle.removeEventListener("dblclick", onDoubleClick);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            window.removeEventListener("resize", onWindowResize);
        };
    }

    function updateFullscreenButton(root) {
        var btn = root.querySelector("#viewer-fullscreen-btn");
        if (!btn) {
            return;
        }

        var fullscreenTarget = getFullscreenTarget(root);
        var isFs = document.fullscreenElement === fullscreenTarget;
        var label = btn.querySelector(".btn-label");
        if (label) {
            label.textContent = isFs ? "Exit Fullscreen" : "Fullscreen";
        }
        btn.title = isFs ? "Exit fullscreen" : "Toggle fullscreen";

        var path = btn.querySelector("svg path");
        if (path) {
            path.setAttribute(
                "d",
                isFs
                    ? "M5 2v3H2M11 2v3h3M5 14v-3H2M11 14v-3h3"
                    : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
            );
        }
    }

    function bindViewerViewEvents(root, actions) {
        var safeRoot = root || document.getElementById("viewer-app") || document;
        if (!safeRoot) {
            return;
        }

        eventActions = actions && typeof actions === "object" ? actions : {};

        if (eventRoot !== safeRoot || typeof disposeViewerViewBindings !== "function") {
            clearViewerViewBindings();
            eventRoot = safeRoot;

            var onRootClick = function (event) {
                var target = event.target;
                if (!(target instanceof Element)) {
                    return;
                }

                var exportToggle = target.closest("[data-export-toggle]");
                if (exportToggle && safeRoot.contains(exportToggle)) {
                    event.preventDefault();
                    event.stopPropagation();
                    var menuRoot = exportToggle.closest("[data-export-root]");
                    var menu = menuRoot && menuRoot.querySelector("[data-export-menu]");
                    if (!menuRoot || !menu) {
                        return;
                    }
                    var nextOpen = !menuRoot.classList.contains("is-open");
                    closeAllExportMenus(safeRoot);
                    menu.setAttribute("aria-hidden", nextOpen ? "false" : "true");
                    exportToggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
                    menuRoot.classList.toggle("is-open", nextOpen);
                    return;
                }

                var exportAction = target.closest("[data-export-action]");
                if (exportAction && safeRoot.contains(exportAction)) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (exportRunning) {
                        return;
                    }

                    closeAllExportMenus(safeRoot);
                    var exportTarget = String(exportAction.dataset.exportTarget || "");
                    var exportActionName = String(exportAction.dataset.exportAction || "");
                    if (!exportTarget || !exportActionName) {
                        return;
                    }
                    void runExportAction(safeRoot, exportTarget, exportActionName);
                    return;
                }

                var sidebarToggle = target.closest("#sidebar-toggle-btn");
                if (sidebarToggle && safeRoot.contains(sidebarToggle)) {
                    if (typeof eventActions.toggleSidebar === "function") {
                        eventActions.toggleSidebar();
                    }
                    return;
                }

                var sidebarClose = target.closest("#sidebar-close-btn");
                if (sidebarClose && safeRoot.contains(sidebarClose)) {
                    if (typeof eventActions.setSidebarOpen === "function") {
                        eventActions.setSidebarOpen(false);
                    }
                    return;
                }

                var backButton = target.closest("#viewer-back-btn");
                if (backButton && safeRoot.contains(backButton)) {
                    if (typeof eventActions.goHome === "function") {
                        eventActions.goHome();
                    }
                    return;
                }

                var fullscreenBtn = target.closest("#viewer-fullscreen-btn");
                if (fullscreenBtn && safeRoot.contains(fullscreenBtn)) {
                    (async function toggleFullscreen() {
                        try {
                            var fullscreenTarget = getFullscreenTarget(safeRoot);
                            if (document.fullscreenElement === fullscreenTarget) {
                                await document.exitFullscreen();
                                return;
                            }

                            if (document.fullscreenElement) {
                                await document.exitFullscreen();
                            }

                            if (fullscreenTarget.requestFullscreen) {
                                await fullscreenTarget.requestFullscreen();
                            }
                        } catch (_error) {
                            // ignore fullscreen errors
                        }
                    })();
                    return;
                }

                var viewModeButton = target.closest("[data-view-mode]");
                if (viewModeButton && safeRoot.contains(viewModeButton)) {
                    if (typeof eventActions.setViewMode === "function") {
                        eventActions.setViewMode(viewModeButton.dataset.viewMode || "inspect");
                    }
                    return;
                }

                var breadcrumbButton = target.closest("[data-breadcrumb-path]");
                if (breadcrumbButton && safeRoot.contains(breadcrumbButton)) {
                    if (typeof eventActions.onBreadcrumbSelect === "function") {
                        eventActions.onBreadcrumbSelect(breadcrumbButton.dataset.breadcrumbPath || "/");
                    }
                    return;
                }

                var displayTabButton = target.closest("[data-display-tab]");
                if (displayTabButton && safeRoot.contains(displayTabButton)) {
                    if (typeof eventActions.setDisplayTab === "function") {
                        eventActions.setDisplayTab(displayTabButton.dataset.displayTab || "line");
                    }
                    return;
                }

                var notationButton = target.closest("[data-notation]");
                if (notationButton && safeRoot.contains(notationButton)) {
                    if (typeof eventActions.setNotation === "function") {
                        eventActions.setNotation(notationButton.dataset.notation || "auto");
                    }
                    return;
                }

                var lineGridButton = target.closest("[data-line-grid-toggle]");
                if (lineGridButton && safeRoot.contains(lineGridButton)) {
                    if (typeof eventActions.toggleLineGrid === "function") {
                        eventActions.toggleLineGrid();
                    }
                    return;
                }

                var lineAspectButton = target.closest("[data-line-aspect]");
                if (lineAspectButton && safeRoot.contains(lineAspectButton)) {
                    if (typeof eventActions.setLineAspect === "function") {
                        eventActions.setLineAspect(lineAspectButton.dataset.lineAspect || "line");
                    }
                    return;
                }

                var heatmapGridButton = target.closest("[data-heatmap-grid-toggle]");
                if (heatmapGridButton && safeRoot.contains(heatmapGridButton)) {
                    if (typeof eventActions.toggleHeatmapGrid === "function") {
                        eventActions.toggleHeatmapGrid();
                    }
                    return;
                }

                var heatmapColorButton = target.closest("[data-heatmap-colormap]");
                if (heatmapColorButton && safeRoot.contains(heatmapColorButton)) {
                    if (typeof eventActions.setHeatmapColormap === "function") {
                        eventActions.setHeatmapColormap(heatmapColorButton.dataset.heatmapColormap || "viridis");
                    }
                }
            };

            var onDocumentClick = function (event) {
                var target = event.target;
                if (target && target.id === "sidebar-backdrop") {
                    if (typeof eventActions.setSidebarOpen === "function") {
                        eventActions.setSidebarOpen(false);
                    }
                }

                if (!(target instanceof Element) || !target.closest("[data-export-root]")) {
                    closeAllExportMenus(safeRoot);
                }
            };

            var onDocumentKeyDown = function (event) {
                if (event.key === "Escape") {
                    closeAllExportMenus(safeRoot);
                }
            };

            var onFullscreenChange = function () {
                updateFullscreenButton(safeRoot);
            };

            safeRoot.addEventListener("click", onRootClick);
            document.addEventListener("click", onDocumentClick);
            document.addEventListener("keydown", onDocumentKeyDown);
            document.addEventListener("fullscreenchange", onFullscreenChange);

            disposeViewerViewBindings = function disposeViewerBindingsImpl() {
                safeRoot.removeEventListener("click", onRootClick);
                document.removeEventListener("click", onDocumentClick);
                document.removeEventListener("keydown", onDocumentKeyDown);
                document.removeEventListener("fullscreenchange", onFullscreenChange);
            };
        }

        refreshExportButtonState(safeRoot);
        updateFullscreenButton(safeRoot);
        bindSidebarResizeHandle(safeRoot);
        syncSidebarResizeHandle(safeRoot);

        if (typeof bindSidebarTreeEvents === "function") {
            bindSidebarTreeEvents(safeRoot, eventActions);
        }
        if (typeof bindViewerPanelEvents === "function") {
            bindViewerPanelEvents(safeRoot, eventActions);
        }
    }

    moduleState.REQUIRED_DOM_IDS = REQUIRED_DOM_IDS;
    moduleState.validateViewerDomIds = validateViewerDomIds;
    moduleState.clearViewerViewBindings = clearViewerViewBindings;
    moduleState.initViewerViewTemplate = initViewerViewTemplate;
    moduleState.renderViewerView = renderViewerView;
    moduleState.bindViewerViewEvents = bindViewerViewEvents;

    global.REQUIRED_DOM_IDS = REQUIRED_DOM_IDS;
    global.validateViewerDomIds = validateViewerDomIds;
    global.clearViewerViewBindings = clearViewerViewBindings;
    global.initViewerViewTemplate = initViewerViewTemplate;
    global.renderViewerView = renderViewerView;
    global.bindViewerViewEvents = bindViewerViewEvents;

    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("views/viewerView");
    }
})(typeof window !== "undefined" ? window : globalThis);






// Viewer HTML module: Runtime config bootstrap where deployments can inject API_BASE_URL before viewer scripts load.
window.__CONFIG__ = window.__CONFIG__ || {};
// Change this when the viewer should call a different backend API base URL.
// Production deployments can inject API_BASE_URL here without changing source modules.
// In Docker/server environments, a web server pre-processing step can replace this value at startup.
// Must be loaded BEFORE core/config.js which reads window.__CONFIG__.API_BASE_URL.
window.__CONFIG__.API_BASE_URL = window.__CONFIG__.API_BASE_URL || "https://hdf-viewer-backend.vercel.app";



// Viewer HTML module: Initializes the global HDFViewer namespace, module registry, and dependency guards for plain-script loading.
function init_viewer_core_1() {
    const global = window;
    "use strict";

    if (!global) {
        return;
    }

    // Guard: do not overwrite an existing non-object value (e.g. if a third-party script claimed the name)
    var existingNamespace = global.HDFViewer;
    if (existingNamespace && typeof existingNamespace !== "object") {
        console.error("[HDFViewer] Cannot initialize namespace: window.HDFViewer is not an object.");
        return;
    }

    // Reuse an existing partial namespace (e.g. set by a previous script) or start fresh
    var ns = existingNamespace || {};

    // Ensures a key on target is an object, creating it if absent
    function ensureObject(target, key) {
        if (!target[key] || typeof target[key] !== "object") {
            target[key] = {};
        }
        return target[key];
    }

    // Walks a dot-separated path string and creates missing intermediate objects,
    // then returns the leaf object so callers can attach properties to it.
    // Example: ensurePath(ns, "api.client") returns ns.api.client (creating ns.api and ns.api.client if needed)
    function ensurePath(root, path) {
        if (!path) {
            return root;
        }

        var parts = String(path).split(".");
        var cursor = root;

        for (var i = 0; i < parts.length; i += 1) {
            var part = parts[i];
            if (!part) {
                continue;
            }

            if (!cursor[part] || typeof cursor[part] !== "object") {
                cursor[part] = {};
            }
            cursor = cursor[part];
        }

        return cursor;
    }

    // Mark namespace as initialized and set a phase identifier for debugging
    ns.__initialized = true;
    ns.__phase = "phase3-port";

    // Create top-level namespace buckets for each subsystem
    ensureObject(ns, "core");
    ensureObject(ns, "utils");
    ensureObject(ns, "api");
    ensureObject(ns, "state");
    ensureObject(ns, "components");
    ensureObject(ns, "views");
    ensureObject(ns, "app");

    // Publish ensurePath so all other modules can safely create their own sub-paths
    ns.core.ensurePath = ensurePath;

    // Module registry: tracks which module IDs have been loaded (prevents double-init errors)
    ns.core.loadedModules = ns.core.loadedModules || {};

    // registerModule: called by each module after it finishes self-registering
    ns.core.registerModule = function registerModule(moduleId) {
        if (!moduleId) {
            return;
        }
        ns.core.loadedModules[moduleId] = true;
    };

    // requireModules: used by app-viewer.js at boot to assert all expected modules loaded successfully
    ns.core.requireModules = function requireModules(moduleIds, scope) {
        var ids = Array.isArray(moduleIds) ? moduleIds : [];
        var missing = [];

        for (var i = 0; i < ids.length; i += 1) {
            var id = ids[i];
            if (id && !ns.core.loadedModules[id]) {
                missing.push(id);
            }
        }

        if (missing.length > 0) {
            console.error(
                "[HDFViewer] Missing required modules" + (scope ? " for " + scope : "") + ":",
                missing.join(", ")
            );
        }

        return {
            ok: missing.length === 0,
            missing: missing,
        };
    };

    // Self-register so requireModules can verify this module loaded
    ns.core.registerModule("core/namespace");

    global.HDFViewer = ns;
}
init_viewer_core_1();



// Viewer HTML module: Builds normalized API endpoint helpers and exposes runtime config for all viewer modules.
function init_viewer_core_2() {
    const global = window;
    "use strict";

    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for core/config.");
        return;
    }

    var DEFAULT_API_BASE_URL = "https://hdf-viewer-backend.vercel.app";

    // Read runtime config injected by config/runtime-config.js before this script loaded
    var runtimeConfig =
        global.__CONFIG__ && typeof global.__CONFIG__ === "object" ? global.__CONFIG__ : {};

    // Strip trailing slashes from the base URL to make URL concatenation consistent
    function normalizeBaseUrl(value) {
        return String(value || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    }

    // Encodes each path segment of an HDF5 object key separately, preserving internal `/` separators
    function encodeObjectKeyForPath(key) {
        return String(key || "")
            .split("/")
            .map(function (segment) {
                return encodeURIComponent(segment);
            })
            .join("/");
    }

    // Appends a query param, supporting array values (appends once per element)
    function appendSearchParams(searchParams, key, value) {
        if (value === null || value === undefined) {
            return;
        }

        if (Array.isArray(value)) {
            for (var i = 0; i < value.length; i += 1) {
                if (value[i] !== null && value[i] !== undefined) {
                    searchParams.append(key, String(value[i]));
                }
            }
            return;
        }

        searchParams.append(key, String(value));
    }

    // Builds a complete request URL from an endpoint path and optional query params object
    function buildApiUrl(endpoint, params) {
        var endpointValue = endpoint || "";
        var normalizedEndpoint =
            endpointValue.charAt(0) === "/" ? endpointValue : "/" + endpointValue;

        var url = new URL(normalizedEndpoint, API_BASE_URL + "/");
        var queryParams = params && typeof params === "object" ? params : {};

        Object.keys(queryParams).forEach(function (paramKey) {
            appendSearchParams(url.searchParams, paramKey, queryParams[paramKey]);
        });

        return url.toString();
    }

    // Resolve final API base URL from runtime config or fall back to localhost default
    var API_BASE_URL = normalizeBaseUrl(runtimeConfig.API_BASE_URL);

    // Frozen map of all backend endpoint path definitions.
    // String values are static paths; functions accept an object key and return the encoded path.
    var API_ENDPOINTS = Object.freeze({
        FILES: "/files",
        FILE_CHILDREN: function (key) {
            return "/files/" + encodeObjectKeyForPath(key) + "/children";
        },
        FILE_META: function (key) {
            return "/files/" + encodeObjectKeyForPath(key) + "/meta";
        },
        FILE_PREVIEW: function (key) {
            return "/files/" + encodeObjectKeyForPath(key) + "/preview";
        },
        FILE_DATA: function (key) {
            return "/files/" + encodeObjectKeyForPath(key) + "/data";
        },
        FILE_EXPORT_CSV: function (key) {
            return "/files/" + encodeObjectKeyForPath(key) + "/export/csv";
        },
    });

    var APP_CONFIG = Object.freeze({
        API_BASE_URL: API_BASE_URL,
    });

    // Bundle everything into a frozen config object for safe consumption by other modules
    var configApi = Object.freeze({
        DEFAULT_API_BASE_URL: DEFAULT_API_BASE_URL,
        runtimeConfig: runtimeConfig,
        API_BASE_URL: API_BASE_URL,
        API_ENDPOINTS: API_ENDPOINTS,
        APP_CONFIG: APP_CONFIG,
        normalizeBaseUrl: normalizeBaseUrl,
        encodeObjectKeyForPath: encodeObjectKeyForPath,
        buildApiUrl: buildApiUrl,
    });

    // Publish under namespace and as shorthand globals for cross-module access
    ns.core.config = configApi;
    ns.core.API_BASE_URL = API_BASE_URL;
    ns.core.API_ENDPOINTS = API_ENDPOINTS;
    ns.core.APP_CONFIG = APP_CONFIG;
    ns.core.normalizeBaseUrl = normalizeBaseUrl;
    ns.core.encodeObjectKeyForPath = encodeObjectKeyForPath;
    ns.core.buildApiUrl = buildApiUrl;

    ns.api = ns.api || {};
    ns.api.config = configApi;

    // Legacy symbol bridge for Phase 3 converted plain-script modules.
    global.DEFAULT_API_BASE_URL = DEFAULT_API_BASE_URL;
    global.API_BASE_URL = API_BASE_URL;
    global.API_ENDPOINTS = API_ENDPOINTS;
    global.APP_CONFIG = APP_CONFIG;
    global.normalizeBaseUrl = normalizeBaseUrl;
    global.encodeObjectKeyForPath = encodeObjectKeyForPath;
    global.buildApiUrl = buildApiUrl;

    if (typeof ns.core.registerModule === "function") {
        ns.core.registerModule("core/config");
    }
}
init_viewer_core_2();



// Viewer HTML module: Centralizes static viewer shell DOM IDs and helper functions for status, visibility, and class toggling.
function init_viewer_core_3() {
    const global = window;
    "use strict";

    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for core/domRefs.");
        return;
    }

    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading core/domRefs.");
        return;
    }

    var moduleState = ensurePath(ns, "core.domRefs");

    // Authoritative list of all element IDs that must exist in the HTML shell before the viewer boots
    var REQUIRED_IDS = [
        "viewer-app",
        "viewer-sidebar",
        "viewer-sidebar-resizer",
        "tree-panel",
        "tree-list",
        "tree-status",
        "metadata-panel",
        "viewer-main",
        "viewer-topbar",
        "breadcrumb-file",
        "breadcrumb-path",
        "viewer-subbar",
        "subbar-tabs",
        "subbar-actions",
        "viewer-panel",
        "display-pane",
        "inspect-pane",
        "display-status",
        "inspect-status",
        "global-status",
        "sidebar-backdrop",
        "sidebar-toggle-btn",
        "sidebar-close-btn",
        "viewer-back-btn",
        "viewer-fullscreen-btn",
    ];

    // Collects all required DOM nodes into a single object so callers never scatter getElementById calls throughout UI code
    function collect(doc) {
        var rootDoc = doc || document;
        return {
            viewerApp: rootDoc.getElementById("viewer-app"),
            viewerSidebar: rootDoc.getElementById("viewer-sidebar"),
            viewerSidebarResizer: rootDoc.getElementById("viewer-sidebar-resizer"),
            treePanel: rootDoc.getElementById("tree-panel"),
            treeList: rootDoc.getElementById("tree-list"),
            treeStatus: rootDoc.getElementById("tree-status"),
            metadataPanel: rootDoc.getElementById("metadata-panel"),
            viewerMain: rootDoc.getElementById("viewer-main"),
            viewerTopbar: rootDoc.getElementById("viewer-topbar"),
            breadcrumbFile: rootDoc.getElementById("breadcrumb-file"),
            breadcrumbPath: rootDoc.getElementById("breadcrumb-path"),
            viewerSubbar: rootDoc.getElementById("viewer-subbar"),
            subbarTabs: rootDoc.getElementById("subbar-tabs"),
            subbarActions: rootDoc.getElementById("subbar-actions"),
            viewerPanel: rootDoc.getElementById("viewer-panel"),
            displayPane: rootDoc.getElementById("display-pane"),
            inspectPane: rootDoc.getElementById("inspect-pane"),
            displayStatus: rootDoc.getElementById("display-status"),
            inspectStatus: rootDoc.getElementById("inspect-status"),
            globalStatus: rootDoc.getElementById("global-status"),
            sidebarBackdrop: rootDoc.getElementById("sidebar-backdrop"),
            sidebarToggleBtn: rootDoc.getElementById("sidebar-toggle-btn"),
            sidebarCloseBtn: rootDoc.getElementById("sidebar-close-btn"),
            viewerBackBtn: rootDoc.getElementById("viewer-back-btn"),
            viewerFullscreenBtn: rootDoc.getElementById("viewer-fullscreen-btn"),
        };
    }

    // Scans REQUIRED_IDS and returns { ok, missing[] }; called during boot to catch missing template IDs early
    function validate(doc) {
        var rootDoc = doc || document;
        var missing = [];

        for (var i = 0; i < REQUIRED_IDS.length; i += 1) {
            var id = REQUIRED_IDS[i];
            if (!rootDoc.getElementById(id)) {
                missing.push(id);
            }
        }

        if (missing.length > 0) {
            console.error("[HDFViewer] Missing required viewer DOM ids:", missing.join(", "));
            return {
                ok: false,
                missing: missing,
            };
        }

        return {
            ok: true,
            missing: [],
        };
    }

    // Writes a status message onto an element and toggles its CSS tone class ("error" / "info" / neutral)
    function setStatus(element, message, tone) {
        if (!element) {
            return;
        }

        element.textContent = String(message || "");
        // Clear both tone classes first to avoid stale state from a previous call
        element.classList.remove("error", "info");
        if (tone === "error") {
            element.classList.add("error");
        } else if (tone === "info") {
            element.classList.add("info");
        }
    }

    // Sets element.hidden; preferred over toggling CSS display directly so layout calculations remain correct
    function setHidden(element, hidden) {
        if (!element) {
            return;
        }
        element.hidden = !!hidden;
    }

    // Writes raw HTML into an element; callers are responsible for using escapeHtml on any user-visible strings inside html
    function setHtml(element, html) {
        if (!element) {
            return;
        }
        element.innerHTML = String(html || "");
    }

    // Sets element.textContent; safe alternative to setHtml when the content is plain text
    function setText(element, text) {
        if (!element) {
            return;
        }
        element.textContent = String(text || "");
    }

    // Adds or removes a class based on a boolean flag; wraps classList.toggle for IE compatibility
    function toggleClass(element, className, enabled) {
        if (!element || !className) {
            return;
        }
        element.classList.toggle(className, !!enabled);
    }

    moduleState.REQUIRED_IDS = REQUIRED_IDS;
    moduleState.collect = collect;
    moduleState.validate = validate;
    moduleState.setStatus = setStatus;
    moduleState.setHidden = setHidden;
    moduleState.setHtml = setHtml;
    moduleState.setText = setText;
    moduleState.toggleClass = toggleClass;

    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("core/domRefs");
    }
}
init_viewer_core_3();



// Viewer HTML module: Provides shared HTML escaping and byte formatting helpers used by renderers.
function init_viewer_core_4() {
    const global = window;
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for utils/format.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading utils/format.");
        return;
    }
    var moduleState = ensurePath(ns, "utils.format");

    // Escapes HTML special characters to prevent XSS when inserting untrusted values into innerHTML.
    // Must be called for every data value injected into a template string (dataset names, attribute values, cell data).
    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    // Converts a raw byte count into a human-readable string with the appropriate unit (B, KB, MB, GB, TB).
    // Used for displaying file sizes in the file list and metadata panel.
    function formatBytes(bytes) {
        const safeBytes = Number(bytes) || 0;
        if (safeBytes === 0) {
            return "0 B";
        }

        const units = ["B", "KB", "MB", "GB", "TB"];
        // Calculate which unit tier the byte count falls into
        const unitIndex = Math.floor(Math.log(safeBytes) / Math.log(1024));
        const normalizedIndex = Math.min(unitIndex, units.length - 1);

        return `${(safeBytes / 1024 ** normalizedIndex).toFixed(2)} ${units[normalizedIndex]}`;
    }
    if (typeof escapeHtml !== "undefined") {
        moduleState.escapeHtml = escapeHtml;
        global.escapeHtml = escapeHtml;
    }
    if (typeof formatBytes !== "undefined") {
        moduleState.formatBytes = formatBytes;
        global.formatBytes = formatBytes;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("utils/format");
    }
}
init_viewer_core_4();



// Viewer HTML module: Implements a lightweight in-memory LRU cache used by data and runtime layers.
function init_viewer_core_5() {
    const global = window;
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for utils/lru.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading utils/lru.");
        return;
    }
    var moduleState = ensurePath(ns, "utils.lru");

    // Bounded LRU cache backed by a native Map.
    // Map preserves insertion order: get() re-inserts accessed keys at the end (most-recent position),
    // and set() evicts the first (oldest) key when the size limit is exceeded.
    class LruCache {
        constructor(limit = 100) {
            this.limit = limit;
            this.map = new Map();
        }

        // Returns the value for key and moves it to most-recently-used position; undefined if not found
        get(key) {
            if (!this.map.has(key)) {
                return undefined;
            }

            // Delete and re-insert to move this entry to the end of the Map's iteration order
            const value = this.map.get(key);
            this.map.delete(key);
            this.map.set(key, value);
            return value;
        }

        // Inserts or updates a key-value pair; evicts the least-recently-used entry if over limit
        set(key, value) {
            if (this.map.has(key)) {
                this.map.delete(key);
            }

            this.map.set(key, value);

            // Evict the oldest entry (first key in Map iteration) when limit is exceeded
            if (this.map.size > this.limit) {
                const oldestKey = this.map.keys().next().value;
                this.map.delete(oldestKey);
            }
        }

        // Removes all entries from the cache
        clear() {
            this.map.clear();
        }
    }
    if (typeof LruCache !== "undefined") {
        moduleState.LruCache = LruCache;
        global.LruCache = LruCache;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("utils/lru");
    }
}
init_viewer_core_5();



// Viewer HTML module: Provides CSV and PNG export utilities with safe filename and CSV cell handling.
function init_viewer_core_6() {
    const global = window;
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for utils/export.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading utils/export.");
        return;
    }
    var moduleState = ensurePath(ns, "utils.export");

    // UTF-8 BOM ensures Excel opens the CSV with the correct encoding on Windows
    const CSV_BOM = "\uFEFF";

    // Strips path-unsafe characters from a filename segment to prevent directory traversal
    function sanitizeSegment(value, fallback = "dataset") {
        const raw = String(value || "").trim();
        if (!raw) {
            return fallback;
        }
        return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
    }

    // Builds a compact timestamp string (YYYYMMdd-HHmmss) for export filenames
    function formatTimestamp(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        return `${year}${month}${day}-${hours}${minutes}${seconds}`;
    }

    // OWASP CSV injection hardening: prefixes cells starting with =, +, -, @ with a single quote so
    // spreadsheet applications do not execute them as formulas
    function csvEscapeCell(value) {
        if (value === null || value === undefined) {
            return "";
        }
        let text = String(value);
        const trimmed = text.trimStart();
        if (trimmed && /^[=+\-@]/.test(trimmed)) {
            text = `'${text}`;
        }
        if (/[",\r\n]/.test(text)) {
            return `"${text.replace(/"/g, "\"\"")}"`;
        }
        return text;
    }

    // Converts a row of values to a properly escaped CSV line
    function toCsvRow(values = []) {
        return values.map((entry) => csvEscapeCell(entry)).join(",");
    }

    // Builds a unique export filename from file key, path, display tab, scope, and a timestamp to avoid overwriting
    function buildExportFilename({ fileKey, path, tab, scope, extension }) {
        const filePart = sanitizeSegment(fileKey || "file", "file");
        const pathPart = sanitizeSegment(String(path || "/").replace(/^\/+/, "").replace(/\//g, "_"), "root");
        const tabPart = sanitizeSegment(tab || "data", "data");
        const scopePart = sanitizeSegment(scope || "export", "export");
        const extPart = sanitizeSegment(extension || "csv", "csv");
        return `${filePart}_${pathPart}_${tabPart}_${scopePart}_${formatTimestamp()}.${extPart}`;
    }

    // Wraps rows in a UTF-8 Blob with the proper MIME type for spreadsheet download
    function createCsvBlob(rows = [], includeBom = true) {
        const lines = Array.isArray(rows) ? rows : [];
        const body = lines.join("\r\n");
        const content = includeBom ? `${CSV_BOM}${body}` : body;
        return new Blob([content], { type: "text/csv;charset=utf-8;" });
    }

    // Creates an invisible <a download> link, clicks it, and removes it â€” the canonical browser download trick
    function triggerBlobDownload(blob, filename) {
        if (!(blob instanceof Blob)) {
            throw new Error("Invalid export blob.");
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename || "export.csv";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Revoke the object URL after a short delay to free browser memory
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function appendQueryParam(searchParams, key, value) {
        if (value === null || value === undefined) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((entry) => {
                if (entry !== null && entry !== undefined && String(entry).trim() !== "") {
                    searchParams.append(key, String(entry));
                }
            });
            return;
        }
        const text = String(value);
        if (text.trim() === "") {
            return;
        }
        searchParams.append(key, text);
    }

    function buildCsvExportUrl(fileKey, params = {}) {
        const endpoint = `/files/${encodeObjectKeyForPath(fileKey)}/export/csv`;
        const url = new URL(endpoint, `${API_BASE_URL}/`);
        const searchParams = url.searchParams;
        Object.entries(params).forEach(([key, value]) => appendQueryParam(searchParams, key, value));
        return url.toString();
    }

    function triggerUrlDownload(url) {
        const link = document.createElement("a");
        link.href = url;
        link.rel = "noopener";
        link.target = "_blank";
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function copySvgComputedStyles(sourceSvg, clonedSvg) {
        const importantProps = [
            "fill",
            "stroke",
            "stroke-width",
            "stroke-linecap",
            "stroke-linejoin",
            "stroke-dasharray",
            "stroke-opacity",
            "opacity",
            "font-family",
            "font-size",
            "font-weight",
            "letter-spacing",
            "text-anchor",
            "dominant-baseline",
        ];

        const sourceNodes = [sourceSvg, ...sourceSvg.querySelectorAll("*")];
        const clonedNodes = [clonedSvg, ...clonedSvg.querySelectorAll("*")];

        const count = Math.min(sourceNodes.length, clonedNodes.length);
        for (let index = 0; index < count; index += 1) {
            const sourceNode = sourceNodes[index];
            const clonedNode = clonedNodes[index];
            if (!sourceNode || !clonedNode) {
                continue;
            }
            const computed = window.getComputedStyle(sourceNode);
            const styleText = importantProps
                .map((property) => `${property}:${computed.getPropertyValue(property)};`)
                .join("");
            const existing = clonedNode.getAttribute("style") || "";
            clonedNode.setAttribute("style", `${existing}${styleText}`);
        }
    }

    async function svgElementToPngBlob(svgElement, options = {}) {
        if (!svgElement) {
            throw new Error("Line chart SVG not available for PNG export.");
        }

        const scale = Number.isFinite(Number(options.scale)) ? Math.max(1, Number(options.scale)) : 2;
        const background = String(options.background || "#FFFFFF");
        const rect = svgElement.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width || Number(svgElement.getAttribute("width")) || 1024));
        const height = Math.max(
            1,
            Math.round(rect.height || Number(svgElement.getAttribute("height")) || 420)
        );

        const clonedSvg = svgElement.cloneNode(true);
        clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clonedSvg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
        clonedSvg.setAttribute("width", String(width));
        clonedSvg.setAttribute("height", String(height));
        clonedSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        copySvgComputedStyles(svgElement, clonedSvg);

        const svgMarkup = new XMLSerializer().serializeToString(clonedSvg);
        const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
        const svgUrl = URL.createObjectURL(svgBlob);

        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error("Failed to rasterize line SVG."));
                img.src = svgUrl;
            });

            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("PNG export context unavailable.");
            }

            context.fillStyle = background;
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);

            const pngBlob = await new Promise((resolve, reject) => {
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error("Failed to encode line PNG."));
                        return;
                    }
                    resolve(blob);
                }, "image/png");
            });

            return pngBlob;
        } finally {
            URL.revokeObjectURL(svgUrl);
        }
    }

    async function canvasElementToPngBlob(canvasElement) {
        if (!canvasElement || typeof canvasElement.toBlob !== "function") {
            throw new Error("Heatmap canvas not available for PNG export.");
        }
        return new Promise((resolve, reject) => {
            canvasElement.toBlob((blob) => {
                if (!blob) {
                    reject(new Error("Failed to encode heatmap PNG."));
                    return;
                }
                resolve(blob);
            }, "image/png");
        });
    }
    if (typeof buildCsvExportUrl !== "undefined") {
        moduleState.buildCsvExportUrl = buildCsvExportUrl;
        global.buildCsvExportUrl = buildCsvExportUrl;
    }
    if (typeof buildExportFilename !== "undefined") {
        moduleState.buildExportFilename = buildExportFilename;
        global.buildExportFilename = buildExportFilename;
    }
    if (typeof createCsvBlob !== "undefined") {
        moduleState.createCsvBlob = createCsvBlob;
        global.createCsvBlob = createCsvBlob;
    }
    if (typeof csvEscapeCell !== "undefined") {
        moduleState.csvEscapeCell = csvEscapeCell;
        global.csvEscapeCell = csvEscapeCell;
    }
    if (typeof svgElementToPngBlob !== "undefined") {
        moduleState.svgElementToPngBlob = svgElementToPngBlob;
        global.svgElementToPngBlob = svgElementToPngBlob;
    }
    if (typeof canvasElementToPngBlob !== "undefined") {
        moduleState.canvasElementToPngBlob = canvasElementToPngBlob;
        global.canvasElementToPngBlob = canvasElementToPngBlob;
    }
    if (typeof toCsvRow !== "undefined") {
        moduleState.toCsvRow = toCsvRow;
        global.toCsvRow = toCsvRow;
    }
    if (typeof triggerBlobDownload !== "undefined") {
        moduleState.triggerBlobDownload = triggerBlobDownload;
        global.triggerBlobDownload = triggerBlobDownload;
    }
    if (typeof triggerUrlDownload !== "undefined") {
        moduleState.triggerUrlDownload = triggerUrlDownload;
        global.triggerUrlDownload = triggerUrlDownload;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("utils/export");
    }
}
init_viewer_core_6();




export const HDFViewer = window.HDFViewer;
export const ViewerCore = window.HDFViewer?.core ?? {};
export const ViewerUtils = window.HDFViewer?.utils ?? {};
export default window.HDFViewer;

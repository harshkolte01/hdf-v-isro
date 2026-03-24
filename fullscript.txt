

// Viewer HTML module: Runtime config bootstrap where deployments can inject API_BASE_URL before viewer scripts load.
window.__CONFIG__ = window.__CONFIG__ || {};
// Change this when the viewer should call a different backend API base URL.
// Production deployments can inject API_BASE_URL here without changing source modules.
// In Docker/server environments, a web server pre-processing step can replace this value at startup.
// Must be loaded BEFORE core/config.js which reads window.__CONFIG__.API_BASE_URL.
window.__CONFIG__.API_BASE_URL = window.__CONFIG__.API_BASE_URL || "https://hdf-viewer-backend.vercel.app";



// Viewer HTML module: Initializes the global HDFViewer namespace, module registry, and dependency guards for plain-script loading.
(function (global) {
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
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Builds normalized API endpoint helpers and exposes runtime config for all viewer modules.
(function (global) {
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
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Centralizes static viewer shell DOM IDs and helper functions for status, visibility, and class toggling.
(function (global) {
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
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Provides shared HTML escaping and byte formatting helpers used by renderers.
(function (global) {
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
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Implements a lightweight in-memory LRU cache used by data and runtime layers.
(function (global) {
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
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Provides CSV and PNG export utilities with safe filename and CSV cell handling.
(function (global) {
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
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Wraps fetch with abort linking, in-flight cancellation keys, and normalized API errors.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for api/client.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading api/client.");
        return;
    }
    var moduleState = ensurePath(ns, "api.client");

    // Tracks currently running requests by cancel key; used to abort previous requests when a new one supersedes them
    const inFlightControllers = new Map();

    // Structured error thrown for all failed API calls â€” includes HTTP status, error code, and request context
    class ApiError extends Error {
        constructor({
            message,
            status = 0,
            code = "REQUEST_FAILED",
            details = null,
            url = "",
            method = "GET",
            isAbort = false,
        }) {
            super(message);
            this.name = "ApiError";
            this.status = status;
            this.code = code;
            this.details = details;
            this.url = url;
            this.method = method;
            this.isAbort = isAbort;
        }
    }

    // Serialises a params object into a URL query string (supports array values by appending multiple times)
    function toQueryString(params = {}) {
        const searchParams = new URLSearchParams();

        Object.entries(params).forEach(([key, value]) => {
            if (value === null || value === undefined) {
                return;
            }

            if (Array.isArray(value)) {
                value.forEach((entry) => {
                    if (entry !== null && entry !== undefined) {
                        searchParams.append(key, String(entry));
                    }
                });
                return;
            }

            searchParams.append(key, String(value));
        });

        const query = searchParams.toString();
        return query ? `?${query}` : "";
    }

    // Combines the base URL, endpoint path, and query params into a complete request URL
    function buildRequestUrl(endpoint, params = {}) {
        const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
        return `${API_BASE_URL}${normalizedEndpoint}${toQueryString(params)}`;
    }

    // Creates a new AbortController and mirrors abort events from an optional external signal.
    // If the external signal is already aborted the new controller aborts immediately.
    function createLinkedController(externalSignal) {
        const controller = new AbortController();

        if (externalSignal) {
            if (externalSignal.aborted) {
                controller.abort(externalSignal.reason || "external-abort");
            } else {
                externalSignal.addEventListener(
                    "abort",
                    () => controller.abort(externalSignal.reason || "external-abort"),
                    { once: true }
                );
            }
        }

        return controller;
    }

    // Reads the response body as JSON or plain text based on Content-Type header
    async function parseResponsePayload(response) {
        const contentType = response.headers.get("content-type") || "";
        const isJson = contentType.includes("application/json");

        if (isJson) {
            try {
                return await response.json();
            } catch (_error) {
                return null;
            }
        }

        try {
            return await response.text();
        } catch (_error) {
            return null;
        }
    }

    // Extracts the most useful error message from the response payload and wraps it in ApiError
    function createErrorFromResponse({ response, payload, url, method }) {
        const messageFromPayload =
            payload && typeof payload === "object"
                ? payload.error || payload.message || null
                : null;

        return new ApiError({
            message: messageFromPayload || `HTTP ${response.status}`,
            status: response.status,
            code: "HTTP_ERROR",
            details: payload,
            url,
            method,
        });
    }

    // Registers a new in-flight controller for the given cancel key.
    // If cancelPrevious is true, the previous in-flight request for this key is aborted first.
    function registerInFlight(cancelKey, controller, cancelPrevious = false) {
        if (!cancelKey) {
            return;
        }

        if (cancelPrevious && inFlightControllers.has(cancelKey)) {
            const previous = inFlightControllers.get(cancelKey);
            previous.abort("superseded");
        }

        inFlightControllers.set(cancelKey, controller);
    }

    // Removes the controller from the in-flight map once a request completes or errors
    function clearInFlight(cancelKey, controller) {
        if (!cancelKey) {
            return;
        }

        const current = inFlightControllers.get(cancelKey);
        if (current === controller) {
            inFlightControllers.delete(cancelKey);
        }
    }

    // Aborts any currently in-flight request registered under cancelKey
    function cancelPendingRequest(cancelKey, reason = "cancelled") {
        const controller = inFlightControllers.get(cancelKey);
        if (!controller) {
            return false;
        }

        controller.abort(reason);
        inFlightControllers.delete(cancelKey);
        return true;
    }

    // Returns a plain { controller, signal, cancel } object for callers that need to manage a request lifecycle externally
    function createRequestController() {
        const controller = new AbortController();
        return {
            controller,
            signal: controller.signal,
            cancel: (reason = "cancelled") => controller.abort(reason),
        };
    }

    // Core fetch wrapper: builds URL, attaches cancel controller, executes fetch, parses response,
    // throws structured ApiError on failure, and normalises network/abort errors.
    async function apiRequest(endpoint, options = {}) {
        const {
            method = "GET",
            params = {},
            body,
            headers = {},
            signal,
            cancelKey,
            cancelPrevious = false,
        } = options;

        const url = buildRequestUrl(endpoint, params);
        const controller = createLinkedController(signal);

        // Register this request in the in-flight map so it can be cancelled by key
        registerInFlight(cancelKey, controller, cancelPrevious);

        try {
            const hasBody = body !== undefined && body !== null;
            const response = await fetch(url, {
                method,
                signal: controller.signal,
                body: hasBody ? JSON.stringify(body) : undefined,
                headers: {
                    Accept: "application/json",
                    ...(hasBody ? { "Content-Type": "application/json" } : {}),
                    ...headers,
                },
            });

            const payload = await parseResponsePayload(response);

            // Throw structured error for any non-2xx HTTP status
            if (!response.ok) {
                throw createErrorFromResponse({ response, payload, url, method });
            }

            return payload;
        } catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }

            // Convert browser AbortError into a structured ApiError with isAbort=true so callers can distinguish it
            if (error?.name === "AbortError") {
                throw new ApiError({
                    message: "Request aborted",
                    status: 0,
                    code: "ABORTED",
                    details: null,
                    url,
                    method,
                    isAbort: true,
                });
            }

            // Wrap unexpected network errors (e.g. no connection, DNS failure)
            throw new ApiError({
                message: error?.message || "Network error",
                status: 0,
                code: "NETWORK_ERROR",
                details: null,
                url,
                method,
            });
        } finally {
            // Always remove from in-flight map once the request settles
            clearInFlight(cancelKey, controller);
        }
    }

    // Public API client: thin wrappers around apiRequest for GET and POST verbs
    const apiClient = {
        get(endpoint, params = {}, options = {}) {
            return apiRequest(endpoint, { ...options, method: "GET", params });
        },

        post(endpoint, body = null, params = {}, options = {}) {
            return apiRequest(endpoint, { ...options, method: "POST", params, body });
        },
    };
    if (typeof ApiError !== "undefined") {
        moduleState.ApiError = ApiError;
        global.ApiError = ApiError;
    }
    if (typeof cancelPendingRequest !== "undefined") {
        moduleState.cancelPendingRequest = cancelPendingRequest;
        global.cancelPendingRequest = cancelPendingRequest;
    }
    if (typeof createRequestController !== "undefined") {
        moduleState.createRequestController = createRequestController;
        global.createRequestController = createRequestController;
    }
    if (typeof apiRequest !== "undefined") {
        moduleState.apiRequest = apiRequest;
        global.apiRequest = apiRequest;
    }
    if (typeof apiClient !== "undefined") {
        moduleState.apiClient = apiClient;
        global.apiClient = apiClient;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("api/client");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Normalizes backend payloads into predictable frontend contracts for files, tree, meta, preview, and data.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for api/contracts.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading api/contracts.");
        return;
    }
    var moduleState = ensurePath(ns, "api.contracts");
    /**
     * @typedef {Object} FileItem
     * @property {string} key
     * @property {number} size
     * @property {string|null} last_modified
     * @property {string|null} etag
     */

    /**
     * @typedef {Object} TreeNode
     * @property {string} type
     * @property {string} name
     * @property {string} path
     * @property {number=} num_children
     * @property {number[]=} shape
     * @property {string=} dtype
     * @property {number=} ndim
     * @property {number[]=} chunks
     * @property {string=} compression
     */

    // Coercion helpers: all accept an optional fallback so callers always get a safe typed value back
    function asObject(value, fallback = {}) {
        return value && typeof value === "object" ? value : fallback;
    }

    function asArray(value, fallback = []) {
        return Array.isArray(value) ? value : fallback;
    }

    function asString(value, fallback = "") {
        if (value === null || value === undefined) {
            return fallback;
        }
        return String(value);
    }

    function asNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    // Returns null for empty/missing values instead of a fallback string so callers can distinguish "no value"
    function asNullableString(value) {
        if (value === null || value === undefined || value === "") {
            return null;
        }
        return String(value);
    }

    // Converts a raw shape array from the server into a plain array of safe integers
    function normalizeShape(value) {
        return asArray(value).map((entry) => asNumber(entry, 0));
    }

    // Normalizes a single file/folder item from the /files response; detects folders by key suffix, type field, or is_folder flag
    function normalizeFileItem(value) {
        const raw = asObject(value);
        const key = asString(raw.key);
        const normalizedType = asString(raw.type, "").toLowerCase();
        const isFolder =
            raw.is_folder === true ||
            normalizedType === "folder" ||
            key.endsWith("/");

        return {
            key,
            size: asNumber(raw.size, 0),
            last_modified: asNullableString(raw.last_modified),
            etag: asNullableString(raw.etag),
            type: isFolder ? "folder" : "file",
            is_folder: isFolder,
        };
    }
    // Normalizes the full /files list response including derived counts and success/error fields
    function normalizeFilesResponse(payload) {
        const raw = asObject(payload);
        const files = asArray(raw.files).map(normalizeFileItem);
        // Derive counts from the normalized list in case the server omits them
        const filesCount = files.filter((entry) => entry.type === "file").length;
        const foldersCount = files.filter((entry) => entry.type === "folder").length;

        return {
            success: raw.success === true,
            count: asNumber(raw.count, files.length),
            files,
            files_count: asNumber(raw.files_count, filesCount),
            folders_count: asNumber(raw.folders_count, foldersCount),
            truncated: raw.truncated === true,
            cached: raw.cached === true,
            error: raw.success === false ? asString(raw.error, "Unknown error") : null,
        };
    }

    // Normalizes a single HDF5 tree node (group or dataset) from the children endpoint
    function normalizeTreeNode(value) {
        const raw = asObject(value);
        return {
            type: asString(raw.type, "unknown"),
            name: asString(raw.name),
            path: asString(raw.path),
            num_children: raw.num_children === undefined ? undefined : asNumber(raw.num_children, 0),
            shape: raw.shape === undefined ? undefined : normalizeShape(raw.shape),
            dtype: raw.dtype === undefined ? undefined : asString(raw.dtype),
            ndim: raw.ndim === undefined ? undefined : asNumber(raw.ndim, 0),
            chunks: raw.chunks === undefined ? undefined : normalizeShape(raw.chunks),
            compression: raw.compression === undefined ? undefined : asString(raw.compression),
        };
    }
    // Maps the /hdf5/children response into a typed object with a normalized children array
    function normalizeChildrenResponse(payload) {
        const raw = asObject(payload);
        return {
            success: raw.success === true,
            key: asString(raw.key),
            path: asString(raw.path, "/"),
            children: asArray(raw.children).map(normalizeTreeNode),
            cached: raw.cached === true,
            error: raw.success === false ? asString(raw.error, "Unknown error") : null,
        };
    }
    // Normalizes the /hdf5/meta response; metadata is kept as a raw object because its keys are dataset-specific
    function normalizeMetaResponse(payload) {
        const raw = asObject(payload);
        return {
            success: raw.success === true,
            key: asString(raw.key),
            metadata: asObject(raw.metadata),
            cached: raw.cached === true,
            error: raw.success === false ? asString(raw.error, "Unknown error") : null,
        };
    }
    // Normalizes the /hdf5/preview response; includes shape, display_dims, stats, table/plot blobs, and profile data
    function normalizePreviewPayload(payload) {
        const raw = asObject(payload);
        return {
            success: raw.success === true,
            key: asString(raw.key),
            path: asString(raw.path),
            preview_type: asString(raw.preview_type, "unknown"),
            dtype: asString(raw.dtype),
            shape: normalizeShape(raw.shape),
            ndim: asNumber(raw.ndim, 0),
            dimension_labels: asArray(raw.dimension_labels).map(asNullableString),
            display_dims: raw.display_dims === null ? null : normalizeShape(raw.display_dims),
            fixed_indices: asObject(raw.fixed_indices),
            mode: asString(raw.mode, "auto"),
            stats: asObject(raw.stats),
            table: asObject(raw.table),
            plot: asObject(raw.plot),
            profile: raw.profile === null ? null : asObject(raw.profile),
            limits: asObject(raw.limits),
            cached: raw.cached === true,
            error: raw.success === false ? asString(raw.error, "Unknown error") : null,
        };
    }

    // Picks the mode-specific fields to include in the normalized data response (matrix/heatmap/line each have distinct fields)
    function normalizeDataByMode(raw) {
        const mode = asString(raw.mode);

        if (mode === "matrix") {
            return {
                mode,
                data: asArray(raw.data),
                shape: normalizeShape(raw.shape),
                dtype: asString(raw.dtype),
                row_offset: asNumber(raw.row_offset, 0),
                col_offset: asNumber(raw.col_offset, 0),
                downsample_info: asObject(raw.downsample_info),
            };
        }

        if (mode === "heatmap") {
            return {
                mode,
                data: asArray(raw.data),
                shape: normalizeShape(raw.shape),
                dtype: asString(raw.dtype),
                stats: asObject(raw.stats),
                sampled: raw.sampled === true,
                downsample_info: asObject(raw.downsample_info),
                requested_max_size: asNumber(raw.requested_max_size, 0),
                effective_max_size: asNumber(raw.effective_max_size, 0),
                max_size_clamped: raw.max_size_clamped === true,
            };
        }

        if (mode === "line") {
            return {
                mode,
                data: asArray(raw.data),
                shape: normalizeShape(raw.shape),
                dtype: asString(raw.dtype),
                axis: asString(raw.axis),
                index: raw.index === null || raw.index === undefined ? null : asNumber(raw.index, 0),
                quality_requested: asString(raw.quality_requested, "auto"),
                quality_applied: asString(raw.quality_applied, "auto"),
                line_offset: asNumber(raw.line_offset, 0),
                line_limit: asNumber(raw.line_limit, 0),
                requested_points: asNumber(raw.requested_points, 0),
                returned_points: asNumber(raw.returned_points, 0),
                line_step: asNumber(raw.line_step, 1),
                downsample_info: asObject(raw.downsample_info),
            };
        }

        return {
            mode,
            data: asArray(raw.data),
            shape: normalizeShape(raw.shape),
            dtype: asString(raw.dtype),
        };
    }
    // Normalizes the /hdf5/data response; merges shared fields (key, path, source_shape) with mode-specific fields
    function normalizeDataPayload(payload) {
        const raw = asObject(payload);
        const dataByMode = normalizeDataByMode(raw);

        return {
            success: raw.success === true,
            key: asString(raw.key),
            path: asString(raw.path),
            source_shape: normalizeShape(raw.source_shape),
            source_ndim: asNumber(raw.source_ndim, 0),
            display_dims: raw.display_dims === null ? null : normalizeShape(raw.display_dims),
            fixed_indices: asObject(raw.fixed_indices),
            error: raw.success === false ? asString(raw.error, "Unknown error") : null,
            ...dataByMode,
        };
    }
    // Throws a named Error if payload.success is false; used after every normalizeXxx call to surface backend errors
    function assertSuccess(payload, operation) {
        if (!payload.success) {
            const message = payload.error || `${operation} failed`;
            throw new Error(message);
        }
        return payload;
    }
    if (typeof normalizeFileItem !== "undefined") {
        moduleState.normalizeFileItem = normalizeFileItem;
        global.normalizeFileItem = normalizeFileItem;
    }
    if (typeof normalizeFilesResponse !== "undefined") {
        moduleState.normalizeFilesResponse = normalizeFilesResponse;
        global.normalizeFilesResponse = normalizeFilesResponse;
    }
    if (typeof normalizeTreeNode !== "undefined") {
        moduleState.normalizeTreeNode = normalizeTreeNode;
        global.normalizeTreeNode = normalizeTreeNode;
    }
    if (typeof normalizeChildrenResponse !== "undefined") {
        moduleState.normalizeChildrenResponse = normalizeChildrenResponse;
        global.normalizeChildrenResponse = normalizeChildrenResponse;
    }
    if (typeof normalizeMetaResponse !== "undefined") {
        moduleState.normalizeMetaResponse = normalizeMetaResponse;
        global.normalizeMetaResponse = normalizeMetaResponse;
    }
    if (typeof normalizePreviewPayload !== "undefined") {
        moduleState.normalizePreviewPayload = normalizePreviewPayload;
        global.normalizePreviewPayload = normalizePreviewPayload;
    }
    if (typeof normalizeDataPayload !== "undefined") {
        moduleState.normalizeDataPayload = normalizeDataPayload;
        global.normalizeDataPayload = normalizeDataPayload;
    }
    if (typeof assertSuccess !== "undefined") {
        moduleState.assertSuccess = assertSuccess;
        global.assertSuccess = assertSuccess;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("api/contracts");
    }
})(typeof window !== "undefined" ? window : globalThis);



// Viewer HTML module: Implements cached HDF5 API operations for files, tree, metadata, preview, and mode-specific data fetches.
(function (global) {
    "use strict";
    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for api/hdf5Service.");
        return;
    }
    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading api/hdf5Service.");
        return;
    }
    var moduleState = ensurePath(ns, "api.hdf5Service");
    // Frontend-side caches keep repeated navigation and redraw operations fast.
    // Key design: cache keys always include file identity + dataset slice selectors.
    const frontendCache = {
        files: null,
        treeChildren: new Map(),
        preview: new Map(),
        matrixBlocks: new LruCache(400),
        lineData: new LruCache(30),
        heatmapData: new LruCache(20),
        metadata: new LruCache(80),
    };
    // Separate maps prevent duplicate background refresh and duplicate data window calls.
    const previewRefreshInFlight = new Map();
    const dataRequestsInFlight = new Map();

    const DEFAULT_LINE_OVERVIEW_MAX_POINTS = 5000;

    // Builds a deterministic string key from displayDims for use inside cache key strings
    function toDisplayDimsKey(displayDims) {
        if (!displayDims) {
            return "none";
        }

        if (Array.isArray(displayDims)) {
            return displayDims.join(",");
        }

        return String(displayDims);
    }

    // Builds a deterministic string key from fixedIndices; sorts by dim index so key order is always the same
    function toFixedIndicesKey(fixedIndices) {
        if (typeof fixedIndices === "string") {
            return fixedIndices || "none";
        }

        if (!fixedIndices || typeof fixedIndices !== "object") {
            return "none";
        }

        return Object.entries(fixedIndices)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([dim, index]) => `${dim}=${index}`)
            .join(",") || "none";
    }

    // Returns (creating if needed) the per-file Map used to cache tree children for that file
    function getTreeCache(fileKey) {
        if (!frontendCache.treeChildren.has(fileKey)) {
            frontendCache.treeChildren.set(fileKey, new Map());
        }
        return frontendCache.treeChildren.get(fileKey);
    }

    // Preview cache key must include all display knobs because any of them can change shape/data.
    function getPreviewCacheKey(fileKey, path, params = {}) {
        return [
            fileKey,
            path,
            params.etag ?? "no-etag",
            toDisplayDimsKey(params.display_dims),
            toFixedIndicesKey(params.fixed_indices),
            params.max_size ?? "default",
            params.mode ?? "auto",
            params.detail ?? "full",
            params.include_stats ?? "default",
        ].join("|");
    }

    // Returns the cache key for a matrix block; includes offsets and step sizes so each scroll-window is cached separately
    function getMatrixBlockCacheKey(fileKey, path, params = {}) {
        return [
            fileKey,
            path,
            params.etag ?? "no-etag",
            toDisplayDimsKey(params.display_dims),
            toFixedIndicesKey(params.fixed_indices),
            params.row_offset ?? 0,
            params.row_limit ?? 100,
            params.col_offset ?? 0,
            params.col_limit ?? 100,
            params.row_step ?? 1,
            params.col_step ?? 1,
        ].join("|");
    }

    // Returns the cache key for a line data window; axis, quality, and offset are all part of the identity
    function getLineCacheKey(fileKey, path, params = {}) {
        return [
            fileKey,
            path,
            params.etag ?? "no-etag",
            params.line_dim ?? "row",
            params.line_index ?? "auto",
            params.quality ?? "auto",
            params.max_points ?? DEFAULT_LINE_OVERVIEW_MAX_POINTS,
            params.line_offset ?? 0,
            params.line_limit ?? "all",
            toDisplayDimsKey(params.display_dims),
            toFixedIndicesKey(params.fixed_indices),
        ].join("|");
    }

    // Returns the cache key for heatmap data; max_size controls downsampling so it must be included
    function getHeatmapCacheKey(fileKey, path, params = {}) {
        return [
            fileKey,
            path,
            params.etag ?? "no-etag",
            params.max_size ?? 512,
            params.include_stats ?? "default",
            toDisplayDimsKey(params.display_dims),
            toFixedIndicesKey(params.fixed_indices),
        ].join("|");
    }

    // Returns the AbortController channel key used to cancel a previous request of the same type+file+path
    function getCancelChannel(type, fileKey, path) {
        return `${type}:${fileKey}:${path}`;
    }
    // Fetches the file listing; returns cached result unless force=true or cache is empty
    async function getFiles(options = {}) {
        const { force = false, signal } = options;

        if (!force && frontendCache.files) {
            // Serve from memory cache, bypassing both backend and browser HTTP caching
            return {
                ...frontendCache.files,
                cached: true,
                cache_source: "frontend",
            };
        }

        const payload = await apiClient.get(API_ENDPOINTS.FILES, {}, { signal });
        const normalized = assertSuccess(normalizeFilesResponse(payload), "getFiles");
        frontendCache.files = normalized;
        return normalized;
    }
    // Fetches children for a path in the HDF5 tree; per-file and per-etag cache prevents redundant network round-trips
    async function getFileChildren(key, path = "/", options = {}) {
        const { force = false, signal, etag } = options;
        const treeCache = getTreeCache(key);
        const treeCacheKey = `${path}|${etag || "no-etag"}`;

        if (!force && treeCache.has(treeCacheKey)) {
            return {
                ...treeCache.get(treeCacheKey),
                cached: true,
                cache_source: "frontend",
            };
        }

        const queryParams = { path };
        if (etag) {
            queryParams.etag = etag;
        }

        const payload = await apiClient.get(
            API_ENDPOINTS.FILE_CHILDREN(key),
            queryParams,
            {
                signal,
                cancelKey: getCancelChannel("children", key, path),
                cancelPrevious: false,
            }
        );

        const normalized = assertSuccess(normalizeChildrenResponse(payload), "getFileChildren");
        treeCache.set(treeCacheKey, normalized);
        return normalized;
    }
    // Fetches HDF5 dataset/group metadata (attributes, dtype, shape) using an LRU cache keyed by file+path+etag
    async function getFileMeta(key, path, options = {}) {
        const { force = false, signal, etag } = options;
        const cacheKey = `${key}|${path}|${etag || "no-etag"}`;

        if (!force) {
            const cached = frontendCache.metadata.get(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true,
                    cache_source: "frontend",
                };
            }
        }

        const queryParams = { path };
        if (etag) {
            queryParams.etag = etag;
        }

        const payload = await apiClient.get(
            API_ENDPOINTS.FILE_META(key),
            queryParams,
            {
                signal,
                cancelKey: getCancelChannel("meta", key, path),
                cancelPrevious: false,
            }
        );

        const normalized = assertSuccess(normalizeMetaResponse(payload), "getFileMeta");
        frontendCache.metadata.set(cacheKey, normalized);
        return normalized;
    }
    async function getFilePreview(key, path, params = {}, options = {}) {
        const {
            force = false,
            signal,
            cancelPrevious = true,
            staleWhileRefresh = false,
            onBackgroundUpdate = null,
        } = options;
        const cacheKey = getPreviewCacheKey(key, path, params);

        if (!force && frontendCache.preview.has(cacheKey)) {
            const cachedPreview = {
                ...frontendCache.preview.get(cacheKey),
                cached: true,
                cache_source: "frontend",
            };

            if (staleWhileRefresh) {
                // Return cached payload immediately, then refresh in background once per key.
                const refreshKey = cacheKey;
                if (!previewRefreshInFlight.has(refreshKey)) {
                    const refreshPromise = apiClient
                        .get(
                            API_ENDPOINTS.FILE_PREVIEW(key),
                            { path, ...params },
                            {
                                cancelKey: `${getCancelChannel("preview-refresh", key, path)}:${refreshKey}`,
                                cancelPrevious: false,
                            }
                        )
                        .then((payload) => {
                            const normalized = assertSuccess(normalizePreviewPayload(payload), "getFilePreview(refresh)");
                            frontendCache.preview.set(cacheKey, normalized);
                            if (typeof onBackgroundUpdate === "function") {
                                onBackgroundUpdate({
                                    ...normalized,
                                    cached: false,
                                    cache_source: "backend-refresh",
                                });
                            }
                            return normalized;
                        })
                        .catch(() => null)
                        .finally(() => {
                            previewRefreshInFlight.delete(refreshKey);
                        });

                    previewRefreshInFlight.set(refreshKey, refreshPromise);
                }

                return {
                    ...cachedPreview,
                    stale: true,
                };
            }

            return cachedPreview;
        }

        const payload = await apiClient.get(
            API_ENDPOINTS.FILE_PREVIEW(key),
            { path, ...params },
            {
                signal,
                cancelKey: getCancelChannel("preview", key, path),
                cancelPrevious,
            }
        );

        const normalized = assertSuccess(normalizePreviewPayload(payload), "getFilePreview");
        frontendCache.preview.set(cacheKey, normalized);
        return normalized;
    }

    async function getMatrixData(key, path, params, options) {
        const { force = false, signal, cancelPrevious = false, cancelKey } = options;
        const cacheKey = getMatrixBlockCacheKey(key, path, params);

        if (!force) {
            const cached = frontendCache.matrixBlocks.get(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true,
                    cache_source: "frontend",
                };
            }

            // Reuse the same promise when multiple consumers ask for the same block concurrently.
            const pendingRequest = dataRequestsInFlight.get(cacheKey);
            if (pendingRequest) {
                return pendingRequest;
            }
        }

        let requestPromise;
        requestPromise = apiClient
            .get(
                API_ENDPOINTS.FILE_DATA(key),
                { path, mode: "matrix", ...params },
                {
                    signal,
                    cancelKey:
                        cancelKey ||
                        `${getCancelChannel("matrix", key, path)}:${params.row_offset ?? 0}:${params.col_offset ?? 0}`,
                    cancelPrevious,
                }
            )
            .then((payload) => {
                const normalized = assertSuccess(normalizeDataPayload(payload), "getFileData(matrix)");
                frontendCache.matrixBlocks.set(cacheKey, normalized);
                return normalized;
            })
            .finally(() => {
                if (dataRequestsInFlight.get(cacheKey) === requestPromise) {
                    dataRequestsInFlight.delete(cacheKey);
                }
            });

        if (!force) {
            dataRequestsInFlight.set(cacheKey, requestPromise);
        }
        return requestPromise;
    }

    async function getLineData(key, path, params, options) {
        const { force = false, signal, cancelPrevious = true, cancelKey } = options;
        const cacheKey = getLineCacheKey(key, path, params);

        if (!force) {
            const cached = frontendCache.lineData.get(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true,
                    cache_source: "frontend",
                };
            }

            // Reuse in-flight line window request so pan/zoom bursts do not duplicate calls.
            const pendingRequest = dataRequestsInFlight.get(cacheKey);
            if (pendingRequest) {
                return pendingRequest;
            }
        }

        let requestPromise;
        requestPromise = apiClient
            .get(
                API_ENDPOINTS.FILE_DATA(key),
                { path, mode: "line", ...params },
                {
                    signal,
                    cancelKey: cancelKey || getCancelChannel("line", key, path),
                    cancelPrevious,
                }
            )
            .then((payload) => {
                const normalized = assertSuccess(normalizeDataPayload(payload), "getFileData(line)");
                frontendCache.lineData.set(cacheKey, normalized);
                return normalized;
            })
            .finally(() => {
                if (dataRequestsInFlight.get(cacheKey) === requestPromise) {
                    dataRequestsInFlight.delete(cacheKey);
                }
            });

        if (!force) {
            dataRequestsInFlight.set(cacheKey, requestPromise);
        }
        return requestPromise;
    }

    async function getHeatmapData(key, path, params, options) {
        const { force = false, signal, cancelPrevious = true, cancelKey } = options;
        const cacheKey = getHeatmapCacheKey(key, path, params);

        if (!force) {
            const cached = frontendCache.heatmapData.get(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true,
                    cache_source: "frontend",
                };
            }

            // Reuse in-flight heatmap request for identical params.
            const pendingRequest = dataRequestsInFlight.get(cacheKey);
            if (pendingRequest) {
                return pendingRequest;
            }
        }

        let requestPromise;
        requestPromise = apiClient
            .get(
                API_ENDPOINTS.FILE_DATA(key),
                { path, mode: "heatmap", ...params },
                {
                    signal,
                    cancelKey: cancelKey || getCancelChannel("heatmap", key, path),
                    cancelPrevious,
                }
            )
            .then((payload) => {
                const normalized = assertSuccess(normalizeDataPayload(payload), "getFileData(heatmap)");
                frontendCache.heatmapData.set(cacheKey, normalized);
                return normalized;
            })
            .finally(() => {
                if (dataRequestsInFlight.get(cacheKey) === requestPromise) {
                    dataRequestsInFlight.delete(cacheKey);
                }
            });

        if (!force) {
            dataRequestsInFlight.set(cacheKey, requestPromise);
        }
        return requestPromise;
    }
    async function getFileData(key, path, params = {}, options = {}) {
        const mode = String(params.mode || "").toLowerCase();

        if (mode === "matrix") {
            return getMatrixData(key, path, params, options);
        }

        if (mode === "line") {
            return getLineData(key, path, params, options);
        }

        if (mode === "heatmap") {
            return getHeatmapData(key, path, params, options);
        }

        throw new Error("Invalid mode. Expected one of: matrix, line, heatmap");
    }
    const __default_export__ = {
        getFiles,
        getFileChildren,
        getFileMeta,
        getFilePreview,
        getFileData,
    };
    if (typeof getFiles !== "undefined") {
        moduleState.getFiles = getFiles;
        global.getFiles = getFiles;
    }
    if (typeof getFileChildren !== "undefined") {
        moduleState.getFileChildren = getFileChildren;
        global.getFileChildren = getFileChildren;
    }
    if (typeof getFileMeta !== "undefined") {
        moduleState.getFileMeta = getFileMeta;
        global.getFileMeta = getFileMeta;
    }
    if (typeof getFilePreview !== "undefined") {
        moduleState.getFilePreview = getFilePreview;
        global.getFilePreview = getFilePreview;
    }
    if (typeof getFileData !== "undefined") {
        moduleState.getFileData = getFileData;
        global.getFileData = getFileData;
    }
    if (typeof __default_export__ !== "undefined") {
        moduleState.defaultService = __default_export__;
        global.__hdf5ServiceDefault = __default_export__;
    }
    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("api/hdf5Service");
    }
})(typeof window !== "undefined" ? window : globalThis);



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
        const { getFiles, getFileChildren, getFileMeta, getFilePreview } = api;
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
        const { getFiles, getFileChildren, getFileMeta, getFilePreview } = api;
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
        const { getFiles, getFileChildren, getFileMeta, getFilePreview } = api;
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
        const { getFiles, getFileChildren, getFileMeta, getFilePreview } = api;
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

        function resolveActiveLineRuntimeApi(snapshot) {
            if (typeof document === "undefined") {
                return null;
            }

            const shell = document.querySelector(
                '[data-line-shell]:not(.heatmap-inline-line-shell):not(.matrix-inline-line-shell)'
            );
            if (!shell) {
                return null;
            }

            if ((shell.dataset.lineFileKey || "") !== String(snapshot.selectedFile || "")) {
                return null;
            }

            if ((shell.dataset.linePath || "/") !== String(snapshot.selectedPath || "/")) {
                return null;
            }

            const runtimeApi = shell.__lineRuntimeApi;
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
            const isHeatmapPlaybackTab = activeTab === "heatmap" || activeTab === "image";
            const isLinePlaybackTab = activeTab === "line";
            if (
                snapshot.route !== "viewer" ||
                snapshot.viewMode !== "display" ||
                snapshot.selectedNodeType !== "dataset" ||
                (!isHeatmapPlaybackTab && !isLinePlaybackTab)
            ) {
                return null;
            }

            let runtimeApi = null;
            if (isLinePlaybackTab) {
                if (snapshot.lineFullEnabled !== true) {
                    return null;
                }
                runtimeApi = resolveActiveLineRuntimeApi(snapshot);
            } else {
                if (snapshot.heatmapFullEnabled !== true) {
                    return null;
                }
                runtimeApi = resolveActiveHeatmapRuntimeApi(snapshot);
            }

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

        function buildLineLiveSelection(snapshot, displayDims, fixedIndices) {
            const displayDimsParam = buildDisplayDimsParam(displayDims) || "";
            const fixedIndicesParam = buildFixedIndicesParam(fixedIndices) || "";
            const nextState = {
                ...snapshot,
                displayConfig: {
                    ...(snapshot.displayConfig || getDisplayConfigDefaults()),
                    displayDims,
                    fixedIndices,
                    stagedDisplayDims: displayDims,
                    stagedFixedIndices: fixedIndices,
                },
            };
            const lineConfig =
                typeof global.resolveLineRuntimeConfig === "function"
                    ? global.resolveLineRuntimeConfig(nextState, snapshot.preview)
                    : null;
            const lineIndex = toSafeInteger(lineConfig?.lineIndex, null);
            const lineDim = lineIndex === null ? null : String(lineConfig?.lineDim || "row");
            const totalPoints = Math.max(0, toSafeInteger(lineConfig?.totalPoints, 0));
            const selectionKey =
                typeof lineConfig?.selectionKey === "string" && lineConfig.selectionKey
                    ? lineConfig.selectionKey
                    : typeof global.buildLineSelectionKey === "function"
                        ? global.buildLineSelectionKey(
                            snapshot.selectedFile,
                            snapshot.selectedPath,
                            displayDimsParam,
                            fixedIndicesParam,
                            lineIndex
                        )
                        : [
                            snapshot.selectedFile || "no-file",
                            snapshot.selectedPath || "/",
                            displayDimsParam || "none",
                            fixedIndicesParam || "none",
                            lineIndex ?? "auto",
                        ].join("|");

            return {
                displayDims,
                fixedIndices,
                displayDimsParam,
                fixedIndicesParam,
                lineIndex,
                lineDim,
                totalPoints,
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
                const liveUpdateMode =
                    snapshot.route === "viewer" &&
                    snapshot.viewMode === "display" &&
                    snapshot.selectedNodeType === "dataset" &&
                    Array.isArray(appliedDims) &&
                    appliedDims.length === 2 &&
                    areDisplayDimsEqual(stagedDims, appliedDims)
                        ? snapshot.displayTab === "line" && snapshot.lineFullEnabled === true
                            ? "line"
                            : (snapshot.displayTab === "heatmap" || snapshot.displayTab === "image") &&
                              snapshot.heatmapFullEnabled === true
                                ? "heatmap"
                                : null
                        : null;

                const selectionRuntimeApi =
                    liveUpdateMode === "line"
                        ? resolveActiveLineRuntimeApi(snapshot)
                        : liveUpdateMode === "heatmap"
                            ? resolveActiveHeatmapRuntimeApi(snapshot)
                            : null;
                if (selectionRuntimeApi) {
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
                        const nextSelection =
                            liveUpdateMode === "line"
                                ? buildLineLiveSelection(snapshot, appliedDims, nextFixedIndices)
                                : buildHeatmapLiveSelection(snapshot, appliedDims, nextFixedIndices);
                        updatePromise = Promise.resolve(
                            selectionRuntimeApi.updateSelection(
                                {
                                    displayDims: nextSelection.displayDimsParam,
                                    fixedIndices: nextSelection.fixedIndicesParam,
                                    selectionKey: nextSelection.selectionKey,
                                    ...(liveUpdateMode === "line"
                                        ? {
                                            lineIndex: nextSelection.lineIndex,
                                            lineDim: nextSelection.lineDim,
                                            totalPoints: nextSelection.totalPoints,
                                        }
                                        : {}),
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
        const { getFiles, getFileChildren, getFileMeta, getFilePreview } = api;
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
        const { getFiles, getFileChildren, getFileMeta, getFilePreview } = api;
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
        const dimensionLabels = Array.isArray(preview?.dimension_labels) ? preview.dimension_labels : [];

        if (!shape.length) {
            return {
                supported: false,
                shape: [],
                displayDims: [],
                fixedIndices: {},
                dimensionLabels: [],
                totalPoints: 0,
                rowCount: 0,
                displayDimsParam: "",
                fixedIndicesParam: "",
                lineIndex: null,
                lineDim: null,
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
                shape,
                displayDims: [],
                fixedIndices: {},
                dimensionLabels,
                totalPoints,
                rowCount: 1,
                displayDimsParam: "",
                fixedIndicesParam: "",
                lineIndex: null,
                lineDim: null,
                selectionKey,
            };
        }

        if (!Array.isArray(dims) || dims.length !== 2) {
            return {
                supported: false,
                shape,
                displayDims: [],
                fixedIndices,
                dimensionLabels,
                totalPoints: 0,
                rowCount: 0,
                displayDimsParam: "",
                fixedIndicesParam: "",
                lineIndex: null,
                lineDim: null,
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
            shape,
            displayDims: dims,
            fixedIndices,
            dimensionLabels,
            totalPoints,
            rowCount,
            displayDimsParam,
            fixedIndicesParam,
            lineIndex,
            lineDim: lineIndex === null ? null : "row",
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
        const showAutoplayControls =
            state.displayTab === "heatmap" ||
            state.displayTab === "image" ||
            state.displayTab === "line";
        const canAutoplayHiddenDims =
            state.displayTab === "line"
                ? state.lineFullEnabled === true
                : showAutoplayControls && state.heatmapFullEnabled === true;

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
    const SHOW_HEATMAP_PANEL_PLAYBACK_CONTROLS = true;

    // Feature flag: when true, hidden-dimension playback controls are rendered inside the Line panel shell.
    const SHOW_LINE_PANEL_PLAYBACK_CONTROLS = true;

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
        const panelPlaybackControls =
            SHOW_LINE_PANEL_PLAYBACK_CONTROLS === true &&
            typeof global.renderFixedIndexControls === "function"
                ? global.renderFixedIndexControls({
                    shape: config.shape,
                    displayDims: config.displayDims,
                    fixedIndices: config.fixedIndices,
                    dimensionLabels: config.dimensionLabels,
                    playingFixedDim: toSafeInteger(state.displayConfig?.playingFixedDim, null),
                    showPlayback: true,
                    canAutoplayHiddenDims: state.lineFullEnabled === true,
                    wrapperClassName: "line-panel-controls",
                    containerClassName: "dim-sliders line-panel-dim-sliders",
                    controlClassName: "line-panel-dim-slider",
                    title: "Slice controls",
                    titleClassName: "line-panel-controls-title",
                })
                : "";
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
      data-line-dim="${escapeHtml(config.lineDim || "")}"
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
      ${panelPlaybackControls}
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
        <!-- <span class="${statusClass}" data-line-status="true">${escapeHtml(statusText)}</span> -->
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
      <div class="matrix-linked-plot" data-matrix-linked-plot="true" hidden>
        <div class="matrix-linked-plot-header">
          <div class="matrix-linked-plot-title" data-matrix-linked-title="true">
            Plot mode: click a row or column header to inspect its profile.
          </div>
          <div class="matrix-linked-plot-actions">
            <button
              type="button"
              class="line-tool-btn line-tool-btn-icon"
              data-matrix-plot-close="true"
              aria-label="Close matrix plot"
              title="Close plot"
            >
              <svg class="line-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 4l8 8M12 4l-8 8"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="data-status info matrix-linked-plot-status" data-line-status="true">
          Click a row or column header to plot.
        </div>
        <div class="matrix-linked-plot-shell-host" data-matrix-linked-shell-host="true"></div>
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
                    ? "Streaming blocks as you scroll. Click a row or column header to plot."
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
      <div
        class="heatmap-runtime-notice"
        data-heatmap-runtime-notice="true"
        role="status"
        aria-live="polite"
        hidden
      ></div>
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
        <!-- <span class="${statusClass}" data-heatmap-status="true">${escapeHtml(statusText)}</span> -->
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
        <!-- <span class="${statusClass}" data-heatmap-status="true">${escapeHtml(statusText)}</span> -->
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
    const MATRIX_LINKED_PLOT_CACHE =
        global.__matrixLinkedPlotCache instanceof Map
            ? global.__matrixLinkedPlotCache
            : new Map();
    global.__matrixLinkedPlotCache = MATRIX_LINKED_PLOT_CACHE;

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
        const linkedPlotPanel = shell.querySelector("[data-matrix-linked-plot]");
        const linkedPlotTitle = shell.querySelector("[data-matrix-linked-title]");
        const linkedPlotStatusElement = shell.querySelector("[data-line-status]");
        const linkedPlotShellHost = shell.querySelector("[data-matrix-linked-shell-host]");
        const linkedPlotCloseButton = shell.querySelector("[data-matrix-plot-close]");
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
            selectedPlot: null,
            linkedLineCleanup: null,
        };

        const visible = {
            rowStart: 0,
            rowEnd: 0,
            colStart: 0,
            colEnd: 0,
        };

        const clampIndex = (value, min, max) => Math.max(min, Math.min(max, value));

        function setLinkedPlotTitle(plot = runtime.selectedPlot) {
            if (!linkedPlotTitle) {
                return;
            }

            if (!plot) {
                linkedPlotTitle.textContent =
                    "Plot mode: click a row or column header to inspect its profile.";
                return;
            }

            linkedPlotTitle.textContent =
                plot.kind === "row"
                    ? `Selected row ${plot.index} | Plotting values across columns`
                    : `Selected column ${plot.index} | Plotting values across rows`;
        }

        function clearLinkedLineRuntime() {
            if (typeof runtime.linkedLineCleanup === "function") {
                try {
                    runtime.linkedLineCleanup();
                } catch (_error) {
                    // ignore cleanup errors for detached inline plots
                }
            }
            runtime.linkedLineCleanup = null;
            if (linkedPlotShellHost) {
                linkedPlotShellHost.innerHTML = "";
            }
        }

        function closeLinkedPlot() {
            runtime.selectedPlot = null;
            MATRIX_LINKED_PLOT_CACHE.delete(runtime.selectionKey);
            clearLinkedLineRuntime();
            if (linkedPlotPanel) {
                linkedPlotPanel.hidden = true;
            }
            setLinkedPlotTitle(null);
            setMatrixStatus(linkedPlotStatusElement, "Click a row or column header to plot.", "info");
            queueRender();
        }

        function revealLinkedPlot() {
            if (!linkedPlotPanel || linkedPlotPanel.hidden) {
                return;
            }

            try {
                linkedPlotPanel.scrollIntoView({
                    block: "nearest",
                    inline: "nearest",
                    behavior: "smooth",
                });
            } catch (_error) {
                linkedPlotPanel.scrollIntoView(false);
            }
        }

        function normalizePlotSelection(kind, index) {
            const normalizedKind =
                kind === "row"
                    ? "row"
                    : kind === "col"
                        ? "col"
                        : null;
            const normalizedIndex = toSafeInteger(index, null);
            if (!normalizedKind || normalizedIndex === null) {
                return null;
            }

            const maxIndex = normalizedKind === "row" ? runtime.rows - 1 : runtime.cols - 1;
            if (maxIndex < 0 || normalizedIndex < 0 || normalizedIndex > maxIndex) {
                return null;
            }

            const totalPoints = normalizedKind === "row" ? runtime.cols : runtime.rows;
            if (totalPoints <= 0) {
                return null;
            }

            const baseSelectionKey =
                typeof buildLineSelectionKey === "function"
                    ? buildLineSelectionKey(
                        runtime.fileKey,
                        runtime.path,
                        runtime.displayDims,
                        runtime.fixedIndices,
                        normalizedIndex
                    )
                    : [
                        runtime.fileKey || "no-file",
                        runtime.path || "/",
                        runtime.displayDims || "none",
                        runtime.fixedIndices || "none",
                        normalizedIndex,
                    ].join("|");

            return {
                kind: normalizedKind,
                index: normalizedIndex,
                totalPoints,
                lineDim: normalizedKind,
                lineIndex: normalizedIndex,
                selectionKey: `${baseSelectionKey}|${normalizedKind}`,
                title:
                    normalizedKind === "row"
                        ? `Row profile: Row ${normalizedIndex} across columns`
                        : `Column profile: Column ${normalizedIndex} across rows`,
            };
        }

        function renderLinkedPlot(plot, options = {}) {
            const normalizedPlot = normalizePlotSelection(plot?.kind, plot?.index);
            if (!normalizedPlot) {
                return false;
            }

            if (
                typeof global.renderLinkedLineShellMarkup !== "function" ||
                typeof initializeLineRuntime !== "function" ||
                !linkedPlotPanel ||
                !linkedPlotShellHost
            ) {
                setMatrixStatus(statusElement, "Inline line plot is unavailable.", "error");
                return false;
            }

            runtime.selectedPlot = normalizedPlot;
            MATRIX_LINKED_PLOT_CACHE.set(runtime.selectionKey, {
                kind: normalizedPlot.kind,
                index: normalizedPlot.index,
            });
            linkedPlotPanel.hidden = false;
            setLinkedPlotTitle(normalizedPlot);
            setMatrixStatus(linkedPlotStatusElement, `Loading ${normalizedPlot.title}...`, "info");
            clearLinkedLineRuntime();

            linkedPlotShellHost.innerHTML = global.renderLinkedLineShellMarkup({
                fileKey: runtime.fileKey,
                fileEtag: runtime.fileEtag,
                path: runtime.path,
                displayDims: runtime.displayDims,
                fixedIndices: runtime.fixedIndices,
                selectionKey: normalizedPlot.selectionKey,
                totalPoints: normalizedPlot.totalPoints,
                lineIndex: normalizedPlot.lineIndex,
                lineDim: normalizedPlot.lineDim,
                notation: runtime.notation,
                lineGrid: true,
                lineAspect: "line",
                inlineShellClass: "matrix-inline-line-shell",
            });

            const lineShell = linkedPlotShellHost.querySelector("[data-line-shell]");
            if (!lineShell) {
                setMatrixStatus(statusElement, "Failed to create inline line plot.", "error");
                return false;
            }

            const cleanup = initializeLineRuntime(lineShell);
            runtime.linkedLineCleanup =
                typeof cleanup === "function"
                    ? cleanup
                    : typeof lineShell.__lineRuntimeCleanup === "function"
                        ? lineShell.__lineRuntimeCleanup
                        : null;

            if (options.reveal !== false) {
                revealLinkedPlot();
            }
            queueRender();
            return true;
        }

        function activatePlotFromTrigger(trigger, options = {}) {
            if (!(trigger instanceof Element)) {
                return false;
            }

            const plot = normalizePlotSelection(
                String(trigger.dataset.matrixPlotKind || "").trim().toLowerCase(),
                trigger.dataset.matrixPlotIndex
            );
            if (!plot) {
                return false;
            }

            return renderLinkedPlot(plot, options);
        }

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
                    ? `Loaded ${runtime.loadedBlocks} block${runtime.loadedBlocks > 1 ? "s" : ""}. Click a row or column header to plot.`
                    : "Scroll to stream blocks. Click a row or column header to plot.",
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
                const isSelected =
                    runtime.selectedPlot?.kind === "col" && runtime.selectedPlot?.index === col;
                node.style.left = `${col * MATRIX_COL_WIDTH}px`;
                node.style.width = `${MATRIX_COL_WIDTH}px`;
                node.style.height = `${MATRIX_HEADER_HEIGHT}px`;
                node.textContent = String(col);
                node.dataset.matrixPlotTrigger = "true";
                node.dataset.matrixPlotKind = "col";
                node.dataset.matrixPlotIndex = String(col);
                node.setAttribute("role", "button");
                node.setAttribute("tabindex", "0");
                node.setAttribute("aria-label", `Plot column ${col} as a line graph`);
                node.setAttribute("aria-pressed", isSelected ? "true" : "false");
                node.setAttribute("title", `Plot column ${col}`);
                node.classList.add("matrix-cell-trigger");
                node.classList.toggle("is-selected", isSelected);
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
                const isSelected =
                    runtime.selectedPlot?.kind === "row" && runtime.selectedPlot?.index === row;
                node.style.left = "0px";
                node.style.top = `${row * MATRIX_ROW_HEIGHT}px`;
                node.style.width = `${MATRIX_INDEX_WIDTH}px`;
                node.style.height = `${MATRIX_ROW_HEIGHT}px`;
                node.textContent = String(row);
                node.dataset.matrixPlotTrigger = "true";
                node.dataset.matrixPlotKind = "row";
                node.dataset.matrixPlotIndex = String(row);
                node.setAttribute("role", "button");
                node.setAttribute("tabindex", "0");
                node.setAttribute("aria-label", `Plot row ${row} as a line graph`);
                node.setAttribute("aria-pressed", isSelected ? "true" : "false");
                node.setAttribute("title", `Plot row ${row}`);
                node.classList.add("matrix-cell-trigger");
                node.classList.toggle("is-selected", isSelected);
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

        function resolvePlotTriggerTarget(target) {
            if (!(target instanceof Element)) {
                return null;
            }
            const trigger = target.closest("[data-matrix-plot-trigger='true']");
            return trigger && shell.contains(trigger) ? trigger : null;
        }

        function onPlotTriggerClick(event) {
            const trigger = resolvePlotTriggerTarget(event.target);
            if (!trigger) {
                return;
            }
            event.preventDefault();
            activatePlotFromTrigger(trigger, { reveal: true });
        }

        function onPlotTriggerKeyDown(event) {
            if (event.key !== "Enter" && event.key !== " ") {
                return;
            }

            const trigger = resolvePlotTriggerTarget(event.target);
            if (!trigger) {
                return;
            }

            event.preventDefault();
            activatePlotFromTrigger(trigger, { reveal: true });
        }

        function onCloseLinkedPlot(event) {
            event?.preventDefault?.();
            closeLinkedPlot();
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
        headerCellsLayer.addEventListener("click", onPlotTriggerClick);
        headerCellsLayer.addEventListener("keydown", onPlotTriggerKeyDown);
        indexLayer.addEventListener("click", onPlotTriggerClick);
        indexLayer.addEventListener("keydown", onPlotTriggerKeyDown);
        if (linkedPlotCloseButton) {
            linkedPlotCloseButton.addEventListener("click", onCloseLinkedPlot);
        }

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
        setLinkedPlotTitle(null);
        setMatrixStatus(linkedPlotStatusElement, "Click a row or column header to plot.", "info");
        const persistedPlot = MATRIX_LINKED_PLOT_CACHE.get(runtime.selectionKey);
        if (persistedPlot && typeof persistedPlot === "object") {
            renderLinkedPlot(persistedPlot, { reveal: false });
        }
        queueRender();

        const cleanup = () => {
            runtime.destroyed = true;
            runtime.blockQueue = [];
            runtime.queuedBlockKeys.clear();
            clearLinkedLineRuntime();
            runtime.activeCancelKeys.forEach((cancelKey) => {
                cancelPendingRequest(cancelKey, "matrix-runtime-disposed");
            });
            runtime.activeCancelKeys.clear();
            table.removeEventListener("scroll", onScroll);
            headerCellsLayer.removeEventListener("click", onPlotTriggerClick);
            headerCellsLayer.removeEventListener("keydown", onPlotTriggerKeyDown);
            indexLayer.removeEventListener("click", onPlotTriggerClick);
            indexLayer.removeEventListener("keydown", onPlotTriggerKeyDown);
            if (linkedPlotCloseButton) {
                linkedPlotCloseButton.removeEventListener("click", onCloseLinkedPlot);
            }
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
    const LINE_WINDOW_RENDER_CACHE =
        global.__lineWindowRenderCache instanceof Map
            ? global.__lineWindowRenderCache
            : new Map();
    const MAX_LINE_WINDOW_RENDER_CACHE_ENTRIES = 320;
    global.__lineWindowRenderCache = LINE_WINDOW_RENDER_CACHE;
    let lineFullscreenRestore = null;

    function getLineWindowRenderCacheKey(runtime, start = runtime?.viewStart, span = runtime?.viewSpan) {
        return [
            runtime?.selectionKey || "no-selection",
            runtime?.fileEtag || "no-etag",
            runtime?.qualityRequested || "auto",
            toSafeInteger(start, 0),
            toSafeInteger(span, 0),
        ].join("|");
    }

    function cloneLinePoints(points) {
        return Array.isArray(points)
            ? points
                .map((point) => ({
                    x: Number(point?.x),
                    y: Number(point?.y),
                }))
                .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
            : [];
    }

    function cloneCompareSeries(seriesList) {
        return Array.isArray(seriesList)
            ? seriesList
                .map((entry) => ({
                    isBase: entry?.isBase === true,
                    path: String(entry?.path || ""),
                    label: String(entry?.label || ""),
                    color: String(entry?.color || "#2563EB"),
                    points: cloneLinePoints(entry?.points),
                }))
                .filter((entry) => entry.points.length > 0)
            : [];
    }

    function rememberLineWindowRender(runtime, snapshot) {
        if (!runtime || !snapshot || typeof snapshot !== "object") {
            return;
        }
        const cacheKey = getLineWindowRenderCacheKey(runtime, snapshot.viewStart, snapshot.viewSpan);
        LINE_WINDOW_RENDER_CACHE.delete(cacheKey);
        LINE_WINDOW_RENDER_CACHE.set(cacheKey, {
            ...snapshot,
            basePoints: cloneLinePoints(snapshot.basePoints),
            compareSeries: cloneCompareSeries(snapshot.compareSeries),
            failedCompareTargets: Array.isArray(snapshot.failedCompareTargets)
                ? snapshot.failedCompareTargets.map((entry) => ({
                    path: String(entry?.path || ""),
                    label: String(entry?.label || ""),
                    reason: String(entry?.reason || ""),
                }))
                : [],
        });
        while (LINE_WINDOW_RENDER_CACHE.size > MAX_LINE_WINDOW_RENDER_CACHE_ENTRIES) {
            const oldestKey = LINE_WINDOW_RENDER_CACHE.keys().next().value;
            if (!oldestKey) {
                break;
            }
            LINE_WINDOW_RENDER_CACHE.delete(oldestKey);
        }
    }

    function getLineWindowRender(runtime, start = runtime?.viewStart, span = runtime?.viewSpan) {
        const cacheKey = getLineWindowRenderCacheKey(runtime, start, span);
        return LINE_WINDOW_RENDER_CACHE.get(cacheKey) || null;
    }

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

    const LINE_SELECTION_UPDATE_DEBOUNCE_MS = 140;

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
            activeCancelKeys: new Set(),
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
            recoveryRetryCount: 0,
            recoveryRetryTimer: null,
        };

        let selectionUpdateTimer = null;
        let pendingSelectionUpdate = null;

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
            rangeLabel.textContent = baseText;
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

        function clearRecoveryRetry() {
            if (runtime.recoveryRetryTimer !== null) {
                clearTimeout(runtime.recoveryRetryTimer);
                runtime.recoveryRetryTimer = null;
            }
        }

        function scheduleRecoveryFetch(reason = "retry") {
            if (
                runtime.destroyed ||
                (Array.isArray(runtime.points) && runtime.points.length >= 2) ||
                runtime.recoveryRetryCount >= 2
            ) {
                return;
            }
            clearRecoveryRetry();
            const retrySelectionKey = runtime.selectionKey;
            const retryStart = runtime.viewStart;
            const retrySpan = runtime.viewSpan;
            runtime.recoveryRetryCount += 1;
            runtime.recoveryRetryTimer = setTimeout(() => {
                runtime.recoveryRetryTimer = null;
                if (
                    runtime.destroyed ||
                    retrySelectionKey !== runtime.selectionKey ||
                    retryStart !== runtime.viewStart ||
                    retrySpan !== runtime.viewSpan
                ) {
                    return;
                }
                setMatrixStatus(statusElement, `Retrying line range (${reason})...`, "info");
                void fetchLineRange({ force: true, recovery: true });
            }, 120 * runtime.recoveryRetryCount);
        }

        function applyCachedWindowSnapshot(snapshot, options = {}) {
            if (!snapshot || typeof snapshot !== "object") {
                return false;
            }
            const basePoints = cloneLinePoints(snapshot.basePoints);
            const compareSeries = cloneCompareSeries(snapshot.compareSeries);
            if (basePoints.length < 2) {
                return false;
            }
            runtime.lineStep = Math.max(1, toSafeInteger(snapshot.lineStep, runtime.lineStep));
            runtime.qualityApplied = normalizeLineQuality(snapshot.qualityApplied || runtime.qualityRequested);
            runtime.requestedPoints = Math.max(
                0,
                toSafeInteger(snapshot.requestedPoints, basePoints.length)
            );
            runtime.returnedPoints = Math.max(
                0,
                toSafeInteger(snapshot.returnedPoints, basePoints.length)
            );
            runtime.failedCompareTargets = Array.isArray(snapshot.failedCompareTargets)
                ? snapshot.failedCompareTargets.map((entry) => ({
                    path: String(entry?.path || ""),
                    label: String(entry?.label || ""),
                    reason: String(entry?.reason || ""),
                }))
                : [];
            updateRangeLabel(basePoints.length);
            updateZoomLabel();
            renderSeries(basePoints, compareSeries);
            if (options.statusMessage) {
                setMatrixStatus(statusElement, options.statusMessage, "info");
            }
            return true;
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

        async function fetchLineRange(options = {}) {
            if (runtime.destroyed) {
                return false;
            }

            const requestId = ++runtime.requestSeq;
            const offset = runtime.viewStart;
            const limit = runtime.viewSpan;
            const forceRequest = options?.force === true;

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

            const requestCancelKeys = [];
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
                    requestTargets.map((target) => {
                        const cancelKey = `${runtime.selectionKey}|${target.path}`;
                        requestCancelKeys.push(cancelKey);
                        runtime.activeCancelKeys.add(cancelKey);
                        return getFileData(runtime.fileKey, target.path, params, {
                            force: forceRequest,
                            cancelPrevious: true,
                            cancelKey,
                        });
                    })
                );

                if (runtime.destroyed || requestId !== runtime.requestSeq) {
                    return false;
                }

                const baseOutcome = settledResponses[0];
                if (!baseOutcome || baseOutcome.status !== "fulfilled") {
                    const baseError = baseOutcome?.reason;
                    if (baseError?.isAbort || baseError?.code === "ABORTED") {
                        scheduleRecoveryFetch("request interrupted");
                        return false;
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

                if (baseSeries.points.length < 2 && limit >= 2) {
                    scheduleRecoveryFetch("empty response");
                } else {
                    clearRecoveryRetry();
                    runtime.recoveryRetryCount = 0;
                }
                if (baseSeries.points.length >= 2) {
                    rememberLineWindowRender(runtime, {
                        viewStart: offset,
                        viewSpan: limit,
                        basePoints: baseSeries.points,
                        compareSeries,
                        failedCompareTargets: failedTargets,
                        lineStep: runtime.lineStep,
                        qualityApplied: runtime.qualityApplied,
                        requestedPoints: runtime.requestedPoints,
                        returnedPoints: runtime.returnedPoints,
                    });
                }

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
                return true;
            } catch (error) {
                if (runtime.destroyed) {
                    return false;
                }

                if (error?.isAbort || error?.code === "ABORTED") {
                    scheduleRecoveryFetch("request interrupted");
                    return false;
                }

                runtime.failedCompareTargets = [];
                runtime.compareSeries = [];
                updateLegend([], []);
                setMatrixStatus(statusElement, error?.message || "Failed to load line range.", "error");
                scheduleRecoveryFetch("load failed");
                return false;
            } finally {
                requestCancelKeys.forEach((cancelKey) => {
                    runtime.activeCancelKeys.delete(cancelKey);
                });
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

        function cancelInFlightRequests() {
            runtime.activeCancelKeys.forEach((cancelKey) => {
                cancelPendingRequest(cancelKey, "line-runtime-selection-update");
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

        function restoreSelectionViewState(selectionKey) {
            const cachedView = LINE_VIEW_CACHE.get(selectionKey);
            if (!cachedView || typeof cachedView !== "object") {
                return false;
            }

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
            return true;
        }

        async function applySelectionUpdate(nextSelection, options = {}) {
            if (runtime.destroyed || !nextSelection || typeof nextSelection !== "object") {
                return false;
            }

            const nextDisplayDims =
                typeof nextSelection.displayDims === "string" ? nextSelection.displayDims : runtime.displayDims;
            const nextFixedIndices =
                typeof nextSelection.fixedIndices === "string" ? nextSelection.fixedIndices : runtime.fixedIndices;
            const hasLineIndex = Object.prototype.hasOwnProperty.call(nextSelection, "lineIndex");
            const nextLineIndex = hasLineIndex
                ? nextSelection.lineIndex === null
                    ? null
                    : toSafeInteger(nextSelection.lineIndex, runtime.lineIndex)
                : runtime.lineIndex;
            const hasTotalPoints = Object.prototype.hasOwnProperty.call(nextSelection, "totalPoints");
            const nextTotalPoints = hasTotalPoints
                ? Math.max(0, toSafeInteger(nextSelection.totalPoints, runtime.totalPoints))
                : runtime.totalPoints;
            const nextLineDimValue =
                typeof nextSelection.lineDim === "string" ? nextSelection.lineDim : runtime.lineDim;
            const nextLineDim =
                nextLineIndex === null
                    ? null
                    : String(nextLineDimValue || "").trim().toLowerCase() === "col"
                        ? "col"
                        : "row";
            const nextSelectionKey = String(
                nextSelection.selectionKey ||
                buildLineSelectionKey(runtime.fileKey, runtime.path, nextDisplayDims, nextFixedIndices, nextLineIndex)
            );

            const dimsChanged = nextDisplayDims !== runtime.displayDims;
            const fixedChanged = nextFixedIndices !== runtime.fixedIndices;
            const totalPointsChanged = nextTotalPoints !== runtime.totalPoints;
            const lineIndexChanged = nextLineIndex !== runtime.lineIndex;
            const lineDimChanged = nextLineDim !== runtime.lineDim;
            const selectionChanged = nextSelectionKey !== runtime.selectionKey;
            if (
                !dimsChanged &&
                !fixedChanged &&
                !totalPointsChanged &&
                !lineIndexChanged &&
                !lineDimChanged &&
                !selectionChanged
            ) {
                return true;
            }

            const preserveViewState = options.preserveViewState === true && !totalPointsChanged;
            persistViewState();
            if (runtime.fetchTimer !== null) {
                clearTimeout(runtime.fetchTimer);
                runtime.fetchTimer = null;
            }
            runtime.requestSeq += 1;
            cancelInFlightRequests();

            runtime.displayDims = nextDisplayDims || "";
            runtime.fixedIndices = nextFixedIndices || "";
            runtime.totalPoints = Math.max(0, nextTotalPoints);
            runtime.lineIndex = nextLineIndex;
            runtime.lineDim = nextLineDim;
            runtime.selectionKey = nextSelectionKey;
            runtime.minSpan = Math.max(1, Math.min(LINE_MIN_VIEW_SPAN, Math.max(1, runtime.totalPoints)));
            shell.dataset.lineDisplayDims = runtime.displayDims;
            shell.dataset.lineFixedIndices = runtime.fixedIndices;
            shell.dataset.lineTotalPoints = String(runtime.totalPoints);
            shell.dataset.lineIndex =
                runtime.lineIndex === null || runtime.lineIndex === undefined ? "" : String(runtime.lineIndex);
            shell.dataset.lineDim = runtime.lineDim || "";
            shell.dataset.lineSelectionKey = runtime.selectionKey;
            runtime.pendingZoomFocusX = null;

            if (preserveViewState) {
                const preserved = clampViewport(runtime.viewStart, runtime.viewSpan);
                runtime.viewStart = preserved.start;
                runtime.viewSpan = preserved.span;
            } else if (!restoreSelectionViewState(runtime.selectionKey)) {
                runtime.viewStart = 0;
                const reset = clampViewport(0, runtime.totalPoints);
                runtime.viewStart = reset.start;
                runtime.viewSpan = reset.span;
                runtime.zoomFocusX = null;
                runtime.panEnabled = false;
                runtime.zoomClickEnabled = false;
            }

            syncPanState();
            syncZoomClickState();
            updateRangeLabel();
            updateZoomLabel();
            syncWindowControl();
            syncJumpInput();
            hideHover();
            persistViewState();
            setMatrixStatus(statusElement, "Updating line slice...", "info");
            return await fetchLineRange();
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
                }, LINE_SELECTION_UPDATE_DEBOUNCE_MS);
            });
        }

        shell.__lineRuntimeApi = {
            updateSelection(nextSelection, options = {}) {
                return queueSelectionUpdate(nextSelection, options);
            },
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

            const cachedWindow = getLineWindowRender(runtime, runtime.viewStart, runtime.viewSpan);
            if (cachedWindow) {
                applyCachedWindowSnapshot(cachedWindow);
            }

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

        function stopShellEventPropagation(event) {
            if (event?.target instanceof Element && shell.contains(event.target)) {
                event.stopPropagation();
            }
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
        const cachedInitialWindow = getLineWindowRender(runtime);
        if (cachedInitialWindow) {
            applyCachedWindowSnapshot(cachedInitialWindow, {
                statusMessage: "Restored cached line range. Refreshing...",
            });
        } else {
            setMatrixStatus(statusElement, "Loading initial line range...", "info");
        }
        void fetchLineRange();

        shell.addEventListener("click", stopShellEventPropagation);
        shell.addEventListener("change", stopShellEventPropagation);
        shell.addEventListener("input", stopShellEventPropagation);
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
                if (shell.__lineRuntimeApi) {
                    delete shell.__lineRuntimeApi;
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
            clearRecoveryRetry();
            if (runtime.fetchTimer !== null) {
                clearTimeout(runtime.fetchTimer);
                runtime.fetchTimer = null;
            }
            clearPendingSelectionUpdate();
            cancelInFlightRequests();
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
            shell.removeEventListener("click", stopShellEventPropagation);
            shell.removeEventListener("change", stopShellEventPropagation);
            shell.removeEventListener("input", stopShellEventPropagation);
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
            if (shell.__lineRuntimeApi) {
                delete shell.__lineRuntimeApi;
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
        const inlineShellClass = String(config?.inlineShellClass || "heatmap-inline-line-shell").trim();
        return `
    <div
      class="line-chart-shell line-chart-shell-full ${escapeHtml(inlineShellClass)}"
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
        const runtimeNotice = shell.querySelector("[data-heatmap-runtime-notice]");
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
        const previewLayout = shell.closest(".preview-layout");

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
            initialHighResLoading: false,
            controlsLocked: false,
            hasShownFullLoadedNotice: false,
            noticeTimer: null,
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

        function clearRuntimeNoticeTimer() {
            if (runtime.noticeTimer !== null) {
                clearTimeout(runtime.noticeTimer);
                runtime.noticeTimer = null;
            }
        }

        function hideRuntimeNotice() {
            clearRuntimeNoticeTimer();
            if (!runtimeNotice) {
                return;
            }
            runtimeNotice.hidden = true;
            runtimeNotice.textContent = "";
            runtimeNotice.classList.remove("info", "error", "is-visible");
        }

        function setRuntimeNotice(message, options = {}) {
            if (!runtimeNotice) {
                return;
            }
            const text = String(message || "").trim();
            if (!text) {
                hideRuntimeNotice();
                return;
            }
            const tone = options.tone === "error" ? "error" : "info";
            const autoHideMs = Math.max(0, Number(options.autoHideMs) || 0);
            clearRuntimeNoticeTimer();
            runtimeNotice.textContent = text;
            runtimeNotice.hidden = false;
            runtimeNotice.classList.remove("info", "error");
            runtimeNotice.classList.add("is-visible", tone);
            if (autoHideMs > 0) {
                runtime.noticeTimer = setTimeout(() => {
                    runtime.noticeTimer = null;
                    if (runtime.destroyed || runtime.initialHighResLoading) {
                        return;
                    }
                    hideRuntimeNotice();
                }, autoHideMs);
            }
        }

        function buildHighResLoadingNoticeText() {
            return isImageMode ? "Loading full-resolution image..." : "Loading full-resolution heatmap...";
        }

        function buildHighResLoadedNoticeText() {
            return isImageMode ? "Image fully loaded." : "Heatmap fully loaded.";
        }

        function getLockableHeatmapControls() {
            const lockableElements = [];
            const lockRoot = previewLayout || shell.closest(".preview-shell") || shell.parentElement;
            const lockableSelectors = [
                "[data-display-dim-select]",
                "[data-fixed-index-range]",
                "[data-fixed-index-number]",
                "[data-fixed-index-play-action]",
                "[data-dim-apply]",
                "[data-dim-reset]",
                "[data-heatmap-pan-toggle]",
                "[data-heatmap-plot-toggle]",
                "[data-heatmap-intensity-toggle]",
                "[data-heatmap-zoom-in]",
                "[data-heatmap-zoom-out]",
                "[data-heatmap-reset-view]",
                "[data-heatmap-fullscreen-toggle]",
                "[data-heatmap-plot-close]",
                "[data-heatmap-plot-axis]",
            ];
            if (!lockRoot) {
                return lockableElements;
            }
            lockRoot.querySelectorAll(lockableSelectors.join(",")).forEach((element) => {
                if (
                    element instanceof HTMLButtonElement ||
                    element instanceof HTMLInputElement ||
                    element instanceof HTMLSelectElement
                ) {
                    lockableElements.push(element);
                }
            });
            return lockableElements;
        }

        function setHeatmapControlsLocked(locked) {
            const nextLocked = locked === true;
            runtime.controlsLocked = nextLocked;
            shell.classList.toggle("is-highres-loading", nextLocked);
            canvasHost.classList.toggle("is-disabled", nextLocked);
            canvasHost.setAttribute("aria-disabled", nextLocked ? "true" : "false");
            if (nextLocked) {
                if (!canvasHost.hasAttribute("data-prev-tabindex")) {
                    canvasHost.setAttribute("data-prev-tabindex", canvasHost.getAttribute("tabindex") || "");
                }
                canvasHost.setAttribute("tabindex", "-1");
            } else if (canvasHost.hasAttribute("data-prev-tabindex")) {
                const previousTabIndex = canvasHost.getAttribute("data-prev-tabindex");
                canvasHost.removeAttribute("data-prev-tabindex");
                if (previousTabIndex) {
                    canvasHost.setAttribute("tabindex", previousTabIndex);
                } else {
                    canvasHost.removeAttribute("tabindex");
                }
            }

            getLockableHeatmapControls().forEach((control) => {
                if (nextLocked) {
                    if (!control.hasAttribute("data-runtime-prev-disabled")) {
                        control.setAttribute("data-runtime-prev-disabled", control.disabled ? "1" : "0");
                    }
                    control.disabled = true;
                } else if (control.hasAttribute("data-runtime-prev-disabled")) {
                    control.disabled = control.getAttribute("data-runtime-prev-disabled") === "1";
                    control.removeAttribute("data-runtime-prev-disabled");
                }
            });
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
            runtime.hasShownFullLoadedNotice = runtime.loadedPhase === "highres";

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
            const lockControls = options && options.lockControls === true;
            const announceLoaded = options && options.announceLoaded === true;
            const loadToken = ++runtime.loadSequence;
            let loaded = false;
            if (lockControls) {
                runtime.initialHighResLoading = true;
                setHeatmapControlsLocked(true);
                setRuntimeNotice(buildHighResLoadingNoticeText(), { tone: "info" });
            }
            try {
                if (forceFullLoad) {
                    const fullResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading full resolution...", {
                        preserveViewState,
                        loadToken,
                    });
                    loaded = fullResult.loaded === true;
                    return loaded;
                }
                // Progressive loading: fast preview first (256), then full resolution (1024)
                const PREVIEW_SIZE = 256;
                const previewResult = await fetchHeatmapAtSize(PREVIEW_SIZE, "Loading heatmap preview...", {
                    preserveViewState,
                    loadToken,
                });
                if (runtime.destroyed || loadToken !== runtime.loadSequence) {
                    loaded = false;
                    return false;
                }
                if (previewResult.loaded && HEATMAP_MAX_SIZE > PREVIEW_SIZE) {
                    // Small delay so the user sees the preview before the full load starts
                    await new Promise((r) => setTimeout(r, 50));
                    if (runtime.destroyed || loadToken !== runtime.loadSequence) {
                        loaded = false;
                        return false;
                    }
                    const fullResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading full resolution...", {
                        preserveViewState,
                        loadToken,
                    });
                    loaded = fullResult.loaded === true;
                    return loaded;
                } else if (!previewResult.loaded) {
                    // Fallback: try full size directly
                    const fallbackResult = await fetchHeatmapAtSize(HEATMAP_MAX_SIZE, "Loading high-res heatmap...", {
                        preserveViewState,
                        loadToken,
                    });
                    loaded = fallbackResult.loaded === true;
                    return loaded;
                }
                loaded = previewResult.loaded === true;
                return loaded;
            } finally {
                if (lockControls) {
                    runtime.initialHighResLoading = false;
                    setHeatmapControlsLocked(false);
                    if (runtime.destroyed) {
                        hideRuntimeNotice();
                    } else if (loaded && announceLoaded && !runtime.hasShownFullLoadedNotice) {
                        runtime.hasShownFullLoadedNotice = true;
                        setRuntimeNotice(buildHighResLoadedNoticeText(), {
                            tone: "info",
                            autoHideMs: 2200,
                        });
                    } else {
                        hideRuntimeNotice();
                    }
                }
            }
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
            void loadHighResHeatmap({
                lockControls: true,
                announceLoaded: true,
            });
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
            hideRuntimeNotice();
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
    if (typeof renderLinkedLineShellMarkup !== "undefined") {
        moduleState.renderLinkedLineShellMarkup = renderLinkedLineShellMarkup;
        global.renderLinkedLineShellMarkup = renderLinkedLineShellMarkup;
    }
    if (typeof renderLinkedLinePanelMarkup !== "undefined") {
        moduleState.renderLinkedLinePanelMarkup = renderLinkedLinePanelMarkup;
        global.renderLinkedLinePanelMarkup = renderLinkedLinePanelMarkup;
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



// Viewer HTML module: Bootstraps viewer lifecycle, validates dependencies, parses deep links, and wires state-driven rendering.
(function (global) {
    "use strict";

    var ns = global.HDFViewer;
    if (!ns) {
        console.error("[HDFViewer] Missing namespace for app-viewer.");
        return;
    }

    var ensurePath = ns.core && ns.core.ensurePath;
    if (typeof ensurePath !== "function") {
        console.error("[HDFViewer] Missing core.ensurePath before loading app-viewer.");
        return;
    }

    // Main startup module for the bundled single-page viewer.
    var moduleState = ensurePath(ns, "app.viewerBoot");
    // Grab the main viewer root once. If this is missing, the app cannot render anything.
    var root = document.getElementById("viewer-app");
    // renderQueued prevents multiple requestAnimationFrame calls stacking up before a render fires
    var renderQueued = false;

    // Displays a fatal error message in the global status bar when boot fails
    function setBootFailureStatus(message) {
        var statusNode = document.getElementById("global-status");
        if (!statusNode) {
            return;
        }

        statusNode.textContent = String(message || "Viewer bootstrap failed.");
        statusNode.classList.remove("info");
        statusNode.classList.add("error");
    }

    // Resolves the actions object from either the local `actions` variable or the namespace
    function resolveActions() {
        if (typeof actions !== "undefined" && actions && typeof actions === "object") {
            return actions;
        }
        if (ns.state && ns.state.actions && typeof ns.state.actions === "object") {
            return ns.state.actions;
        }
        return {};
    }

    // Quick safety check before boot. Stop early if the required JS pieces are missing.
    function verifyRuntimeDependencies() {
        var missingGlobals = [];

        if (typeof getState !== "function") {
            missingGlobals.push("getState");
        }
        if (typeof subscribe !== "function") {
            missingGlobals.push("subscribe");
        }
        if (typeof renderViewerView !== "function") {
            missingGlobals.push("renderViewerView");
        }
        if (typeof bindViewerViewEvents !== "function") {
            missingGlobals.push("bindViewerViewEvents");
        }

        var missingModules = [];
        // This list must match every module that registers itself via ns.core.registerModule
        var requiredModules = [
            "core/namespace",
            "core/config",
            "core/domRefs",
            "utils/format",
            "api/client",
            "api/contracts",
            "api/hdf5Service",
            "state/store",
            "state/reducers",
            "components/sidebarTree",
            "components/viewerPanel",
            "views/viewerView",
        ];

        if (ns.core && typeof ns.core.requireModules === "function") {
            var requirement = ns.core.requireModules(requiredModules, "app-viewer");
            if (!requirement.ok) {
                missingModules = requirement.missing || [];
            }
        }

        var hasRoot = !!root;
        if (!hasRoot) {
            missingGlobals.push("#viewer-app");
        }

        if (missingGlobals.length > 0 || missingModules.length > 0) {
            console.error("[HDFViewer] Runtime dependency check failed.", {
                missingGlobals: missingGlobals,
                missingModules: missingModules,
            });
            return {
                ok: false,
                missingGlobals: missingGlobals,
                missingModules: missingModules,
            };
        }

        return {
            ok: true,
            missingGlobals: [],
            missingModules: [],
        };
    }

    // Schedules a render on the next animation frame; skips if one is already queued
    function queueRender() {
        if (renderQueued) {
            return;
        }

        renderQueued = true;
        var schedule =
            typeof window !== "undefined" && window.requestAnimationFrame
                ? window.requestAnimationFrame.bind(window)
                : function (cb) {
                    return setTimeout(cb, 16);
                };

        schedule(function () {
            renderQueued = false;
            renderApp();
        });
    }

    // Paint the latest app state into the fixed HTML shell and wire events again.
    function renderApp() {
        if (!root) {
            return;
        }

        if (typeof getState !== "function" || typeof renderViewerView !== "function") {
            return;
        }

        var state = getState();
        var missingFile = state && state.viewerBlocked === true;

        renderViewerView(state, {
            missingFile: missingFile,
            deepLinkExample: "?file=<url-encoded-object-key>",
        });

        // Rebind events after innerHTML updates so interaction still works on fresh DOM nodes
        if (typeof bindViewerViewEvents === "function") {
            bindViewerViewEvents(root, resolveActions());
        }
    }

    // Main startup flow: validate the page, hook listeners, open the file from URL, then render.
    async function bootstrapApp() {
        // Step 1: verify all modules and globals are available
        var deps = verifyRuntimeDependencies();
        if (!deps.ok) {
            setBootFailureStatus("Viewer bootstrap failed: missing runtime dependencies.");
            return;
        }

        // Step 2: verify all required DOM IDs are present in the HTML shell
        if (typeof validateViewerDomIds === "function") {
            var validation = validateViewerDomIds(document);
            if (!validation.ok) {
                setBootFailureStatus(
                    "Viewer bootstrap failed: missing required DOM IDs (" +
                    validation.missing.join(", ") +
                    ")."
                );
                return;
            }
        }

        // Step 3: run any async template init hooks (currently a no-op, reserved for future use)
        if (typeof initViewerViewTemplate === "function") {
            await Promise.allSettled([initViewerViewTemplate()]);
        }

        // Step 4: subscribe the render loop to state changes
        if (typeof subscribe === "function") {
            subscribe(queueRender);
        }

        var actionsApi = resolveActions();

        // Step 5: set up responsive sidebar collapse on narrow viewports (tablet/mobile)
        var mql = window.matchMedia("(max-width: 1024px)");

        function handleViewportChange(e) {
            if (typeof actionsApi.setSidebarOpen === "function") {
                actionsApi.setSidebarOpen(!e.matches);
            }
        }

        if (mql.addEventListener) {
            mql.addEventListener("change", handleViewportChange);
        } else if (mql.addListener) {
            mql.addListener(handleViewportChange);
        }

        // Collapse sidebar immediately if we are already on a narrow viewport
        if (mql.matches && typeof actionsApi.setSidebarOpen === "function") {
            actionsApi.setSidebarOpen(false);
        }

        // Step 6: parse ?file= query parameter for deep-link file opening
        var params = new URLSearchParams(location.search);
        var deepLinkKey = params.get("file");
        var hasFile = Boolean(deepLinkKey);

        if (hasFile && typeof actionsApi.openViewer === "function") {
            // // Remove ?file= from the browser URL bar to keep it clean after boot
            // history.replaceState({}, "", location.pathname);
            actionsApi.openViewer({
                key: deepLinkKey,
                etag: null,
            });

            if (typeof actionsApi.loadFiles === "function") {
                void actionsApi.loadFiles();
            }
        } else {
            if (typeof actionsApi.goHome === "function") {
                actionsApi.goHome();
            }
            if (typeof clearViewerRuntimeBindings === "function") {
                clearViewerRuntimeBindings();
            }
        }

        renderApp();
    }

    // Start the viewer as soon as this script loads.
    void bootstrapApp();

    moduleState.queueRender = queueRender;
    moduleState.renderApp = renderApp;
    moduleState.bootstrapApp = bootstrapApp;
    moduleState.verifyRuntimeDependencies = verifyRuntimeDependencies;

    global.queueRender = queueRender;
    global.renderApp = renderApp;
    global.bootstrapApp = bootstrapApp;
    global.verifyRuntimeDependencies = verifyRuntimeDependencies;

    if (ns.core && typeof ns.core.registerModule === "function") {
        ns.core.registerModule("app-viewer");
    }
})(typeof window !== "undefined" ? window : globalThis);

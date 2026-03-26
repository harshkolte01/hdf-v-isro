import './viewer-core.js';

// Viewer HTML module: Wraps fetch with abort linking, in-flight cancellation keys, and normalized API errors.
function init_viewer_api_1() {
    const global = window;
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

    function toUserFacingApiMessage(message) {
        const text = String(message || "").trim();
        if (!text) {
            return "";
        }

        const normalized = text.toLowerCase();
        if (normalized.includes("file signature not found")) {
            return "HDF4 files are not supported.";
        }

        return text;
    }

    // Extracts the most useful error message from the response payload and wraps it in ApiError
    function createErrorFromResponse({ response, payload, url, method }) {
        const messageFromPayload =
            payload && typeof payload === "object"
                ? payload.error || payload.message || null
                : typeof payload === "string"
                    ? payload
                    : null;

        const userMessage = toUserFacingApiMessage(messageFromPayload);

        return new ApiError({
            message: userMessage || `HTTP ${response.status}`,
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
}
init_viewer_api_1();



// Viewer HTML module: Normalizes backend payloads into predictable frontend contracts for files, tree, meta, preview, and data.
function init_viewer_api_2() {
    const global = window;
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
            const message = toUserFacingApiMessage(payload.error) || `${operation} failed`;
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
}
init_viewer_api_2();



// Viewer HTML module: Implements cached HDF5 API operations for files, tree, metadata, preview, and mode-specific data fetches.
function init_viewer_api_3() {
    const global = window;
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
}
init_viewer_api_3();




export const HDFViewer = window.HDFViewer;
export const ViewerApi = window.HDFViewer?.api ?? {};
export default ViewerApi;

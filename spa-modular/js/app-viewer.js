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

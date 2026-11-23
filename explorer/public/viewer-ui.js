/*
 * A link's 3D page, around the scene (viewer/scene.js, an ES module that calls ExplorerViewer.start once three.js
 * and Spark have loaded): the switch between the task's types, the loading status and the failure messages, the
 * bar's controls (viewer-controls.js), the Background menu, and the point cloud's Point Size and Colour by Elevation
 * with its legend.
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    var helpers = node ? require("./linkpage.js") : window.ExplorerLinkPage;
    var Controls = node ? require("./viewer-controls.js") : window.ExplorerControls;
    var Layers = node ? require("./layers.js") : window.ExplorerLayers;
    var SIZE_KEY = "explorer-cloud-size";
    var COLOUR_KEY = "explorer-cloud-colour";
    var BACKGROUND_KEY = "explorer-background";
    // In the menu's order; the first is the default (the user, 2026-11-22)
    var BACKGROUNDS = ["grid", "sky", "space", "plain"];

    function remembered(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function remember(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* not kept */ }
    }

    // The point cloud's panel: Point Size and Colour, remembered in the browser, and the elevation legend in the unit
    // chosen on a map's legend (m or ft)
    function cloudPanel(page, scene) {
        var panel = page.querySelector("[data-cloud-panel]");
        if (!panel) return {show: function () {}};
        var size = panel.querySelector("[data-point-size]");
        var colour = panel.querySelector("[data-cloud-colour]");
        var legend = panel.querySelector("[data-cloud-legend]");
        var unit = legend.querySelector("[data-unit]");
        legend.querySelector(".explorer-legend-ramp").style.background = Layers.rampCss(Layers.VIRIDIS);
        var savedSize = parseFloat(remembered(SIZE_KEY));
        if (savedSize >= parseFloat(size.min) && savedSize <= parseFloat(size.max)) size.value = String(savedSize);
        if (remembered(COLOUR_KEY) === "elevation") colour.value = "elevation";

        function drawLegend() {
            var range = scene.cloudRange();
            legend.hidden = colour.value !== "elevation" || !range;
            if (legend.hidden) return;
            var choices = Layers.units("dsm");
            var key = Layers.UNITS_KEY + "elevation";
            var index = Math.max(0, choices.map(function (u) { return u.label; }).indexOf(remembered(key)));
            legend.querySelector("[data-min]").textContent = Layers.number(range[0], choices[index]);
            legend.querySelector("[data-max]").textContent = Layers.number(range[1], choices[index]);
            unit.textContent = choices[index].label;
            unit.onclick = function () {
                remember(key, choices[(index + 1) % choices.length].label);
                drawLegend();
            };
        }
        function apply() {
            scene.setCloudStyle({size: parseFloat(size.value), colour: colour.value});
            drawLegend();
        }
        size.addEventListener("input", function () {
            remember(SIZE_KEY, size.value);
            apply();
        });
        colour.addEventListener("change", function () {
            remember(COLOUR_KEY, colour.value);
            apply();
        });
        // Dragging the slider shouldn't orbit the model under it
        ["pointerdown", "wheel", "dblclick"].forEach(function (name) {
            panel.addEventListener(name, function (e) { e.stopPropagation(); });
        });
        apply();
        return {
            show: function (on) {
                panel.hidden = !on;
                if (on) drawLegend();
            }
        };
    }

    function backgroundChoice(saved) {
        return BACKGROUNDS.indexOf(saved) >= 0 ? saved : BACKGROUNDS[0];
    }

    // The Background menu: Grid, Sky, Space or Plain behind the model, remembered in the browser. Returns {next()},
    // for the B key.
    function backgroundMenu(page, scene) {
        var items = page.querySelectorAll("[data-background]");
        var chosen = backgroundChoice(remembered(BACKGROUND_KEY));

        function choose(kind) {
            chosen = kind;
            scene.setBackground(kind);
            for (var i = 0; i < items.length; i++) {
                var on = items[i].getAttribute("data-background") === kind;
                items[i].setAttribute("aria-checked", on ? "true" : "false");
                items[i].parentNode.classList.toggle("active", on);
            }
        }
        function pick(kind) {
            remember(BACKGROUND_KEY, kind);
            choose(kind);
        }
        for (var i = 0; i < items.length; i++) {
            items[i].addEventListener("click", function (e) {
                e.preventDefault();
                pick(e.currentTarget.getAttribute("data-background"));
            });
        }
        choose(chosen);
        return {
            next: function () { pick(BACKGROUNDS[(BACKGROUNDS.indexOf(chosen) + 1) % BACKGROUNDS.length]); }
        };
    }

    // The address keeps the type shown, so Back and reloading open it again
    function keepType(type) {
        if (!window.history || !window.history.replaceState) return;
        try {
            var url = new URL(window.location.href);
            url.searchParams.set("t", type);
            window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
        } catch (e) { /* the address stays */ }
    }
    // The scene module not starting by then means it couldn't load (an old browser without import maps)
    var START_TIMEOUT = 30000;

    // As WebODM's Utils.isIOS and isMobile, so the GLB is the size WebODM's own 3D page would pick
    function platform(userAgent, touch) {
        if (/(iPad)|(iPhone)|(iPod)/i.test(userAgent) || (/Mac/i.test(userAgent) && touch)) return "ios";
        if (/(android)|(webOS)/i.test(userAgent)) return "mobile";
        return "";
    }

    // Points drawn at most, as WebODM's own 3D page sets Potree's budget (ModelView.jsx)
    function pointBudget(kind) {
        if (kind === "ios") return 1000 * 1000;
        if (kind === "mobile") return 2 * 1000 * 1000;
        return 10 * 1000 * 1000;
    }

    // Bytes of mesh tiles kept in memory: lower on phones, as the point budget
    function tilesMemory(kind) {
        if (kind === "ios") return 96 * 1024 * 1024;
        if (kind === "mobile") return 192 * 1024 * 1024;
        return 512 * 1024 * 1024;
    }

    // How long the note that a faster view is being prepared stays
    var NOTE_MS = 8000;
    // A failed node or tile checks the link with the server: one check at a time, at most this often unless the server
    // answered 404 (a revoked link), and none once the link is known to be gone
    var CHECK_MS = 10000;

    function meshUrl(url, kind) {
        return kind ? url + "?platform=" + kind : url;
    }

    function create(page, options) {
        var line = helpers.status(page.querySelector(".explorer-status"));
        var switches = page.querySelectorAll("[data-type]");
        var kind = platform(options.userAgent, options.touch);
        var started = false;
        var current = null;
        var timer = setTimeout(function () {
            if (!started) line.show(page.getAttribute("data-error"));
        }, START_TIMEOUT);

        // The mesh's data-url is its tiles when they are built (data-fallback: WebODM's GLB), else the GLB
        function urlFor(button) {
            var url = button.getAttribute("data-url");
            var tiled = button.hasAttribute("data-fallback");
            return button.getAttribute("data-type") === "mesh" && !tiled ? meshUrl(url, kind) : url;
        }

        function fallbackFor(button) {
            var url = button.getAttribute("data-fallback");
            return url ? meshUrl(url, kind) : null;
        }

        function start(scene) {
            started = true;
            viewer.scene = scene;
            clearTimeout(timer);
            var fit = helpers.fitHeight(page.querySelector(".explorer-scene"), scene.resize);
            var background = backgroundMenu(page, scene);
            var controls = Controls.init(page, {reset: function () { scene.reset(); }, resize: fit,
                keys: {b: background.next}});
            var panel = cloudPanel(page, scene);
            if (scene.watchContext) {
                scene.watchContext(function () {
                    line.show(page.getAttribute("data-context-lost"));
                }, function () {
                    if (line.text() === page.getAttribute("data-context-lost")) line.hide();
                    // The view chosen, shown again (opened again where the lost context took it)
                    for (var i = 0; i < switches.length; i++) {
                        if (switches[i].getAttribute("data-type") === current) select(switches[i]);
                    }
                });
            }
            var lastCheck = -Infinity, checking = false, gone = false;
            function checkLink(type, status) {
                var now = Date.now();
                if (gone || checking || (status !== 404 && now - lastCheck < CHECK_MS)) return;
                lastCheck = now;
                checking = true;
                helpers.linkIsValid(page.getAttribute("data-link")).then(function (valid) {
                    checking = false;
                    gone = !valid;
                    if (!valid && current === type) line.show(page.getAttribute("data-invalid"));
                });
            }

            function select(button) {
                var type = button.getAttribute("data-type");
                current = type;
                controls.setView(type);
                keepType(type);
                panel.show(false);
                for (var i = 0; i < switches.length; i++) {
                    var on = switches[i] === button;
                    switches[i].setAttribute("aria-pressed", on ? "true" : "false");
                    switches[i].classList.toggle("active", on);
                }
                var loading = page.getAttribute("data-loading");
                line.show(loading);
                scene.show(type, urlFor(button), function (fraction) {
                    if (current === type && fraction !== null) line.show(loading + " " + Math.round(fraction * 100) + "%");
                }, function (status) {
                    // A point cloud node or a tile failed once the view was open: say so only if the link is gone
                    checkLink(type, status);
                }, fallbackFor(button)).then(function () {
                    if (current !== type) return;
                    panel.show(type === "cloud");
                    if (!button.hasAttribute("data-preparing")) return line.hide();
                    // The GLB shows while the tiles are built: say a faster view comes next time
                    line.show(page.getAttribute("data-preparing"));
                    setTimeout(function () {
                        if (current === type && line.text() === page.getAttribute("data-preparing")) line.hide();
                    }, NOTE_MS);
                }, function () {
                    if (current === type) helpers.explainFailure(page, line);
                });
            }

            var initial = switches[0];
            for (var i = 0; i < switches.length; i++) {
                switches[i].addEventListener("click", function (e) { select(e.currentTarget); });
                if (switches[i].getAttribute("data-type") === page.getAttribute("data-initial")) initial = switches[i];
            }
            if (initial) select(initial);
        }

        function fail() {
            started = true;
            clearTimeout(timer);
            line.show(page.getAttribute("data-no-webgl"));
        }

        var viewer = {start: start, fail: fail, pointBudget: pointBudget(kind), tilesMemory: tilesMemory(kind), small: !!kind,
            scene: null};
        return viewer;
    }

    if (node) {
        module.exports = {create: create, platform: platform, meshUrl: meshUrl, pointBudget: pointBudget,
            tilesMemory: tilesMemory, keepType: keepType, backgroundChoice: backgroundChoice, BACKGROUND_KEY: BACKGROUND_KEY};
    } else {
        var page = document.querySelector("[data-explorer-viewer]");
        if (page) {
            window.ExplorerViewer = create(page, {userAgent: navigator.userAgent, touch: "ontouchend" in document});
        }
    }
})();

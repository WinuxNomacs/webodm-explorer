/*
 * The map page's Measure tool (upcoming-changes.md, "Plan: measurement tools"): Length, Area and Point, drawn on the
 * map by click or tap. Lengths and areas are geodesics on WGS84 with GeographicLib (Karney's method, as PROJ's), in
 * the browser; an area's volume is WebODM's own (its Measure plugin's job, in WebODM's worker); a point's elevations
 * are read from the task's DSM and DTM by Explorer's view. Units follow the legend's switch (metric or imperial).
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    // GeographicLib, on the map page only (the 3D page measures in the task's grid: measure3d.js)
    var geodesic = node ? require("./vendor/geographiclib-geodesic-2.2.0/geographiclib-geodesic.min.js") : window.geodesic;
    var WGS84 = geodesic ? geodesic.Geodesic.WGS84 : null;
    var UNITS_KEY = "explorer-units-elevation";
    var METHOD_KEY = "explorer-volume-method";
    var METHODS = ["triangulate", "plane", "average", "highest", "lowest"];
    var POLL_MS = 1000;
    var DEADLINE_MS = 120000;  // as long as a link's job holds its place (measure.py VOLUME_SECONDS)
    var FOOT = 0.3048;
    var YARD3 = 0.9144 * 0.9144 * 0.9144;
    var ACRE = 4046.8564224;
    var MILE = 1609.344;

    function remembered(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function remember(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* not kept */ }
    }

    // points: [[lat, lng], ...]. The path's length in metres, segment by segment along the ellipsoid
    function pathLength(points) {
        var total = 0;
        for (var i = 1; i < points.length; i++) {
            total += WGS84.Inverse(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], geodesic.Geodesic.DISTANCE).s12;
        }
        return total;
    }

    // The polygon the points close: {area: m2, perimeter: m}; edges are geodesics
    function polygonArea(points) {
        var polygon = WGS84.Polygon(false);
        points.forEach(function (p) { polygon.AddPoint(p[0], p[1]); });
        var result = polygon.Compute(false, true);
        return {area: Math.abs(result.area), perimeter: result.perimeter};
    }

    function isImperial() {
        return remembered(UNITS_KEY) === "ft";
    }

    function number(value, digits) {
        return value.toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits});
    }

    // Each value in the unit system the legend chose: metres, or feet (miles past one)
    function formatLength(metres, imperial) {
        if (imperial) {
            return metres >= MILE ? number(metres / MILE, 3) + " mi" : number(metres / FOOT, 2) + " ft";
        }
        return metres >= 1000 ? number(metres / 1000, 3) + " km" : number(metres, 2) + " m";
    }

    function formatArea(m2, imperial) {
        if (imperial) {
            return m2 >= ACRE ? number(m2 / ACRE, 3) + " ac" : number(m2 / (FOOT * FOOT), 2) + " ft²";
        }
        return m2 >= 10000 ? number(m2 / 10000, 4) + " ha" : number(m2, 2) + " m²";
    }

    function formatVolume(m3, imperial) {
        return imperial ? number(m3 / YARD3, 2) + " yd³" : number(m3, 2) + " m³";
    }

    function formatHeight(metres, imperial) {
        return imperial ? number(metres / FOOT, 2) + " ft" : number(metres, 2) + " m";
    }

    function chosenMethod() {
        var saved = remembered(METHOD_KEY);
        return METHODS.indexOf(saved) >= 0 ? saved : "triangulate";
    }

    // GeoJSON for WebODM's volume view: a Feature whose polygon's ring is [lng, lat] pairs, closed
    function areaFeature(points) {
        var ring = points.map(function (p) { return [p[1], p[0]]; });
        ring.push(ring[0]);
        return {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [ring]}};
    }

    function failure(status, message) {
        var error = new Error(message || "");
        error.status = status;
        return error;
    }

    function readJson(response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
            if (!response.ok) throw failure(response.status, data && (data.error || data.detail));
            return data;
        });
    }

    // WebODM's volume: start the job, then ask for its result until it is in or the deadline passes.
    // ctx: {fetch, csrf, volume: {start, result}, wait(ms) -> Promise, now() -> ms}. Resolves to cubic metres.
    function measureVolume(ctx, points, method, isCurrent) {
        var started = ctx.now();
        return ctx.fetch(ctx.volume.start, {
            method: "POST", credentials: "same-origin",
            headers: {"Content-Type": "application/json", "Accept": "application/json", "X-CSRFToken": ctx.csrf},
            body: JSON.stringify({area: areaFeature(points), method: method})
        }).then(readJson).then(function (data) {
            if (data.error || !data.celery_task_id) throw failure(200, data.error);
            var job = data.celery_task_id;
            function poll() {
                if (isCurrent && !isCurrent()) return Promise.reject(failure(0, "stale"));
                return ctx.fetch(ctx.volume.result + encodeURIComponent(job), {credentials: "same-origin", headers: {"Accept": "application/json"}})
                    .then(readJson).then(function (result) {
                        if (result.error === "Task not ready") {
                            if (ctx.now() - started >= DEADLINE_MS) throw failure(0, "timeout");
                            return ctx.wait(POLL_MS).then(poll);
                        }
                        if (result.error) throw failure(200, result.error);
                        var value = parseFloat(result.output);
                        if (!isFinite(value)) throw failure(200, "");
                        return value;
                    });
            }
            return poll();
        });
    }

    function el(tag, className, text) {
        var element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function button(text, iconClass, attribute) {
        var b = el("button", "btn btn-default btn-sm");
        b.type = "button";
        if (iconClass) {
            var i = el("i", "fa " + iconClass);
            i.setAttribute("aria-hidden", "true");
            b.appendChild(i);
            b.appendChild(document.createTextNode(" "));
        }
        b.appendChild(document.createTextNode(text));
        if (attribute) b.setAttribute(attribute, "");
        return b;
    }


    // The 3D page's measurements, in the scene's coordinates (the task's projected grid, minus WebODM's offset in x and
    // y; heights as they are). Horizontal parts are divided by the grid's scale factor at the model (`scale`), so they
    // are lengths on the ground, as the map's geodesics; heights need no correction. Points are [x, y, z].
    function ground(p, scale) {
        return [p[0] / scale, p[1] / scale, p[2]];
    }

    function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
    function norm(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }

    // {length (3D), horizontal, vertical (b's height less a's), slope (degrees, and percent: null when vertical)}
    function distance3d(a, b, scale) {
        var d = sub(ground(b, scale), ground(a, scale));
        var horizontal = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
        return {length: norm(d), horizontal: horizontal, vertical: d[2],
            degrees: Math.atan2(Math.abs(d[2]), horizontal) * 180 / Math.PI,
            percent: horizontal > 0 ? Math.abs(d[2]) / horizontal * 100 : null};
    }

    // {horizontal: m2 seen from above, sloped: m2 on the plane through the points (Newell's normal: exact for a flat
    // shape, the best plane's for one that isn't), perimeter: m along its 3D edges}
    function area3d(points, scale) {
        var pts = points.map(function (p) { return ground(p, scale); });
        var n = [0, 0, 0], perimeter = 0;
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[(i + 1) % pts.length];
            n[0] += (a[1] - b[1]) * (a[2] + b[2]);
            n[1] += (a[2] - b[2]) * (a[0] + b[0]);
            n[2] += (a[0] - b[0]) * (a[1] + b[1]);
            perimeter += norm(sub(b, a));
        }
        return {horizontal: Math.abs(n[2]) / 2, sloped: norm(n) / 2, perimeter: perimeter};
    }

    // The angle at b between a and c, in degrees
    function angle3d(a, b, c, scale) {
        var u = sub(ground(a, scale), ground(b, scale)), v = sub(ground(c, scale), ground(b, scale));
        var cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (norm(u) * norm(v));
        return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    }

    // Each mode: the points it takes (min, and max where it finishes by itself), whether it is one point, its icon
    var MODES = {
        length: {min: 2, icon: "fa-ruler"},
        area: {min: 3, icon: "fa-draw-polygon", closed: true},
        point: {single: true, icon: "fa-map-marker-alt"},
        distance: {min: 2, max: 2, icon: "fa-ruler"},
        angle: {min: 3, max: 3, icon: "fa-drafting-compass"}
    };

    function samePoint(a, b) {
        return a && b && a.length === b.length && a.every(function (v, i) { return v === b[i]; });
    }

    /*
     * The Measure tool's panel and drawing, on any surface (the map, the 3D scene). opts: {page, view, toggle, texts,
     * modes, surface, method: whether the Volume Base menu is offered}. The surface: {start(handlers: click(point),
     * finish(), move(point)), stop(), draw(state), rows(state, imperial) -> [[label, value, className]], hint(state),
     * clicked(state, point) (a point mode's click), finished(state) (a shape just finished), method(state) (the Volume
     * Base menu shown), methodChanged(state)}. Returns the tool, with render() for the surface's late answers.
     */
    function create(opts) {
        var page = opts.page, view = opts.view, toggle = opts.toggle, texts = opts.texts, surface = opts.surface;
        var modes = opts.modes;
        var state = {on: false, mode: modes[0], points: [], done: false, job: 0, cursor: null, message: null};
        var panel = null, parts = null;
        var tool = {};

        function buildPanel() {
            panel = el("div", "explorer-measure theme-secondary theme-border-secondary-07");
            panel.setAttribute("role", "region");
            panel.setAttribute("aria-label", texts.measure);
            var tabs = el("div", "btn-group btn-group-sm explorer-measure-modes");
            tabs.setAttribute("role", "group");
            var tabButtons = {};
            modes.forEach(function (mode) {
                var b = button(texts[mode], MODES[mode].icon);
                b.setAttribute("data-mode", mode);
                b.addEventListener("click", function () { setMode(mode); });
                tabButtons[mode] = b;
                tabs.appendChild(b);
            });
            var hint = el("p", "explorer-measure-hint");
            var results = el("dl", "explorer-measure-results");
            results.setAttribute("aria-live", "polite");
            var method = el("label", "explorer-measure-method");
            var select = el("select", "form-control input-sm");
            if (opts.method) {
                method.appendChild(document.createTextNode(texts.base + " "));
                METHODS.forEach(function (m) {
                    var option = el("option", null, texts.methods[m]);
                    option.value = m;
                    select.appendChild(option);
                });
                select.value = chosenMethod();
                select.addEventListener("change", function () {
                    remember(METHOD_KEY, select.value);
                    if (surface.methodChanged) surface.methodChanged(state);
                });
                method.appendChild(select);
            }
            var actions = el("div", "explorer-measure-actions");
            var undo = button(texts.undo, "fa-undo", "data-undo");
            var finish = button(texts.finish, "fa-check", "data-finish");
            var clear = button(texts.clear, "fa-eraser", "data-clear");
            undo.addEventListener("click", undoPoint);
            finish.addEventListener("click", finishShape);
            clear.addEventListener("click", function () { cancel(); reset(); });
            actions.appendChild(undo);
            actions.appendChild(finish);
            actions.appendChild(clear);
            // The 3D page has no legend on every view: the panel switches the units itself (the same choice as the
            // legends', which follow it)
            var units = null;
            if (opts.units) {
                units = button("", null, "data-units");
                units.setAttribute("title", texts.units);
                units.addEventListener("click", function () {
                    remember(UNITS_KEY, isImperial() ? "m" : "ft");
                    page.dispatchEvent(new window.CustomEvent("explorer-units"));
                });
                actions.appendChild(units);
            }
            // Close in the theme's button colours (Bootstrap's .close is a faint black on any theme)
            var close = button("", "fa-times");
            close.className += " explorer-measure-close";
            close.setAttribute("aria-label", texts.close);
            close.setAttribute("title", texts.close);
            close.addEventListener("click", off);
            var top = el("div", "explorer-measure-top");
            tabs.style.flex = "1 1 auto";
            top.appendChild(tabs);
            top.appendChild(close);
            panel.appendChild(top);
            panel.appendChild(hint);
            panel.appendChild(results);
            panel.appendChild(method);
            panel.appendChild(actions);
            // Clicks and drags on the panel are not the view's
            ["mousedown", "touchstart", "dblclick", "click", "wheel", "pointerdown", "pointerup"].forEach(function (name) {
                panel.addEventListener(name, function (e) { e.stopPropagation(); });
            });
            parts = {tabs: tabButtons, hint: hint, results: results, method: method, select: select, undo: undo, finish: finish,
                clear: clear, units: units};
            view.appendChild(panel);
        }

        // The panel says what the drawing measures, in the units chosen now
        function render() {
            if (!panel) return;
            var imperial = isImperial();
            var mode = MODES[state.mode];
            Object.keys(parts.tabs).forEach(function (m) {
                var on = m === state.mode;
                parts.tabs[m].classList.toggle("active", on);
                parts.tabs[m].setAttribute("aria-pressed", on ? "true" : "false");
            });
            parts.hint.textContent = state.message || surface.hint(state);
            parts.results.textContent = "";
            surface.rows(state, imperial).forEach(function (r) {
                parts.results.appendChild(el("dt", null, r[0]));
                parts.results.appendChild(el("dd", r[2] || null, r[1]));
            });
            var n = state.points.length;
            parts.method.hidden = !(opts.method && surface.method && surface.method(state));
            parts.undo.hidden = parts.finish.hidden = Boolean(mode.single);
            parts.undo.disabled = !n || state.done;
            parts.finish.disabled = state.done || n < (mode.min || 1);
            parts.clear.disabled = !n;
            if (parts.units) parts.units.textContent = imperial ? "ft" : "m";
        }

        function update() { surface.draw(state); render(); }

        function reset(keepMode) {
            state.points = [];
            state.done = false;
            state.volume = undefined;
            state.elevations = null;
            state.message = null;
            state.job++;
            if (!keepMode) state.cursor = null;
            update();
        }

        // Clear, another mode or closing drops what the surface is still working out (a 3D pick still loading)
        function cancel() {
            if (surface.cancel) surface.cancel();
        }

        function setMode(mode) {
            cancel();
            state.mode = modes.indexOf(mode) >= 0 ? mode : modes[0];
            reset(true);
        }

        function undoPoint() {
            if (state.done || !state.points.length) return;
            state.points.pop();
            update();
        }

        function finishShape() {
            var mode = MODES[state.mode];
            if (state.done || mode.single || state.points.length < mode.min) return;
            state.done = true;
            state.cursor = null;
            update();
            if (surface.finished) surface.finished(state);
        }

        function onClick(p) {
            var mode = MODES[state.mode];
            state.message = null;
            if (mode.single) {
                state.points = [p];
                state.job++;
                update();
                if (surface.clicked) surface.clicked(state, p);
                return;
            }
            if (state.done) reset(true);
            // A double-click's two clicks (or two picks of the same spot) add the point once
            if (samePoint(p, state.points[state.points.length - 1])) return;
            state.points.push(p);
            update();
            if (mode.max && state.points.length >= mode.max) finishShape();
        }

        function onMove(p) {
            if (state.done || MODES[state.mode].single || !state.points.length) return;
            state.cursor = p;
            surface.draw(state);
        }

        // Something the surface says in the hint's place until the next click (a click on nothing)
        function say(message) {
            state.message = message;
            render();
        }

        function turnOn() {
            if (state.on) return;
            if (surface.ready && !surface.ready()) return;
            state.on = true;
            page.dispatchEvent(new window.CustomEvent("explorer-tool", {detail: {tool: "measure", source: "measure"}}));
            if (!panel) buildPanel();
            panel.hidden = false;
            view.classList.add("explorer-measuring");
            toggle.classList.add("active");
            toggle.setAttribute("aria-pressed", "true");
            surface.start({click: onClick, finish: finishShape, move: onMove, say: say});
            update();
        }

        function off() {
            if (!state.on) return;
            state.on = false;
            cancel();
            reset();
            surface.stop();
            if (panel) panel.hidden = true;
            view.classList.remove("explorer-measuring");
            toggle.classList.remove("active");
            toggle.setAttribute("aria-pressed", "false");
        }

        toggle.addEventListener("click", function () { if (state.on) off(); else turnOn(); });
        page.addEventListener("explorer-tool", function (event) {
            if (event.detail && event.detail.source !== "measure") off();
        });
        // The legend's unit switch (map.js) and the 3D page's unit menu change what the panel reads in
        page.addEventListener("explorer-units", render);
        // The 3D page's view switch (viewer-ui.js): the hint can depend on the view (splats measured on the cloud)
        page.addEventListener("explorer-view", render);
        var Controls = node ? require("./viewer-controls.js") : window.ExplorerControls;
        document.addEventListener("keydown", function (event) {
            if (!Controls.isShortcut(event)) return;
            var key = (event.key || "").toLowerCase();
            if (key === "m") {
                if (state.on) off(); else turnOn();
            } else if (!state.on) {
                return;
            } else if (key === "escape") {
                off();
            } else if (event.target && event.target.tagName && event.target.tagName.toLowerCase() === "button") {
                return;  // Enter on a focused button presses it
            } else if (key === "backspace") {
                undoPoint();
            } else if (key === "enter") {
                finishShape();
            } else {
                return;
            }
            event.preventDefault();
        });

        tool.on = turnOn;
        tool.off = off;
        tool.setMode = setMode;
        tool.finish = finishShape;
        tool.undo = undoPoint;
        tool.render = render;
        tool.method = function () { return parts ? parts.select.value : chosenMethod(); };
        tool.state = function () { return state; };
        tool.panel = function () { return panel; };
        return tool;
    }

    // The map's surface: Leaflet's clicks, the drawing as Leaflet layers, geodesics on WGS84, WebODM's volume and the
    // DSM's and DTM's elevations from the server
    function mapSurface(page, toggle, texts, ctx, getL, getMap, hasDsm, hasDtm, isLink) {
        var shapes = null, tool = null;
        var listeners = {};

        function startVolume(state) {
            if (!ctx.volume || !hasDsm) return;
            var mine = ++state.job;
            state.volume = null;
            tool.render();
            measureVolume(ctx, state.points, tool.method(), function () { return mine === state.job; }).then(function (value) {
                if (mine !== state.job) return;
                state.volume = value;
                tool.render();
            }, function (error) {
                if (mine !== state.job || (error && error.message === "stale")) return;
                state.volume = error.status === 404 && isLink ? page.getAttribute("data-invalid") || texts.volumeFailed
                    : error.message === "timeout" ? texts.volumeTimeout
                    : error.status === 429 || error.status === 503 || error.status === 200 ? error.message || texts.volumeFailed
                    : texts.volumeFailed;
                tool.render();
            });
        }

        var surface = {
            bind: function (t) { tool = t; },
            ready: function () { return Boolean(getMap()); },
            start: function (h) {
                var map = getMap();
                listeners.click = function (e) { h.click([e.latlng.lat, e.latlng.lng]); };
                listeners.dblclick = function () { h.finish(); };
                listeners.mousemove = function (e) { h.move([e.latlng.lat, e.latlng.lng]); };
                if (map.doubleClickZoom) map.doubleClickZoom.disable();
                Object.keys(listeners).forEach(function (name) { map.on(name, listeners[name]); });
            },
            stop: function () {
                var map = getMap();
                if (shapes && map) { map.removeLayer(shapes); shapes = null; }
                if (map) {
                    Object.keys(listeners).forEach(function (name) { map.off(name, listeners[name]); });
                    if (map.doubleClickZoom) map.doubleClickZoom.enable();
                }
            },
            // The points, the line or polygon through them, and (while drawing) the edge to the pointer
            draw: function (state) {
                var L = getL(), map = getMap();
                if (!L || !map) return;
                if (shapes) shapes.clearLayers();
                else shapes = L.layerGroup().addTo(map);
                function style(fill) {
                    return {className: "explorer-measure-shape theme-color-button-primary", weight: 3, interactive: false, fillOpacity: fill};
                }
                var line = state.points.slice();
                if (!state.done && state.cursor && state.mode !== "point" && line.length) line.push(state.cursor);
                if (state.mode === "area" && line.length >= 3) {
                    L.polygon(line, style(0.15)).addTo(shapes);
                } else if (state.mode !== "point" && line.length >= 2) {
                    L.polyline(line, style(0)).addTo(shapes);
                }
                state.points.forEach(function (p) {
                    L.circleMarker(p, {className: "explorer-measure-point theme-color-button-primary", radius: 5, weight: 2,
                        fillOpacity: 1, interactive: false}).addTo(shapes);
                });
            },
            hint: function (state) {
                return state.mode === "point" ? texts.hintPoint
                    : state.done ? texts.hintDone : state.mode === "area" ? texts.hintArea : texts.hintLength;
            },
            rows: function (state, imperial) {
                var n = state.points.length, rows = [];
                if (state.mode === "length" && n >= 2) {
                    rows.push([texts.lengthLabel, formatLength(pathLength(state.points), imperial)]);
                } else if (state.mode === "area" && n >= 3) {
                    var a = polygonArea(state.points);
                    rows.push([texts.areaLabel, formatArea(a.area, imperial)]);
                    rows.push([texts.perimeter, formatLength(a.perimeter, imperial)]);
                    if (state.done && ctx.volume && hasDsm) {
                        var v = state.volume;
                        rows.push([texts.volume, v === undefined || v === null ? texts.computing
                            : typeof v === "number" ? formatVolume(v, imperial) : v, typeof v === "string" ? "explorer-measure-error" : null]);
                    }
                } else if (state.mode === "point" && n === 1) {
                    var e = state.elevations;
                    if (!e) {
                        rows.push([texts.elevation, texts.reading]);
                    } else if (typeof e === "string") {
                        rows.push([texts.elevation, e, "explorer-measure-error"]);
                    } else {
                        if (hasDsm) rows.push([texts.surface, typeof e.dsm === "number" ? formatHeight(e.dsm, imperial) : texts.noValue]);
                        if (hasDtm) rows.push([texts.ground, typeof e.dtm === "number" ? formatHeight(e.dtm, imperial) : texts.noValue]);
                        if (typeof e.dsm === "number" && typeof e.dtm === "number") {
                            rows.push([texts.heightAboveGround, formatHeight(e.dsm - e.dtm, imperial)]);
                        }
                    }
                }
                return rows;
            },
            method: function (state) { return state.mode === "area" && Boolean(ctx.volume) && hasDsm; },
            methodChanged: function (state) { if (state.mode === "area" && state.done) startVolume(state); },
            finished: function (state) { if (state.mode === "area") startVolume(state); },
            clicked: function (state, p) {
                var mine = state.job;
                state.elevations = null;
                tool.render();
                var url = toggle.getAttribute("data-elevation") + "?lng=" + encodeURIComponent(p[1]) + "&lat=" + encodeURIComponent(p[0]);
                ctx.fetch(url, {credentials: "same-origin", headers: {"Accept": "application/json"}}).then(readJson).then(function (data) {
                    if (mine !== state.job) return;
                    state.elevations = data;
                    tool.render();
                }, function (error) {
                    if (mine !== state.job) return;
                    state.elevations = error.status === 404 && isLink ? page.getAttribute("data-invalid") || texts.elevationFailed : texts.elevationFailed;
                    tool.render();
                });
            }
        };
        return surface;
    }

    // page: the map page; options (for the tests): {L, map, fetch, wait, now}
    function init(page, options) {
        options = options || {};
        var toggle = page.querySelector("[data-tool=measure]");
        var view = page.querySelector(".explorer-map");
        var textsScript = document.getElementById("explorer-measure-texts");
        if (!toggle || !view || !textsScript) return null;
        var texts = JSON.parse(textsScript.textContent);
        var csrfInput = page.querySelector("input[name=csrfmiddlewaretoken]");
        var elevationUrl = toggle.getAttribute("data-elevation") || "";
        var hasDsm = toggle.hasAttribute("data-dsm"), hasDtm = toggle.hasAttribute("data-dtm");
        var volumeStart = toggle.getAttribute("data-volume-start");
        var ctx = {
            fetch: options.fetch || function (url, o) { return window.fetch(url, o); },
            wait: options.wait || function (ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); },
            now: options.now || function () { return Date.now(); },
            csrf: csrfInput ? csrfInput.value : "",
            volume: volumeStart ? {start: volumeStart, result: toggle.getAttribute("data-volume-result")} : null
        };
        var surface = mapSurface(page, toggle, texts, ctx, function () { return options.L || window.L; },
            function () { return options.map || page.explorerMap; }, hasDsm, hasDtm, toggle.hasAttribute("data-link"));
        var tool = create({page: page, view: view, toggle: toggle, texts: texts, surface: surface, method: true,
            modes: ["length", "area"].concat(elevationUrl && (hasDsm || hasDtm) ? ["point"] : [])});
        surface.bind(tool);
        return tool;
    }

    function start() {
        var page = document.querySelector("[data-explorer-map]");
        // On the page, for the live checks (the drawing's points)
        if (page) page.explorerMeasure = init(page);
    }

    var api = {init: init, create: create, pathLength: pathLength, polygonArea: polygonArea, formatLength: formatLength,
        formatArea: formatArea, formatVolume: formatVolume, formatHeight: formatHeight, areaFeature: areaFeature,
        measureVolume: measureVolume, distance3d: distance3d, area3d: area3d, angle3d: angle3d, number: number,
        isImperial: isImperial, METHODS: METHODS, MODES: MODES, DEADLINE_MS: DEADLINE_MS, POLL_MS: POLL_MS};
    if (node) {
        module.exports = api;
    } else {
        window.ExplorerMeasure = api;
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
})();

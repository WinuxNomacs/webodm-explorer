/*
 * The map page's Measure tool (upcoming-changes.md, "Plan: measurement tools"): Length, Area and Point, drawn on the
 * map by click or tap. Lengths and areas are geodesics on WGS84 with GeographicLib (Karney's method, as PROJ's), in
 * the browser; an area's volume is WebODM's own (its Measure plugin's job, in WebODM's worker); a point's elevations
 * are read from the task's DSM and DTM by Explorer's view. Units follow the legend's switch (metric or imperial).
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    var geodesic = node ? require("./vendor/geographiclib-geodesic-2.2.0/geographiclib-geodesic.min.js") : window.geodesic;
    var WGS84 = geodesic.Geodesic.WGS84;
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
        var isLink = toggle.hasAttribute("data-link");
        var modes = ["length", "area"].concat(elevationUrl && (hasDsm || hasDtm) ? ["point"] : []);
        var state = {on: false, mode: "length", points: [], done: false, job: 0, cursor: null};
        var shapes = null, panel = null, parts = null;

        function getMap() { return options.map || page.explorerMap; }
        function getL() { return options.L || window.L; }

        function buildPanel() {
            panel = el("div", "explorer-measure theme-secondary theme-border-secondary-07");
            panel.setAttribute("role", "region");
            panel.setAttribute("aria-label", texts.measure);
            var tabs = el("div", "btn-group btn-group-sm explorer-measure-modes");
            tabs.setAttribute("role", "group");
            var tabButtons = {};
            var icons = {length: "fa-ruler", area: "fa-draw-polygon", point: "fa-map-marker-alt"};
            modes.forEach(function (mode) {
                var b = button(texts[mode], icons[mode]);
                b.setAttribute("data-mode", mode);
                b.addEventListener("click", function () { setMode(mode); });
                tabButtons[mode] = b;
                tabs.appendChild(b);
            });
            var hint = el("p", "explorer-measure-hint");
            var results = el("dl", "explorer-measure-results");
            results.setAttribute("aria-live", "polite");
            var method = el("label", "explorer-measure-method");
            method.appendChild(document.createTextNode(texts.base + " "));
            var select = el("select", "form-control input-sm");
            METHODS.forEach(function (m) {
                var option = el("option", null, texts.methods[m]);
                option.value = m;
                select.appendChild(option);
            });
            select.value = chosenMethod();
            select.addEventListener("change", function () {
                remember(METHOD_KEY, select.value);
                if (state.mode === "area" && state.done) startVolume();
            });
            method.appendChild(select);
            var actions = el("div", "explorer-measure-actions");
            var undo = button(texts.undo, "fa-undo", "data-undo");
            var finish = button(texts.finish, "fa-check", "data-finish");
            var clear = button(texts.clear, "fa-eraser", "data-clear");
            undo.addEventListener("click", undoPoint);
            finish.addEventListener("click", finishShape);
            clear.addEventListener("click", function () { reset(); });
            actions.appendChild(undo);
            actions.appendChild(finish);
            actions.appendChild(clear);
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
            // Clicks and drags on the panel are not the map's
            ["mousedown", "touchstart", "dblclick", "click", "wheel", "pointerdown"].forEach(function (name) {
                panel.addEventListener(name, function (e) { e.stopPropagation(); });
            });
            parts = {tabs: tabButtons, hint: hint, results: results, method: method, select: select, undo: undo, finish: finish, clear: clear};
            view.appendChild(panel);
        }

        function row(label, value, className) {
            var dt = el("dt", null, label);
            var dd = el("dd", className || null, value);
            parts.results.appendChild(dt);
            parts.results.appendChild(dd);
            return dd;
        }

        // The panel says what the drawing measures, in the units chosen now
        function render() {
            if (!panel) return;
            var imperial = isImperial();
            Object.keys(parts.tabs).forEach(function (mode) {
                var on = mode === state.mode;
                parts.tabs[mode].classList.toggle("active", on);
                parts.tabs[mode].setAttribute("aria-pressed", on ? "true" : "false");
            });
            var n = state.points.length;
            parts.hint.textContent = state.mode === "point" ? texts.hintPoint
                : state.done ? texts.hintDone : state.mode === "area" ? texts.hintArea : texts.hintLength;
            parts.results.textContent = "";
            if (state.mode === "length" && n >= 2) {
                row(texts.lengthLabel, formatLength(pathLength(state.points), imperial));
            } else if (state.mode === "area" && n >= 3) {
                var a = polygonArea(state.points);
                row(texts.areaLabel, formatArea(a.area, imperial));
                row(texts.perimeter, formatLength(a.perimeter, imperial));
                if (state.done && ctx.volume && hasDsm) {
                    var v = state.volume;
                    row(texts.volume, v === undefined || v === null ? texts.computing
                        : typeof v === "number" ? formatVolume(v, imperial) : v, typeof v === "string" ? "explorer-measure-error" : null);
                }
            } else if (state.mode === "point" && n === 1) {
                var e = state.elevations;
                if (!e) {
                    row(texts.elevation, texts.reading);
                } else if (typeof e === "string") {
                    row(texts.elevation, e, "explorer-measure-error");
                } else {
                    if (hasDsm) row(texts.surface, typeof e.dsm === "number" ? formatHeight(e.dsm, imperial) : texts.noValue);
                    if (hasDtm) row(texts.ground, typeof e.dtm === "number" ? formatHeight(e.dtm, imperial) : texts.noValue);
                    if (typeof e.dsm === "number" && typeof e.dtm === "number") {
                        row(texts.heightAboveGround, formatHeight(e.dsm - e.dtm, imperial));
                    }
                }
            }
            parts.method.hidden = !(state.mode === "area" && ctx.volume && hasDsm);
            parts.undo.hidden = parts.finish.hidden = state.mode === "point";
            parts.undo.disabled = !n || state.done;
            parts.finish.disabled = state.done || n < (state.mode === "area" ? 3 : 2);
            parts.clear.disabled = !n;
        }

        // The drawing on the map: the points, the line or polygon through them, and (while drawing) the edge to the pointer
        function draw() {
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
        }

        function update() { draw(); render(); }

        function reset(keepMode) {
            state.points = [];
            state.done = false;
            state.volume = undefined;
            state.elevations = null;
            state.job++;
            if (!keepMode) state.cursor = null;
            update();
        }

        function setMode(mode) {
            state.mode = modes.indexOf(mode) >= 0 ? mode : "length";
            reset(true);
        }

        function undoPoint() {
            if (state.done || !state.points.length) return;
            state.points.pop();
            update();
        }

        function startVolume() {
            if (!ctx.volume || !hasDsm) return;
            var mine = ++state.job;
            state.volume = null;
            render();
            measureVolume(ctx, state.points, parts.select.value, function () { return mine === state.job; }).then(function (value) {
                if (mine !== state.job) return;
                state.volume = value;
                render();
            }, function (error) {
                if (mine !== state.job || (error && error.message === "stale")) return;
                state.volume = error.status === 404 && isLink ? page.getAttribute("data-invalid") || texts.volumeFailed
                    : error.message === "timeout" ? texts.volumeTimeout
                    : error.status === 429 || error.status === 503 || error.status === 200 ? error.message || texts.volumeFailed
                    : texts.volumeFailed;
                render();
            });
        }

        function finishShape() {
            if (state.done || state.points.length < (state.mode === "area" ? 3 : 2)) return;
            state.done = true;
            state.cursor = null;
            update();
            if (state.mode === "area") startVolume();
        }

        function readElevation(lat, lng) {
            var mine = ++state.job;
            state.elevations = null;
            render();
            var url = elevationUrl + "?lng=" + encodeURIComponent(lng) + "&lat=" + encodeURIComponent(lat);
            ctx.fetch(url, {credentials: "same-origin", headers: {"Accept": "application/json"}}).then(readJson).then(function (data) {
                if (mine !== state.job) return;
                state.elevations = data;
                render();
            }, function (error) {
                if (mine !== state.job) return;
                state.elevations = error.status === 404 && isLink ? page.getAttribute("data-invalid") || texts.elevationFailed : texts.elevationFailed;
                render();
            });
        }

        function onClick(e) {
            var p = [e.latlng.lat, e.latlng.lng];
            if (state.mode === "point") {
                state.points = [p];
                update();
                readElevation(p[0], p[1]);
                return;
            }
            if (state.done) reset(true);
            state.points.push(p);
            update();
        }

        // A double-click ends the shape; its two clicks added the same point twice
        function onDoubleClick() {
            if (state.mode === "point" || state.done) return;
            var pts = state.points;
            if (pts.length >= 2 && pts[pts.length - 1][0] === pts[pts.length - 2][0] && pts[pts.length - 1][1] === pts[pts.length - 2][1]) pts.pop();
            finishShape();
        }

        function onMove(e) {
            if (state.done || state.mode === "point" || !state.points.length) return;
            state.cursor = [e.latlng.lat, e.latlng.lng];
            draw();
        }

        function turnOn() {
            var map = getMap();
            if (!map || state.on) return;
            state.on = true;
            page.dispatchEvent(new window.CustomEvent("explorer-tool", {detail: {tool: "measure", source: "measure"}}));
            if (!panel) buildPanel();
            panel.hidden = false;
            view.classList.add("explorer-measuring");
            toggle.classList.add("active");
            toggle.setAttribute("aria-pressed", "true");
            if (map.doubleClickZoom) map.doubleClickZoom.disable();
            map.on("click", onClick);
            map.on("dblclick", onDoubleClick);
            map.on("mousemove", onMove);
            update();
        }

        function off() {
            if (!state.on) return;
            state.on = false;
            var map = getMap();
            reset();
            if (shapes && map) { map.removeLayer(shapes); shapes = null; }
            if (map) {
                map.off("click", onClick);
                map.off("dblclick", onDoubleClick);
                map.off("mousemove", onMove);
                if (map.doubleClickZoom) map.doubleClickZoom.enable();
            }
            if (panel) panel.hidden = true;
            view.classList.remove("explorer-measuring");
            toggle.classList.remove("active");
            toggle.setAttribute("aria-pressed", "false");
        }

        toggle.addEventListener("click", function () { if (state.on) off(); else turnOn(); });
        page.addEventListener("explorer-tool", function (event) {
            if (event.detail && event.detail.source !== "measure") off();
        });
        // The legend's unit switch (map.js) changes what the panel reads in
        page.addEventListener("explorer-units", render);
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

        return {
            on: turnOn, off: off, setMode: setMode, finish: finishShape, undo: undoPoint,
            state: function () { return state; }, panel: function () { return panel; }
        };
    }

    function start() {
        var page = document.querySelector("[data-explorer-map]");
        // On the page, for the live checks (the drawing's points)
        if (page) page.explorerMeasure = init(page);
    }

    var api = {init: init, pathLength: pathLength, polygonArea: polygonArea, formatLength: formatLength, formatArea: formatArea,
        formatVolume: formatVolume, formatHeight: formatHeight, areaFeature: areaFeature, measureVolume: measureVolume,
        METHODS: METHODS, DEADLINE_MS: DEADLINE_MS, POLL_MS: POLL_MS};
    if (node) {
        module.exports = api;
    } else {
        window.ExplorerMeasure = api;
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
})();

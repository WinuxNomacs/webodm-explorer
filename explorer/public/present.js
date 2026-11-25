/*
 * The map and 3D pages' presentation tools (upcoming-changes.md, "Plan: presentation tools"): Laser Pointer (L), a
 * dot with a fading trail that follows the pointer, and Area Highlight (H), a freehand loop, rectangle or ellipse
 * that fades after about 3 seconds (kept until cleared when drawn with Shift), optionally as a Spotlight that dims
 * everything else. Marks are drawn on one canvas over the view, in screen positions, and only while one shows; the
 * view below is never touched. Esc turns the tool off and clears kept highlights.
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    var Controls = node ? require("./viewer-controls.js") : window.ExplorerControls;
    var SHAPE_KEY = "explorer-present-shape";
    var SPOTLIGHT_KEY = "explorer-present-spotlight";
    var SHAPES = ["freehand", "rectangle", "ellipse"];
    var HOLD_MS = 2500;      // a highlight shows fully this long,
    var FADE_MS = 500;       // then fades out over this
    var TRAIL_MS = 500;      // the laser's trail
    var MIN_DRAG = 6;        // pixels: a shorter drag draws nothing
    var MIN_STEP = 2;        // pixels between a freehand loop's points

    function remembered(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function remember(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* the default next time */ }
    }

    function shapeChoice(value) {
        return SHAPES.indexOf(value) >= 0 ? value : SHAPES[0];
    }

    // The shape a drag through `points` ({x, y}, in order) draws, or null when it is too small to mean anything
    function makeShape(kind, points, kept, now) {
        if (!points.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < points.length; i++) {
            minX = Math.min(minX, points[i].x); maxX = Math.max(maxX, points[i].x);
            minY = Math.min(minY, points[i].y); maxY = Math.max(maxY, points[i].y);
        }
        if (Math.max(maxX - minX, maxY - minY) < MIN_DRAG) return null;
        var shape = {kind: kind, kept: !!kept, at: now};
        var a = points[0], b = points[points.length - 1];
        if (kind === "rectangle") {
            shape.x = Math.min(a.x, b.x); shape.y = Math.min(a.y, b.y);
            shape.w = Math.abs(b.x - a.x); shape.h = Math.abs(b.y - a.y);
            if (Math.max(shape.w, shape.h) < MIN_DRAG) return null;
        } else if (kind === "ellipse") {
            shape.cx = (a.x + b.x) / 2; shape.cy = (a.y + b.y) / 2;
            shape.rx = Math.abs(b.x - a.x) / 2; shape.ry = Math.abs(b.y - a.y) / 2;
            if (Math.max(shape.rx, shape.ry) * 2 < MIN_DRAG) return null;
        } else {
            shape.kind = "freehand";
            shape.points = points.slice();  // closed when drawn
        }
        return shape;
    }

    // How visible a highlight is at `now`: 1, then fading to 0 (gone); a kept one stays at 1
    function opacity(shape, now) {
        if (shape.kept) return 1;
        var age = now - shape.at;
        if (age <= HOLD_MS) return 1;
        return Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
    }

    // The laser's trail points still showing at `now`
    function trail(points, now) {
        return points.filter(function (p) { return now - p.at < TRAIL_MS; });
    }

    // Adds a point to a freehand loop unless it is too close to the last one
    function addPoint(points, p) {
        var last = points[points.length - 1];
        if (!last || Math.abs(p.x - last.x) >= MIN_STEP || Math.abs(p.y - last.y) >= MIN_STEP) points.push(p);
        return points;
    }

    function tracePath(ctx, shape) {
        ctx.beginPath();
        if (shape.kind === "rectangle") {
            ctx.rect(shape.x, shape.y, shape.w, shape.h);
        } else if (shape.kind === "ellipse") {
            ctx.ellipse(shape.cx, shape.cy, Math.max(shape.rx, 0.5), Math.max(shape.ry, 0.5), 0, 0, 2 * Math.PI);
        } else {
            ctx.moveTo(shape.points[0].x, shape.points[0].y);
            for (var i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i].x, shape.points[i].y);
            ctx.closePath();
        }
    }

    // The theme's colours, read from elements carrying WebODM's theme classes (a canvas needs values, not classes):
    // the laser in Button Danger, highlights in Dialog Warning, outlines and the Spotlight's dimming in Primary
    function themeColours(page) {
        function probe(className, property, fallback) {
            var el = document.createElement("div");
            el.className = className;
            el.hidden = true;
            page.appendChild(el);
            var value = window.getComputedStyle(el)[property];
            page.removeChild(el);
            return value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : fallback;
        }
        var primary = probe("theme-color-primary", "color", "");
        return {
            laser: probe("theme-color-button-danger", "color", primary),
            highlight: probe("alert alert-warning", "borderTopColor", primary),
            outline: primary
        };
    }

    // page: the map or 3D page; options: {now(), frame(callback)} for the tests
    function init(page, options) {
        options = options || {};
        var group = page.querySelector("[data-present]");
        var view = page.querySelector(".explorer-map, .explorer-scene");
        if (!group || !view) return null;
        if (typeof window.PointerEvent !== "function") {
            group.hidden = true;
            return null;
        }
        var now = options.now || function () { return Date.now(); };
        var frame = options.frame || function (callback) { return window.requestAnimationFrame(callback); };
        var buttons = {laser: group.querySelector("[data-tool=laser]"), highlight: group.querySelector("[data-tool=highlight]")};
        var shapeItems = group.querySelectorAll("[data-shape]");
        var spotlightItem = group.querySelector("[data-spotlight]");
        var clearItem = group.querySelector("[data-clear]");

        var canvas = document.createElement("canvas");
        canvas.className = "explorer-present-canvas";
        canvas.setAttribute("aria-hidden", "true");
        view.appendChild(canvas);
        var ctx = canvas.getContext ? canvas.getContext("2d") : null;
        var colours = null;

        var state = {
            tool: null,
            shape: shapeChoice(remembered(SHAPE_KEY)),
            spotlight: remembered(SPOTLIGHT_KEY) === "1",
            shapes: [],        // drawn highlights
            drawing: null,     // the highlight being drawn: {points, kept}
            trail: [],         // the laser's recent positions
            dot: null,         // where the laser is, or null when off the view
            gesture: null,     // the press this script took from the view: {id, event, target}
            touches: {},       // touch pointers down on the view
            pending: false
        };

        function point(event) {
            var rect = view.getBoundingClientRect();
            return {x: event.clientX - rect.left, y: event.clientY - rect.top, at: now()};
        }

        // Sized to the view at the device's pixel ratio; a resize clears the marks, whose screen places moved
        function fit() {
            var ratio = window.devicePixelRatio || 1;
            var width = Math.round(view.clientWidth * ratio), height = Math.round(view.clientHeight * ratio);
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                state.shapes = [];
                state.trail = [];
                state.drawing = null;
            }
            draw();
        }

        function draw() {
            if (!ctx) return false;
            var t = now();
            var ratio = canvas.width / Math.max(1, view.clientWidth);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            if (!colours) colours = themeColours(page);
            state.shapes = state.shapes.filter(function (s) { return opacity(s, t) > 0; });
            state.trail = trail(state.trail, t);

            var shown = state.shapes.map(function (s) { return {shape: s, alpha: opacity(s, t)}; });
            if (state.drawing) {
                var current = makeShape(state.shape, state.drawing.points, true, t);
                if (current) shown.push({shape: current, alpha: 1});
            }
            if (shown.length && state.spotlight) {
                // Everything dimmed, then the shapes cut out of the dimming
                var strongest = 0;
                shown.forEach(function (s) { strongest = Math.max(strongest, s.alpha); });
                ctx.save();
                ctx.globalAlpha = 0.55 * strongest;
                ctx.fillStyle = colours.outline;
                ctx.fillRect(0, 0, view.clientWidth, view.clientHeight);
                ctx.globalCompositeOperation = "destination-out";
                ctx.globalAlpha = 1;
                shown.forEach(function (s) { tracePath(ctx, s.shape); ctx.fill(); });
                ctx.restore();
            }
            shown.forEach(function (s) {
                ctx.save();
                ctx.globalAlpha = s.alpha;
                tracePath(ctx, s.shape);
                if (!state.spotlight) {
                    ctx.globalAlpha = 0.18 * s.alpha;
                    ctx.fillStyle = colours.highlight;
                    ctx.fill();
                    ctx.globalAlpha = s.alpha;
                }
                ctx.lineJoin = "round";
                ctx.strokeStyle = colours.outline;
                ctx.lineWidth = 5;
                ctx.stroke();
                ctx.strokeStyle = colours.highlight;
                ctx.lineWidth = 3;
                ctx.stroke();
                ctx.restore();
            });

            if (state.trail.length > 1) {
                ctx.save();
                ctx.lineCap = "round";
                ctx.strokeStyle = colours.laser;
                for (var i = 1; i < state.trail.length; i++) {
                    var a = state.trail[i - 1], b = state.trail[i];
                    ctx.globalAlpha = Math.max(0, 1 - (t - b.at) / TRAIL_MS) * 0.8;
                    ctx.lineWidth = 2 + 4 * ctx.globalAlpha;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
                ctx.restore();
            }
            if (state.dot) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(state.dot.x, state.dot.y, 7, 0, 2 * Math.PI);
                ctx.fillStyle = colours.laser;
                ctx.shadowColor = colours.laser;
                ctx.shadowBlur = 14;
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = colours.outline;
                ctx.stroke();
                ctx.restore();
            }
            // More frames only while something changes by itself: a trail or a highlight fading
            return state.trail.length > 0 || state.shapes.some(function (s) { return !s.kept; });
        }

        function schedule() {
            if (state.pending) return;
            state.pending = true;
            frame(function () {
                state.pending = false;
                if (draw()) schedule();
            });
        }

        function setTool(tool) {
            state.tool = tool;
            ["laser", "highlight"].forEach(function (kind) {
                var on = tool === kind;
                if (buttons[kind]) {
                    buttons[kind].setAttribute("aria-pressed", on ? "true" : "false");
                    buttons[kind].classList.toggle("active", on);
                }
                view.classList.toggle("explorer-present-" + kind, on);
            });
            // One tool at a time on the page: Source Frames (frames.js) turns off when one of these turns on
            if (tool) page.dispatchEvent(new window.CustomEvent("explorer-tool", {detail: {tool: tool, source: "present"}}));
            if (tool !== "laser") { state.dot = null; state.trail = []; }
            if (tool !== "highlight") state.drawing = null;
            endGesture(false);
            schedule();
        }
        function toggle(tool) { setTool(state.tool === tool ? null : tool); }

        function clear() {
            state.shapes = [];
            schedule();
        }

        function chooseShape(kind) {
            state.shape = shapeChoice(kind);
            for (var i = 0; i < shapeItems.length; i++) {
                var on = shapeItems[i].getAttribute("data-shape") === state.shape;
                shapeItems[i].setAttribute("aria-checked", on ? "true" : "false");
                shapeItems[i].parentNode.classList.toggle("active", on);
            }
        }
        function showSpotlight() {
            if (!spotlightItem) return;
            spotlightItem.setAttribute("aria-checked", state.spotlight ? "true" : "false");
            spotlightItem.parentNode.classList.toggle("active", state.spotlight);
        }

        // The press this script took ends: a highlight being drawn is kept as drawn (`kept` from Shift)
        function endGesture(finish, kept) {
            var gesture = state.gesture;
            if (!gesture) return;
            state.gesture = null;
            if (finish && state.drawing) {
                var shape = makeShape(state.shape, state.drawing.points, kept, now());
                if (shape) state.shapes.push(shape);
            }
            state.drawing = null;
            if (gesture.touch) state.dot = null;
            try { if (view.hasPointerCapture && view.hasPointerCapture(gesture.id)) view.releasePointerCapture(gesture.id); } catch (e) { /* gone */ }
            schedule();
        }

        function inView(event) {
            return event.target && view.contains(event.target);
        }

        // A second finger on the view while one draws: the drawing is dropped and the first finger's press is given
        // back to the view, so both fingers pan and zoom it as usual
        var replaying = false;
        function giveBack(gesture) {
            state.gesture = null;
            state.drawing = null;
            state.dot = null;
            try { if (view.hasPointerCapture && view.hasPointerCapture(gesture.id)) view.releasePointerCapture(gesture.id); } catch (e) { /* gone */ }
            var e = gesture.event;
            var copy = new window.PointerEvent("pointerdown", {
                bubbles: true, cancelable: true, composed: true, pointerId: e.pointerId, pointerType: e.pointerType,
                isPrimary: e.isPrimary, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
                button: e.button, buttons: e.buttons, width: e.width, height: e.height, pressure: e.pressure
            });
            replaying = true;
            try { gesture.target.dispatchEvent(copy); } finally { replaying = false; }
            schedule();
        }

        function swallow(event) {
            event.stopPropagation();
            if (event.cancelable) event.preventDefault();
        }

        page.addEventListener("pointerdown", function (event) {
            if (replaying || !inView(event)) return;
            var touch = event.pointerType === "touch";
            if (touch) state.touches[event.pointerId] = true;
            if (!state.tool) return;
            if (state.gesture) {
                if (touch && state.gesture.touch && event.pointerId !== state.gesture.id) giveBack(state.gesture);
                return;
            }
            if (Object.keys(state.touches).length > 1) return;  // a pinch already under way: the view's
            if (state.tool === "laser" && !touch) return;        // the mouse points without pressing
            if (!touch && event.button !== 0) return;            // right-drag and the middle button still move the view
            swallow(event);
            state.gesture = {id: event.pointerId, event: event, target: event.target, touch: touch};
            try { view.setPointerCapture(event.pointerId); } catch (e) { /* the moves still come while over the view */ }
            var p = point(event);
            if (state.tool === "highlight") {
                state.drawing = {points: [p]};
            } else {
                state.dot = p;
                state.trail.push(p);
            }
            schedule();
        }, true);

        page.addEventListener("pointermove", function (event) {
            if (replaying) return;
            var gesture = state.gesture;
            if (gesture && event.pointerId === gesture.id) {
                swallow(event);
                var p = point(event);
                if (state.drawing) {
                    addPoint(state.drawing.points, p);
                } else if (state.tool === "laser") {
                    state.dot = p;
                    state.trail.push(p);
                }
                schedule();
            } else if (state.tool === "laser" && event.pointerType !== "touch" && inView(event)) {
                var q = point(event);
                state.dot = q;
                state.trail.push(q);
                schedule();
            }
        }, true);

        function released(event) {
            if (event.pointerType === "touch") delete state.touches[event.pointerId];
            if (state.gesture && event.pointerId === state.gesture.id) {
                swallow(event);
                endGesture(event.type === "pointerup" || state.tool === "highlight", event.shiftKey);
            }
        }
        // Where touch events exist, Leaflet listens to them rather than to pointer events: a finger this script took
        // keeps its touch events from the view too (pointer events come first, so a second finger's touchstart,
        // which carries both fingers, already finds the press given back and reaches the view's pinch)
        ["touchstart", "touchmove"].forEach(function (type) {
            page.addEventListener(type, function (event) {
                if (state.gesture && state.gesture.touch && inView(event)) swallow(event);
            }, {capture: true, passive: false});
        });
        page.addEventListener("pointerup", released, true);
        page.addEventListener("pointercancel", released, true);
        // Capture taken away (an alert, a tab switch): the drawing ends as drawn
        view.addEventListener("lostpointercapture", function (event) {
            if (state.gesture && event.pointerId === state.gesture.id) endGesture(true, false);
        });
        view.addEventListener("pointerleave", function (event) {
            if (state.tool === "laser" && event.pointerType !== "touch" && !state.gesture) {
                state.dot = null;
                schedule();
            }
        });
        // While drawing highlights, clicks don't reach the view (no double-click zoom or focus)
        ["click", "dblclick"].forEach(function (type) {
            page.addEventListener(type, function (event) {
                if (state.tool === "highlight" && inView(event)) swallow(event);
            }, true);
        });

        page.addEventListener("explorer-tool", function (event) {
            if (event.detail && event.detail.source !== "present" && state.tool) setTool(null);
        });
        Object.keys(buttons).forEach(function (kind) {
            if (buttons[kind]) buttons[kind].addEventListener("click", function () { toggle(kind); });
        });
        for (var i = 0; i < shapeItems.length; i++) {
            shapeItems[i].addEventListener("click", function (e) {
                e.preventDefault();
                chooseShape(e.currentTarget.getAttribute("data-shape"));
                remember(SHAPE_KEY, state.shape);
                setTool("highlight");
            });
        }
        if (spotlightItem) {
            spotlightItem.addEventListener("click", function (e) {
                e.preventDefault();
                state.spotlight = !state.spotlight;
                remember(SPOTLIGHT_KEY, state.spotlight ? "1" : "0");
                showSpotlight();
                schedule();
            });
        }
        if (clearItem) {
            clearItem.addEventListener("click", function (e) {
                e.preventDefault();
                clear();
            });
        }

        document.addEventListener("keydown", function (event) {
            if (!Controls.isShortcut(event)) return;
            var key = (event.key || "").toLowerCase();
            if (key === "l") {
                toggle("laser");
            } else if (key === "h") {
                toggle("highlight");
            } else if (key === "escape" && (state.tool || state.shapes.length)) {
                setTool(null);
                clear();
            } else {
                return;
            }
            event.preventDefault();
        });

        if (typeof window.ResizeObserver === "function") {
            new window.ResizeObserver(fit).observe(view);
        } else {
            window.addEventListener("resize", fit);
        }
        chooseShape(state.shape);
        showSpotlight();
        fit();

        return {
            setTool: setTool, clear: clear, fit: fit,
            state: function () { return state; }
        };
    }

    function start() {
        var page = document.querySelector("[data-explorer-map], [data-explorer-viewer]");
        if (page) init(page);
    }

    var api = {init: init, themeColours: themeColours, makeShape: makeShape, opacity: opacity, trail: trail, addPoint: addPoint, shapeChoice: shapeChoice,
        HOLD_MS: HOLD_MS, FADE_MS: FADE_MS, TRAIL_MS: TRAIL_MS, MIN_DRAG: MIN_DRAG};
    if (node) {
        module.exports = api;
    } else {
        window.ExplorerPresent = api;
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
})();

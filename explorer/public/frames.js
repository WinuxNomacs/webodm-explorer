/*
 * Source Frames on a task's map and 3D pages (upcoming-changes.md, "Plan: Source Frames in Explorer's viewer"): the
 * Source Frames button (S) in the Present group turns it on; while it is on, each click on the map or the model (not
 * a drag, which still pans or orbits) moves the spot there, and a window over the view lists the task's photos that
 * show it, best first, with the spot drawn on the chosen one, its details, Download and Open Full Frame (full screen,
 * zoom, pan, previous and next). Esc, the window's Close or the button again turns it off. Explorer's API finds the
 * photos (frames.py); WebODM's own serves them. Ported from TweakUI's source_frames.js (the same author's).
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    var Controls = node ? require("./viewer-controls.js") : window.ExplorerControls;
    var Present = node ? require("./present.js") : window.ExplorerPresent;
    var THUMB = 256, PHOTO = 1024;
    var CLICK_SLOP = 5;   // pixels a press may move and still be a click
    var SVGNS = "http://www.w3.org/2000/svg";

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    function icon(name) { return el("i", "fa " + name); }

    function button(className, iconName, label, text) {
        var b = el("button", "btn btn-default btn-sm" + (className ? " " + className : ""));
        b.type = "button";
        b.title = label;
        b.setAttribute("aria-label", label);
        b.appendChild(icon(iconName));
        if (text) b.appendChild(document.createTextNode(" " + text));
        return b;
    }

    function formatTime(seconds) {
        if (!seconds) return "";
        var d = new Date(seconds * 1000);
        return isNaN(d.getTime()) ? "" : d.toLocaleString();
    }

    function imageUrl(images, filename, kind, size) {
        var url = images + kind + "/" + encodeURIComponent(filename);
        return size ? url + "?size=" + size : url;
    }

    // Asks Explorer's API for the photos that show a spot; resolves to the list, best first, or rejects with the
    // server's message. `signal` cancels it when a newer spot comes
    function findFrames(fetchFn, api, csrf, place, signal, failed) {
        var options = {
            method: "POST", credentials: "same-origin",
            headers: {"Content-Type": "application/json", "Accept": "application/json", "X-CSRFToken": csrf},
            body: JSON.stringify(place)
        };
        if (signal) options.signal = signal;
        return fetchFn(api, options).then(function (res) {
            return res.json().then(function (body) {
                if (!res.ok || !body || !Array.isArray(body.frames)) throw refused((body && body.detail) || failed, res.status);
                return body.frames;
            }, function () { throw refused(failed, res.status); });
        });
    }

    function refused(message, status) {
        var error = new Error(message);
        error.status = status;
        return error;
    }

    // The spot drawn on a photo: a ring in an SVG over it, in fractions of its width and height
    function overlay(frame, colours) {
        var svg = document.createElementNS(SVGNS, "svg");
        svg.setAttribute("class", "explorer-sf-overlay");
        svg.setAttribute("viewBox", "0 0 1 1");
        svg.setAttribute("preserveAspectRatio", "none");
        if (frame.spot) {
            var aspect = frame.width && frame.height ? frame.width / frame.height : 1;
            [[colours.outline, 5], [colours.spot, 2.5]].forEach(function (ring) {
                var e = document.createElementNS(SVGNS, "ellipse");
                e.setAttribute("cx", frame.spot[0]);
                e.setAttribute("cy", frame.spot[1]);
                // Round on the photo: the radius in each direction is a share of the other side
                e.setAttribute("rx", 0.035 / Math.max(aspect, 1));
                e.setAttribute("ry", 0.035 * Math.min(aspect, 1));
                e.setAttribute("fill", "none");
                e.setAttribute("stroke", ring[0]);
                e.setAttribute("stroke-width", ring[1]);
                e.setAttribute("vector-effect", "non-scaling-stroke");
                svg.appendChild(e);
            });
        }
        return svg;
    }

    function photo(ctx, frame, size, className) {
        var wrap = el("div", "explorer-sf-photo" + (className ? " " + className : ""));
        var img = el("img");
        img.alt = frame.filename;
        img.draggable = false;
        img.src = imageUrl(ctx.images, frame.filename, "thumbnail", size);
        img.addEventListener("error", function () {
            wrap.classList.add("explorer-sf-missing");
            wrap.textContent = "";
            wrap.appendChild(el("span", "explorer-sf-message", ctx.texts.missing));
        });
        wrap.appendChild(img);
        wrap.appendChild(overlay(frame, ctx.colours));
        return wrap;
    }

    // A box dragged by its handle, within its container
    function draggable(box, handle, container) {
        var start = null;
        handle.addEventListener("pointerdown", function (e) {
            if (e.target.closest && e.target.closest("button, a")) return;
            var b = box.getBoundingClientRect(), c = container.getBoundingClientRect();
            start = {x: e.clientX, y: e.clientY, left: b.left - c.left, top: b.top - c.top, b: b, c: c};
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* moves still come while over it */ }
            e.preventDefault();
        });
        handle.addEventListener("pointermove", function (e) {
            if (!start) return;
            var left = Math.max(0, Math.min(start.left + e.clientX - start.x, start.c.width - start.b.width));
            var top = Math.max(0, Math.min(start.top + e.clientY - start.y, start.c.height - start.b.height));
            box.style.left = left + "px";
            box.style.top = top + "px";
            box.style.right = "auto";
            box.style.bottom = "auto";
        });
        function end() { start = null; }
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }

    // Open Full Frame: a photo full screen with zoom (wheel, pinch, buttons, double-click) and pan, the previous and
    // next photos (arrow keys), Esc to close. Returns {element, close, show}
    function fullFrame(ctx, frames, index, onClose) {
        var t = ctx.texts;
        var root = el("div", "explorer-sf-viewer theme-secondary");
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-label", t.full);
        var bar = el("div", "explorer-sf-viewer-bar theme-border-secondary-07");
        var name = el("span", "explorer-sf-viewer-name");
        var stage = el("div", "explorer-sf-viewer-stage");
        var view = {scale: 1, x: 0, y: 0}, current = null;

        function apply() {
            if (current) current.style.transform = "translate(" + view.x + "px, " + view.y + "px) scale(" + view.scale + ")";
        }
        function zoom(factor, cx, cy) {
            var s = Math.max(1, Math.min(view.scale * factor, 20));
            var r = stage.getBoundingClientRect();
            // Around the given point (the stage's centre otherwise)
            var px = (cx === undefined ? r.width / 2 : cx - r.left) - r.width / 2;
            var py = (cy === undefined ? r.height / 2 : cy - r.top) - r.height / 2;
            view.x = px - (px - view.x) * s / view.scale;
            view.y = py - (py - view.y) * s / view.scale;
            view.scale = s;
            if (s === 1) view.x = view.y = 0;
            apply();
        }
        var download = button("", "fa-download", t.download);
        function show(i) {
            index = (i + frames.length) % frames.length;
            var frame = frames[index];
            view = {scale: 1, x: 0, y: 0};
            stage.textContent = "";
            current = photo(ctx, frame, Math.max(frame.width || 0, frame.height || 0) || 8192, "explorer-sf-viewer-photo");
            stage.appendChild(current);
            name.textContent = (index + 1) + " / " + frames.length + " · " + frame.filename;
            name.title = frame.filename;
            download.setAttribute("data-href", imageUrl(ctx.images, frame.filename, "download"));
            apply();
        }
        download.addEventListener("click", function () { ctx.assign(download.getAttribute("data-href")); });
        function control(iconName, label, action) {
            var b = button("", iconName, label);
            b.addEventListener("click", action);
            bar.appendChild(b);
            return b;
        }
        control("fa-chevron-left", t.previous, function () { show(index - 1); });
        bar.appendChild(name);
        control("fa-chevron-right", t.next, function () { show(index + 1); });
        control("fa-search-minus", t.zoomOut, function () { zoom(1 / 1.5); });
        control("fa-search-plus", t.zoomIn, function () { zoom(1.5); });
        if (ctx.download) bar.appendChild(download);
        var closeButton = control("fa-times", t.close, close);
        root.appendChild(bar);
        root.appendChild(stage);

        stage.addEventListener("wheel", function (e) {
            e.preventDefault();
            zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY);
        });
        var pointers = {}, pan = null, pinch = null;
        stage.addEventListener("pointerdown", function (e) {
            pointers[e.pointerId] = {x: e.clientX, y: e.clientY};
            var ids = Object.keys(pointers);
            if (ids.length === 1) {
                pan = {x: e.clientX - view.x, y: e.clientY - view.y};
            } else if (ids.length === 2) {
                var a = pointers[ids[0]], b = pointers[ids[1]];
                pinch = {d: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale};
                pan = null;
            }
            e.preventDefault();
        });
        stage.addEventListener("pointermove", function (e) {
            if (!pointers[e.pointerId]) return;
            pointers[e.pointerId] = {x: e.clientX, y: e.clientY};
            var ids = Object.keys(pointers);
            if (pinch && ids.length === 2) {
                var a = pointers[ids[0]], b = pointers[ids[1]];
                var d = Math.hypot(a.x - b.x, a.y - b.y);
                if (pinch.d > 0) zoom(pinch.scale * d / pinch.d / view.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
            } else if (pan && view.scale > 1) {
                view.x = e.clientX - pan.x;
                view.y = e.clientY - pan.y;
                apply();
            }
        });
        function lift(e) {
            delete pointers[e.pointerId];
            if (Object.keys(pointers).length < 2) pinch = null;
            if (!Object.keys(pointers).length) pan = null;
        }
        stage.addEventListener("pointerup", lift);
        stage.addEventListener("pointercancel", lift);
        stage.addEventListener("dblclick", function (e) {
            if (view.scale > 1) zoom(1 / view.scale); else zoom(3, e.clientX, e.clientY);
        });

        // The keyboard is the viewer's while it is open: nothing reaches the page's own shortcuts
        function keys(e) {
            var used = true;
            if (e.key === "Escape") close();
            else if (e.key === "ArrowLeft") show(index - 1);
            else if (e.key === "ArrowRight") show(index + 1);
            else if (e.key === "+" || e.key === "=") zoom(1.5);
            else if (e.key === "-") zoom(1 / 1.5);
            else if (e.key !== "Tab") used = false;
            if (used || /^[a-z]$/i.test(e.key || "")) e.stopPropagation();
            if (used && e.key !== "Tab") e.preventDefault();
        }
        document.addEventListener("keydown", keys, true);

        function close() {
            document.removeEventListener("keydown", keys, true);
            if (root.parentNode) root.parentNode.removeChild(root);
            if (onClose) onClose(index);
        }

        show(index);
        // In the page element, so it stays shown in the page's fullscreen
        ctx.page.appendChild(root);
        closeButton.focus();
        return {element: root, close: close, show: show};
    }

    // The window of photos: the list, best first, and the chosen one with its details. Returns
    // {element, close, show(frames), fail(message), busy(on)}
    function buildWindow(ctx, onClose) {
        var t = ctx.texts;
        var box = el("div", "explorer-sf-window explorer-overlay theme-secondary theme-border-secondary-07");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", t.title);
        var head = el("div", "explorer-sf-head theme-background-highlight");
        var title = el("span", "explorer-sf-title", t.title);
        var spinner = icon("fa-spinner fa-spin explorer-sf-busy");
        spinner.setAttribute("aria-label", t.finding);
        spinner.hidden = true;
        var closeButton = el("button", "close explorer-sf-close");
        closeButton.type = "button";
        closeButton.title = t.close;
        closeButton.setAttribute("aria-label", t.close);
        closeButton.textContent = "×";
        head.appendChild(title);
        head.appendChild(spinner);
        head.appendChild(closeButton);
        var body = el("div", "explorer-sf-body");
        box.appendChild(head);
        box.appendChild(body);
        ctx.view.appendChild(box);
        draggable(box, head, ctx.view);
        // Presses, clicks and the wheel in the window stay out of the map or the model
        ["click", "dblclick", "mousedown", "pointerdown", "pointerup", "touchstart", "wheel", "contextmenu"].forEach(function (type) {
            box.addEventListener(type, function (e) { e.stopPropagation(); });
        });

        var selected = 0, list = null, main = null, full = null, frames = [];

        function details(frame) {
            var table = el("table", "table table-condensed explorer-sf-props");
            var rows = [[t.file, frame.filename], [t.captured, formatTime(frame.capture_time)],
                [t.camera, frame.camera ? String(frame.camera).replace(/^v2 /, "") : ""],
                [t.size, frame.width && frame.height ? frame.width + " × " + frame.height + " px" : ""],
                [t.altitude, typeof frame.altitude === "number" ? frame.altitude.toFixed(1) + " m" : ""]];
            var tbody = el("tbody");
            rows.forEach(function (row) {
                if (!row[1]) return;
                var tr = el("tr");
                tr.appendChild(el("th", "", row[0]));
                var td = el("td", "", row[1]);
                td.title = row[1];
                tr.appendChild(td);
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            return table;
        }

        function select(i) {
            selected = i;
            var frame = frames[i];
            Array.prototype.forEach.call(list.children, function (item, j) {
                item.classList.toggle("active", j === i);
                item.setAttribute("aria-selected", j === i ? "true" : "false");
            });
            main.textContent = "";
            var big = photo(ctx, frame, PHOTO, "explorer-sf-main-photo");
            big.title = t.open;
            big.addEventListener("click", openFull);
            main.appendChild(big);
            var actions = el("div", "explorer-sf-actions");
            var open = button("btn-primary explorer-sf-open", "fa-expand", t.open, t.open);
            open.classList.remove("btn-default");
            open.addEventListener("click", openFull);
            var download = button("explorer-sf-download", "fa-download", t.download, t.download);
            download.addEventListener("click", function () {
                ctx.assign(imageUrl(ctx.images, frame.filename, "download"));
            });
            actions.appendChild(open);
            if (ctx.download) actions.appendChild(download);
            main.appendChild(actions);
            main.appendChild(details(frame));
        }

        // Closed, the focus goes back to Open Full Frame, of the photo chosen in the viewer
        function openFull() {
            if (full) return;
            full = fullFrame(ctx, frames, selected, function (i) {
                full = null;
                if (!box.parentNode) return;
                if (i !== selected) {
                    select(i);
                    if (list.children[i] && list.children[i].scrollIntoView) list.children[i].scrollIntoView({block: "nearest"});
                }
                var back = main.querySelector(".explorer-sf-open");
                if (back) back.focus();
            });
        }

        function message(text, className) {
            body.textContent = "";
            body.appendChild(el("p", "explorer-sf-message" + (className ? " " + className : ""), text));
        }

        function busy(on) { spinner.hidden = !on; }

        function show(found) {
            busy(false);
            if (full) full.close();
            frames = found;
            title.textContent = t.title + " (" + frames.length + ")";
            if (!frames.length) {
                message(t.none, "text-muted");
                return;
            }
            body.textContent = "";
            list = el("div", "explorer-sf-list theme-border-secondary-07");
            list.setAttribute("role", "listbox");
            list.setAttribute("aria-label", t.list);
            frames.forEach(function (frame, i) {
                var item = el("button", "explorer-sf-item theme-secondary theme-border-secondary-07");
                item.type = "button";
                item.setAttribute("role", "option");
                item.title = frame.filename;
                var thumb = photo(ctx, frame, THUMB);
                thumb.querySelector("img").loading = "lazy";
                item.appendChild(thumb);
                item.appendChild(el("span", "explorer-sf-caption", "#" + (i + 1)));
                item.addEventListener("click", function () { select(i); });
                list.appendChild(item);
            });
            main = el("div", "explorer-sf-main");
            body.appendChild(list);
            body.appendChild(main);
            select(0);
        }

        function fail(text) {
            busy(false);
            if (full) full.close();
            frames = [];
            title.textContent = t.title;
            message(text, "text-danger");
        }

        function close() {
            if (full) full.close();
            if (box.parentNode) box.parentNode.removeChild(box);
            if (onClose) onClose();
        }
        closeButton.addEventListener("click", close);

        message(t.finding);
        return {element: box, close: close, show: show, fail: fail, busy: busy,
            fullOpen: function () { return !!full; }, select: select};
    }

    // The map's spot: a ring of Leaflet's at the click; Leaflet tells a click from the end of a drag
    function mapTool(L, map, colours) {
        var marker = null, handler = null;
        function stop() {
            if (handler) { map.off("click", handler); handler = null; }
            if (marker) { map.removeLayer(marker); marker = null; }
        }
        return {
            start: function (onSpot) {
                stop();
                handler = function (e) {
                    var latlng = e.latlng;
                    if (marker) marker.setLatLng(latlng);
                    else marker = L.circleMarker(latlng, {radius: 9, color: colours.spot, weight: 3, fillColor: colours.spot,
                        fillOpacity: 0.25, interactive: false}).addTo(map);
                    onSpot({type: "Point", coordinates: [latlng.lng, latlng.lat]});
                };
                map.on("click", handler);
            },
            stop: stop
        };
    }

    // The 3D page's spot: a click on the model (a press that hardly moves; a drag orbits) picks the point under it;
    // the scene's coordinates plus WebODM's offset are the task's
    function sceneTool(view, scene, colours) {
        var on = null;
        var api = {
            hint: null,
            start: function (onSpot) {
                api.stop();
                on = {at: null, picks: 0};
                on.down = function (e) {
                    on.at = e.button === 0 || e.pointerType === "touch" ? {x: e.clientX, y: e.clientY} : null;
                };
                on.up = function (e) {
                    var at = on.at;
                    on.at = null;
                    if (!at || Math.abs(e.clientX - at.x) > CLICK_SLOP || Math.abs(e.clientY - at.y) > CLICK_SLOP) return;
                    var mine = ++on.picks, current = on;
                    Promise.resolve(scene.pick(e.clientX, e.clientY)).then(function (p) {
                        if (on !== current || mine !== current.picks) return;
                        if (!p) {
                            if (api.hint) api.hint("nothing");
                            return;
                        }
                        scene.setMarker(p, colours);
                        var o = scene.offset;
                        onSpot({type: "Point", coordinates: [p.x + o.x, p.y + o.y, p.z + o.z], crs: "task"});
                    });
                };
                view.addEventListener("pointerdown", on.down, true);
                view.addEventListener("pointerup", on.up, true);
            },
            stop: function () {
                if (on) {
                    view.removeEventListener("pointerdown", on.down, true);
                    view.removeEventListener("pointerup", on.up, true);
                    on = null;
                }
                scene.setMarker(null);
            }
        };
        return api;
    }

    // page: the map or 3D page; options (for the tests): {fetch, assign, L, map, scene, colours}
    function init(page, options) {
        options = options || {};
        var toggleButton = page.querySelector("[data-tool=frames][data-frames-api]");
        var view = page.querySelector(".explorer-map, .explorer-scene");
        var textsScript = document.getElementById("explorer-frames-texts");
        if (!toggleButton || !view || !textsScript) return null;
        var csrfInput = page.querySelector("input[name=csrfmiddlewaretoken]");
        var ctx = {
            page: page, view: view, texts: JSON.parse(textsScript.textContent),
            api: toggleButton.getAttribute("data-frames-api"), images: toggleButton.getAttribute("data-images"),
            csrf: csrfInput ? csrfInput.value : "",
            // Download where allowed (a link that allows downloads too); a link refusing a request has been revoked
            download: toggleButton.getAttribute("data-download") !== "0", link: toggleButton.hasAttribute("data-link"),
            fetch: options.fetch || function (url, o) { return window.fetch(url, o); },
            assign: options.assign || function (url) { window.location.assign(url); },
            colours: null
        };
        var isMap = view.classList.contains("explorer-map");
        var on = false, label = null, box = null, tool = null, latest = 0, abort = null;

        function colours() {
            if (!ctx.colours) {
                var theme = options.colours || Present.themeColours(page);
                ctx.colours = {spot: theme.highlight, outline: theme.outline};
            }
            return ctx.colours;
        }

        // The map's or the scene's tool, once they exist (the 3D scene starts after its libraries load)
        function getTool() {
            if (tool) return tool;
            if (isMap) {
                var map = options.map || page.explorerMap, L = options.L || window.L;
                if (map && L) tool = mapTool(L, map, colours());
            } else {
                var scene = options.scene || (window.ExplorerViewer && window.ExplorerViewer.scene);
                if (scene && scene.offset) {
                    tool = sceneTool(view, scene, colours());
                    tool.hint = function (what) { showHint(ctx.texts[what]); };
                }
            }
            return tool;
        }

        function showHint(text) {
            if (!label) return;
            var hint = label.querySelector(".explorer-sf-hint");
            hint.textContent = text || "";
            hint.hidden = !text;
        }

        function onSpot(place) {
            showHint("");
            if (!box) {
                box = buildWindow(ctx, function () { box = null; off(); });
            } else {
                box.busy(true);
            }
            if (abort) abort.abort();
            abort = typeof window.AbortController === "function" ? new window.AbortController() : null;
            var mine = ++latest, target = box;
            findFrames(ctx.fetch, ctx.api, ctx.csrf, place, abort && abort.signal, ctx.texts.failed).then(function (found) {
                if (mine === latest && box === target) target.show(found);
            }, function (error) {
                if (mine !== latest || box !== target || (error && error.name === "AbortError")) return;
                var gone = ctx.link && (error.status === 404 || error.status === 403);
                target.fail(gone ? page.getAttribute("data-invalid") || error.message : error.message || ctx.texts.failed);
            });
        }

        function turnOn() {
            var t = getTool();
            if (!t) return;
            on = true;
            page.dispatchEvent(new window.CustomEvent("explorer-tool", {detail: {tool: "frames", source: "frames"}}));
            label = el("div", "explorer-sf-label theme-secondary theme-border-secondary-07");
            label.setAttribute("role", "status");
            label.appendChild(icon("fa-crosshairs"));
            label.appendChild(document.createTextNode(" " + ctx.texts.label));
            var hint = el("div", "explorer-sf-hint");
            hint.hidden = true;
            label.appendChild(hint);
            view.appendChild(label);
            view.classList.add("explorer-sf-picking");
            toggleButton.classList.add("active");
            toggleButton.setAttribute("aria-pressed", "true");
            t.start(onSpot);
        }

        function off() {
            if (!on) return;
            on = false;
            latest++;
            if (abort) { abort.abort(); abort = null; }
            if (tool) tool.stop();
            if (label && label.parentNode) label.parentNode.removeChild(label);
            label = null;
            view.classList.remove("explorer-sf-picking");
            toggleButton.classList.remove("active");
            toggleButton.setAttribute("aria-pressed", "false");
            if (box) { var b = box; box = null; b.close(); }
        }

        function toggle() { if (on) off(); else turnOn(); }

        toggleButton.addEventListener("click", toggle);
        page.addEventListener("explorer-tool", function (event) {
            if (event.detail && event.detail.source !== "frames") off();
        });
        document.addEventListener("keydown", function (event) {
            if (!Controls.isShortcut(event)) return;
            var key = (event.key || "").toLowerCase();
            if (key === "s") {
                toggle();
            } else if (key === "escape" && on) {
                off();
            } else {
                return;
            }
            event.preventDefault();
        });

        return {toggle: toggle, off: off, isOn: function () { return on; }, window: function () { return box; }};
    }

    function start() {
        var page = document.querySelector("[data-explorer-map], [data-explorer-viewer]");
        if (page) init(page);
    }

    var api = {init: init, findFrames: findFrames, overlay: overlay, formatTime: formatTime, imageUrl: imageUrl,
        mapTool: mapTool, sceneTool: sceneTool, CLICK_SLOP: CLICK_SLOP};
    if (node) {
        module.exports = api;
    } else {
        window.ExplorerFrames = api;
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
})();

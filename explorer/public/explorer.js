/*
 * The Explorer pages: the home's toolbar and its Settings panel for admins, card thumbnails (drawn from the task's tiles where
 * WebODM's thumbnail API can't make one, else a placeholder), and the project page's Share panel, which shows the
 * page's own link (for signed-in users the project is shared with) and, for users who can change the project, its
 * "anyone with the link" links: listed, created, changed and revoked through the plugin's API; and the Sharing Center,
 * every link the user may manage across projects (its filters in sharing.js).
 */
(function () {
    "use strict";
    var Layers = typeof module !== "undefined" && module.exports ? require("./layers.js") : window.ExplorerLayers;
    if (typeof module !== "undefined" && module.exports && !window.ExplorerSharing) window.ExplorerSharing = require("./sharing.js");
    // A drawn thumbnail: at most this many pixels across, twice a card's width for sharp screens
    var DRAWN_SIZE = 512;

    function copyText(input, done) {
        var text = input.value;
        // The Clipboard API needs a secure context (https or localhost); a WebODM on plain http falls back to the
        // selected text and execCommand.
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback()); });
        } else {
            done(fallback());
        }

        function fallback() {
            input.focus();
            input.select();
            // iOS Safari selects nothing in a read-only field with select() alone, yet execCommand says it copied
            if (input.setSelectionRange) input.setSelectionRange(0, input.value.length);
            try {
                return document.execCommand("copy");
            } catch (e) {
                return false;
            }
        }
    }

    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error("tile")); };
            img.src = url;
        });
    }

    // A thumbnail drawn from the task's tiles (a thermal orthophoto, or a DSM): the layer's metadata, then the few
    // 256-pixel tiles that show its bounds at most DRAWN_SIZE across, on a canvas cut to the bounds. Resolves to an
    // image URL; rejects when anything fails, and the card keeps its placeholder.
    function drawThumbnail(element) {
        var type = element.getAttribute("data-draw");
        var api = element.getAttribute("data-api");
        var crop = element.getAttribute("data-crop") === "1";
        return window.fetch(Layers.metadataUrl(api, type, crop), {credentials: "same-origin"}).then(function (response) {
            if (!response.ok) throw new Error(response.status);
            return response.json();
        }).then(function (metadata) {
            var area = Layers.cover(metadata.bounds.value, metadata.maxzoom, DRAWN_SIZE);
            var template = Layers.tileUrl(api, type, metadata, [], crop, Layers.TILE);
            var tiles = [];
            for (var y = area.y0; y <= area.y1; y++) {
                for (var x = area.x0; x <= area.x1; x++) {
                    tiles.push({x: x, y: y, url: template.replace("{z}", area.z).replace("{x}", x).replace("{y}", y)});
                }
            }
            return Promise.all(tiles.map(function (tile) {
                return loadImage(tile.url).then(function (img) { tile.img = img; return tile; });
            })).then(function () {
                var canvas = document.createElement("canvas");
                canvas.width = area.width;
                canvas.height = area.height;
                var context = canvas.getContext("2d");
                // Whole pixels: at a fractional offset each tile's edge is blended with the empty canvas, a seam
                var left = Math.round(area.left), top = Math.round(area.top);
                tiles.forEach(function (tile) {
                    context.drawImage(tile.img, (tile.x - area.x0) * Layers.TILE - left, (tile.y - area.y0) * Layers.TILE - top);
                });
                return canvas.toDataURL("image/png");
            });
        });
    }

    function placeholderFor(img) {
        var placeholder = document.createElement("div");
        placeholder.className = "explorer-thumbnail explorer-no-thumbnail theme-border-secondary-07";
        ["data-draw", "data-api", "data-crop"].forEach(function (name) {
            if (img.hasAttribute(name)) placeholder.setAttribute(name, img.getAttribute(name));
        });
        var icon = document.createElement("i");
        icon.className = img.getAttribute("data-placeholder-icon");
        placeholder.appendChild(icon);
        return placeholder;
    }

    // A placeholder that names a layer to draw becomes that drawing once it is near the screen
    function drawWhenSeen(placeholder) {
        function draw() {
            drawThumbnail(placeholder).then(function (url) {
                var img = document.createElement("img");
                img.className = "explorer-thumbnail";
                img.alt = "";
                img.src = url;
                if (placeholder.parentNode) placeholder.parentNode.replaceChild(img, placeholder);
            }, function () { /* the placeholder stays */ });
        }
        if (typeof window.IntersectionObserver === "undefined") {
            draw();
            return;
        }
        var observer = new window.IntersectionObserver(function (entries) {
            if (entries.some(function (entry) { return entry.isIntersecting; })) {
                observer.disconnect();
                draw();
            }
        }, {rootMargin: "200px"});
        observer.observe(placeholder);
    }

    // WebODM's thumbnail endpoint answers 404 for an orthophoto with fewer than three colour bands (a thermal one):
    // such a card gets a placeholder, drawn from the task's tiles when the card names a layer to draw.
    function useThumbnailPlaceholder(img) {
        var placeholder = placeholderFor(img);
        if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
        if (placeholder.hasAttribute("data-draw")) drawWhenSeen(placeholder);
    }

    function watchThumbnails(root) {
        var images = root.querySelectorAll("img.explorer-thumbnail");
        for (var i = 0; i < images.length; i++) {
            var img = images[i];
            // An image that failed before this script ran has finished loading with no size.
            if (img.complete && img.naturalWidth === 0) {
                useThumbnailPlaceholder(img);
            } else {
                img.addEventListener("error", function (e) { useThumbnailPlaceholder(e.target); });
            }
        }
        var drawn = root.querySelectorAll(".explorer-no-thumbnail[data-draw]");
        for (var j = 0; j < drawn.length; j++) drawWhenSeen(drawn[j]);
    }

    // The value of a name in a query string ("?a=1&b=2"), or ""
    function queryValue(search, name) {
        var pairs = (search || "").replace(/^\?/, "").split("&");
        for (var i = 0; i < pairs.length; i++) {
            var at = pairs[i].indexOf("=");
            if (at !== -1 && decodeURIComponent(pairs[i].slice(0, at)) === name) {
                return decodeURIComponent(pairs[i].slice(at + 1).replace(/\+/g, " "));
            }
        }
        return "";
    }

    // The home's List view: choosing a project in the folder pane swaps the right pane in place (the pane alone, from
    // the server) and keeps the address, so Back and Forward work; Up and Down move the selection. A choice made
    // while another is loading wins: the older answer is dropped. On a phone the pane replaces the folder pane, with
    // Back to Projects.
    var KEY_DELAY = 150;  // ms: holding Up or Down loads only where it stops
    function initListView(root) {
        var list = root.querySelector("[data-explorer-list]");
        if (!list) return;
        var paneUrl = list.getAttribute("data-pane-url");
        var content = list.querySelector(".explorer-pane-content");
        var back = list.querySelector(".explorer-pane-back");
        var items = Array.prototype.slice.call(list.querySelectorAll(".explorer-folder-item"));
        var latest = 0;
        var keyTimer = null;

        function itemFor(id) {
            return items.filter(function (item) { return item.getAttribute("data-project") === id; })[0];
        }

        function mark(item) {
            items.forEach(function (other) {
                other.classList.toggle("active", other === item);
                other.classList.toggle("theme-background-highlight", other === item);
                if (other === item) other.setAttribute("aria-current", "true");
                else other.removeAttribute("aria-current");
            });
        }

        // The home's search narrows the pane's tasks to those it matches; Show All Tasks (all) loads them all
        function load(item, all) {
            var mine = ++latest;
            var q = all ? "" : queryValue(window.location.search, "q");
            content.setAttribute("aria-busy", "true");
            return window.fetch(paneUrl + item.getAttribute("data-project") + "/" + (q ? "?q=" + encodeURIComponent(q) : ""), {credentials: "same-origin",
                headers: {"Accept": "text/html"}}).then(function (response) {
                if (!response.ok) throw new Error(response.status);
                return response.text();
            }).then(function (html) {
                if (mine !== latest) return;
                content.innerHTML = html;
                content.removeAttribute("aria-busy");
                watchThumbnails(content);
            }, function () {
                if (mine !== latest) return;
                content.removeAttribute("aria-busy");
                content.innerHTML = "";
                content.appendChild(element("p", "explorer-card-text explorer-pane-error", list.getAttribute("data-error")));
            });
        }

        // history: "push" (a click: Back returns to the previous project), "replace" (keys) or none (Back, Forward)
        function choose(item, history) {
            mark(item);
            list.classList.add("explorer-list-chosen");
            if (history && window.history && window.history.pushState) {
                window.history[history === "push" ? "pushState" : "replaceState"]({project: item.getAttribute("data-project")},
                    "", item.getAttribute("href"));
            }
            return load(item);
        }

        items.forEach(function (item) {
            item.addEventListener("click", function (event) {
                // A new tab or window opens the page as it is
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                clearTimeout(keyTimer);
                choose(item, "push");
            });
            item.addEventListener("keydown", function (event) {
                var step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                var next = items[items.indexOf(item) + step];
                event.preventDefault();
                if (!next) return;
                next.focus();
                mark(next);
                clearTimeout(keyTimer);
                keyTimer = setTimeout(function () { choose(next, "replace"); }, KEY_DELAY);
            });
        });

        content.addEventListener("click", function (event) {
            var all = event.target.closest && event.target.closest("[data-pane-all]");
            if (!all || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            var item = itemFor(all.getAttribute("data-pane-all"));
            if (!item) return;
            event.preventDefault();
            load(item, true);
        });

        if (back) {
            back.addEventListener("click", function (event) {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                list.classList.remove("explorer-list-chosen");
                if (window.history && window.history.pushState) window.history.pushState({project: ""}, "", back.getAttribute("href"));
                var active = list.querySelector(".explorer-folder-item.active");
                if (active) active.focus();
            });
        }

        window.addEventListener("popstate", function () {
            if (!document.documentElement.contains(list)) return;  // a list no longer on the page
            var id = queryValue(window.location.search, "project");
            var item = itemFor(id) || items[0];
            list.classList.toggle("explorer-list-chosen", !!id);
            if (!item) return;
            mark(item);
            // Back to Projects and forward again on a phone shows the same project: nothing to load
            var shown = content.querySelector("[data-pane-project]");
            if (!shown || shown.getAttribute("data-pane-project") !== item.getAttribute("data-project")) load(item);
        });
    }

    // A field disabled while its change is saved loses the keyboard focus: given back when it is enabled again
    function busy(field, on) {
        if (on) {
            field.explorerHadFocus = document.activeElement === field;
            field.disabled = true;
            return;
        }
        field.disabled = false;
        if (field.explorerHadFocus && document.activeElement === document.body) field.focus();
        field.explorerHadFocus = false;
    }

    // The server's reason for refusing a change (DRF: {"detail": ...} or {"<field>": message or [messages]}), else null
    function refusal(response, field) {
        return response.json().then(function (data) {
            var said = data && (data[field] || data.detail);
            if (Array.isArray(said)) said = said[0];
            return typeof said === "string" && said ? said : null;
        }, function () { return null; });
    }

    // The Explorer Settings page, for WebODM's superusers: each change is saved at once. A switch that couldn't be
    // saved goes back; an address the server refuses stays in the field with the server's reason, to be corrected.
    function initSettings(root) {
        var form = root.querySelector("[data-settings-api]");
        if (!form) return;
        var error = form.querySelector(".explorer-settings-error");
        function save(field, change, apply, undo) {
            busy(field, true);
            error.hidden = true;
            return window.fetch(form.getAttribute("data-settings-api"), {
                method: "PATCH", credentials: "same-origin",
                headers: {"Content-Type": "application/json", "X-CSRFToken": form.elements.csrfmiddlewaretoken.value},
                body: JSON.stringify(change)
            }).then(function (response) {
                if (response.ok) return response.json();
                return refusal(response, field.name).then(function (said) { throw new Error(said || ""); });
            }, function () {
                throw new Error("");
            }).then(apply, function (e) {
                undo();
                error.textContent = e.message || form.getAttribute("data-error");
                error.hidden = false;
            }).then(function () { busy(field, false); });
        }
        // Each choice (Links to Private Projects) by its field's name; back to the saved one if it can't be saved
        var choices = form.querySelectorAll("select");
        Array.prototype.forEach.call(choices, function (select) {
            var saved = select.value;
            select.addEventListener("change", function () {
                var change = {};
                change[select.name] = select.value;
                save(select, change,
                    function (result) { saved = select.value = result[select.name]; },
                    function () { select.value = saved; });
            });
        });
        // Each switch (Basemaps on Links) by its field's name
        var boxes = form.querySelectorAll("input[type=checkbox]");
        Array.prototype.forEach.call(boxes, function (box) {
            box.addEventListener("change", function () {
                var wanted = box.checked, change = {};
                change[box.name] = wanted;
                save(box, change,
                    function (saved) { box.checked = saved[box.name]; },
                    function () { box.checked = !wanted; });
            });
        });
        // The address is saved when the field is left or Enter is pressed, shown as the server cleaned it. Enter then
        // leaving the field asks once: a value being saved, or refused already, isn't sent again.
        var address = form.elements.public_address;
        if (address) {
            var savedAddress = address.value;
            var sent = null;
            var saveAddress = function () {
                var value = address.value.trim();
                if (value === savedAddress || value === sent) return;
                sent = value;
                save(address, {public_address: value},
                    function (saved) {
                        savedAddress = address.value = saved.public_address;
                        sent = null;
                    },
                    function () { /* kept as typed, with the reason above */ });
            };
            address.addEventListener("change", saveAddress);
            // Typing again after a refusal makes the value worth sending
            address.addEventListener("input", function () { if (address.value.trim() !== sent) sent = null; });
            form.addEventListener("submit", function (event) {
                event.preventDefault();
                saveAddress();
            });
        }
    }

    // The home's search filters as the user types: from the second letter, or when emptied (everything again), the
    // same page is fetched for the new search after a short pause and its results swapped in place, with the address
    // updated. One letter waits for Enter or the search button. An older answer arriving late is dropped. Returns
    // whether a submit is the search's (Enter, the search button) and handled here; a changed filter still loads the
    // page.
    var SEARCH_DELAY = 250;  // ms after the last keystroke
    function initLiveSearch(root, form) {
        var results = root.querySelector("[data-explorer-results]");
        var box = form.elements.q;
        var button = form.querySelector("[type=submit]");
        if (!results || !box || !window.fetch || !window.DOMParser) return function () { return false; };
        var timer = null, latest = 0, shown = box.value.trim();

        // The form's fields as its submit sends them (empty and default values left out, so back to the first page),
        // with the search q; List view keeps its chosen project, which the server keeps while it is still listed
        function address(q) {
            var pairs = [];
            Array.prototype.forEach.call(form.querySelectorAll("[name]"), function (field) {
                if (field.type === "checkbox" && !field.checked) return;
                var value = field.name === "q" ? q : field.value;
                if (value === "" || value === field.getAttribute("data-default")) return;
                pairs.push(encodeURIComponent(field.name) + "=" + encodeURIComponent(value));
            });
            var project = queryValue(window.location.search, "project");
            if (project) pairs.push("project=" + encodeURIComponent(project));
            return pairs.length ? "?" + pairs.join("&") : window.location.pathname;
        }

        function failed() {
            results.removeAttribute("aria-busy");
            shown = null;  // the next keystroke or Enter tries again
            var note = results.querySelector(".explorer-search-error");
            if (!note) {
                note = element("p", "explorer-card-text explorer-search-error", form.getAttribute("data-search-error"));
                results.insertBefore(note, results.firstChild);
            }
        }

        function search(q) {
            clearTimeout(timer);
            if (q === shown) return;
            shown = q;
            var mine = ++latest, url = address(q);
            results.setAttribute("aria-busy", "true");
            window.fetch(url, {credentials: "same-origin", headers: {"Accept": "text/html"}}).then(function (response) {
                if (!response.ok) throw new Error(response.status);
                return response.text();
            }).then(function (html) {
                if (mine !== latest) return;
                var page = new window.DOMParser().parseFromString(html, "text/html");
                var fresh = page.querySelector("[data-explorer-results]");
                if (!fresh) throw new Error("no results");
                results.innerHTML = fresh.innerHTML;
                results.removeAttribute("aria-busy");
                // Grid, List and Map carry the search too
                var views = page.querySelector(".explorer-view-switch"), ours = form.querySelector(".explorer-view-switch");
                if (views && ours) ours.innerHTML = views.innerHTML;
                if (window.history && window.history.replaceState) window.history.replaceState(window.history.state, "", url);
                watchThumbnails(results);
                initListView(results);
                if (window.ExplorerFootprints && window.L) window.ExplorerFootprints.init(results, window.L);
            }).catch(function () {
                if (mine === latest) failed();
            });
        }

        box.addEventListener("input", function () {
            var q = box.value.trim();
            clearTimeout(timer);
            if (q.length === 1) return;
            timer = setTimeout(function () { search(q); }, SEARCH_DELAY);
        });
        return function (event) {
            // Enter in the box submits through the form's default button, the search button; a changed filter has none
            if (!button || event.submitter !== button) return false;
            search(box.value.trim());
            return true;
        };
    }

    // The home's toolbar is a plain GET form; a changed scope, sort or filter applies at once. Empty and default values
    // stay out of the address, as the page's own links leave them out.
    function initToolbar(root) {
        var form = root.querySelector("[data-explorer-toolbar]");
        if (!form) return;
        var liveSearch = initLiveSearch(root, form);
        form.addEventListener("submit", function (event) {
            if (liveSearch(event)) {
                event.preventDefault();
                return;
            }
            var named = form.querySelectorAll("[name]");
            for (var i = 0; i < named.length; i++) {
                var field = named[i];
                if (field.value === "" || field.value === field.getAttribute("data-default")) field.disabled = true;
            }
        });
        // Back to this page from the browser's cache: the fields left out are usable again
        window.addEventListener("pageshow", function () {
            var named = form.querySelectorAll("[name]");
            for (var i = 0; i < named.length; i++) named[i].disabled = false;
        });
        var fields = form.querySelectorAll("select, input[type=checkbox]");
        for (var i = 0; i < fields.length; i++) {
            fields[i].addEventListener("change", function () {
                if (form.requestSubmit) form.requestSubmit(); else form.submit();
            });
        }
    }

    // The address of the project page with its Share panel open (after Allow Links reloads it)
    var SHARE_OPEN = "#share";

    // A superuser's Allow Links for a private project (Links for Public Projects Only): saved at once, then the page
    // is loaded again with the Share panel open, since what the panel offers depends on it. A failure says so beside
    // the box.
    function initAllowLinks(root, reload) {
        var form = root.querySelector("[data-allowed-api]");
        if (!form) return;
        var box = form.elements.allowed;
        var csrf = root.querySelector("input[name=csrfmiddlewaretoken]");
        box.addEventListener("change", function () {
            var wanted = box.checked;
            box.disabled = true;
            window.fetch(form.getAttribute("data-allowed-api"), {
                method: "PATCH", credentials: "same-origin",
                headers: {"Content-Type": "application/json", "X-CSRFToken": csrf ? csrf.value : ""},
                body: JSON.stringify({allowed: wanted})
            }).then(function (response) {
                if (!response.ok) throw new Error(response.status);
                (reload || function () {
                    window.location.hash = SHARE_OPEN;
                    window.location.reload();
                })();
            }).catch(function () {
                box.checked = !wanted;
                box.disabled = false;
                box.focus();
                var error = form.querySelector(".explorer-allowed-error");
                if (error) {
                    error.textContent = form.getAttribute("data-error");
                    error.hidden = false;
                }
            });
        });
    }

    function init(root, options) {
        initToolbar(root);
        initSettings(root);
        initAllowLinks(root, options && options.reload);
        watchThumbnails(root);
        initShare(root);
        initLinks(root);
        initSharingCenter(root);
        initListView(root);
    }

    // The button says "Copied" for a moment after a copy; a copy the browser refuses leaves the text selected. Its
    // label is kept once, so a second click while it says "Copied" doesn't keep "Copied" for good.
    function wireCopy(button, input, copiedText) {
        var label = button.innerHTML;
        var timer = null;
        button.addEventListener("click", function () {
            copyText(input, function (ok) {
                if (!ok) return;
                button.textContent = copiedText;
                clearTimeout(timer);
                timer = setTimeout(function () { button.innerHTML = label; }, 1500);
            });
        });
    }

    function initShare(root) {
        var shareButton = root.querySelector("[data-explorer-share]");
        var panel = root.querySelector("#explorer-share");
        if (!shareButton || !panel) return;
        var input = panel.querySelector("#explorer-share-link") || panel.querySelector("input");
        var copyButton = panel.querySelector("[data-explorer-copy]");

        // The template renders the path; the full link uses the address the visitor reached WebODM by. From the data
        // attribute, not the field: a browser restoring the field's value on reload or back would double the origin.
        input.value = window.location.origin + (input.getAttribute("data-path") || input.value);

        function show(opening) {
            panel.hidden = !opening;
            shareButton.setAttribute("aria-expanded", opening ? "true" : "false");
        }
        shareButton.addEventListener("click", function () {
            show(panel.hidden);
            if (!panel.hidden) input.select();
        });
        if (window.location.hash === SHARE_OPEN) show(true);

        wireCopy(copyButton, input, copyButton.getAttribute("data-copied"));
    }

    function escapeAttribute(value) {
        return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // The iframe code for a link's page or one of its views (path below the link's page, "" for the page itself),
    // in Explorer's embed layout (?embed=1). Fullscreen allowed; loaded when the host page scrolls to it.
    function embedCode(linkUrl, path, title) {
        var url = linkUrl + (path || "");
        url += (url.indexOf("?") === -1 ? "?" : "&") + "embed=1";
        return '<iframe src="' + escapeAttribute(url) + '" title="' + escapeAttribute(title) + '" width="100%" ' +
            'height="480" style="border: 0;" allow="fullscreen" allowfullscreen loading="lazy"></iframe>';
    }

    function readJson(root, id, empty) {
        var script = root.getElementById ? root.getElementById(id) : document.getElementById(id);
        if (!script) return empty === undefined ? [] : empty;
        try { return JSON.parse(script.textContent) || empty || []; } catch (e) { return empty === undefined ? [] : empty; }
    }

    function element(tag, className, content) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (content) node.textContent = content;
        return node;
    }

    // Requests to the plugin's API. WebODM's CSRF check applies to it, so every request carries the page's token; a
    // refusal rejects with the server's reason (or fallback) and the status.
    function apiClient(csrf, fallback) {
        return function request(method, url, body) {
            var options = {method: method, credentials: "same-origin",
                headers: {"X-CSRFToken": csrf, "Accept": "application/json"}};
            if (body) {
                options.headers["Content-Type"] = "application/json";
                options.body = JSON.stringify(body);
            }
            return window.fetch(url, options).then(function (response) {
                if (response.ok) return response.status === 204 ? null : response.json();
                function failure(message) {
                    var error = new Error(message);
                    error.status = response.status;
                    return error;
                }
                return response.json().then(function (data) {
                    var said = data && (data.detail || data.label || data.expires_days);
                    if (Array.isArray(said)) said = said[0];
                    throw failure(typeof said === "string" && said ? said : fallback);
                }, function () {
                    throw failure(fallback);
                });
            });
        };
    }

    function button(className, caption, title) {
        var node = element("button", "btn " + className, caption);
        node.type = "button";
        if (title) node.title = title;
        return node;
    }

    // A panel shown and hidden by a button (Embed, Edit), which says whether it is open
    function toggles(trigger, panel, opened) {
        trigger.setAttribute("aria-expanded", "false");
        trigger.addEventListener("click", function () {
            panel.hidden = !panel.hidden;
            trigger.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
            if (!panel.hidden && opened) opened();
        });
    }

    // Embed: pick the whole page or a task's view, then copy the iframe code. ctx: {text, origin, views (the project's
    // tasks and their views), title, signIn() (whether the link asks for a login now)}
    function embedBox(link, ctx) {
        var text = ctx.text;
        var panel = element("div", "explorer-embed");
        panel.hidden = true;
        var label = element("label", "explorer-embed-pick explorer-card-text", text("embed-label"));
        var select = element("select", "form-control input-sm");
        var page = element("option", null, text("embed-page"));
        page.value = "";
        select.appendChild(page);
        (ctx.views || []).forEach(function (task) {
            var group = element("optgroup");
            group.label = task.task;
            task.views.forEach(function (view) {
                var option = element("option", null, view.label);
                option.value = view.path;
                group.appendChild(option);
            });
            select.appendChild(group);
        });
        label.appendChild(select);
        panel.appendChild(label);
        var group = element("div", "input-group input-group-sm");
        var code = element("textarea", "form-control explorer-embed-code");
        code.readOnly = true;
        code.rows = 3;
        code.setAttribute("aria-label", text("embed-code"));
        group.appendChild(code);
        var buttons = element("span", "input-group-btn");
        var copy = button("btn-default", text("copy"));
        wireCopy(copy, code, text("copied"));
        buttons.appendChild(copy);
        group.appendChild(buttons);
        panel.appendChild(group);
        panel.appendChild(element("p", "explorer-card-text", text("embed-note")));
        // A link that asks for a login shows in another site's frame only to visitors signed in to this WebODM
        // in the same browser, which most browsers prevent (third-party cookies)
        var signInNote = element("p", "explorer-card-text", text("embed-sign-in"));
        panel.appendChild(signInNote);
        function update() {
            signInNote.hidden = !ctx.signIn();
            code.value = embedCode(ctx.origin + link.path, select.value, ctx.title || "");
        }
        select.addEventListener("change", update);
        update();
        panel.explorerRefresh = update;  // the link's Require Sign-In may have changed since
        return panel;
    }

    // Edit: a link's label and expiry (7, 30 or 90 days from today, or never), or the current expiry kept. On an
    // expired link it is Renew: a new expiry is needed, and the same URL works again. ctx: {text, request, url (the
    // link's API), saved(updated link), failed(message)}
    function editBox(link, ctx) {
        var text = ctx.text;
        var renew = !!link.expired;
        var form = element("form", "explorer-link-edit");
        form.hidden = true;
        var label = element("input", "form-control input-sm");
        label.name = "label";
        label.maxLength = 100;
        label.value = link.label || "";
        label.placeholder = text("label-placeholder") || "";
        label.setAttribute("aria-label", text("label"));
        form.appendChild(label);
        var expiry = element("select", "form-control input-sm");
        expiry.name = "expires_days";
        expiry.setAttribute("aria-label", text("expiry"));
        if (!renew) {
            var keep = element("option", null, text("keep-expiry"));
            keep.value = "";
            expiry.appendChild(keep);
        }
        ["7", "30", "90", "never"].forEach(function (value) {
            var option = element("option", null, text("expiry-" + value));
            option.value = value;
            option.selected = renew && value === "30";
            expiry.appendChild(option);
        });
        form.appendChild(expiry);
        var save = element("button", "btn btn-primary btn-sm", renew ? text("renew") : text("save"));
        save.type = "submit";
        form.appendChild(save);
        var cancel = button("btn-default btn-sm", text("cancel"));
        form.appendChild(cancel);
        function close() {
            form.hidden = true;
            label.value = link.label || "";
            expiry.selectedIndex = renew ? 1 : 0;
            if (form.explorerTrigger) {
                form.explorerTrigger.setAttribute("aria-expanded", "false");
                form.explorerTrigger.focus();
            }
        }
        cancel.addEventListener("click", close);
        form.addEventListener("submit", function (event) {
            event.preventDefault();
            var change = window.ExplorerSharing.editChange(link, label.value, expiry.value);
            if (!change) {
                close();
                return;
            }
            save.disabled = true;
            ctx.request("PATCH", ctx.url, change).then(function (updated) {
                save.disabled = false;
                ctx.saved(updated);
            }, function (e) {
                save.disabled = false;
                ctx.failed(e.message, e.status);
            });
        });
        return form;
    }

    // A link's Allow Downloads, Require Sign-In, Allow Source Photos or Allow All Task Files (name), changed at once; the
    // box goes back if the change fails.
    // ctx: {request, url (the link's API), forced (Require Sign-In fixed on by Explorer Settings), forcedTitle,
    // disabled, done(message or ""), changed() (after each change, done or not)}
    function linkToggle(link, name, caption, ctx) {
        var label = element("label", "explorer-link-downloads explorer-card-text");
        var toggle = element("input");
        toggle.type = "checkbox";
        toggle.name = name;
        var forced = name === "sign_in" && ctx.forced;
        toggle.checked = !!link[name] || forced;
        toggle.disabled = forced || !!ctx.disabled;
        if (forced) label.title = ctx.forcedTitle || "";
        toggle.addEventListener("change", function () {
            var wanted = toggle.checked, change = {};
            change[name] = wanted;
            busy(toggle, true);
            ctx.request("PATCH", ctx.url, change).then(function (updated) {
                link[name] = !!updated[name];
                toggle.checked = link[name];
                ctx.done("");
            }, function (e) {
                toggle.checked = !wanted;
                ctx.done(e.message);
            }).then(function () {
                busy(toggle, false);
                if (ctx.changed) ctx.changed();
            });
        });
        label.appendChild(toggle);
        label.appendChild(document.createTextNode(" " + caption));
        return label;
    }

    // A link's file options: Allow Downloads, Allow Source Photos and Allow All Task Files, which works only with Allow
    // Downloads, so its box is greyed out (keeping its value) while downloads are off. ctx as linkToggle's, per link.
    function linkFileToggles(link, text, ctx) {
        var all = linkToggle(link, "all_files", text("all-files"), ctx);
        var box = all.querySelector("input");
        all.title = text("all-files-title") || "";
        ctx.changed = function () { box.disabled = !!ctx.disabled || !link.downloads; };
        ctx.changed();
        return [linkToggle(link, "downloads", text("downloads"), ctx), linkToggle(link, "photos", text("photos"), ctx),
            all];
    }

    // A create form's Allow All Task Files, usable only while its Allow Downloads is ticked
    function formFileOptions(form) {
        var downloads = form.elements.downloads, all = form.elements.all_files;
        function sync() {
            all.disabled = !downloads.checked;
            if (all.disabled) all.checked = false;
        }
        downloads.addEventListener("change", sync);
        sync();
        return {
            values: function () {
                return {downloads: downloads.checked, photos: form.elements.photos.checked, all_files: all.checked};
            },
            reset: function () {
                downloads.checked = false;
                form.elements.photos.checked = false;
                sync();
            }
        };
    }

    function expiryText(text, link) {
        if (!link.expires) return text("never");
        var date = new Date(link.expires).toLocaleDateString();
        return (link.expired ? text("expired-on") : text("expires")).replace("%(date)s", date);
    }

    // The link page as anyone with the link sees it, in a new tab (this user's session changes nothing there)
    function openButton(text, link) {
        var open = element("a", "btn btn-default", text("open"));
        open.href = link.path;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.title = text("open-title");
        return open;
    }

    // The Share panel's links: the project's live links, listed, created, changed and revoked
    function initLinks(root) {
        var box = root.querySelector("[data-links-api]");
        if (!box) return;
        var api = box.getAttribute("data-links-api");
        var list = box.querySelector(".explorer-links-list");
        var form = box.querySelector(".explorer-link-form");
        var submit = form.querySelector("[type=submit]");
        var fileOptions = formFileOptions(form);
        var errorBox = box.querySelector(".explorer-links-error");
        var csrf = form.querySelector("input[name=csrfmiddlewaretoken]").value;

        function text(name) {
            return box.getAttribute("data-" + name);
        }

        // Explorer's Public Address where the admin set one (WebODM reached through a tunnel), else the browser's
        var origin = text("origin") || window.location.origin;
        var request = apiClient(csrf, text("error"));

        function showError(message) {
            errorBox.textContent = message || "";
            errorBox.hidden = !message;
        }

        var embedViews = readJson(root, "explorer-embed-views");
        // Every link of this project asks for a login (a private project under Signed-In Users Only)
        var signInForced = box.hasAttribute("data-sign-in-forced");

        function renderLink(link) {
            var row = element("div", "explorer-link theme-border-secondary-07");
            row.setAttribute("data-token", link.token);
            var url = api + link.token + "/";
            var toggleCtx = {request: request, url: url, forced: signInForced, forcedTitle: text("forced-title"),
                done: showError};
            var heading = element("div", "explorer-link-heading");
            heading.appendChild(element("span", "explorer-card-title", link.label || text("untitled")));
            heading.appendChild(element("span", "explorer-card-text", expiryText(text, link)));
            linkFileToggles(link, text, toggleCtx).forEach(function (toggle) { heading.appendChild(toggle); });
            heading.appendChild(linkToggle(link, "sign_in", text("sign-in"), toggleCtx));
            row.appendChild(heading);

            var group = element("div", "input-group input-group-sm explorer-link-group");
            var input = element("input", "form-control explorer-link-address");
            input.type = "text";
            input.readOnly = true;
            input.value = origin + link.path;
            input.setAttribute("aria-label", link.label || text("untitled"));
            group.appendChild(input);
            var buttons = element("span", "input-group-btn");
            var copy = button("btn-default", text("copy"));
            wireCopy(copy, input, text("copied"));
            var revoke = button("btn-danger", text("revoke"));
            revoke.addEventListener("click", function () {
                if (!window.confirm(text("confirm-revoke"))) return;
                revoke.disabled = true;
                request("DELETE", url).then(load, function (e) {
                    revoke.disabled = false;
                    showError(e.message);
                    // Revoked or expired meanwhile (another tab, another admin): the list as it is now
                    if (e.status === 404) load().then(function () { showError(e.message); });
                });
            });
            var embedPanel = embedBox(link, {text: text, origin: origin, views: embedViews, title: text("project-name"),
                signIn: function () { return !!link.sign_in || signInForced; }});
            var embed = button("btn-default", text("embed"), text("embed-title"));
            toggles(embed, embedPanel, function () {
                embedPanel.explorerRefresh();
                embedPanel.querySelector("textarea").select();
            });
            var editForm = editBox(link, {text: text, request: request, url: url, saved: function () {
                showError("");
                load();
            }, failed: function (message, status) {
                showError(message);
                if (status === 404) load().then(function () { showError(message); });
            }});
            var edit = button("btn-default", text("edit"), text("edit-title"));
            editForm.explorerTrigger = edit;
            toggles(edit, editForm, function () { editForm.elements.label.focus(); });
            buttons.appendChild(openButton(text, link));
            buttons.appendChild(embed);
            buttons.appendChild(edit);
            buttons.appendChild(copy);
            buttons.appendChild(revoke);
            group.appendChild(buttons);
            row.appendChild(group);
            row.appendChild(editForm);
            row.appendChild(embedPanel);
            return row;
        }

        function render(links) {
            list.innerHTML = "";
            if (!links.length) list.appendChild(element("p", "explorer-card-text", text("none")));
            for (var i = 0; i < links.length; i++) list.appendChild(renderLink(links[i]));
        }

        function load() {
            return request("GET", api).then(function (links) {
                showError("");
                render(links);
            }, function (e) {
                showError(e.message);
            });
        }

        form.addEventListener("submit", function (e) {
            e.preventDefault();
            submit.disabled = true;
            var signIn = form.elements.sign_in;
            var created = fileOptions.values();
            created.label = form.elements.label.value;
            created.expires_days = form.elements.expires_days.value;
            created.sign_in = signIn ? signIn.checked : false;
            request("POST", api, created)
                .then(function (link) {
                    form.elements.label.value = "";
                    fileOptions.reset();
                    if (signIn && !signInForced) signIn.checked = false;
                    return load().then(function () {
                        var input = list.querySelector('[data-token="' + link.token + '"] .explorer-link-address');
                        if (input) input.select();
                    });
                }, function (e) {
                    showError(e.message);
                })
                .then(function () { submit.disabled = false; });
        });

        load();
    }

    // The Sharing Center: every link of the projects the user may manage, filtered on the page (the filters kept in
    // its address), with the Share panel's actions, Renew and Delete for expired links, and Create Link for any of
    // those projects. Changes go through each project's links API, as in its Share panel.
    function initSharingCenter(root) {
        var box = root.querySelector("[data-all-links-api]");
        // Without a project the user may manage, the page has only its note
        if (!box || !box.querySelector(".explorer-sharing-rows")) return;
        var Sharing = window.ExplorerSharing;
        var api = box.getAttribute("data-all-links-api");
        var body = box.querySelector(".explorer-sharing-rows");
        var table = box.querySelector(".explorer-sharing-table");
        var empty = box.querySelector(".explorer-sharing-empty");
        var errorBox = box.querySelector(".explorer-links-error");
        var filtersForm = box.querySelector(".explorer-sharing-filters");
        var createForm = box.querySelector(".explorer-sharing-create");
        var csrf = box.querySelector("input[name=csrfmiddlewaretoken]").value;
        var projects = readJson(root, "explorer-sharing-projects");
        var embedViews = readJson(root, "explorer-embed-views", {});
        var links = [];
        var loaded = false;

        function text(name) {
            return box.getAttribute("data-" + name);
        }

        var origin = text("origin") || window.location.origin;
        var request = apiClient(csrf, text("error"));

        function showError(message) {
            errorBox.textContent = message || "";
            errorBox.hidden = !message;
        }

        var filters = Sharing.readFilters(window.location.search);

        function fillFilters() {
            Object.keys(filters).forEach(function (name) {
                var field = filtersForm.elements[name];
                if (field) field.value = filters[name];
            });
            // A project filter for a project no longer listed shows them all
            if (filtersForm.elements.project.value !== filters.project) filters.project = "";
        }

        function readForm() {
            Object.keys(Sharing.DEFAULTS).forEach(function (name) {
                var field = filtersForm.elements[name];
                if (field) filters[name] = field.value;
            });
            if (window.history && window.history.replaceState) {
                window.history.replaceState(null, "", window.location.pathname + Sharing.writeFilters(filters));
            }
        }

        function cell(row, labelName, className) {
            var td = element("td", className);
            td.setAttribute("data-label", text(labelName) || "");
            row.appendChild(td);
            return td;
        }

        function renderRow(link) {
            var project = link.project;
            var url = project.links_api + link.token + "/";
            var state = Sharing.status(link);
            var row = element("tr", "explorer-sharing-row" + (link.expired ? " explorer-sharing-expired" : ""));
            row.setAttribute("data-token", link.token);

            var where = cell(row, "column-project", "explorer-sharing-project");
            var name = element("a", null, project.name);
            name.href = project.page + "#share";
            name.title = text("project-title") || "";
            where.appendChild(name);
            if (!project.links_work) {
                where.appendChild(element("div", "explorer-sharing-note text-warning", text("blocked")));
            }

            var labelCell = cell(row, "column-link", "explorer-sharing-link");
            labelCell.appendChild(element("div", "explorer-card-title", link.label || text("untitled")));
            var input = element("input", "form-control input-sm explorer-link-address");
            input.type = "text";
            input.readOnly = true;
            input.value = origin + link.path;
            input.setAttribute("aria-label", link.label || text("untitled"));
            // An expired link's address opens nothing until it is renewed: not offered
            if (!link.expired) labelCell.appendChild(input);

            var toggleCtx = {request: request, url: url, forced: project.sign_in_forced,
                forcedTitle: text("forced-title"), disabled: link.expired, done: function (message) {
                    showError(message);
                }};
            cell(row, "column-access").appendChild(linkToggle(link, "sign_in", text("sign-in"), toggleCtx));
            var files = cell(row, "column-downloads");
            linkFileToggles(link, text, toggleCtx).forEach(function (toggle) { files.appendChild(toggle); });

            var made = cell(row, "column-created", "explorer-card-text explorer-sharing-dates");
            made.appendChild(element("div", null, new Date(link.created).toLocaleDateString()));
            made.appendChild(element("div", null, text("by").replace("%(user)s", link.created_by || text("unknown-user"))));

            var expiresCell = cell(row, "column-expires", "explorer-card-text explorer-sharing-dates");
            expiresCell.appendChild(element("div", null, expiryText(text, link)));
            if (state === "soon" || state === "expired") {
                expiresCell.appendChild(element("span", "label " + (state === "soon" ? "label-warning" : "label-default"),
                    state === "soon" ? text("expires-soon") : text("status-expired")));
            }

            var actions = cell(row, "column-actions", "explorer-sharing-actions");
            var group = element("div", "explorer-sharing-buttons");
            actions.appendChild(group);

            var detail = element("tr", "explorer-sharing-detail");
            var detailCell = element("td");
            detailCell.colSpan = 7;
            detail.appendChild(detailCell);
            detail.hidden = true;

            function showDetail() {
                detail.hidden = Array.prototype.every.call(detailCell.children, function (child) { return child.hidden; });
            }

            var editForm = editBox(link, {text: text, request: request, url: url, saved: function (updated) {
                showError("");
                load().then(function () { highlight(updated.token); });
            }, failed: function (message, status) {
                showError(message);
                if (status === 404) load().then(function () { showError(message); });
            }});
            var edit = button("btn-default", link.expired ? text("renew") : text("edit"),
                link.expired ? text("renew-title") : text("edit-title"));
            editForm.explorerTrigger = edit;
            toggles(edit, editForm, function () { editForm.elements.label.focus(); });
            edit.addEventListener("click", showDetail);
            var cancel = editForm.querySelector("button[type=button]");
            cancel.addEventListener("click", showDetail);

            if (!link.expired) {
                group.appendChild(openButton(text, link));
                var embedPanel = embedBox(link, {text: text, origin: origin, views: embedViews[String(project.id)] || [],
                    title: project.name, signIn: function () { return Sharing.asksSignIn(link); }});
                var embed = button("btn-default", text("embed"), text("embed-title"));
                toggles(embed, embedPanel, function () {
                    embedPanel.explorerRefresh();
                    embedPanel.querySelector("textarea").select();
                });
                embed.addEventListener("click", showDetail);
                group.appendChild(embed);
                var copy = button("btn-default", text("copy"));
                wireCopy(copy, input, text("copied"));
                group.appendChild(copy);
                group.appendChild(edit);
                detailCell.appendChild(embedPanel);
            } else {
                group.appendChild(edit);
            }
            detailCell.appendChild(editForm);

            var remove = button("btn-danger", link.expired ? text("delete") : text("revoke"));
            remove.addEventListener("click", function () {
                if (!window.confirm(link.expired ? text("confirm-delete") : text("confirm-revoke"))) return;
                remove.disabled = true;
                request("DELETE", url).then(load, function (e) {
                    remove.disabled = false;
                    showError(e.message);
                    if (e.status === 404) load().then(function () { showError(e.message); });
                });
            });
            group.appendChild(remove);
            return [row, detail];
        }

        function updateCounts() {
            var counts = Sharing.counts(links);
            Array.prototype.forEach.call(filtersForm.elements.status.options, function (option) {
                var caption = option.getAttribute("data-caption") || option.textContent;
                option.setAttribute("data-caption", caption);
                option.textContent = caption + " (" + counts[option.value] + ")";
            });
        }

        function render() {
            body.innerHTML = "";
            var shown = Sharing.filter(links, filters);
            shown.forEach(function (link) {
                renderRow(link).forEach(function (node) { body.appendChild(node); });
            });
            table.hidden = !shown.length;
            empty.hidden = !!shown.length || !loaded;
            empty.textContent = links.length ? text("no-match") : text("none");
            updateCounts();
        }

        function highlight(token) {
            var row = body.querySelector('tr[data-token="' + token + '"]');
            if (!row) return;
            var input = row.querySelector(".explorer-link-address");
            if (input) {
                input.focus();
                input.select();
            }
        }

        function load() {
            return request("GET", api).then(function (all) {
                showError("");
                links = all;
                loaded = true;
                render();
            }, function (e) {
                showError(e.message);
            });
        }

        fillFilters();
        filtersForm.addEventListener("submit", function (e) { e.preventDefault(); });
        filtersForm.addEventListener("change", function () {
            readForm();
            render();
        });
        filtersForm.addEventListener("input", function (e) {
            if (e.target.name !== "q") return;
            readForm();
            render();
        });

        if (createForm) initCreate();

        // Create Link: one of the projects the user may manage, then the Share panel's form. Require Sign-In is fixed
        // on for a project whose links must all ask for a login; a project whose links aren't allowed can't be picked.
        function initCreate() {
            var opener = box.querySelector("[data-sharing-create]");
            var picker = createForm.elements.project;
            var signIn = createForm.elements.sign_in;
            var submit = createForm.querySelector("[type=submit]");
            var fileOptions = formFileOptions(createForm);
            var createError = createForm.querySelector(".explorer-sharing-create-error");
            function byId(id) {
                return projects.filter(function (project) { return String(project.id) === String(id); })[0];
            }
            function pick() {
                var project = byId(picker.value);
                var forced = !!(project && project.sign_in_forced);
                signIn.disabled = forced;
                if (forced) signIn.checked = true;
                signIn.parentNode.title = forced ? text("forced-title") || "" : "";
                submit.disabled = !project;
            }
            picker.addEventListener("change", pick);
            // A project filter picks the same project
            if (filters.project && byId(filters.project) && byId(filters.project).links_work) picker.value = filters.project;
            pick();
            if (opener) toggles(opener, createForm, function () { picker.focus(); });
            createForm.addEventListener("submit", function (e) {
                e.preventDefault();
                var project = byId(picker.value);
                if (!project) return;
                submit.disabled = true;
                createError.hidden = true;
                var created = fileOptions.values();
                created.label = createForm.elements.label.value;
                created.expires_days = createForm.elements.expires_days.value;
                created.sign_in = signIn.checked;
                request("POST", project.links_api, created).then(function (link) {
                    createForm.elements.label.value = "";
                    fileOptions.reset();
                    if (!signIn.disabled) signIn.checked = false;
                    return load().then(function () {
                        // The new link shown even where the filters would leave it out
                        if (!body.querySelector('tr[data-token="' + link.token + '"]')) {
                            Object.keys(Sharing.DEFAULTS).forEach(function (name) { filters[name] = Sharing.DEFAULTS[name]; });
                            fillFilters();
                            readForm();
                            render();
                        }
                        highlight(link.token);
                    });
                }, function (e) {
                    createError.textContent = e.message;
                    createError.hidden = false;
                }).then(function () { submit.disabled = !byId(picker.value); });
            });
        }

        load();
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { init: init, drawThumbnail: drawThumbnail, embedCode: embedCode };
    } else {
        init(document);
    }
})();

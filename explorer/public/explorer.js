/*
 * The Explorer pages: the home's toolbar and its Settings panel for admins, card thumbnails (drawn from the task's tiles where
 * WebODM's thumbnail API can't make one, else a placeholder), and the project page's Share panel, which shows the
 * page's own link (for signed-in users the project is shared with) and, for users who can change the project, its
 * "anyone with the link" links: listed, created and revoked through the plugin's API.
 */
(function () {
    "use strict";
    var Layers = typeof module !== "undefined" && module.exports ? require("./layers.js") : window.ExplorerLayers;
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

    // The Explorer home's Settings panel, for WebODM's admins: each change is saved at once, and undone on the page if
    // it couldn't be saved.
    function initSettings(root) {
        var toggle = root.querySelector("[data-explorer-settings-toggle]");
        var form = root.querySelector("[data-settings-api]");
        if (!toggle || !form) return;
        var error = form.querySelector(".explorer-settings-error");
        toggle.addEventListener("click", function () {
            form.hidden = !form.hidden;
            toggle.setAttribute("aria-expanded", form.hidden ? "false" : "true");
        });
        var box = form.elements.basemaps_on_links;
        box.addEventListener("change", function () {
            var wanted = box.checked;
            box.disabled = true;
            error.hidden = true;
            window.fetch(form.getAttribute("data-settings-api"), {
                method: "PATCH", credentials: "same-origin",
                headers: {"Content-Type": "application/json", "X-CSRFToken": form.elements.csrfmiddlewaretoken.value},
                body: JSON.stringify({basemaps_on_links: wanted})
            }).then(function (response) {
                if (!response.ok) throw new Error(response.status);
                return response.json();
            }).then(function (saved) {
                box.checked = saved.basemaps_on_links;
            }, function () {
                box.checked = !wanted;
                error.textContent = form.getAttribute("data-error");
                error.hidden = false;
            }).then(function () { box.disabled = false; });
        });
    }

    // The home's toolbar is a plain GET form; a changed scope, sort or filter applies at once. Empty and default values
    // stay out of the address, as the page's own links leave them out.
    function initToolbar(root) {
        var form = root.querySelector("[data-explorer-toolbar]");
        if (!form) return;
        form.addEventListener("submit", function () {
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

    function init(root) {
        initToolbar(root);
        initSettings(root);
        watchThumbnails(root);
        initShare(root);
        initLinks(root);
    }

    // The button says "Copied" for a moment after a copy; a copy the browser refuses leaves the text selected.
    function wireCopy(button, input, copiedText) {
        button.addEventListener("click", function () {
            var label = button.innerHTML;
            copyText(input, function (ok) {
                if (!ok) return;
                button.textContent = copiedText;
                setTimeout(function () { button.innerHTML = label; }, 1500);
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

        shareButton.addEventListener("click", function () {
            var opening = panel.hidden;
            panel.hidden = !opening;
            shareButton.setAttribute("aria-expanded", opening ? "true" : "false");
            if (opening) input.select();
        });

        wireCopy(copyButton, input, copyButton.getAttribute("data-copied"));
    }

    function initLinks(root) {
        var box = root.querySelector("[data-links-api]");
        if (!box) return;
        var api = box.getAttribute("data-links-api");
        var list = box.querySelector(".explorer-links-list");
        var form = box.querySelector(".explorer-link-form");
        var submit = form.querySelector("[type=submit]");
        var errorBox = box.querySelector(".explorer-links-error");
        var csrf = form.querySelector("input[name=csrfmiddlewaretoken]").value;

        function text(name) {
            return box.getAttribute("data-" + name);
        }

        function showError(message) {
            errorBox.textContent = message || "";
            errorBox.hidden = !message;
        }

        // WebODM's CSRF check applies to the plugin's API, so every request carries the page's token.
        function request(method, url, body) {
            var options = {method: method, credentials: "same-origin",
                headers: {"X-CSRFToken": csrf, "Accept": "application/json"}};
            if (body) {
                options.headers["Content-Type"] = "application/json";
                options.body = JSON.stringify(body);
            }
            return window.fetch(url, options).then(function (response) {
                if (response.ok) return response.status === 204 ? null : response.json();
                return response.json().then(function (data) {
                    throw new Error((data && data.detail) || text("error"));
                }, function () {
                    throw new Error(text("error"));
                });
            });
        }

        function element(tag, className, content) {
            var node = document.createElement(tag);
            if (className) node.className = className;
            if (content) node.textContent = content;
            return node;
        }

        function renderLink(link) {
            var row = element("div", "explorer-link theme-border-secondary-07");
            row.setAttribute("data-token", link.token);
            var heading = element("div", "explorer-link-heading");
            heading.appendChild(element("span", "explorer-card-title", link.label || text("untitled")));
            heading.appendChild(element("span", "explorer-card-text", link.expires
                ? text("expires").replace("%(date)s", new Date(link.expires).toLocaleDateString())
                : text("never")));
            heading.appendChild(downloadsToggle(link));
            row.appendChild(heading);

            var group = element("div", "input-group input-group-sm");
            var input = element("input", "form-control explorer-link-address");
            input.type = "text";
            input.readOnly = true;
            input.value = window.location.origin + link.path;
            input.setAttribute("aria-label", link.label || text("untitled"));
            group.appendChild(input);
            var buttons = element("span", "input-group-btn");
            var copy = element("button", "btn btn-default", text("copy"));
            copy.type = "button";
            wireCopy(copy, input, text("copied"));
            var revoke = element("button", "btn btn-danger", text("revoke"));
            revoke.type = "button";
            revoke.addEventListener("click", function () {
                if (!window.confirm(text("confirm-revoke"))) return;
                revoke.disabled = true;
                request("DELETE", api + link.token + "/").then(load, function (e) {
                    revoke.disabled = false;
                    showError(e.message);
                });
            });
            // The link page as anyone with the link sees it, in a new tab (this user's session changes nothing there)
            var open = element("a", "btn btn-default", text("open"));
            open.href = link.path;
            open.target = "_blank";
            open.rel = "noopener noreferrer";
            open.title = text("open-title");
            buttons.appendChild(open);
            buttons.appendChild(copy);
            buttons.appendChild(revoke);
            group.appendChild(buttons);
            row.appendChild(group);
            return row;
        }

        // Allows or stops downloads through the link at once; the box goes back if the change fails.
        function downloadsToggle(link) {
            var label = element("label", "explorer-link-downloads explorer-card-text");
            var box = element("input");
            box.type = "checkbox";
            box.checked = !!link.downloads;
            box.addEventListener("change", function () {
                var wanted = box.checked;
                box.disabled = true;
                request("PATCH", api + link.token + "/", {downloads: wanted}).then(function (updated) {
                    showError("");
                    box.checked = !!updated.downloads;
                }, function (e) {
                    box.checked = !wanted;
                    showError(e.message);
                }).then(function () { box.disabled = false; });
            });
            label.appendChild(box);
            label.appendChild(document.createTextNode(" " + text("downloads")));
            return label;
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
            request("POST", api, {label: form.elements.label.value, expires_days: form.elements.expires_days.value,
                downloads: form.elements.downloads.checked})
                .then(function (link) {
                    form.elements.label.value = "";
                    form.elements.downloads.checked = false;
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

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { init: init, drawThumbnail: drawThumbnail };
    } else {
        init(document);
    }
})();

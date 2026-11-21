/*
 * The Explorer pages: thumbnails that fail fall back to a placeholder, and the project page's Share panel shows the
 * page's own link (for signed-in users the project is shared with) and, for users who can change the project, its
 * "anyone with the link" links: listed, created and revoked through the plugin's API.
 */
(function () {
    "use strict";

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

    // WebODM's thumbnail endpoint answers 404 for an orthophoto with fewer than three colour bands (a greyscale
    // one): such a card gets the placeholder a task without an orthophoto has.
    function useThumbnailPlaceholder(img) {
        var placeholder = document.createElement("div");
        placeholder.className = "explorer-thumbnail explorer-no-thumbnail theme-border-secondary-07";
        var icon = document.createElement("i");
        icon.className = img.getAttribute("data-placeholder-icon");
        placeholder.appendChild(icon);
        if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
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
    }

    function init(root) {
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

        // The template renders the path; the full link uses the address the visitor reached WebODM by.
        input.value = window.location.origin + input.value;

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
            row.appendChild(heading);

            var group = element("div", "input-group input-group-sm");
            var input = element("input", "form-control");
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
            buttons.appendChild(copy);
            buttons.appendChild(revoke);
            group.appendChild(buttons);
            row.appendChild(group);
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
            request("POST", api, {label: form.elements.label.value, expires_days: form.elements.expires_days.value})
                .then(function (link) {
                    form.elements.label.value = "";
                    return load().then(function () {
                        var input = list.querySelector('[data-token="' + link.token + '"] input');
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
        module.exports = { init: init };
    } else {
        init(document);
    }
})();

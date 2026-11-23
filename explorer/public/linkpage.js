/*
 * What a link's map and 3D pages share: the view fills the window below WebODM's header, a status line, and telling
 * a revoked or expired link (the link page answers 404) from a view that failed for another reason.
 */
(function () {
    "use strict";

    // The element fills the window from its top edge down, and follows the window's size.
    function fitHeight(element, onResize) {
        function fit() {
            // In fullscreen the view fills the screen below the bar, and nothing else is laid out
            var full = document.fullscreenElement || document.webkitFullscreenElement;
            if (full && full.contains(element)) {
                element.style.height = Math.max(240, window.innerHeight - element.getBoundingClientRect().top) + "px";
                if (onResize) onResize();
                return;
            }
            var top = element.getBoundingClientRect().top + (window.pageYOffset || 0);
            var height = Math.max(240, window.innerHeight - top);
            element.style.height = height + "px";
            // The page's own bottom padding would still scroll the window by a few pixels: take it off the view
            var over = document.documentElement.scrollHeight - window.innerHeight;
            if (over > 0) element.style.height = Math.max(240, height - over) + "px";
            if (onResize) onResize();
        }
        window.addEventListener("resize", fit);
        document.addEventListener("fullscreenchange", fit);
        document.addEventListener("webkitfullscreenchange", fit);
        fit();
        return fit;
    }

    function status(element) {
        return {
            show: function (message) {
                element.textContent = message;
                element.hidden = false;
            },
            hide: function () {
                element.hidden = true;
            },
            // The message showing, or null
            text: function () {
                return element.hidden ? null : element.textContent;
            }
        };
    }

    // Resolves true unless the link page answers 404; a network failure counts as valid (it says nothing).
    function linkIsValid(linkPath) {
        return window.fetch(linkPath, {method: "HEAD", credentials: "same-origin", cache: "no-store"})
            .then(function (response) { return response.status !== 404; }, function () { return true; });
    }

    // After a failure: "no longer valid" if the link is gone, otherwise the page's own error message. The check takes
    // a request: by its answer the visitor may have chosen another view, and stillWanted() then says false.
    function explainFailure(page, line, stillWanted) {
        return linkIsValid(page.getAttribute("data-link")).then(function (valid) {
            if (valid && stillWanted && !stillWanted()) return valid;
            line.show(page.getAttribute(valid ? "data-error" : "data-invalid"));
            return valid;
        });
    }

    // A menu that would open past an edge of the screen opens the other way: the bar's menus open leftwards from
    // their button (dropdown-menu-right), and when the bar wraps on a phone a button can land near the left edge; a
    // card's or the cover's Download menu opens rightwards, and on a phone its button can be near the right edge.
    function keepOnScreen(menu) {
        menu.classList.remove("explorer-menu-left", "explorer-menu-right");
        var box = menu.getBoundingClientRect();
        var width = document.documentElement.clientWidth || window.innerWidth;
        if (box.left < 0) menu.classList.add("explorer-menu-left");
        else if (box.right > width) menu.classList.add("explorer-menu-right");
    }

    var api = {fitHeight: fitHeight, status: status, linkIsValid: linkIsValid, explainFailure: explainFailure,
               keepOnScreen: keepOnScreen};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        window.ExplorerLinkPage = api;
        // Bootstrap's dropdowns (WebODM's jQuery) say when one has opened
        if (window.jQuery) {
            window.jQuery(document).on("shown.bs.dropdown", ".explorer-viewer-bar, .explorer-public", function (event) {
                var menu = event.target.querySelector(".dropdown-menu");
                if (menu) keepOnScreen(menu);
            });
        }
    }
})();

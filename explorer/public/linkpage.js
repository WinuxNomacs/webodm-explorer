/*
 * What a link's map and 3D pages share: the view fills the window below WebODM's header, a status line, and telling
 * a revoked or expired link (the link page answers 404) from a view that failed for another reason.
 */
(function () {
    "use strict";

    // The element fills the window from its top edge down, and follows the window's size.
    function fitHeight(element, onResize) {
        function fit() {
            var top = element.getBoundingClientRect().top + (window.pageYOffset || 0);
            element.style.height = Math.max(240, window.innerHeight - top) + "px";
            if (onResize) onResize();
        }
        window.addEventListener("resize", fit);
        fit();
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

    // After a failure: "no longer valid" if the link is gone, otherwise the page's own error message.
    function explainFailure(page, line) {
        return linkIsValid(page.getAttribute("data-link")).then(function (valid) {
            line.show(page.getAttribute(valid ? "data-error" : "data-invalid"));
            return valid;
        });
    }

    var api = {fitHeight: fitHeight, status: status, linkIsValid: linkIsValid, explainFailure: explainFailure};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        window.ExplorerLinkPage = api;
    }
})();

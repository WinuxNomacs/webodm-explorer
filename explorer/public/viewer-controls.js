/*
 * What the map and 3D pages' bars share: Fullscreen (F) and Reset View (R), the 3D page's Controls help, and the
 * Previous / Next task links following the view shown (pages.neighbours gives each link a URL per view it has).
 */
(function () {
    "use strict";

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    // Element fullscreen, where the browser has it (iPhone Safari has it for videos only)
    function canFullscreen(element) {
        return !!(element.requestFullscreen || element.webkitRequestFullscreen) &&
            (document.fullscreenEnabled !== false || document.webkitFullscreenEnabled === true);
    }

    function toggleFullscreen(element) {
        try {
            var result;
            if (fullscreenElement()) {
                result = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen();
            } else {
                result = element.requestFullscreen ? element.requestFullscreen() : element.webkitRequestFullscreen();
            }
            // Refused (no user gesture, a policy): nothing happens, and nothing needs saying
            if (result && result.catch) result.catch(function () {});
        } catch (e) { /* refused */ }
    }

    // A key typed into a field, or with a modifier, is not a shortcut
    function isShortcut(event) {
        var target = event.target;
        var tag = target && target.tagName ? target.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "select" || tag === "textarea" || (target && target.isContentEditable)) return false;
        return !(event.ctrlKey || event.metaKey || event.altKey);
    }

    // options: {reset: function, resize: function (after fullscreen changes)}. Returns {setView(kind)}.
    function init(page, options) {
        var resetButton = page.querySelector("[data-reset]");
        var fullButton = page.querySelector("[data-fullscreen]");
        var helpButton = page.querySelector("[data-help-toggle]");
        var help = helpButton ? document.getElementById(helpButton.getAttribute("aria-controls")) : null;

        if (resetButton) resetButton.addEventListener("click", function () { options.reset(); });

        var fullscreen = fullButton && canFullscreen(page);
        if (fullscreen) {
            fullButton.hidden = false;
            fullButton.addEventListener("click", function () { toggleFullscreen(page); });
            var changed = function () {
                var on = fullscreenElement() === page;
                fullButton.querySelector("i").className = on ? "fa fa-compress" : "fa fa-expand";
                fullButton.setAttribute("aria-pressed", on ? "true" : "false");
                if (options.resize) options.resize();
            };
            document.addEventListener("fullscreenchange", changed);
            document.addEventListener("webkitfullscreenchange", changed);
        }

        function showHelp(open) {
            help.hidden = !open;
            helpButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
        if (helpButton && help) helpButton.addEventListener("click", function () { showHelp(help.hidden); });

        document.addEventListener("keydown", function (event) {
            if (!isShortcut(event)) return;
            var key = (event.key || "").toLowerCase();
            if (key === "r") {
                options.reset();
            } else if (key === "f" && fullscreen) {
                toggleFullscreen(page);
            } else if (key === "escape" && help && !help.hidden) {
                showHelp(false);
            } else {
                return;
            }
            event.preventDefault();
        });

        var neighbours = page.querySelectorAll("[data-neighbour]");
        return {
            // The links open the same view on the other task where it has it, else its first view
            setView: function (kind) {
                for (var i = 0; i < neighbours.length; i++) {
                    var link = neighbours[i];
                    link.setAttribute("href", link.getAttribute("data-view-" + kind) || link.getAttribute("data-open"));
                }
            }
        };
    }

    var api = {init: init, canFullscreen: canFullscreen, isShortcut: isShortcut, fullscreenElement: fullscreenElement};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        window.ExplorerControls = api;
    }
})();

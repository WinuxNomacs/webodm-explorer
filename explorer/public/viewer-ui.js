/*
 * A link's 3D page, around the scene (viewer/scene.js, an ES module that calls ExplorerViewer.start once three.js
 * and Spark have loaded): the switch between the task's types, the loading status and the failure messages.
 */
(function () {
    "use strict";
    var helpers = typeof module !== "undefined" && module.exports ? require("./linkpage.js") : window.ExplorerLinkPage;
    // The scene module not starting by then means it couldn't load (an old browser without import maps)
    var START_TIMEOUT = 30000;

    // As WebODM's Utils.isIOS and isMobile, so the GLB is the size WebODM's own 3D page would pick
    function platform(userAgent, touch) {
        if (/(iPad)|(iPhone)|(iPod)/i.test(userAgent) || (/Mac/i.test(userAgent) && touch)) return "ios";
        if (/(android)|(webOS)/i.test(userAgent)) return "mobile";
        return "";
    }

    // Points drawn at most, as WebODM's own 3D page sets Potree's budget (ModelView.jsx)
    function pointBudget(kind) {
        if (kind === "ios") return 1000 * 1000;
        if (kind === "mobile") return 2 * 1000 * 1000;
        return 10 * 1000 * 1000;
    }

    function meshUrl(url, kind) {
        return kind ? url + "?platform=" + kind : url;
    }

    function create(page, options) {
        var line = helpers.status(page.querySelector(".explorer-status"));
        var switches = page.querySelectorAll("[data-type]");
        var kind = platform(options.userAgent, options.touch);
        var started = false;
        var current = null;
        var timer = setTimeout(function () {
            if (!started) line.show(page.getAttribute("data-error"));
        }, START_TIMEOUT);

        function urlFor(button) {
            var url = button.getAttribute("data-url");
            return button.getAttribute("data-type") === "mesh" ? meshUrl(url, kind) : url;
        }

        function start(scene) {
            started = true;
            viewer.scene = scene;
            clearTimeout(timer);
            helpers.fitHeight(page.querySelector(".explorer-scene"), scene.resize);

            function select(button) {
                var type = button.getAttribute("data-type");
                current = type;
                for (var i = 0; i < switches.length; i++) {
                    var on = switches[i] === button;
                    switches[i].setAttribute("aria-pressed", on ? "true" : "false");
                    switches[i].classList.toggle("active", on);
                }
                var loading = page.getAttribute("data-loading");
                line.show(loading);
                scene.show(type, urlFor(button), function (fraction) {
                    if (current === type && fraction !== null) line.show(loading + " " + Math.round(fraction * 100) + "%");
                }, function () {
                    // A point cloud node failed once the view was open: say so only if the link is gone
                    helpers.linkIsValid(page.getAttribute("data-link")).then(function (valid) {
                        if (!valid && current === type) line.show(page.getAttribute("data-invalid"));
                    });
                }).then(function () {
                    if (current === type) line.hide();
                }, function () {
                    if (current === type) helpers.explainFailure(page, line);
                });
            }

            var initial = switches[0];
            for (var i = 0; i < switches.length; i++) {
                switches[i].addEventListener("click", function (e) { select(e.currentTarget); });
                if (switches[i].getAttribute("data-type") === page.getAttribute("data-initial")) initial = switches[i];
            }
            if (initial) select(initial);
        }

        function fail() {
            started = true;
            clearTimeout(timer);
            line.show(page.getAttribute("data-no-webgl"));
        }

        var viewer = {start: start, fail: fail, pointBudget: pointBudget(kind), scene: null};
        return viewer;
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {create: create, platform: platform, meshUrl: meshUrl, pointBudget: pointBudget};
    } else {
        var page = document.querySelector("[data-explorer-viewer]");
        if (page) {
            window.ExplorerViewer = create(page, {userAgent: navigator.userAgent, touch: "ontouchend" in document});
        }
    }
})();

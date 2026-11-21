/*
 * A link's map page: the task's orthophoto, DSM or DTM on Leaflet, from the link's token tile views. No basemap (one
 * would send visitors' addresses to a tile provider). Tile URLs are built as WebODM's Map.jsx builds them.
 */
(function () {
    "use strict";
    var helpers = typeof module !== "undefined" && module.exports ? require("./linkpage.js") : window.ExplorerLinkPage;
    var TILE_SIZE = 512;
    var RGB = ["red", "green", "blue"];

    function bandNames(bands) {
        var names = [];
        for (var i = 0; i < (bands || []).length; i++) names.push((bands[i].description || "").toLowerCase());
        return names;
    }

    function hasBands(needles, bands) {
        var names = bandNames(bands);
        for (var i = 0; i < needles.length; i++) if (names.indexOf(needles[i]) === -1) return false;
        return true;
    }

    // Elevation is shaded and coloured, as on WebODM's map
    function layerParams(type) {
        return type === "orthophoto" ? {} : {hillshade: 6, color_map: "viridis"};
    }

    // The value range to stretch: the RGB bands' min and max for a colour orthophoto, every band's otherwise.
    function rescale(type, statistics, bands) {
        if (!statistics["1"]) return "-1,1";
        var indexes = Object.keys(statistics);
        if (type === "orthophoto" && hasBands(RGB, bands)) {
            var names = bandNames(bands);
            indexes = RGB.map(function (name) { return String(names.indexOf(name) + 1); });
        }
        var min = Infinity, max = -Infinity;
        indexes.forEach(function (b) {
            min = Math.min(min, statistics[b].min);
            max = Math.max(max, statistics[b].max);
        });
        return min + "," + max;
    }

    function query(params) {
        return Object.keys(params).map(function (k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
        }).join("&");
    }

    function metadataUrl(api, type, crop) {
        var params = layerParams(type);
        if (crop) params.crop = 1;
        var q = query(params);
        return api + type + "/metadata" + (q ? "?" + q : "");
    }

    function tileUrl(api, type, metadata, bands, crop) {
        var params = layerParams(type);
        if (metadata.statistics) params.rescale = rescale(type, metadata.statistics, bands);
        params.size = TILE_SIZE;
        if (crop) params.crop = 1;
        return api + type + "/tiles/{z}/{x}/{y}?" + query(params);
    }

    // [west, south, east, north] to Leaflet's [[south, west], [north, east]]
    function boundsLatLng(value) {
        return [[value[1], value[0]], [value[3], value[2]]];
    }

    function start(page, L) {
        var api = page.getAttribute("data-api");
        var crop = page.getAttribute("data-crop") === "1";
        var bandsScript = document.getElementById("explorer-bands");
        var bands = bandsScript ? JSON.parse(bandsScript.textContent) : [];
        var line = helpers.status(page.querySelector(".explorer-status"));
        var mapElement = page.querySelector(".explorer-map");
        var switches = page.querySelectorAll("[data-layer]");
        var map = L.map(mapElement, {maxZoom: 24});
        var layers = {};
        var current = null;
        var fitted = false;
        var checking = false;

        helpers.fitHeight(mapElement, function () { map.invalidateSize(); });

        function failed() {
            helpers.explainFailure(page, line);
        }

        // A tile can fail on its own (the tiler at an edge); only a link that is gone is worth saying.
        function tileFailed() {
            if (checking) return;
            checking = true;
            helpers.linkIsValid(page.getAttribute("data-link")).then(function (valid) {
                if (!valid) line.show(page.getAttribute("data-invalid"));
                checking = false;
            });
        }

        function select(type) {
            current = type;
            for (var i = 0; i < switches.length; i++) {
                var on = switches[i].getAttribute("data-layer") === type;
                switches[i].setAttribute("aria-pressed", on ? "true" : "false");
                switches[i].classList.toggle("active", on);
            }
            Object.keys(layers).forEach(function (k) {
                if (k !== type && layers[k].layer) map.removeLayer(layers[k].layer);
            });
            if (layers[type]) {
                if (layers[type].layer) layers[type].layer.addTo(map);
                return;
            }
            layers[type] = {};
            line.show(page.getAttribute("data-loading"));
            window.fetch(metadataUrl(api, type, crop), {credentials: "same-origin"}).then(function (response) {
                if (!response.ok) throw new Error(response.status);
                return response.json();
            }).then(function (metadata) {
                var bounds = L.latLngBounds(boundsLatLng(metadata.bounds.value));
                var layer = L.tileLayer(tileUrl(api, type, metadata, bands, crop), {
                    bounds: bounds, minZoom: 0, maxZoom: metadata.maxzoom + 99, maxNativeZoom: metadata.maxzoom - 1,
                    tileSize: TILE_SIZE, detectRetina: true
                });
                layer.on("tileerror", tileFailed);
                layers[type].layer = layer;
                line.hide();
                if (current === type) layer.addTo(map);
                if (!fitted) {
                    map.fitBounds(bounds);
                    fitted = true;
                }
            }).catch(function () {
                delete layers[type];
                failed();
            });
        }

        for (var i = 0; i < switches.length; i++) {
            switches[i].addEventListener("click", function (e) { select(e.currentTarget.getAttribute("data-layer")); });
        }
        if (switches.length) select(switches[0].getAttribute("data-layer"));
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {start: start, rescale: rescale, tileUrl: tileUrl, metadataUrl: metadataUrl,
            boundsLatLng: boundsLatLng};
    } else {
        var page = document.querySelector("[data-explorer-map]");
        if (page) start(page, window.L);
    }
})();

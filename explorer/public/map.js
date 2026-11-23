/*
 * A link's map page: the task's orthophoto, thermal, DSM or DTM layer on Leaflet, from the link's token tile views
 * (or WebODM's own API on a preview), drawn as WebODM's map draws them (layers.js), with a legend for value layers.
 * Under it, one of the basemaps the admin configured in WebODM unless Explorer's settings turn them off on links
 * (decided 2026-11-21: they send visitors' map views to the basemap's provider).
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    var helpers = node ? require("./linkpage.js") : window.ExplorerLinkPage;
    var Layers = node ? require("./layers.js") : window.ExplorerLayers;
    var Controls = node ? require("./viewer-controls.js") : window.ExplorerControls;
    var OPACITY_KEY = "explorer-opacity";
    var TILE_SIZE = 512;
    var BASEMAP_KEY = Layers.BASEMAP_KEY;
    var UNITS_KEY = "explorer-units-";

    // Browser storage can be missing or refuse (private windows, blocked site data): a preference is then not kept
    function remembered(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function remember(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* not kept */ }
    }

    // [west, south, east, north] to Leaflet's [[south, west], [north, east]]
    function boundsLatLng(value) {
        return [[value[1], value[0]], [value[3], value[2]]];
    }

    // Whether lengths read in feet: the elevation unit chosen on a legend
    function imperial() {
        return remembered(UNITS_KEY + "elevation") === "ft";
    }

    // The value layers' legend: the colour ramp between the stretched range, in a unit the visitor can switch;
    // onUnits() after a switch
    function legend(container, onUnits) {
        var element = document.createElement("div");
        element.className = "explorer-legend theme-secondary theme-border-secondary-07";
        element.hidden = true;
        var ramp = document.createElement("div");
        ramp.className = "explorer-legend-ramp";
        var labels = document.createElement("div");
        labels.className = "explorer-legend-labels";
        var min = document.createElement("span");
        var unit = document.createElement("button");
        unit.type = "button";
        unit.className = "btn btn-default btn-xs explorer-legend-unit";
        var max = document.createElement("span");
        labels.appendChild(min);
        labels.appendChild(unit);
        labels.appendChild(max);
        element.appendChild(ramp);
        element.appendChild(labels);
        container.appendChild(element);
        // Dragging or double-clicking the legend shouldn't move the map under it
        ["mousedown", "touchstart", "dblclick", "click", "wheel"].forEach(function (name) {
            element.addEventListener(name, function (e) { e.stopPropagation(); });
        });

        var shown = null;
        function draw() {
            var choices = Layers.units(shown.type);
            var kind = shown.type === "thermal" ? "thermal" : "elevation";
            var index = Math.max(0, choices.map(function (u) { return u.label; }).indexOf(remembered(UNITS_KEY + kind)));
            var chosen = choices[index];
            // The values in the unit the button between them names
            min.textContent = Layers.number(shown.range[0], chosen);
            max.textContent = Layers.number(shown.range[1], chosen);
            unit.textContent = chosen.label;
            unit.setAttribute("title", unit.getAttribute("data-switch") || "");
            unit.onclick = function () {
                remember(UNITS_KEY + kind, choices[(index + 1) % choices.length].label);
                draw();
                if (onUnits) onUnits();
            };
        }
        return {
            show: function (type, metadata, bands) {
                var colors = Layers.colorRamp(type, metadata);
                if (!colors || !Layers.units(type).length) {
                    element.hidden = true;
                    return;
                }
                shown = {type: type, range: Layers.range(type, metadata.statistics, bands)};
                ramp.style.background = "linear-gradient(to right, " + colors.join(", ") + ")";
                draw();
                element.hidden = false;
            },
            hide: function () { element.hidden = true; },
            element: element
        };
    }

    function start(page, L) {
        var api = page.getAttribute("data-api");
        var crop = page.getAttribute("data-crop") === "1";
        var bandsScript = document.getElementById("explorer-bands");
        var bands = bandsScript ? JSON.parse(bandsScript.textContent) : [];
        var basemapsScript = document.getElementById("explorer-basemaps");
        var basemaps = basemapsScript ? JSON.parse(basemapsScript.textContent) : [];
        var line = helpers.status(page.querySelector(".explorer-status"));
        var mapElement = page.querySelector(".explorer-map");
        var switches = page.querySelectorAll("[data-layer]");
        var picker = page.querySelector("[data-basemap]");
        var map = L.map(mapElement, {maxZoom: 24});
        // A scale bar in the unit system of the elevation legend
        var scale = null;
        function drawScale() {
            if (!L.control || !L.control.scale) return;
            if (scale) scale.remove();
            scale = L.control.scale({metric: !imperial(), imperial: imperial(), position: "bottomright"}).addTo(map);
        }
        var key = legend(mapElement, drawScale);
        drawScale();
        var opacitySlider = page.querySelector("[data-opacity]");
        function opacity() {
            return opacitySlider ? parseInt(opacitySlider.value, 10) / 100 : 1;
        }
        if (opacitySlider) {
            var savedOpacity = parseInt(remembered(OPACITY_KEY), 10);
            if (savedOpacity >= 0 && savedOpacity <= 100) opacitySlider.value = String(savedOpacity);
            opacitySlider.addEventListener("input", function () {
                remember(OPACITY_KEY, opacitySlider.value);
                Object.keys(layers).forEach(function (k) {
                    if (layers[k].layer) layers[k].layer.setOpacity(opacity());
                });
            });
        }
        key.element.querySelector("button").setAttribute("data-switch", page.getAttribute("data-unit-switch") || "");
        var layers = {};
        var current = null;
        var basemap = null;
        var fitted = false;
        var checking = false;

        var fit = helpers.fitHeight(mapElement, function () { map.invalidateSize(); });
        // Reset View fits the layer shown again
        Controls.init(page, {resize: fit, reset: function () {
            var shown = current && layers[current];
            if (shown && shown.bounds) map.fitBounds(shown.bounds);
        }});

        function failed(type) {
            helpers.explainFailure(page, line, function () { return current === type; });
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

        // The remembered basemap if the admin still offers it, else WebODM's default one; "" is none
        function pickBasemap(label) {
            if (basemap) map.removeLayer(basemap);
            basemap = null;
            var chosen = basemaps.filter(function (b) { return b.label === label; })[0];
            if (picker) picker.value = chosen ? chosen.label : "";
            if (!chosen) return;
            // A provider that fails leaves the layer on the page's background: its tiles are not the page's errors
            basemap = Layers.basemapLayer(L, chosen);
            basemap.addTo(map);
            if (basemap.bringToBack) basemap.bringToBack();
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
            // The status line speaks for the layer shown: one already loaded clears it, one still loading says so
            if (layers[type]) {
                if (layers[type].layer) {
                    line.hide();
                    layers[type].layer.addTo(map);
                    key.show(type, layers[type].metadata, bands);
                } else {
                    key.hide();
                    line.show(page.getAttribute("data-loading"));
                }
                return;
            }
            layers[type] = {};
            key.hide();
            line.show(page.getAttribute("data-loading"));
            window.fetch(Layers.metadataUrl(api, type, crop), {credentials: "same-origin"}).then(function (response) {
                if (!response.ok) throw new Error(response.status);
                return response.json();
            }).then(function (metadata) {
                var bounds = L.latLngBounds(boundsLatLng(metadata.bounds.value));
                var layer = L.tileLayer(Layers.tileUrl(api, type, metadata, bands, crop, TILE_SIZE), {
                    bounds: bounds, minZoom: 0, maxZoom: metadata.maxzoom + 99, maxNativeZoom: metadata.maxzoom - 1,
                    tileSize: TILE_SIZE, detectRetina: true, opacity: opacity()
                });
                layers[type].bounds = bounds;
                layer.on("tileerror", tileFailed);
                layers[type].layer = layer;
                layers[type].metadata = metadata;
                if (current === type) {
                    line.hide();
                    layer.addTo(map);
                    key.show(type, metadata, bands);
                }
                if (!fitted) {
                    map.fitBounds(bounds);
                    fitted = true;
                }
            }).catch(function () {
                // Tried again when chosen again; said only while it is the layer chosen
                delete layers[type];
                if (current === type) failed(type);
            });
        }

        if (basemaps.length) {
            pickBasemap(Layers.chosenBasemap(basemaps, remembered(BASEMAP_KEY)));
            if (picker) {
                picker.addEventListener("change", function () {
                    remember(BASEMAP_KEY, picker.value);
                    pickBasemap(picker.value);
                });
            }
        }
        for (var i = 0; i < switches.length; i++) {
            switches[i].addEventListener("click", function (e) { select(e.currentTarget.getAttribute("data-layer")); });
        }
        if (switches.length) select(switches[0].getAttribute("data-layer"));
    }

    if (node) {
        module.exports = {start: start, boundsLatLng: boundsLatLng, basemapLayer: Layers.basemapLayer};
    } else {
        var page = document.querySelector("[data-explorer-map]");
        if (page) start(page, window.L);
    }
})();

/*
 * The signed-in pages' footprint maps, drawn as outlines from the footprints the page holds (no tiles of the tasks):
 * the Explorer home's Map view (each project around its tasks, a marker that stays visible at any zoom) and the
 * project page's Overview Map (each task's footprint, opening the task as its card does). Under them, the basemap
 * chosen on Explorer's map pages, or WebODM's default one. A map in a folded <details> is made when it unfolds.
 */
(function () {
    "use strict";
    var node = typeof module !== "undefined" && module.exports;
    var Layers = node ? require("./layers.js") : window.ExplorerLayers;
    // Outlines take the theme's primary button colour through its class and currentColor (explorer.css: CSS beats
    // Leaflet's stroke and fill attributes)
    var STYLE = {className: "explorer-footprint theme-color-button-primary", weight: 3, fillOpacity: 0.15};

    function remembered(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function readJson(id) {
        var script = document.getElementById(id);
        if (!script) return [];
        try { return JSON.parse(script.textContent) || []; } catch (e) { return []; }
    }

    function addBasemap(L, map, basemaps) {
        var label = Layers.chosenBasemap(basemaps, remembered(Layers.BASEMAP_KEY));
        var chosen = basemaps.filter(function (b) { return b.label === label; })[0];
        if (chosen) Layers.basemapLayer(L, chosen).addTo(map);
    }

    // Tooltips take an element: Leaflet puts a string in as HTML, and names are whatever users typed
    function label(text) {
        var span = document.createElement("span");
        span.textContent = text;
        return span;
    }

    function link(L, url, text) {
        var a = document.createElement("a");
        a.href = url;
        a.textContent = text;
        return a;
    }

    // [west, south, east, north] to Leaflet's [[south, west], [north, east]]
    function latLngs(bounds) {
        return [[bounds[1], bounds[0]], [bounds[3], bounds[2]]];
    }

    function drawProjects(L, map, places, element) {
        var all = L.latLngBounds([]);
        places.forEach(function (place) {
            var box = L.latLngBounds(latLngs(place.bounds));
            all.extend(box);
            var popup = document.createElement("div");
            popup.appendChild(link(L, place.url, place.name));
            var count = place.count === 1 ? element.getAttribute("data-tasks-one")
                : (element.getAttribute("data-tasks-many") || "").replace("%(count)s", place.count);
            popup.appendChild(document.createElement("br"));
            popup.appendChild(document.createTextNode(count));
            L.rectangle(box, STYLE).bindPopup(popup).addTo(map);
            L.circleMarker(box.getCenter(), {className: STYLE.className, radius: 7, weight: 3, fillOpacity: 0.6})
                .bindPopup(popup).bindTooltip(label(place.name)).addTo(map);
        });
        return all;
    }

    function drawTasks(L, map, tasks) {
        var all = L.latLngBounds([]);
        tasks.forEach(function (task) {
            var shape = L.geoJSON(task.geometry, {style: function () { return STYLE; }});
            shape.bindTooltip(label(task.name), {sticky: true});
            shape.on("click", function () { api.navigate(task.url); });
            shape.addTo(map);
            all.extend(shape.getBounds());
        });
        return all;
    }

    function start(element, L) {
        var kind = element.getAttribute("data-explorer-footprints");
        var items = readJson("explorer-footprints");
        var map = L.map(element, {maxZoom: 22, scrollWheelZoom: kind === "projects"});
        addBasemap(L, map, readJson("explorer-basemaps"));
        var all = kind === "projects" ? drawProjects(L, map, items, element) : drawTasks(L, map, items);
        if (all.isValid()) map.fitBounds(all, {padding: [24, 24], maxZoom: 19});
        else map.setView([0, 0], 1);
        return map;
    }

    function init(root, L) {
        var elements = root.querySelectorAll("[data-explorer-footprints]");
        Array.prototype.forEach.call(elements, function (element) {
            var folded = element.closest("details");
            if (!folded || folded.open) {
                start(element, L);
                return;
            }
            // Leaflet measures its container: a map made while folded would be zero-sized
            var made = false;
            folded.addEventListener("toggle", function () {
                if (folded.open && !made) {
                    made = true;
                    start(element, L);
                }
            });
        });
    }

    var api = {init: init, start: start, navigate: function (url) { window.location.href = url; }};
    if (node) {
        module.exports = api;
    } else if (window.L) {
        init(document, window.L);
    }
})();

/*
 * The raster layers Explorer draws, drawn as WebODM's map draws them (Map.jsx): each layer's tile parameters and
 * stretch, its tile and metadata URLs, its legend, and the tiles that cover a small picture of it (a card's thumbnail
 * when WebODM's thumbnail API can't make one). Layer types: orthophoto, thermal (the orthophoto's one band in degrees
 * Celsius), dsm and dtm.
 */
(function () {
    "use strict";
    var RGB = ["red", "green", "blue"];
    var TILE = 256;
    // Mercator's limit: beyond it a latitude has no tile row
    var MAX_LAT = 85.0511287798;
    var UNITS = {
        thermal: [{label: "°C", factor: 1, offset: 0}, {label: "°F", factor: 9 / 5, offset: 32}],
        elevation: [{label: "m", factor: 1, offset: 0}, {label: "ft", factor: 1 / 0.3048, offset: 0}]
    };

    function tileType(type) {
        return type === "thermal" ? "orthophoto" : type;
    }

    // The parameters WebODM's map sends for each layer: a single-band orthophoto as degrees Celsius in magma,
    // elevation shaded and in viridis
    function params(type) {
        if (type === "thermal") return {formula: "Celsius", bands: "L", color_map: "magma"};
        if (type === "dsm" || type === "dtm") return {hillshade: 6, color_map: "viridis"};
        return {};
    }

    function bandNames(bands) {
        var names = [];
        for (var i = 0; i < (bands || []).length; i++) names.push((bands[i].description || "").toLowerCase());
        return names;
    }

    function hasBands(needles, bands) {
        var names = bandNames(bands);
        for (var i = 0; i < needles.length; i++) {
            if (names.indexOf(needles[i]) === -1) return false;
        }
        return true;
    }

    // The value range to stretch, as WebODM's map: thermal between its 2nd and 98th percentiles, a colour orthophoto
    // between its RGB bands' min and max, anything else between every band's min and max. [min, max].
    function range(type, statistics, bands) {
        if (!statistics || !statistics["1"]) return [-1, 1];
        var indexes = Object.keys(statistics);
        if (type === "orthophoto" && hasBands(RGB, bands)) {
            var names = bandNames(bands);
            indexes = RGB.map(function (name) { return String(names.indexOf(name) + 1); });
        }
        var min = Infinity, max = -Infinity;
        indexes.forEach(function (b) {
            var low = type === "thermal" ? statistics[b].percentiles[0] : statistics[b].min;
            var high = type === "thermal" ? statistics[b].percentiles[1] : statistics[b].max;
            min = Math.min(min, low);
            max = Math.max(max, high);
        });
        return [min, max];
    }

    function rescale(type, statistics, bands) {
        return range(type, statistics, bands).join(",");
    }

    function query(values) {
        return Object.keys(values).map(function (k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(values[k]);
        }).join("&");
    }

    // api: the task's API path, ending in a slash (WebODM's own or a link's token views)
    function metadataUrl(api, type, crop) {
        var values = params(type);
        if (crop) values.crop = 1;
        var q = query(values);
        return api + tileType(type) + "/metadata" + (q ? "?" + q : "");
    }

    function tileUrl(api, type, metadata, bands, crop, size) {
        var values = params(type);
        if (metadata.statistics) values.rescale = rescale(type, metadata.statistics, bands);
        values.size = size || 512;
        if (crop) values.crop = 1;
        return api + tileType(type) + "/tiles/{z}/{x}/{y}?" + query(values);
    }

    // The layer's colour ramp as CSS colours, from the metadata's colour maps (each colour packed as RGBA in one
    // integer, as WebODM's ColorMaps.js decodes them); null for a layer without one
    function colorRamp(type, metadata, stops) {
        var key = params(type).color_map;
        var maps = (metadata && metadata.color_maps) || [];
        for (var i = 0; i < maps.length; i++) {
            if (maps[i].key !== key || !maps[i].color_map || !maps[i].color_map.length) continue;
            var values = maps[i].color_map;
            var count = stops || 12;
            var colors = [];
            for (var s = 0; s < count; s++) {
                var v = values[Math.round(s * (values.length - 1) / (count - 1))];
                colors.push("rgb(" + ((v >>> 24) & 255) + "," + ((v >>> 16) & 255) + "," + ((v >>> 8) & 255) + ")");
            }
            return colors;
        }
        return null;
    }

    // The units a layer's legend can show, the first being the metadata's own; none for an orthophoto
    function units(type) {
        if (type === "thermal") return UNITS.thermal;
        if (type === "dsm" || type === "dtm") return UNITS.elevation;
        return [];
    }

    function convert(value, unit) {
        return value * unit.factor + unit.offset;
    }

    // A legend value in the unit, rounded as it reads: whole numbers from 100, else one decimal
    function number(value, unit) {
        var converted = convert(value, unit);
        return String(Math.abs(converted) >= 100 ? Math.round(converted) : Math.round(converted * 10) / 10);
    }

    function format(value, unit) {
        return number(value, unit) + " " + unit.label;
    }

    // Web Mercator: a longitude and latitude to pixels at zoom z, with 256-pixel tiles
    function toPixels(lon, lat, z) {
        var scale = TILE * Math.pow(2, z);
        var clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
        return {
            x: (lon + 180) / 360 * scale,
            y: (1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2 * scale
        };
    }

    // The 256-pixel tiles that draw bounds ([west, south, east, north]) at most size pixels across: the deepest zoom
    // up to maxzoom where the bounds fit, the tile range, and where the bounds sit in the drawn tiles.
    function cover(bounds, maxzoom, size) {
        var z = Math.max(0, Math.min(maxzoom, 24));
        var nw, se;
        for (; z > 0; z--) {
            nw = toPixels(bounds[0], bounds[3], z);
            se = toPixels(bounds[2], bounds[1], z);
            if (se.x - nw.x <= size && se.y - nw.y <= size) break;
        }
        nw = toPixels(bounds[0], bounds[3], z);
        se = toPixels(bounds[2], bounds[1], z);
        var x0 = Math.floor(nw.x / TILE), y0 = Math.floor(nw.y / TILE);
        return {
            z: z, x0: x0, y0: y0, x1: Math.floor((se.x - 1e-9) / TILE), y1: Math.floor((se.y - 1e-9) / TILE),
            left: nw.x - x0 * TILE, top: nw.y - y0 * TILE,
            width: Math.max(1, Math.round(se.x - nw.x)), height: Math.max(1, Math.round(se.y - nw.y))
        };
    }

    var Layers = {
        TILE: TILE, tileType: tileType, params: params, hasBands: hasBands, range: range, rescale: rescale,
        query: query, metadataUrl: metadataUrl, tileUrl: tileUrl, colorRamp: colorRamp, units: units,
        convert: convert, number: number, format: format, toPixels: toPixels, cover: cover
    };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = Layers;
    } else {
        window.ExplorerLayers = Layers;
    }
})();

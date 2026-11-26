const footprints = require("../footprints.js");
const Layers = require("../layers.js");

const BASEMAPS = [{label: "OSM", url: "https://osm/{z}/{x}/{y}.png"}, {label: "Google", url: "https://g/{z}", default: true}];

function square(west, south) {
    return {type: "Polygon", coordinates: [[[west, south], [west + 1, south], [west + 1, south + 1], [west, south]]]};
}

// Leaflet's calls as footprints.js makes them, with real bounds arithmetic
function fakeLeaflet() {
    const added = [];
    const bounds = (corners) => {
        const box = {
            corners: corners ? corners.slice() : [],
            extend(other) { box.corners = box.corners.concat(other.corners); return box; },
            isValid() { return box.corners.length > 0; },
            getCenter() { return {lat: 0, lng: 0}; },
        };
        return box;
    };
    const layer = (kind, extra) => {
        const handlers = {};
        const item = Object.assign({kind, handlers, on(name, fn) { handlers[name] = fn; return item; },
            bindPopup(p) { item.popup = p; return item; }, bindTooltip(t) { item.tooltip = t; return item; },
            addTo() { added.push(item); return item; }}, extra);
        return item;
    };
    const leafletMap = {fitBounds: jest.fn(), setView: jest.fn()};
    const L = {
        map: jest.fn(() => leafletMap),
        latLngBounds: bounds,
        tileLayer: jest.fn((url) => layer("tiles", {url})),
        rectangle: jest.fn((box, style) => layer("rectangle", {box, style})),
        circleMarker: jest.fn((at, style) => layer("marker", {style})),
        geoJSON: jest.fn((geometry, options) => {
            const ring = geometry.coordinates[0].map((p) => [p[1], p[0]]);
            return layer("geojson", {geometry, style: options.style(), getBounds: () => bounds(ring)});
        }),
    };
    L.tileLayer.wms = jest.fn();
    return {L, leafletMap, added};
}

function page(html, items, basemaps) {
    document.body.innerHTML = html +
        `<script type="application/json" id="explorer-footprints">${JSON.stringify(items)}</script>` +
        `<script type="application/json" id="explorer-basemaps">${JSON.stringify(basemaps || [])}</script>`;
}

afterEach(() => window.localStorage.clear());

test("the home's map puts each project in a box and a marker that open it, over the default basemap", () => {
    page('<div data-explorer-footprints="projects" data-tasks-one="1 task" data-tasks-many="%(count)s tasks"></div>',
        [{name: "Barn", url: "/plugins/explorer/project/1/", bounds: [-88, 42, -87, 43], count: 3}], BASEMAPS);
    const {L, leafletMap, added} = fakeLeaflet();
    footprints.init(document, L);
    expect(added.map((a) => a.kind)).toEqual(["tiles", "rectangle", "marker"]);
    expect(added[0].url).toBe("https://g/{z}");
    expect(L.rectangle.mock.calls[0][0].corners).toEqual([[42, -88], [43, -87]]);
    const popup = added[1].popup;
    expect(popup.querySelector("a").getAttribute("href")).toBe("/plugins/explorer/project/1/");
    expect(popup.textContent).toBe("Barn3 tasks");
    expect(added[2].tooltip.textContent).toBe("Barn");
    expect(added[1].style.className).toContain("theme-color-button-primary");
    expect(leafletMap.fitBounds).toHaveBeenCalled();
});

test("a project name is text in its popup, never markup", () => {
    page('<div data-explorer-footprints="projects" data-tasks-one="1 task"></div>',
        [{name: "<img src=x onerror=alert(1)>", url: "/p/", bounds: [0, 0, 1, 1], count: 1}]);
    const {L, added} = fakeLeaflet();
    footprints.init(document, L);
    expect(added[0].popup.querySelector("img")).toBeNull();
    expect(added[0].popup.textContent).toContain("<img");
});

test("the remembered basemap is kept, and none means none", () => {
    page('<div data-explorer-footprints="projects"></div>', [], BASEMAPS);
    window.localStorage.setItem("explorer-basemap", "OSM");
    let fake = fakeLeaflet();
    footprints.init(document, fake.L);
    expect(fake.added[0].url).toBe("https://osm/{z}/{x}/{y}.png");
    window.localStorage.setItem("explorer-basemap", "");
    fake = fakeLeaflet();
    footprints.init(document, fake.L);
    expect(fake.added).toHaveLength(0);
    expect(fake.leafletMap.setView).toHaveBeenCalledWith([0, 0], 1);  // nothing to fit
});

test("the overview map draws each task's footprint and a marker that shows at any zoom, both opening the task", () => {
    page('<div data-explorer-footprints="tasks"></div>',
        [{name: "First", url: "/plugins/explorer/project/1/map/T/", geometry: square(7, 46)}]);
    const {L, leafletMap, added} = fakeLeaflet();
    const navigate = jest.spyOn(footprints, "navigate").mockImplementation(() => {});
    let layersAtFit = -1;
    leafletMap.fitBounds.mockImplementation(() => { layersAtFit = added.length; });
    footprints.init(document, L);
    expect(added.map((layer) => layer.kind)).toEqual(["geojson", "marker"]);
    added.forEach((layer) => {
        expect(layer.tooltip.textContent).toBe("First");
        layer.handlers.click();
    });
    expect(navigate.mock.calls).toEqual([["/plugins/explorer/project/1/map/T/"], ["/plugins/explorer/project/1/map/T/"]]);
    // The marker only once the map has its view: Leaflet throws clipping the outlines when one comes first
    expect(added.findIndex((layer) => layer.kind === "marker")).toBeGreaterThanOrEqual(layersAtFit);
    navigate.mockRestore();
    expect(leafletMap.fitBounds.mock.calls[0][0].corners[0]).toEqual([46, 7]);
    expect(L.map.mock.calls[0][1].scrollWheelZoom).toBe(false);  // the page scrolls past it
});

test("a folded overview map is made only when it unfolds, and once", () => {
    page('<details><summary>Overview Map</summary><div data-explorer-footprints="tasks"></div></details>',
        [{name: "First", url: "/t/", geometry: square(7, 46)}]);
    const {L} = fakeLeaflet();
    footprints.init(document, L);
    expect(L.map).not.toHaveBeenCalled();
    const details = document.querySelector("details");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(L.map).toHaveBeenCalledTimes(1);
});

test("footprint data that doesn't parse leaves an empty map", () => {
    document.body.innerHTML = '<div data-explorer-footprints="tasks"></div>' +
        '<script type="application/json" id="explorer-footprints">{nope</script>';
    const {L, leafletMap} = fakeLeaflet();
    footprints.init(document, L);
    expect(leafletMap.setView).toHaveBeenCalled();
});

test("the chosen basemap is the remembered one while offered, else WebODM's default, else the first", () => {
    expect(Layers.chosenBasemap(BASEMAPS, null)).toBe("Google");
    expect(Layers.chosenBasemap(BASEMAPS, "OSM")).toBe("OSM");
    expect(Layers.chosenBasemap(BASEMAPS, "")).toBe("");
    expect(Layers.chosenBasemap(BASEMAPS, "Gone")).toBe("Google");
    expect(Layers.chosenBasemap([{label: "A"}, {label: "B"}], null)).toBe("A");
    expect(Layers.chosenBasemap([], "OSM")).toBe("");
});

test("names are shown as text, never as HTML", () => {
    const name = '<img src=x onerror="window.pwned=1">';
    page('<div data-explorer-footprints="tasks"></div>', [{name, url: "/t/", geometry: square(7, 46)}]);
    const {L, added} = fakeLeaflet();
    footprints.init(document, L);
    expect(added[0].tooltip.textContent).toBe(name);
    expect(added[0].tooltip.children).toHaveLength(0);
});

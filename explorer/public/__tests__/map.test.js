const map = require("../map.js");

const API = "/api/plugins/explorer/s/TOKEN/tasks/TASK/";
const RGB_BANDS = [{description: "red"}, {description: "green"}, {description: "blue"}, {description: "alpha"}];
const STATS = {"1": {min: 10, max: 200}, "2": {min: 5, max: 210}, "3": {min: 20, max: 190}, "4": {min: 0, max: 255}};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("bounds turn from west, south, east, north into Leaflet's corners", () => {
    expect(map.boundsLatLng([7.1, 46.2, 7.3, 46.4])).toEqual([[46.2, 7.1], [46.4, 7.3]]);
});

function fakeLeaflet() {
    const added = [];
    const leafletMap = {
        fitBounds: jest.fn(), invalidateSize: jest.fn(),
        removeLayer: jest.fn((layer) => added.splice(added.indexOf(layer), 1)),
    };
    const L = {
        map: jest.fn(() => leafletMap),
        latLngBounds: jest.fn((corners) => ({corners})),
        tileLayer: jest.fn((url, options) => {
            const handlers = {};
            const layer = {url, options, on: (name, fn) => { handlers[name] = fn; }, handlers,
                addTo: () => { added.push(layer); return layer; }, bringToBack: jest.fn()};
            return layer;
        }),
    };
    L.tileLayer.wms = jest.fn((url, options) => {
        const layer = {url, options, wms: true, addTo: () => { added.push(layer); return layer; }, bringToBack: jest.fn()};
        return layer;
    });
    return {L, leafletMap, added};
}

function page(layers, basemaps) {
    const picker = basemaps && basemaps.length ? `<select data-basemap>${basemaps.map((b) =>
        `<option value="${b.label}">${b.label}</option>`).join("")}<option value="">None</option></select>` : "";
    document.body.innerHTML = `
        <div data-explorer-map data-api="${API}" data-link="/plugins/explorer/s/TOKEN/" data-crop=""
             data-loading="Loading..." data-invalid="Gone." data-error="Failed.">
            ${layers.map((l) => `<button data-layer="${l}">${l}</button>`).join("")}${picker}
            <div class="explorer-status" hidden></div><div class="explorer-map"></div>
        </div>
        <script type="application/json" id="explorer-bands">${JSON.stringify(RGB_BANDS)}</script>
        <script type="application/json" id="explorer-basemaps">${JSON.stringify(basemaps || [])}</script>`;
    return document.querySelector("[data-explorer-map]");
}

const metadata = {statistics: STATS, maxzoom: 22, bounds: {value: [7.1, 46.2, 7.3, 46.4]}};
const ok = (body) => Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(body)});

afterEach(() => { delete window.fetch; window.localStorage.clear(); });

test("the first layer opens fitted to its bounds, and the switch swaps layers", async () => {
    const element = page(["orthophoto", "dsm"]);
    window.fetch = jest.fn(() => ok(metadata));
    const { L, leafletMap, added } = fakeLeaflet();
    map.start(element, L);
    await settle();
    expect(added).toHaveLength(1);
    expect(added[0].url).toContain(API + "orthophoto/tiles/");
    expect(added[0].options).toEqual(expect.objectContaining({maxNativeZoom: 21, tileSize: 512}));
    expect(leafletMap.fitBounds).toHaveBeenCalledTimes(1);
    expect(element.querySelector("[data-layer=orthophoto]").getAttribute("aria-pressed")).toBe("true");

    element.querySelector("[data-layer=dsm]").click();
    await settle();
    expect(added).toHaveLength(1);
    expect(added[0].url).toContain(API + "dsm/tiles/");
    expect(leafletMap.fitBounds).toHaveBeenCalledTimes(1);
    expect(element.querySelector(".explorer-status").hidden).toBe(true);
});

test("a layer that fails says whether the link is gone or the layer failed", async () => {
    const element = page(["orthophoto"]);
    const notFound = Promise.resolve({ok: false, status: 404});
    window.fetch = jest.fn(() => notFound);
    map.start(element, fakeLeaflet().L);
    await settle();
    expect(element.querySelector(".explorer-status").textContent).toBe("Gone.");

    const other = page(["orthophoto"]);
    window.fetch = jest.fn((url, options) => (options && options.method === "HEAD"
        ? Promise.resolve({ok: true, status: 200}) : Promise.resolve({ok: false, status: 500})));
    map.start(other, fakeLeaflet().L);
    await settle();
    expect(other.querySelector(".explorer-status").textContent).toBe("Failed.");
});

test("a failing tile only speaks up when the link is gone", async () => {
    const element = page(["orthophoto"]);
    let linkValid = true;
    window.fetch = jest.fn((url, options) => (options && options.method === "HEAD"
        ? Promise.resolve({ok: linkValid, status: linkValid ? 200 : 404}) : ok(metadata)));
    const { L, added } = fakeLeaflet();
    map.start(element, L);
    await settle();
    added[0].handlers.tileerror();
    await settle();
    expect(element.querySelector(".explorer-status").hidden).toBe(true);
    linkValid = false;
    added[0].handlers.tileerror();
    await settle();
    expect(element.querySelector(".explorer-status").textContent).toBe("Gone.");
});

const packed = (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
const thermalMetadata = {
    statistics: {"1": {min: -74.9, max: 128.4, percentiles: [10.5, 50.3]}}, maxzoom: 26,
    bounds: {value: [7.1, 46.2, 7.3, 46.4]},
    color_maps: [{key: "magma", color_map: [packed(0, 0, 4), packed(252, 253, 191)]},
        {key: "viridis", color_map: [packed(68, 1, 84), packed(253, 231, 37)]}],
};

test("a thermal layer draws in magma between its percentiles, with a legend whose unit switches and is kept", async () => {
    const element = page(["thermal", "orthophoto"]);
    window.fetch = jest.fn(() => ok(thermalMetadata));
    const { L, added } = fakeLeaflet();
    map.start(element, L);
    await settle();
    expect(window.fetch.mock.calls[0][0]).toBe(API + "orthophoto/metadata?formula=Celsius&bands=L&color_map=magma");
    expect(added[0].url).toContain("formula=Celsius&bands=L&color_map=magma&rescale=10.5%2C50.3");
    const legend = element.querySelector(".explorer-legend");
    expect(legend.hidden).toBe(false);
    expect(legend.textContent).toBe("10.5\u00b0C50.3");
    expect(legend.querySelector(".explorer-legend-ramp").style.background).toContain("linear-gradient");
    legend.querySelector("button").click();
    expect(legend.textContent).toBe("50.9\u00b0F123");
    expect(window.localStorage.getItem("explorer-units-thermal")).toBe("\u00b0F");

    // The orthophoto has no legend
    element.querySelector("[data-layer=orthophoto]").click();
    await settle();
    expect(legend.hidden).toBe(true);
});

const BASEMAPS = [
    {label: "Google Maps Hybrid", type: "tms", url: "//{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", default: true,
        maxzoom: 21, minzoom: 0, subdomains: ["mt0", "mt1"], attribution: "Map data: Google"},
    {label: "A WMS", type: "wms", url: "https://wms.example/service", default: false, maxzoom: 20, minzoom: 0,
        layers: "ortho", format: "image/png"},
];

test("the admin's default basemap sits under the layer, and the visitor's choice is kept", async () => {
    const element = page(["orthophoto"], BASEMAPS);
    window.fetch = jest.fn(() => ok(metadata));
    const { L, leafletMap, added } = fakeLeaflet();
    map.start(element, L);
    await settle();
    const google = added.find((layer) => layer.url.includes("google"));
    expect(google.options).toEqual(expect.objectContaining({subdomains: ["mt0", "mt1"], maxNativeZoom: 21,
        attribution: "Map data: Google"}));
    expect(google.bringToBack).toHaveBeenCalled();
    expect(element.querySelector("[data-basemap]").value).toBe("Google Maps Hybrid");

    const picker = element.querySelector("[data-basemap]");
    picker.value = "A WMS";
    picker.dispatchEvent(new Event("change"));
    expect(leafletMap.removeLayer).toHaveBeenCalledWith(google);
    expect(added.find((layer) => layer.wms).options).toEqual(expect.objectContaining({layers: "ortho", format: "image/png"}));
    expect(window.localStorage.getItem("explorer-basemap")).toBe("A WMS");

    picker.value = "";
    picker.dispatchEvent(new Event("change"));
    expect(added.some((layer) => layer.wms)).toBe(false);
});

test("a remembered basemap the admin no longer offers falls back to the default, and none stays none", async () => {
    window.localStorage.setItem("explorer-basemap", "Gone Basemap");
    let element = page(["orthophoto"], BASEMAPS);
    window.fetch = jest.fn(() => ok(metadata));
    let fake = fakeLeaflet();
    map.start(element, fake.L);
    expect(element.querySelector("[data-basemap]").value).toBe("Google Maps Hybrid");

    window.localStorage.setItem("explorer-basemap", "");
    element = page(["orthophoto"], BASEMAPS);
    fake = fakeLeaflet();
    map.start(element, fake.L);
    await settle();
    expect(fake.added.every((layer) => layer.url.startsWith(API))).toBe(true);
});

test("without basemaps (turned off in Explorer's settings) the map has none and no picker", async () => {
    const element = page(["orthophoto"]);
    window.fetch = jest.fn(() => ok(metadata));
    const { L, added } = fakeLeaflet();
    map.start(element, L);
    await settle();
    expect(added).toHaveLength(1);
    expect(element.querySelector("[data-basemap]")).toBeNull();
});

test("the status line speaks for the layer chosen, not for one left while it loaded", async () => {
    const element = page(["orthophoto", "dsm"]);
    let failDsm;
    window.fetch = jest.fn((url) => url.includes("/dsm/")
        ? new Promise((resolve) => { failDsm = () => resolve({ok: false, status: 500}); })
        : ok(metadata));
    map.start(element, fakeLeaflet().L);
    await settle();
    const status = element.querySelector(".explorer-status");
    element.querySelector("[data-layer=dsm]").click();
    expect(status.textContent).toBe("Loading...");
    expect(status.hidden).toBe(false);
    element.querySelector("[data-layer=orthophoto]").click();  // loaded already
    expect(status.hidden).toBe(true);
    failDsm();
    await settle();
    await settle();
    expect(status.hidden).toBe(true);  // DSM failed, but the orthophoto is the one shown
    expect(window.fetch.mock.calls.filter(([url]) => url.includes("/dsm/"))).toHaveLength(1);
    element.querySelector("[data-layer=dsm]").click();  // tried again when chosen again
    expect(window.fetch.mock.calls.filter(([url]) => url.includes("/dsm/"))).toHaveLength(2);
});

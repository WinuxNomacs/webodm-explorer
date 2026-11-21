const map = require("../map.js");

const API = "/api/plugins/explorer/s/TOKEN/tasks/TASK/";
const RGB_BANDS = [{description: "red"}, {description: "green"}, {description: "blue"}, {description: "alpha"}];
const STATS = {"1": {min: 10, max: 200}, "2": {min: 5, max: 210}, "3": {min: 20, max: 190}, "4": {min: 0, max: 255}};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a colour orthophoto stretches between its RGB bands' min and max, as WebODM's map does", () => {
    expect(map.rescale("orthophoto", STATS, RGB_BANDS)).toBe("5,210");
});

test("other rasters stretch over every band, and missing statistics fall back to -1,1", () => {
    expect(map.rescale("orthophoto", {"1": {min: 0, max: 255}, "2": {min: 0, max: 255}}, [])).toBe("0,255");
    expect(map.rescale("dsm", {"1": {min: 101.5, max: 140.25}}, [])).toBe("101.5,140.25");
    expect(map.rescale("dsm", {}, [])).toBe("-1,1");
});

test("tile and metadata URLs point at the link's token views with WebODM's parameters", () => {
    expect(map.metadataUrl(API, "orthophoto", false)).toBe(API + "orthophoto/metadata");
    expect(map.metadataUrl(API, "dsm", true)).toBe(API + "dsm/metadata?hillshade=6&color_map=viridis&crop=1");
    expect(map.tileUrl(API, "orthophoto", {statistics: STATS}, RGB_BANDS, false))
        .toBe(API + "orthophoto/tiles/{z}/{x}/{y}?rescale=5%2C210&size=512");
    expect(map.tileUrl(API, "dtm", {}, [], true))
        .toBe(API + "dtm/tiles/{z}/{x}/{y}?hillshade=6&color_map=viridis&size=512&crop=1");
});

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
                addTo: () => { added.push(layer); return layer; }};
            return layer;
        }),
    };
    return {L, leafletMap, added};
}

function page(layers) {
    document.body.innerHTML = `
        <div data-explorer-map data-api="${API}" data-link="/plugins/explorer/s/TOKEN/" data-crop=""
             data-loading="Loading..." data-invalid="Gone." data-error="Failed.">
            ${layers.map((l) => `<button data-layer="${l}">${l}</button>`).join("")}
            <div class="explorer-status" hidden></div><div class="explorer-map"></div>
        </div>
        <script type="application/json" id="explorer-bands">${JSON.stringify(RGB_BANDS)}</script>`;
    return document.querySelector("[data-explorer-map]");
}

const metadata = {statistics: STATS, maxzoom: 22, bounds: {value: [7.1, 46.2, 7.3, 46.4]}};
const ok = (body) => Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(body)});

afterEach(() => { delete window.fetch; });

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

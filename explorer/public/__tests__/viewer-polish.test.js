const Controls = require("../viewer-controls.js");
const viewer = require("../viewer-ui.js");
const map = require("../map.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const desktop = {userAgent: "Mozilla/5.0 (X11; Linux x86_64)", touch: false};

function bar(extra) {
    document.body.innerHTML = `
        <div class="page" data-explorer-viewer data-initial="cloud" data-link="/l/" data-loading="Loading..."
             data-error="Failed." data-invalid="Gone.">
            <a data-neighbour href="/p/3d/B/?t=cloud" data-open="/p/map/B/" data-view-cloud="/p/3d/B/?t=cloud" data-view-map="/p/map/B/">Next</a>
            <button data-type="cloud" data-url="/c/">Cloud</button><button data-type="mesh" data-url="/m/">Mesh</button>
            <button data-reset></button><button data-fullscreen hidden><i class="fa fa-expand"></i></button>
            <button data-help-toggle aria-controls="explorer-help" aria-expanded="false"></button>
            <div id="explorer-help" hidden></div>
            <input type="search" id="field">
            ${extra || ""}
            <div class="explorer-status" hidden></div><div class="explorer-scene"></div>
        </div>`;
    return document.querySelector(".page");
}

function key(name, options) {
    const target = (options && options.target) || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", Object.assign({key: name, bubbles: true}, options)));
}

afterEach(() => {
    window.localStorage.clear();
    delete HTMLElement.prototype.requestFullscreen;
    delete document.exitFullscreen;
    // Listeners from earlier tests stay on document: each test makes its own page and checks its own spies
    document.body.innerHTML = "";
});

test("Fullscreen stays hidden where the browser can't make an element fullscreen", () => {
    const page = bar();
    Controls.init(page, {reset: jest.fn()});
    expect(page.querySelector("[data-fullscreen]").hidden).toBe(true);
});

test("Fullscreen shows where it can, and F or the button turns it on", () => {
    HTMLElement.prototype.requestFullscreen = jest.fn(() => Promise.reject(new Error("refused")));
    const page = bar();
    Controls.init(page, {reset: jest.fn()});
    const button = page.querySelector("[data-fullscreen]");
    expect(button.hidden).toBe(false);
    button.click();
    key("f");
    expect(HTMLElement.prototype.requestFullscreen).toHaveBeenCalledTimes(2);  // a refusal is silent
});

test("R resets the view, but not while typing in a field or with a modifier", () => {
    const page = bar();
    const reset = jest.fn();
    Controls.init(page, {reset});
    key("r");
    key("R", {ctrlKey: true});
    key("r", {target: page.querySelector("#field")});
    expect(reset).toHaveBeenCalledTimes(1);
    page.querySelector("[data-reset]").click();
    expect(reset).toHaveBeenCalledTimes(2);
});

test("the Controls help opens and closes with its button and closes with Escape", () => {
    const page = bar();
    Controls.init(page, {reset: jest.fn()});
    const button = page.querySelector("[data-help-toggle]");
    const help = page.querySelector("#explorer-help");
    button.click();
    expect(help.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    key("Escape");
    expect(help.hidden).toBe(true);
});

test("Previous / Next follow the view shown, falling back to the other task's first view", () => {
    const page = bar();
    const controls = Controls.init(page, {reset: jest.fn()});
    const link = page.querySelector("[data-neighbour]");
    controls.setView("mesh");
    expect(link.getAttribute("href")).toBe("/p/map/B/");
    controls.setView("cloud");
    expect(link.getAttribute("href")).toBe("/p/3d/B/?t=cloud");
});

function fakeScene(range) {
    const calls = [];
    return {
        calls, resize: jest.fn(), reset: jest.fn(), setCloudStyle: jest.fn(), setBackground: jest.fn(), cloudRange: () => range,
        show: jest.fn((type) => new Promise((resolve, reject) => calls.push({type, resolve, reject}))),
    };
}

const PANEL = `
    <div data-cloud-panel hidden>
        <input type="range" data-point-size min="0.25" max="4" step="0.25" value="1">
        <select data-cloud-colour><option value="rgb">Photo</option><option value="elevation">Elevation</option></select>
        <div data-cloud-legend hidden><div class="explorer-legend-ramp"></div>
            <span data-min></span><button data-unit></button><span data-max></span></div>
    </div>`;

test("switching type moves the address and the neighbour links with it", async () => {
    window.history.replaceState(null, "", "/p/3d/A/?t=cloud");
    const page = bar();
    const scene = fakeScene(null);
    viewer.create(page, desktop).start(scene);
    page.querySelector("[data-type=mesh]").click();
    expect(window.location.search).toBe("?t=mesh");
    expect(page.querySelector("[data-neighbour]").getAttribute("href")).toBe("/p/map/B/");
});

test("the point cloud panel shows once the cloud opens, and its size and colour apply and are remembered", async () => {
    const page = bar(PANEL);
    const scene = fakeScene([210.24, 224.5]);
    viewer.create(page, desktop).start(scene);
    const panel = page.querySelector("[data-cloud-panel]");
    expect(panel.hidden).toBe(true);
    scene.calls[0].resolve();
    await settle();
    expect(panel.hidden).toBe(false);
    const size = page.querySelector("[data-point-size]");
    size.value = "2";
    size.dispatchEvent(new Event("input"));
    expect(scene.setCloudStyle).toHaveBeenLastCalledWith({size: 2, colour: "rgb"});
    expect(window.localStorage.getItem("explorer-cloud-size")).toBe("2");
    const legend = page.querySelector("[data-cloud-legend]");
    expect(legend.hidden).toBe(true);
    const colour = page.querySelector("[data-cloud-colour]");
    colour.value = "elevation";
    colour.dispatchEvent(new Event("change"));
    expect(scene.setCloudStyle).toHaveBeenLastCalledWith({size: 2, colour: "elevation"});
    expect(legend.hidden).toBe(false);
    expect(legend.querySelector("[data-min]").textContent).toBe("210");
    legend.querySelector("[data-unit]").click();
    expect(legend.querySelector("[data-unit]").textContent).toBe("ft");
    expect(legend.querySelector("[data-max]").textContent).toBe("737");
    page.querySelector("[data-type=mesh]").click();
    expect(panel.hidden).toBe(true);
});

test("a remembered size and colour open with the next cloud; a size out of range is ignored", () => {
    window.localStorage.setItem("explorer-cloud-size", "3");
    window.localStorage.setItem("explorer-cloud-colour", "elevation");
    let page = bar(PANEL);
    let scene = fakeScene(null);
    viewer.create(page, desktop).start(scene);
    expect(scene.setCloudStyle).toHaveBeenCalledWith({size: 3, colour: "elevation"});
    window.localStorage.setItem("explorer-cloud-size", "99");
    page = bar(PANEL);
    scene = fakeScene(null);
    viewer.create(page, desktop).start(scene);
    expect(scene.setCloudStyle).toHaveBeenCalledWith({size: 1, colour: "elevation"});
});

function fakeLeaflet() {
    const controls = [];
    const leafletMap = {fitBounds: jest.fn(), invalidateSize: jest.fn(), removeLayer: jest.fn()};
    const L = {
        map: jest.fn(() => leafletMap),
        latLngBounds: jest.fn((corners) => ({corners})),
        tileLayer: jest.fn((url, options) => {
            const layer = {url, options, on: () => {}, addTo: () => layer, setOpacity: jest.fn(), bringToBack: () => {}};
            return layer;
        }),
        control: {scale: jest.fn((options) => {
            const control = {options, addTo: () => { controls.push(control); return control; }, remove: jest.fn()};
            return control;
        })},
    };
    return {L, leafletMap, controls};
}

function mapPage() {
    document.body.innerHTML = `
        <div data-explorer-map data-api="/api/T/" data-link="/l/" data-crop="" data-loading="L" data-error="E">
            <button data-layer="dsm">DSM</button>
            <input type="range" data-opacity min="0" max="100" value="100">
            <button data-reset></button><button data-fullscreen hidden><i></i></button>
            <div class="explorer-status" hidden></div><div class="explorer-map"></div>
        </div>
        <script type="application/json" id="explorer-bands">[]</script>`;
    return document.querySelector("[data-explorer-map]");
}

const DSM_METADATA = {statistics: {"1": {min: 210, max: 224}}, maxzoom: 22, bounds: {value: [7.1, 46.2, 7.3, 46.4]},
    color_maps: [{key: "viridis", color_map: [0x440154ff, 0xfde725ff]}]};

test("the map's opacity applies to the layer and is remembered; Reset View fits the layer again", async () => {
    window.localStorage.setItem("explorer-opacity", "40");
    window.fetch = jest.fn(() => Promise.resolve({ok: true, json: () => Promise.resolve(DSM_METADATA)}));
    const page = mapPage();
    const {L, leafletMap} = fakeLeaflet();
    map.start(page, L);
    await settle(); await settle();
    const layer = L.tileLayer.mock.results[0].value;
    expect(layer.options.opacity).toBe(0.4);
    const slider = page.querySelector("[data-opacity]");
    slider.value = "70";
    slider.dispatchEvent(new Event("input"));
    expect(layer.setOpacity).toHaveBeenCalledWith(0.7);
    expect(window.localStorage.getItem("explorer-opacity")).toBe("70");
    leafletMap.fitBounds.mockClear();
    page.querySelector("[data-reset]").click();
    expect(leafletMap.fitBounds).toHaveBeenCalledWith({corners: [[46.2, 7.1], [46.4, 7.3]]});
    delete window.fetch;
});

test("the scale bar follows the elevation legend's unit", async () => {
    window.fetch = jest.fn(() => Promise.resolve({ok: true, json: () => Promise.resolve(DSM_METADATA)}));
    const page = mapPage();
    const {L, controls} = fakeLeaflet();
    map.start(page, L);
    await settle(); await settle();
    expect(controls[0].options).toMatchObject({metric: true, imperial: false});
    page.querySelector(".explorer-legend-unit").click();
    expect(controls[0].remove).toHaveBeenCalled();
    expect(controls[controls.length - 1].options).toMatchObject({metric: false, imperial: true});
    delete window.fetch;
});

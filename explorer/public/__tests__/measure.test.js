const Measure = require("../measure.js");

// GeographicLib's own test data (geographiclib-geodesic 2.2.0, test/geodesictest.js: GeodTest cases and Planimeter0):
// [lat1, lon1, lat2, lon2, s12 in metres] on WGS84
const GEODESICS = [
    [35.60777, -139.44815, -11.17491, -69.95921, 8935244.56048183],
    [55.52454, 106.05087, 77.03196, 197.18234, 4105086.17139244],
    [-21.97856, 142.59065, 41.84138, 98.56635, 8394328.894657671],
    [-66.99028, 112.2363, -12.70631, 285.90344, 11150344.2312080],
];

test("a length is the geodesic on WGS84, to GeographicLib's published values", () => {
    GEODESICS.forEach(([lat1, lon1, lat2, lon2, s12]) => {
        expect(Measure.pathLength([[lat1, lon1], [lat2, lon2]])).toBeCloseTo(s12, 6);
    });
    // A path is the sum of its segments
    const [a, b] = GEODESICS;
    expect(Measure.pathLength([[a[0], a[1]], [a[2], a[3]], [a[0], a[1]]])).toBeCloseTo(2 * a[4], 5);
    expect(Measure.pathLength([[1, 2]])).toBe(0);
    expect(b).toBeDefined();
});

test("an area and its perimeter are those of GeographicLib's planimeter tests, whichever way the points go", () => {
    const square = [[0, -1], [-1, 0], [0, 1], [1, 0]];
    let result = Measure.polygonArea(square);
    expect(result.perimeter).toBeCloseTo(627598.2731, 3);
    expect(result.area).toBeCloseTo(24619419146, -1);
    result = Measure.polygonArea(square.slice().reverse());
    expect(result.area).toBeCloseTo(24619419146, -1);
    result = Measure.polygonArea([[89, 0], [89, 90], [89, 180], [89, 270]]);
    expect(result.perimeter).toBeCloseTo(631819.8745, 3);
    expect(result.area).toBeCloseTo(24952305678, -1);
});

test("values read in metric or imperial units, with larger units past a threshold", () => {
    const n = (s) => s.replace(/[\u00a0,]/g, "");
    expect(n(Measure.formatLength(28.4, false))).toBe("28.40 m");
    expect(n(Measure.formatLength(1234.5, false))).toBe("1.235 km");
    expect(n(Measure.formatLength(30.48, true))).toBe("100.00 ft");
    expect(n(Measure.formatLength(1609.344 * 2, true))).toBe("2.000 mi");
    expect(n(Measure.formatArea(423.98, false))).toBe("423.98 m²");
    expect(n(Measure.formatArea(25000, false))).toBe("2.5000 ha");
    expect(n(Measure.formatArea(0.3048 * 0.3048 * 10, true))).toBe("10.00 ft²");
    expect(n(Measure.formatArea(4046.8564224 * 3, true))).toBe("3.000 ac");
    expect(n(Measure.formatVolume(1000, false))).toBe("1000.00 m³");
    expect(n(Measure.formatVolume(0.764554857984 * 4, true))).toBe("4.00 yd³");
    expect(n(Measure.formatHeight(3.048, true))).toBe("10.00 ft");
});

test("the volume request is a GeoJSON Feature with a closed ring of longitude, latitude pairs", () => {
    expect(Measure.areaFeature([[1, 10], [2, 20], [3, 30]]).geometry.coordinates).toEqual([[[10, 1], [20, 2], [30, 3], [10, 1]]]);
});

function json(status, body) {
    return Promise.resolve({ok: status < 400, status, json: () => Promise.resolve(body)});
}

function volumeCtx(answers, clock) {
    clock = clock || {t: 0};
    return {
        fetch: jest.fn(() => answers.shift()),
        csrf: "tok",
        volume: {start: "/v/start", result: "/v/get/"},
        wait: jest.fn((ms) => { clock.t += ms; return Promise.resolve(); }),
        now: () => clock.t,
    };
}

const POINTS = [[1, 10], [2, 20], [3, 30]];

test("volume starts WebODM's job, then asks for its result until it is in", async () => {
    const ctx = volumeCtx([json(200, {celery_task_id: "j 1"}), json(200, {error: "Task not ready"}), json(200, {output: "316.09"})]);
    await expect(Measure.measureVolume(ctx, POINTS, "plane")).resolves.toBe(316.09);
    const [url, options] = ctx.fetch.mock.calls[0];
    expect(url).toBe("/v/start");
    expect(options.method).toBe("POST");
    expect(options.headers["X-CSRFToken"]).toBe("tok");
    expect(JSON.parse(options.body).method).toBe("plane");
    expect(ctx.fetch.mock.calls[1][0]).toBe("/v/get/j%201");
    expect(ctx.wait).toHaveBeenCalledWith(Measure.POLL_MS);
});

test("volume stops waiting at the deadline", async () => {
    const answers = [json(200, {celery_task_id: "j"})];
    for (let i = 0; i < 200; i++) answers.push(json(200, {error: "Task not ready"}));
    const ctx = volumeCtx(answers);
    await expect(Measure.measureVolume(ctx, POINTS, "plane")).rejects.toMatchObject({message: "timeout"});
    expect(ctx.fetch.mock.calls.length).toBeLessThanOrEqual(Measure.DEADLINE_MS / Measure.POLL_MS + 2);
});

test("volume failures carry WebODM's message and the status: a job's error, a refusal, a full link", async () => {
    await expect(Measure.measureVolume(volumeCtx([json(200, {error: "No surface model available."})]), POINTS, "plane"))
        .rejects.toMatchObject({status: 200, message: "No surface model available."});
    await expect(Measure.measureVolume(volumeCtx([json(200, {celery_task_id: "j"}), json(200, {error: "Points are out of bounds"})]), POINTS, "plane"))
        .rejects.toMatchObject({status: 200, message: "Points are out of bounds"});
    await expect(Measure.measureVolume(volumeCtx([json(429, {error: "Too many"})]), POINTS, "plane"))
        .rejects.toMatchObject({status: 429, message: "Too many"});
    await expect(Measure.measureVolume(volumeCtx([json(200, {celery_task_id: "j"}), json(404, {detail: "Not found."})]), POINTS, "plane"))
        .rejects.toMatchObject({status: 404});
    await expect(Measure.measureVolume(volumeCtx([json(200, {celery_task_id: "j"}), json(200, {output: "nope"})]), POINTS, "plane"))
        .rejects.toMatchObject({status: 200});
});

test("a volume nobody waits for any more stops asking", async () => {
    let current = true;
    const ctx = volumeCtx([json(200, {celery_task_id: "j"}), json(200, {error: "Task not ready"})]);
    ctx.wait = jest.fn(() => { current = false; return Promise.resolve(); });
    await expect(Measure.measureVolume(ctx, POINTS, "plane", () => current)).rejects.toMatchObject({message: "stale"});
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
});

// Leaflet's calls as measure.js makes them
function fakeLeaflet() {
    const handlers = {};
    const group = {layers: [], clearLayers() { group.layers = []; }, addTo() { return group; }};
    const layer = (kind, latlngs) => ({kind, latlngs, addTo(g) { g.layers.push(this); return this; }});
    const map = {
        on: jest.fn((name, fn) => { handlers[name] = fn; }),
        off: jest.fn((name) => { delete handlers[name]; }),
        removeLayer: jest.fn(),
        doubleClickZoom: {enable: jest.fn(), disable: jest.fn()},
    };
    const L = {
        layerGroup: () => group,
        polyline: (latlngs) => layer("line", latlngs),
        polygon: (latlngs) => layer("polygon", latlngs),
        circleMarker: (at) => layer("point", at),
    };
    return {L, map, handlers, group};
}

const TEXTS = {measure: "Measure", length: "Length", area: "Area", point: "Point", hintLength: "hl", hintArea: "ha", hintPoint: "hp",
    hintDone: "hd", lengthLabel: "Length", areaLabel: "Area", perimeter: "Perimeter", volume: "Volume", computing: "Computing...",
    base: "Volume Base", methods: {triangulate: "Triangulate", plane: "Plane", average: "Average", highest: "Highest", lowest: "Lowest"},
    volumeFailed: "The volume could not be measured.", volumeTimeout: "too long", elevation: "Elevation", reading: "Reading...",
    surface: "Surface", ground: "Ground", heightAboveGround: "Height Above Ground", noValue: "No value here",
    elevationFailed: "The elevation could not be read.", undo: "Undo", finish: "Finish", clear: "Clear", close: "Close"};

function render(attributes, fetch) {
    document.body.innerHTML = `
        <div data-explorer-map data-invalid="This link is no longer valid.">
            <button data-tool="measure" ${attributes}></button>
            <input type="hidden" name="csrfmiddlewaretoken" value="tok">
            <div class="explorer-map"></div>
        </div>
        <script type="application/json" id="explorer-measure-texts">${JSON.stringify(TEXTS)}</script>`;
    const page = document.querySelector("[data-explorer-map]");
    const fake = fakeLeaflet();
    const tool = Measure.init(page, {L: fake.L, map: fake.map, fetch: fetch || jest.fn(), wait: () => Promise.resolve(), now: () => 0});
    const results = () => [...page.querySelectorAll(".explorer-measure-results dt, .explorer-measure-results dd")].map((e) => e.textContent);
    const click = (lat, lng) => fake.handlers.click({latlng: {lat, lng}});
    return {page, tool, fake, results, click, panel: () => page.querySelector(".explorer-measure")};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => window.localStorage.clear());

test("Length draws the path as points are clicked and reads its geodesic length; Finish ends it", () => {
    const { tool, fake, results, click, page } = render("");
    tool.on();
    expect(fake.map.doubleClickZoom.disable).toHaveBeenCalled();
    click(0, 0);
    click(0, 0.001);
    expect(results()[0]).toBe("Length");
    expect(results()[1].replace(/[\u00a0,]/g, "")).toBe(Measure.formatLength(Measure.pathLength([[0, 0], [0, 0.001]]), false).replace(/[\u00a0,]/g, ""));
    expect(fake.group.layers.map((l) => l.kind)).toEqual(["line", "point", "point"]);
    page.querySelector("[data-finish]").click();
    expect(tool.state().done).toBe(true);
    // The next click starts a new measurement
    click(1, 1);
    expect(tool.state().points).toEqual([[1, 1]]);
});

test("a double-click ends the shape without the point its two clicks added twice", () => {
    const { tool, fake, click } = render("");
    tool.on();
    click(0, 0);
    click(0, 1);
    click(0, 1);
    fake.handlers.dblclick();
    expect(tool.state().points).toEqual([[0, 0], [0, 1]]);
    expect(tool.state().done).toBe(true);
});

test("Undo takes the last point back; Clear starts over", () => {
    const { tool, click, page } = render("");
    tool.on();
    click(0, 0);
    click(0, 1);
    page.querySelector("[data-undo]").click();
    expect(tool.state().points).toEqual([[0, 0]]);
    page.querySelector("[data-clear]").click();
    expect(tool.state().points).toEqual([]);
});

test("Area reads area and perimeter; with a DSM and volume available, Finish asks WebODM for the volume in the base chosen", async () => {
    window.localStorage.setItem("explorer-volume-method", "lowest");
    const fetch = jest.fn()
        .mockReturnValueOnce(json(200, {celery_task_id: "j"}))
        .mockReturnValueOnce(json(200, {output: 1000}));
    const { tool, click, results, page } = render('data-dsm data-volume-start="/v" data-volume-result="/v/get/"', fetch);
    tool.on();
    tool.setMode("area");
    click(0, 0);
    click(0, 0.001);
    click(0.001, 0.001);
    expect(results().filter((_, i) => i % 2 === 0)).toEqual(["Area", "Perimeter"]);
    tool.finish();
    expect(results()).toContain("Computing...");
    expect(JSON.parse(fetch.mock.calls[0][1].body).method).toBe("lowest");
    await settle(); await settle(); await settle();
    expect(results()).toContain("Volume");
    expect(results().join(" ")).toMatch(/1,?000\.00 m³/);
    expect(page.querySelector(".explorer-measure-method").hidden).toBe(false);
});

test("Area without a DSM or without WebODM's Measure plugin has no volume", () => {
    const { tool, click, results, page } = render("data-dsm");
    tool.on();
    tool.setMode("area");
    [[0, 0], [0, 1], [1, 1]].forEach(([a, b]) => click(a, b));
    tool.finish();
    expect(results()).not.toContain("Volume");
    expect(page.querySelector(".explorer-measure-method").hidden).toBe(true);
});

test("a link that is gone says so instead of a volume; a full link says WebODM's message", async () => {
    let r = render('data-dsm data-link data-volume-start="/v" data-volume-result="/v/get/"', jest.fn(() => json(404, {})));
    r.tool.on();
    r.tool.setMode("area");
    [[0, 0], [0, 1], [1, 1]].forEach(([a, b]) => r.click(a, b));
    r.tool.finish();
    await settle(); await settle();
    expect(r.results()).toContain("This link is no longer valid.");
    r = render('data-dsm data-link data-volume-start="/v" data-volume-result="/v/get/"', jest.fn(() => json(429, {error: "Too many at once"})));
    r.tool.on();
    r.tool.setMode("area");
    [[0, 0], [0, 1], [1, 1]].forEach(([a, b]) => r.click(a, b));
    r.tool.finish();
    await settle(); await settle();
    expect(r.results()).toContain("Too many at once");
});

test("Point reads the DSM and DTM under the click and the height above ground between them", async () => {
    const fetch = jest.fn(() => json(200, {dsm: 110, dtm: 95.5}));
    const { tool, click, results } = render('data-elevation="/e/" data-dsm data-dtm', fetch);
    tool.on();
    tool.setMode("point");
    click(1.5, 2.5);
    expect(fetch.mock.calls[0][0]).toBe("/e/?lng=2.5&lat=1.5");
    expect(results()).toContain("Reading...");
    await settle(); await settle();
    expect(results()).toEqual(["Surface", "110.00 m", "Ground", "95.50 m", "Height Above Ground", "14.50 m"]);
});

test("a point outside a raster says it has no value there, with no height above ground", async () => {
    const { tool, click, results } = render('data-elevation="/e/" data-dsm data-dtm', jest.fn(() => json(200, {dsm: 100, dtm: null})));
    tool.on();
    tool.setMode("point");
    click(1, 2);
    await settle(); await settle();
    expect(results()).toEqual(["Surface", "100.00 m", "Ground", "No value here"]);
});

test("Point is offered only with an elevation raster", () => {
    let r = render("");
    r.tool.on();
    expect(r.page.querySelector("[data-mode=point]")).toBeNull();
    r = render('data-elevation="/e/" data-dtm');
    r.tool.on();
    expect(r.page.querySelector("[data-mode=point]")).not.toBeNull();
});

test("a unit switch on the legend reads the results again in feet", () => {
    const { tool, click, results, page } = render("");
    tool.on();
    click(0, 0);
    click(0, 0.001);
    expect(results()[1]).toMatch(/ m$/);
    window.localStorage.setItem("explorer-units-elevation", "ft");
    page.dispatchEvent(new window.CustomEvent("explorer-units"));
    expect(results()[1]).toMatch(/ ft$/);
});

test("one tool at a time: Measure turning on tells the others, and another tool turning on closes it", () => {
    const { tool, page, fake } = render("");
    const heard = [];
    page.addEventListener("explorer-tool", (e) => heard.push(e.detail.source));
    tool.on();
    expect(heard).toEqual(["measure"]);
    page.dispatchEvent(new window.CustomEvent("explorer-tool", {detail: {tool: "laser", source: "present"}}));
    expect(tool.state().on).toBe(false);
    expect(fake.map.off).toHaveBeenCalledWith("click", expect.any(Function));
    expect(fake.map.doubleClickZoom.enable).toHaveBeenCalled();
});

test("M toggles the tool, Backspace undoes, Enter finishes, Escape closes", () => {
    const { tool, click } = render("");
    const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown", {key: k}));
    key("m");
    expect(tool.state().on).toBe(true);
    click(0, 0);
    click(0, 1);
    click(0, 2);
    key("Backspace");
    expect(tool.state().points).toHaveLength(2);
    key("Enter");
    expect(tool.state().done).toBe(true);
    key("Escape");
    expect(tool.state().on).toBe(false);
});

// The 3D page's values: in the task's grid, horizontal parts divided by its scale factor
test("a 3D distance has its horizontal and vertical parts and its slope, the horizontal on the ground", () => {
    const d = Measure.distance3d([0, 0, 100], [3, 4, 112], 1);
    expect(d.length).toBeCloseTo(13, 9);
    expect(d.horizontal).toBeCloseTo(5, 9);
    expect(d.vertical).toBeCloseTo(12, 9);
    expect(d.degrees).toBeCloseTo(Math.atan2(12, 5) * 180 / Math.PI, 9);
    expect(d.percent).toBeCloseTo(240, 9);
    // UTM's grid is 0.9996 of the ground on its central meridian: 9996 m of grid are 10 km on the ground
    expect(Measure.distance3d([0, 0, 0], [9996, 0, 0], 0.9996).horizontal).toBeCloseTo(10000, 6);
    expect(Measure.distance3d([0, 0, 0], [0, 0, 5], 1).percent).toBeNull();
    expect(Measure.distance3d([0, 0, 5], [1, 0, 0], 1).vertical).toBe(-5);
});

test("a 3D area is its area seen from above and its area on the plane through the points", () => {
    // A 10 m x 10 m roof face rising 10 m across: 100 m2 from above, 100 * sqrt(2) on the slope
    const roof = [[0, 0, 0], [10, 0, 0], [10, 10, 10], [0, 10, 10]];
    const a = Measure.area3d(roof, 1);
    expect(a.horizontal).toBeCloseTo(100, 9);
    expect(a.sloped).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(a.perimeter).toBeCloseTo(20 + 20 * Math.SQRT2, 9);
    expect(Measure.area3d(roof.slice().reverse(), 1).horizontal).toBeCloseTo(100, 9);
    expect(Measure.area3d([[0, 0, 0], [9996, 0, 0], [9996, 9996, 0]], 0.9996).horizontal).toBeCloseTo(5e7, 0);
});

test("an angle is the one at the middle point, in degrees", () => {
    expect(Measure.angle3d([1, 0, 0], [0, 0, 0], [0, 1, 0], 1)).toBeCloseTo(90, 9);
    expect(Measure.angle3d([1, 0, 0], [0, 0, 0], [1, 0, 1], 1)).toBeCloseTo(45, 9);
    expect(Measure.angle3d([1, 0, 0], [0, 0, 0], [-1, 0, 0], 1)).toBeCloseTo(180, 9);
});

// The shared panel on another surface (the 3D page's), with the modes it has
function fakeSurface() {
    return {
        started: null, drawn: 0,
        start(h) { this.started = h; }, stop() { this.started = null; }, draw() { this.drawn++; },
        hint: (state) => "hint " + state.mode, rows: (state) => [["Points", String(state.points.length)]],
    };
}

function renderScene() {
    document.body.innerHTML = `<div data-explorer-viewer><button data-tool="measure"></button><div class="explorer-scene"></div></div>`;
    const page = document.querySelector("[data-explorer-viewer]");
    const surface = fakeSurface();
    const tool = Measure.create({page, view: page.querySelector(".explorer-scene"), toggle: page.querySelector("[data-tool=measure]"),
        texts: Object.assign({}, TEXTS, {distance: "Distance", angle: "Angle", units: "Switch units"}), surface, units: true,
        modes: ["distance", "area", "point", "angle"]});
    return {page, surface, tool};
}

test("Distance finishes by itself at its second point, Angle at its third", () => {
    const { surface, tool } = renderScene();
    tool.on();
    surface.started.click([0, 0, 0]);
    expect(tool.state().done).toBe(false);
    surface.started.click([1, 0, 0]);
    expect(tool.state().done).toBe(true);
    tool.setMode("angle");
    [[0, 0, 0], [1, 0, 0], [1, 1, 0]].forEach((p) => surface.started.click(p));
    expect(tool.state().done).toBe(true);
    expect(tool.state().points).toHaveLength(3);
});

test("the same spot picked twice (a double-click) is one point; a click on nothing says so until the next click", () => {
    const { page, surface, tool } = renderScene();
    tool.on();
    tool.setMode("area");
    surface.started.click([0, 0, 0]);
    surface.started.click([0, 0, 0]);
    expect(tool.state().points).toHaveLength(1);
    surface.started.say("Nothing there");
    expect(page.querySelector(".explorer-measure-hint").textContent).toBe("Nothing there");
    surface.started.click([1, 0, 0]);
    expect(page.querySelector(".explorer-measure-hint").textContent).toBe("hint area");
});

test("Clear, another mode and closing cancel what the surface is still working out; a new shape after Finish doesn't", () => {
    const { page, surface, tool } = renderScene();
    surface.cancelled = 0;
    surface.cancel = () => { surface.cancelled++; };
    tool.on();
    tool.setMode("area");
    expect(surface.cancelled).toBe(1);
    [[0, 0, 0], [1, 0, 0], [1, 1, 0]].forEach((p) => surface.started.click(p));
    surface.started.finish();
    surface.started.click([5, 5, 0]);  // starts a new shape: the picks after it must still count
    expect(surface.cancelled).toBe(1);
    page.querySelector("[data-clear]").click();
    expect(surface.cancelled).toBe(2);
    tool.off();
    expect(surface.cancelled).toBe(3);
});

test("the hint follows the 3D page's view switch", () => {
    const { page, surface, tool } = renderScene();
    let view = "mesh";
    surface.hint = () => "hint on " + view;
    tool.on();
    view = "splats";
    page.dispatchEvent(new window.CustomEvent("explorer-view", {detail: {type: "splats"}}));
    expect(page.querySelector(".explorer-measure-hint").textContent).toBe("hint on splats");
});

test("the panel's unit switch flips metres and feet and tells the page", () => {
    const { page, tool } = renderScene();
    tool.on();
    const heard = [];
    page.addEventListener("explorer-units", () => heard.push(true));
    const units = page.querySelector("[data-units]");
    expect(units.textContent).toBe("m");
    units.click();
    expect(window.localStorage.getItem("explorer-units-elevation")).toBe("ft");
    expect(units.textContent).toBe("ft");
    expect(heard).toHaveLength(1);
    expect(page.querySelector(".explorer-measure-method").hidden).toBe(true);  // no Volume Base in 3D
});

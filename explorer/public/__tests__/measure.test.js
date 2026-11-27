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

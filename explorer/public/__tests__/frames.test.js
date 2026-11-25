const Frames = require("../frames.js");
const Present = require("../present.js");

// jsdom has no Pointer Events, no canvas drawing and no pointer capture: the same stand-ins as present.test.js
class FakePointerEvent extends MouseEvent {
    constructor(type, init) {
        super(type, init);
        this.pointerId = (init && init.pointerId) || 1;
        this.pointerType = (init && init.pointerType) || "mouse";
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const COLOURS = {laser: "rgb(231, 76, 60)", highlight: "rgb(243, 156, 18)", outline: "rgb(44, 62, 80)"};
const TEXTS = {label: "Click to View Source Frames", title: "Source Frames", finding: "Finding the photos...",
    none: "No photo shows this spot.", failed: "The photos could not be found.", nothing: "Nothing there: click on the model.",
    open: "Open Full Frame", download: "Download", close: "Close", previous: "Previous Photo", next: "Next Photo",
    zoomIn: "Zoom In", zoomOut: "Zoom Out", list: "Photos, best first", full: "Full Frame", file: "File",
    captured: "Captured", camera: "Camera", size: "Size", altitude: "Camera Altitude", missing: "This photo could not be loaded."};

function frame(name, extra) {
    return Object.assign({filename: name, camera: "v2 test cam", width: 4000, height: 3000, capture_time: 1000,
        altitude: 120.04, centre: 0, spot: [0.5, 0.5]}, extra);
}

function answer(status, body) {
    return Promise.resolve({ok: status < 400, status, json: () => Promise.resolve(body)});
}

// A Leaflet stand-in: map.on/off for click, circleMarker recording where it is
function fakeLeaflet() {
    const handlers = {};
    const markers = [];
    const map = {
        on: (type, fn) => { handlers[type] = fn; },
        off: (type) => { delete handlers[type]; },
        removeLayer: (m) => { m.removed = true; },
        click: (lat, lng) => handlers.click && handlers.click({latlng: {lat, lng}})
    };
    const L = {circleMarker: (latlng, options) => {
        const m = {latlng, options, setLatLng(p) { this.latlng = p; }, addTo() { markers.push(this); return this; }};
        return m;
    }};
    return {map, L, markers, handlers};
}

beforeEach(() => {
    window.PointerEvent = FakePointerEvent;
    HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {get: () => () => {}});
    HTMLElement.prototype.setPointerCapture = function () {};
    HTMLElement.prototype.hasPointerCapture = function () { return false; };
    HTMLElement.prototype.releasePointerCapture = function () {};
});

afterEach(() => {
    delete window.PointerEvent;
    window.localStorage.clear();
    // Listeners from earlier tests stay on document: each test makes its own page
    document.body.innerHTML = "";
});

function render(kind, responses, options) {
    document.body.innerHTML = `
        <div class="page" data-explorer-${kind === "map" ? "map" : "viewer"}>
            <div data-present>
                <button data-tool="laser" aria-pressed="false"></button>
                <button data-tool="highlight" aria-pressed="false"></button>
                <button data-tool="frames" aria-pressed="false" data-frames-api="/api/frames/" data-images="/api/images/"></button>
                <input type="hidden" name="csrfmiddlewaretoken" value="tok">
            </div>
            <script type="application/json" id="explorer-frames-texts">${JSON.stringify(TEXTS)}</script>
            <input type="search" id="field">
            <div class="${kind === "map" ? "explorer-map" : "explorer-scene"}"><div class="inner"></div></div>
        </div>`;
    const page = document.querySelector(".page");
    const fetch = jest.fn(() => responses.shift());
    const assign = jest.fn();
    const leaflet = fakeLeaflet();
    const present = Present.init(page, {now: () => 0, frame: () => {}});
    const frames = Frames.init(page, Object.assign({fetch, assign, colours: COLOURS, map: leaflet.map, L: leaflet.L}, options));
    return {page, fetch, assign, leaflet, present, frames, button: page.querySelector("[data-tool=frames]"),
        view: page.querySelector(".explorer-map, .explorer-scene")};
}

function key(name, target) {
    (target || document.body).dispatchEvent(new KeyboardEvent("keydown", {key: name, bubbles: true, cancelable: true}));
}

test("S turns Source Frames on with its label, and a click on the map asks for that spot's photos", async () => {
    const { page, fetch, leaflet, button } = render("map", [answer(200, {frames: [frame("a.jpg"), frame("b.jpg", {spot: [0.2, 0.7]})]})]);
    key("s");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(page.querySelector(".explorer-sf-label").textContent).toContain("Click to View Source Frames");
    leaflet.map.click(45.1, -86.2);
    expect(leaflet.markers).toHaveLength(1);
    expect(leaflet.markers[0].options.color).toBe(COLOURS.highlight);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("/api/frames/");
    expect(request.headers["X-CSRFToken"]).toBe("tok");
    expect(JSON.parse(request.body)).toEqual({type: "Point", coordinates: [-86.2, 45.1]});
    expect(page.querySelector(".explorer-sf-window").textContent).toContain("Finding the photos...");
    await settle();
    const items = page.querySelectorAll(".explorer-sf-item");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(page.querySelector(".explorer-sf-title").textContent).toBe("Source Frames (2)");
    const main = page.querySelector(".explorer-sf-main-photo img");
    expect(main.getAttribute("src")).toBe("/api/images/thumbnail/a.jpg?size=1024");
    const props = page.querySelector(".explorer-sf-props").textContent;
    expect(props).toContain("test cam");
    expect(props).toContain("4000 × 3000 px");
    expect(props).toContain("120.0 m");
    // The ring on the photo, in the theme's colours
    const rings = page.querySelectorAll(".explorer-sf-main-photo ellipse");
    expect(rings[1].getAttribute("stroke")).toBe(COLOURS.highlight);
    items[1].click();
    expect(page.querySelector(".explorer-sf-main-photo ellipse").getAttribute("cx")).toBe("0.2");
});

test("a later spot wins over an answer still on its way, which is cancelled", async () => {
    let first;
    const slow = new Promise((resolve) => { first = resolve; });
    const { page, fetch, leaflet } = render("map", [slow, answer(200, {frames: [frame("late.jpg")]})]);
    key("s");
    leaflet.map.click(1, 1);
    leaflet.map.click(2, 2);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await settle();
    first({ok: true, status: 200, json: () => Promise.resolve({frames: [frame("early.jpg")]})});
    await settle();
    expect(page.querySelector(".explorer-sf-item").title).toBe("late.jpg");
    expect(leaflet.markers).toHaveLength(1);  // one spot, moved
    expect(leaflet.markers[0].latlng).toEqual({lat: 2, lng: 2});
});

test("no photo, a refusal and a broken answer each say so", async () => {
    const { page, leaflet } = render("map", [answer(200, {frames: []}), answer(400, {detail: "This task has no cameras"}),
        Promise.resolve({ok: false, status: 502, json: () => Promise.reject(new Error("html"))})]);
    key("s");
    leaflet.map.click(1, 1);
    await settle();
    expect(page.querySelector(".explorer-sf-body").textContent).toBe("No photo shows this spot.");
    leaflet.map.click(1, 2);
    await settle();
    expect(page.querySelector(".explorer-sf-body").textContent).toBe("This task has no cameras");
    leaflet.map.click(1, 3);
    await settle();
    expect(page.querySelector(".explorer-sf-body").textContent).toBe("The photos could not be found.");
});

test("a photo that can't load says so in its place", async () => {
    const { page, leaflet } = render("map", [answer(200, {frames: [frame("gone.jpg")]})]);
    key("s");
    leaflet.map.click(1, 1);
    await settle();
    page.querySelector(".explorer-sf-main-photo img").dispatchEvent(new Event("error"));
    expect(page.querySelector(".explorer-sf-main-photo").textContent).toBe("This photo could not be loaded.");
});

test("Esc, the window's Close and the button each turn it off, taking the spot and the window away", async () => {
    const { page, leaflet, button, frames } = render("map", [answer(200, {frames: [frame("a.jpg")]}), answer(200, {frames: [frame("a.jpg")]})]);
    key("s");
    leaflet.map.click(1, 1);
    await settle();
    key("Escape");
    expect(frames.isOn()).toBe(false);
    expect(page.querySelector(".explorer-sf-window")).toBeNull();
    expect(page.querySelector(".explorer-sf-label")).toBeNull();
    expect(leaflet.markers[0].removed).toBe(true);
    expect(leaflet.handlers.click).toBeUndefined();
    button.click();
    leaflet.map.click(1, 1);
    await settle();
    page.querySelector(".explorer-sf-close").click();
    expect(frames.isOn()).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
});

test("one tool at a time: Source Frames turns the Laser Pointer off, and the Laser Pointer turns it off", () => {
    const { present, frames } = render("map", []);
    key("l");
    expect(present.state().tool).toBe("laser");
    key("s");
    expect(frames.isOn()).toBe(true);
    expect(present.state().tool).toBeNull();
    key("h");
    expect(present.state().tool).toBe("highlight");
    expect(frames.isOn()).toBe(false);
});

test("S typed into a field is not a shortcut", () => {
    const { frames, page } = render("map", []);
    key("s", page.querySelector("#field"));
    expect(frames.isOn()).toBe(false);
});

test("Open Full Frame takes the keyboard, steps with the arrows, and gives the focus back to Open Full Frame", async () => {
    const { page, leaflet, frames, assign } = render("map", [answer(200, {frames: [frame("a.jpg"), frame("b.jpg"), frame("c.jpg")]})]);
    key("s");
    leaflet.map.click(1, 1);
    await settle();
    page.querySelector(".explorer-sf-open").click();
    const viewer = page.querySelector(".explorer-sf-viewer");
    expect(viewer).not.toBeNull();
    expect(document.activeElement.getAttribute("aria-label")).toBe("Close");
    expect(viewer.querySelector("img").getAttribute("src")).toBe("/api/images/thumbnail/a.jpg?size=4000");
    key("ArrowRight");
    key("ArrowRight");
    expect(viewer.querySelector(".explorer-sf-viewer-name").textContent).toBe("3 / 3 · c.jpg");
    key("ArrowRight");
    expect(viewer.querySelector(".explorer-sf-viewer-name").textContent).toBe("1 / 3 · a.jpg");
    key("ArrowLeft");
    // Letters belong to the viewer while it is open: L doesn't turn the Laser Pointer on behind it
    key("l");
    expect(page.querySelector("[data-tool=laser]").getAttribute("aria-pressed")).toBe("false");
    viewer.querySelector("[aria-label=Download]").click();
    expect(assign).toHaveBeenCalledWith("/api/images/download/c.jpg");
    // Esc closes the viewer only; the window shows the photo it ended on, Open Full Frame focused
    key("Escape");
    expect(page.querySelector(".explorer-sf-viewer")).toBeNull();
    expect(frames.isOn()).toBe(true);
    expect(page.querySelectorAll(".explorer-sf-item")[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement.classList.contains("explorer-sf-open")).toBe(true);
});

test("on the 3D page a click picks the model's point and sends it in the task's coordinates; a drag doesn't", async () => {
    const scene = {offset: {x: 1000, y: 2000, z: 0}, setMarker: jest.fn(),
        pick: jest.fn(() => Promise.resolve({x: 5, y: 6, z: 7}))};
    const { page, fetch, view } = render("3d", [answer(200, {frames: [frame("a.jpg")]})], {scene});
    key("s");
    const press = (type, x, y, extra) => view.querySelector(".inner").dispatchEvent(
        new FakePointerEvent(type, Object.assign({bubbles: true, clientX: x, clientY: y, button: 0}, extra)));
    press("pointerdown", 100, 100);
    press("pointerup", 140, 100);  // a drag: it orbits
    await settle();
    expect(scene.pick).not.toHaveBeenCalled();
    press("pointerdown", 100, 100);
    press("pointerup", 102, 101);
    await settle();
    expect(scene.pick).toHaveBeenCalledWith(102, 101);
    expect(scene.setMarker).toHaveBeenCalledWith({x: 5, y: 6, z: 7}, {spot: COLOURS.highlight, outline: COLOURS.outline});
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({type: "Point", coordinates: [1005, 2006, 7], crs: "task"});
    await settle();
    expect(page.querySelectorAll(".explorer-sf-item")).toHaveLength(1);
    // A click on empty space says so
    scene.pick.mockImplementation(() => Promise.resolve(null));
    press("pointerdown", 10, 10);
    press("pointerup", 10, 10);
    await settle();
    expect(page.querySelector(".explorer-sf-hint").textContent).toBe("Nothing there: click on the model.");
    key("s");
    expect(scene.setMarker).toHaveBeenLastCalledWith(null);
});

test("before the 3D scene has started, the button does nothing yet", () => {
    const { frames } = render("3d", [], {scene: null});
    key("s");
    expect(frames.isOn()).toBe(false);
});

test("a page without the button (a link, View as Visitor) has no Source Frames", () => {
    document.body.innerHTML = `<div class="page"><button data-tool="frames" aria-disabled="true"></button><div class="explorer-map"></div></div>`;
    expect(Frames.init(document.querySelector(".page"))).toBeNull();
});

test("capture times read as dates, and none as nothing", () => {
    expect(Frames.formatTime(0)).toBe("");
    expect(Frames.formatTime(1000)).toBe(new Date(1000000).toLocaleString());
    expect(Frames.imageUrl("/i/", "a b.jpg", "thumbnail", 256)).toBe("/i/thumbnail/a%20b.jpg?size=256");
});

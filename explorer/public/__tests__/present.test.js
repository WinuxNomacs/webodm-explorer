const Present = require("../present.js");

// jsdom has no Pointer Events or canvas drawing: a PointerEvent built on MouseEvent, pointer capture kept per element,
// and a 2D context that records what is drawn
class FakePointerEvent extends MouseEvent {
    constructor(type, init) {
        super(type, init);
        this.pointerId = (init && init.pointerId) || 1;
        this.pointerType = (init && init.pointerType) || "mouse";
        this.isPrimary = true;
    }
}

let drawn;
let clock;
let frames;

function fakeContext() {
    const ctx = {};
    ["setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "closePath", "rect", "ellipse", "arc",
        "fill", "stroke", "save", "restore"].forEach((name) => {
        ctx[name] = (...args) => drawn.push([name, ...args]);
    });
    return ctx;
}

beforeEach(() => {
    drawn = [];
    clock = 1000;
    frames = [];
    window.PointerEvent = FakePointerEvent;
    HTMLCanvasElement.prototype.getContext = fakeContext;
    const captured = new WeakMap();
    HTMLElement.prototype.setPointerCapture = function (id) { captured.set(this, id); };
    HTMLElement.prototype.hasPointerCapture = function (id) { return captured.get(this) === id; };
    HTMLElement.prototype.releasePointerCapture = function () { captured.delete(this); };
});

afterEach(() => {
    delete window.PointerEvent;
    window.localStorage.clear();
    jest.restoreAllMocks();
    // Listeners from earlier tests stay on document: each test makes its own page
    document.body.innerHTML = "";
});

function render() {
    document.body.innerHTML = `
        <div class="page" data-explorer-map>
            <div data-present>
                <button data-tool="laser" aria-pressed="false"></button>
                <button data-tool="highlight" aria-pressed="false"></button>
                <ul>
                    <li><a href="#" data-shape="freehand"></a></li>
                    <li><a href="#" data-shape="rectangle"></a></li>
                    <li><a href="#" data-shape="ellipse"></a></li>
                    <li><a href="#" data-spotlight></a></li>
                    <li><a href="#" data-clear></a></li>
                </ul>
            </div>
            <input type="search" id="field">
            <div class="explorer-map"><div class="pane"></div></div>
        </div>`;
    const page = document.querySelector(".page");
    const view = page.querySelector(".explorer-map");
    view.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 300});
    const present = Present.init(page, {now: () => clock, frame: (callback) => frames.push(callback)});
    return {page, view, pane: view.querySelector(".pane"), present, state: () => present.state()};
}

// Runs the frames asked for so far, as the browser would on its next repaint
function paint() {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback());
}

function pointer(target, type, x, y, options) {
    const event = new FakePointerEvent(type, Object.assign({bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0}, options));
    target.dispatchEvent(event);
    return event;
}

function key(name, target) {
    (target || document.body).dispatchEvent(new KeyboardEvent("keydown", {key: name, bubbles: true}));
}

function drag(target, points, options) {
    pointer(target, "pointerdown", points[0][0], points[0][1], options);
    points.slice(1).forEach(([x, y]) => pointer(target, "pointermove", x, y, options));
    const [x, y] = points[points.length - 1];
    return pointer(target, "pointerup", x, y, options);
}

test("a rectangle and an ellipse go from corner to corner, and a freehand loop keeps its points", () => {
    const points = [{x: 10, y: 50}, {x: 40, y: 20}, {x: 70, y: 90}];
    expect(Present.makeShape("rectangle", points, false, 0)).toMatchObject({kind: "rectangle", x: 10, y: 50, w: 60, h: 40});
    expect(Present.makeShape("ellipse", points, false, 0)).toMatchObject({kind: "ellipse", cx: 40, cy: 70, rx: 30, ry: 20});
    expect(Present.makeShape("freehand", points, true, 0)).toMatchObject({kind: "freehand", kept: true, points});
});

test("a drag too short to mean anything draws nothing", () => {
    expect(Present.makeShape("freehand", [{x: 0, y: 0}, {x: 3, y: 4}], false, 0)).toBeNull();
    expect(Present.makeShape("rectangle", [{x: 0, y: 0}, {x: 50, y: 50}, {x: 2, y: 2}], false, 0)).toBeNull();
    expect(Present.makeShape("ellipse", [], false, 0)).toBeNull();
});

test("a highlight shows fully, then fades out, and a kept one stays", () => {
    const shape = {at: 0, kept: false};
    expect(Present.opacity(shape, Present.HOLD_MS)).toBe(1);
    expect(Present.opacity(shape, Present.HOLD_MS + Present.FADE_MS / 2)).toBeCloseTo(0.5);
    expect(Present.opacity(shape, Present.HOLD_MS + Present.FADE_MS)).toBe(0);
    expect(Present.opacity({at: 0, kept: true}, 1e9)).toBe(1);
});

test("the laser's trail keeps only its recent points, and a freehand loop skips points too close together", () => {
    expect(Present.trail([{at: 0}, {at: 400}, {at: 900}], 1000)).toEqual([{at: 900}]);
    const points = Present.addPoint(Present.addPoint([{x: 0, y: 0}], {x: 1, y: 1}), {x: 5, y: 0});
    expect(points).toEqual([{x: 0, y: 0}, {x: 5, y: 0}]);
});

test("L and H turn the tools on and off, one at a time, and keys typed into a field are ignored", () => {
    const { page, view, state } = render();
    const laser = page.querySelector("[data-tool=laser]");
    const highlight = page.querySelector("[data-tool=highlight]");
    key("l");
    expect(state().tool).toBe("laser");
    expect(laser.getAttribute("aria-pressed")).toBe("true");
    expect(view.classList.contains("explorer-present-laser")).toBe(true);
    key("h");
    expect(state().tool).toBe("highlight");
    expect(laser.getAttribute("aria-pressed")).toBe("false");
    expect(view.classList.contains("explorer-present-laser")).toBe(false);
    key("h");
    expect(state().tool).toBeNull();
    key("l", page.querySelector("#field"));
    expect(state().tool).toBeNull();
    highlight.click();
    expect(state().tool).toBe("highlight");
});

test("a highlight drag doesn't reach the view, draws its shape, and fades away", () => {
    const { pane, state } = render();
    const seen = jest.fn();
    pane.addEventListener("pointerdown", seen);
    pane.addEventListener("pointermove", seen);
    key("h");
    const up = drag(pane, [[10, 10], [60, 20], [80, 70], [20, 60]]);
    expect(seen).not.toHaveBeenCalled();
    expect(up.defaultPrevented).toBe(true);
    expect(state().shapes).toHaveLength(1);
    expect(state().shapes[0].kind).toBe("freehand");
    paint();
    expect(drawn.some(([name]) => name === "lineTo")).toBe(true);
    // Still asks for frames while it fades, then stops once it is gone
    clock += Present.HOLD_MS + Present.FADE_MS + 1;
    paint();
    expect(state().shapes).toHaveLength(0);
    expect(frames).toHaveLength(0);
});

test("a click while highlighting doesn't reach the view, so it doesn't zoom or focus", () => {
    const { pane } = render();
    const clicked = jest.fn();
    pane.addEventListener("dblclick", clicked);
    key("h");
    pane.dispatchEvent(new MouseEvent("dblclick", {bubbles: true, cancelable: true}));
    expect(clicked).not.toHaveBeenCalled();
});

test("right-drag and the wheel still move the view while highlighting", () => {
    const { pane, state } = render();
    const seen = jest.fn();
    pane.addEventListener("pointerdown", seen);
    key("h");
    pointer(pane, "pointerdown", 10, 10, {button: 2});
    expect(seen).toHaveBeenCalledTimes(1);
    expect(state().gesture).toBeNull();
});

test("Shift keeps a highlight until Esc or Clear Highlights", () => {
    const { page, pane, state } = render();
    key("h");
    drag(pane, [[10, 10], [90, 80]], {shiftKey: true});
    clock += 60000;
    paint();
    expect(state().shapes).toHaveLength(1);
    expect(frames).toHaveLength(0);  // a kept highlight needs no frames
    page.querySelector("[data-clear]").click();
    expect(state().shapes).toHaveLength(0);
    drag(pane, [[10, 10], [90, 80]], {shiftKey: true});
    key("Escape");
    expect(state().shapes).toHaveLength(0);
    expect(state().tool).toBeNull();
});

test("the chosen shape and Spotlight are remembered, and a store that throws leaves the defaults", () => {
    let { page, pane, state } = render();
    page.querySelector("[data-shape=ellipse]").click();
    expect(state().tool).toBe("highlight");  // choosing a shape turns the tool on
    page.querySelector("[data-spotlight]").click();
    expect(page.querySelector("[data-spotlight]").getAttribute("aria-checked")).toBe("true");
    drag(pane, [[10, 10], [90, 80]]);
    expect(state().shapes[0].kind).toBe("ellipse");
    paint();
    expect(drawn.some(([name]) => name === "fillRect")).toBe(true);  // the dimming around the shape
    ({ state } = render());
    expect(state().shape).toBe("ellipse");
    expect(state().spotlight).toBe(true);
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    ({ page, state } = render());
    expect(state().shape).toBe("freehand");
    expect(state().spotlight).toBe(false);
    page.querySelector("[data-shape=rectangle]").click();
    expect(state().shape).toBe("rectangle");
});

test("the mouse's laser follows the pointer without taking its presses, and leaves with it", () => {
    const { view, pane, state } = render();
    const seen = jest.fn();
    pane.addEventListener("pointerdown", seen);
    key("l");
    pointer(pane, "pointermove", 30, 40);
    expect(state().dot).toMatchObject({x: 30, y: 40});
    pointer(pane, "pointerdown", 30, 40);
    expect(seen).toHaveBeenCalledTimes(1);  // a drag still pans or orbits
    paint();
    expect(drawn.some(([name]) => name === "arc")).toBe(true);
    view.dispatchEvent(new FakePointerEvent("pointerleave", {pointerType: "mouse"}));
    expect(state().dot).toBeNull();
});

test("a finger points instead of moving the view, and a second finger gives both back to the view", () => {
    const { pane, state } = render();
    const seen = [];
    pane.addEventListener("pointerdown", (e) => seen.push(e.pointerId));
    key("l");
    pointer(pane, "pointerdown", 30, 40, {pointerType: "touch", pointerId: 7});
    pointer(pane, "pointermove", 50, 40, {pointerType: "touch", pointerId: 7});
    expect(seen).toEqual([]);
    expect(state().dot).toMatchObject({x: 50});
    pointer(pane, "pointerdown", 90, 90, {pointerType: "touch", pointerId: 8});
    expect(seen).toEqual([7, 8]);  // the first finger's press given back, then the second's own
    expect(state().gesture).toBeNull();
    expect(state().dot).toBeNull();
    // While the pinch lasts, a lifted and lowered finger is the view's too
    pointer(pane, "pointerup", 90, 90, {pointerType: "touch", pointerId: 8});
    pointer(pane, "pointerdown", 90, 90, {pointerType: "touch", pointerId: 9});
    expect(seen).toEqual([7, 8, 9]);
});

test("a finger the laser took keeps its touch events from the view, which Leaflet listens to on touch screens", () => {
    const { pane } = render();
    const touched = jest.fn();
    pane.addEventListener("touchstart", touched);
    pane.addEventListener("touchmove", touched);
    key("l");
    pointer(pane, "pointerdown", 30, 40, {pointerType: "touch", pointerId: 7});
    pane.dispatchEvent(new Event("touchstart", {bubbles: true, cancelable: true}));
    pane.dispatchEvent(new Event("touchmove", {bubbles: true, cancelable: true}));
    expect(touched).not.toHaveBeenCalled();
    // A second finger: both go to the view
    pointer(pane, "pointerdown", 90, 90, {pointerType: "touch", pointerId: 8});
    pane.dispatchEvent(new Event("touchstart", {bubbles: true, cancelable: true}));
    expect(touched).toHaveBeenCalledTimes(1);
});

test("a lost pointer capture ends the drawing as drawn", () => {
    const { view, pane, state } = render();
    key("h");
    pointer(pane, "pointerdown", 10, 10);
    pointer(pane, "pointermove", 80, 70);
    const lost = new FakePointerEvent("lostpointercapture", {pointerId: 1});
    view.dispatchEvent(lost);
    expect(state().gesture).toBeNull();
    expect(state().shapes).toHaveLength(1);
    expect(state().shapes[0].kept).toBe(false);
});

test("a resize clears the marks, whose places on the screen moved", () => {
    const { view, pane, present, state } = render();
    key("h");
    drag(pane, [[10, 10], [90, 80]], {shiftKey: true});
    Object.defineProperty(view, "clientWidth", {value: 500, configurable: true});
    present.fit();
    expect(state().shapes).toHaveLength(0);
});

test("the tools are hidden in a browser without Pointer Events", () => {
    delete window.PointerEvent;
    document.body.innerHTML = `<div class="page"><div data-present></div><div class="explorer-scene"></div></div>`;
    const page = document.querySelector(".page");
    expect(Present.init(page)).toBeNull();
    expect(page.querySelector("[data-present]").hidden).toBe(true);
});

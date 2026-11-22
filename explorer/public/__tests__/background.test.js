const viewer = require("../viewer-ui.js");

const desktop = {userAgent: "Mozilla/5.0 (X11; Linux x86_64)", touch: false};

function page() {
    document.body.innerHTML = `
        <div class="page" data-explorer-viewer data-initial="cloud" data-link="/l/" data-loading="Loading...">
            <button data-type="cloud" data-url="/c/">Cloud</button>
            <ul>
                <li><a href="#" data-background="grid">Grid</a></li><li><a href="#" data-background="sky">Sky</a></li>
                <li><a href="#" data-background="space">Space</a></li><li><a href="#" data-background="plain">Plain</a></li>
            </ul>
            <input type="search" id="field">
            <div class="explorer-status" hidden></div><div class="explorer-scene"></div>
        </div>`;
    return document.querySelector(".page");
}

function fakeScene() {
    return {resize: jest.fn(), reset: jest.fn(), setCloudStyle: jest.fn(), setBackground: jest.fn(), cloudRange: () => null,
        show: jest.fn(() => new Promise(() => {}))};
}

function checked() {
    return Array.prototype.map.call(document.querySelectorAll("[aria-checked=true]"), (a) => a.getAttribute("data-background"));
}

function key(name, target) {
    (target || document.body).dispatchEvent(new KeyboardEvent("keydown", {key: name, bubbles: true}));
}

afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = "";
});

test("the grid shows by default, before the model has loaded, and nothing is remembered until the visitor picks", () => {
    const scene = fakeScene();
    viewer.create(page(), desktop).start(scene);
    expect(scene.setBackground).toHaveBeenCalledWith("grid");
    expect(checked()).toEqual(["grid"]);
    expect(document.querySelector("li.active [data-background]").getAttribute("data-background")).toBe("grid");
    expect(window.localStorage.getItem(viewer.BACKGROUND_KEY)).toBeNull();
});

test("picking a background applies it, marks it in the menu and remembers it for the next page", () => {
    const scene = fakeScene();
    viewer.create(page(), desktop).start(scene);
    const space = document.querySelector("[data-background=space]");
    const click = new MouseEvent("click", {bubbles: true, cancelable: true});
    space.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); // the "#" link doesn't move the page
    expect(scene.setBackground).toHaveBeenLastCalledWith("space");
    expect(checked()).toEqual(["space"]);
    expect(window.localStorage.getItem(viewer.BACKGROUND_KEY)).toBe("space");
    const next = fakeScene();
    viewer.create(page(), desktop).start(next);
    expect(next.setBackground).toHaveBeenCalledWith("space");
});

test("B steps through the backgrounds in the menu's order, but not while typing", () => {
    const scene = fakeScene();
    viewer.create(page(), desktop).start(scene);
    key("b");
    expect(scene.setBackground).toHaveBeenLastCalledWith("sky");
    key("B");
    key("b");
    expect(scene.setBackground).toHaveBeenLastCalledWith("plain");
    key("b");
    expect(scene.setBackground).toHaveBeenLastCalledWith("grid");
    const calls = scene.setBackground.mock.calls.length;
    key("b", document.getElementById("field"));
    expect(scene.setBackground.mock.calls.length).toBe(calls);
});

test("an unknown remembered background falls back to the grid", () => {
    expect(viewer.backgroundChoice("nebula")).toBe("grid");
    expect(viewer.backgroundChoice(null)).toBe("grid");
    expect(viewer.backgroundChoice("plain")).toBe("plain");
});

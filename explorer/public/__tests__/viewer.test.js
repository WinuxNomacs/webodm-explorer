const viewer = require("../viewer-ui.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function page(initial) {
    document.body.innerHTML = `
        <div data-explorer-viewer data-initial="${initial}" data-link="/plugins/explorer/s/TOKEN/"
             data-loading="Loading..." data-invalid="Gone." data-error="Failed." data-no-webgl="No WebGL.">
            <button data-type="mesh" data-url="/api/m/textured_model/">Mesh</button>
            <button data-type="splats" data-url="/api/m/assets/splats/model.rad">Splats</button>
            <div class="explorer-status" hidden></div><div class="explorer-scene"></div>
        </div>`;
    return document.querySelector("[data-explorer-viewer]");
}

// A stand-in scene: each show() waits until the test resolves or rejects it
function fakeScene() {
    const calls = [];
    return {
        calls,
        resize: jest.fn(),
        setBackground: jest.fn(),
        show: jest.fn((type, url, onProgress, onFailure, fallback) => new Promise((resolve, reject) => {
            calls.push({type, url, onProgress, onFailure, fallback, resolve, reject});
        })),
    };
}

const desktop = {userAgent: "Mozilla/5.0 (X11; Linux x86_64)", touch: false};

afterEach(() => {
    delete window.fetch;
    jest.useRealTimers();
});

test("the GLB is asked for at the size WebODM picks for the device", () => {
    expect(viewer.platform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", true)).toBe("ios");
    expect(viewer.platform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", true)).toBe("ios");
    expect(viewer.platform("Mozilla/5.0 (Linux; Android 14)", true)).toBe("mobile");
    expect(viewer.platform(desktop.userAgent, false)).toBe("");
    expect(viewer.meshUrl("/m/", "ios")).toBe("/m/?platform=ios");
    expect(viewer.meshUrl("/m/", "")).toBe("/m/");
});

test("the point budget is the one WebODM's own 3D page sets for the device", () => {
    expect(viewer.pointBudget("ios")).toBe(1000000);
    expect(viewer.pointBudget("mobile")).toBe(2000000);
    expect(viewer.pointBudget("")).toBe(10000000);
    expect(viewer.create(page("mesh"), {userAgent: "Mozilla/5.0 (Linux; Android 14)", touch: true}).pointBudget).toBe(2000000);
});

test("a point cloud node that fails says the link is gone only when it is", async () => {
    const element = page("mesh");
    const scene = fakeScene();
    viewer.create(element, desktop).start(scene);
    scene.calls[0].resolve();
    await settle();
    const status = element.querySelector(".explorer-status");
    window.fetch = jest.fn(() => Promise.resolve({status: 200}));
    scene.calls[0].onFailure(500);
    await settle();
    expect(window.fetch).toHaveBeenCalledWith("/plugins/explorer/s/TOKEN/", expect.objectContaining({method: "HEAD"}));
    expect(status.hidden).toBe(true);
    window.fetch = jest.fn(() => Promise.resolve({status: 404}));
    scene.calls[0].onFailure(404);
    await settle();
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Gone.");
});

test("a failure from a type no longer shown changes nothing", async () => {
    const element = page("mesh");
    const scene = fakeScene();
    viewer.create(element, desktop).start(scene);
    element.querySelector("[data-type=splats]").click();
    window.fetch = jest.fn(() => Promise.resolve({status: 404}));
    scene.calls[0].onFailure(404);
    await settle();
    expect(element.querySelector(".explorer-status").textContent).toBe("Loading...");
});

test("the type the link asked for opens first, with its progress shown", async () => {
    const element = page("splats");
    const scene = fakeScene();
    viewer.create(element, desktop).start(scene);
    expect(scene.calls[0].type).toBe("splats");
    expect(scene.calls[0].url).toBe("/api/m/assets/splats/model.rad");
    expect(element.querySelector("[data-type=splats]").getAttribute("aria-pressed")).toBe("true");
    scene.calls[0].onProgress(0.42);
    expect(element.querySelector(".explorer-status").textContent).toBe("Loading... 42%");
    scene.calls[0].resolve();
    await settle();
    expect(element.querySelector(".explorer-status").hidden).toBe(true);
});

test("switching type loads the other one, and a late answer for the first doesn't hide the new status", async () => {
    const element = page("mesh");
    const scene = fakeScene();
    viewer.create(element, {userAgent: "Android", touch: true}).start(scene);
    expect(scene.calls[0].url).toBe("/api/m/textured_model/?platform=mobile");
    element.querySelector("[data-type=splats]").click();
    expect(scene.calls[1].type).toBe("splats");
    scene.calls[0].resolve();
    await settle();
    expect(element.querySelector(".explorer-status").hidden).toBe(false);
    expect(element.querySelector("[data-type=mesh]").getAttribute("aria-pressed")).toBe("false");
});

test("a failed view says whether the link is gone or the view failed", async () => {
    const element = page("mesh");
    const scene = fakeScene();
    window.fetch = jest.fn(() => Promise.resolve({status: 404}));
    viewer.create(element, desktop).start(scene);
    scene.calls[0].reject(new Error("404"));
    await settle();
    expect(window.fetch).toHaveBeenCalledWith("/plugins/explorer/s/TOKEN/", expect.objectContaining({method: "HEAD"}));
    expect(element.querySelector(".explorer-status").textContent).toBe("Gone.");

    window.fetch = jest.fn(() => Promise.resolve({status: 200}));
    element.querySelector("[data-type=splats]").click();
    scene.calls[1].reject(new Error("decode"));
    await settle();
    expect(element.querySelector(".explorer-status").textContent).toBe("Failed.");
});

test("without WebGL the page says so", () => {
    const element = page("mesh");
    viewer.create(element, desktop).fail();
    expect(element.querySelector(".explorer-status").textContent).toBe("No WebGL.");
});

test("a scene that never starts (its scripts didn't load) ends in the error message", () => {
    jest.useFakeTimers();
    const element = page("mesh");
    viewer.create(element, desktop);
    jest.advanceTimersByTime(30000);
    expect(element.querySelector(".explorer-status").textContent).toBe("Failed.");
});

// A link 3D page whose mesh button is as the server renders it: tiles with the GLB as fallback, or the GLB while the
// tiles are being prepared
function tiledPage({tiles, preparing}) {
    const element = page("mesh");
    const button = element.querySelector("[data-type=mesh]");
    element.setAttribute("data-preparing", "Preparing.");
    if (tiles) {
        button.setAttribute("data-url", "/api/m/tiles/0123456789abcdef/tileset.json");
        button.setAttribute("data-fallback", "/api/m/textured_model/");
    }
    if (preparing) button.setAttribute("data-preparing", "");
    return element;
}

test("built tiles open with WebODM's GLB, at the device's size, as their fallback", () => {
    const scene = fakeScene();
    viewer.create(tiledPage({tiles: true}), {userAgent: "Mozilla/5.0 (Linux; Android 14)", touch: true}).start(scene);
    expect(scene.calls[0].url).toBe("/api/m/tiles/0123456789abcdef/tileset.json");
    expect(scene.calls[0].fallback).toBe("/api/m/textured_model/?platform=mobile");
    const glb = fakeScene();
    viewer.create(page("mesh"), desktop).start(glb);
    expect(glb.calls[0].url).toBe("/api/m/textured_model/");
    expect(glb.calls[0].fallback).toBeNull();
});

test("while tiles are prepared the GLB shows, with a note that goes after a while", async () => {
    jest.useFakeTimers();
    const element = tiledPage({preparing: true});
    const scene = fakeScene();
    viewer.create(element, desktop).start(scene);
    scene.calls[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    const status = element.querySelector(".explorer-status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Preparing.");
    jest.advanceTimersByTime(8000);
    expect(status.hidden).toBe(true);
});

test("the tiles kept in memory are fewer on phones", () => {
    expect(viewer.tilesMemory("ios")).toBeLessThan(viewer.tilesMemory("mobile"));
    expect(viewer.tilesMemory("mobile")).toBeLessThan(viewer.tilesMemory(""));
    expect(viewer.create(page("mesh"), desktop).tilesMemory).toBe(viewer.tilesMemory(""));
});

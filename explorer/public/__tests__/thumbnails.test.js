const { init } = require("../explorer.js");

const API = "/api/projects/2/tasks/TASK/";
const metadata = {
    statistics: {"1": {min: -74.9, max: 128.4, percentiles: [10.5, 50.3]}}, maxzoom: 26,
    bounds: {value: [-40.00000000, 42.00000000, -39.99953634, 42.00038846]},
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ok = (body) => Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(body)});

let tileOutcome, tilesLoaded, drawn;
const RealImage = window.Image;

beforeEach(() => {
    tileOutcome = "load";
    tilesLoaded = [];
    drawn = [];
    // jsdom loads no images and has no canvas: tiles load or fail on request, and drawing is recorded
    window.Image = function () {
        const img = {};
        Object.defineProperty(img, "src", {set(url) {
            tilesLoaded.push(url);
            setTimeout(() => (tileOutcome === "load" ? img.onload() : img.onerror()), 0);
        }});
        return img;
    };
    HTMLCanvasElement.prototype.getContext = function () {
        return {drawImage: (img, x, y) => drawn.push([x, y])};
    };
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,DRAWN";
    delete window.IntersectionObserver;
});

afterEach(() => {
    window.Image = RealImage;
    delete window.fetch;
});

function card(html) {
    document.body.innerHTML = `<div class="explorer-card">${html}</div>`;
    init(document);
}

test("a thermal task's card draws its thumbnail from the Thermal layer's tiles, cut to its bounds", async () => {
    window.fetch = jest.fn(() => ok(metadata));
    card(`<div class="explorer-thumbnail explorer-no-thumbnail" data-draw="thermal" data-api="${API}"><i></i></div>`);
    for (let i = 0; i < 5; i++) await settle();
    expect(window.fetch.mock.calls[0][0]).toBe(API + "orthophoto/metadata?formula=Celsius&bands=L&color_map=magma");
    expect(tilesLoaded.length).toBeGreaterThan(0);
    expect(tilesLoaded.length).toBeLessThanOrEqual(9);
    expect(tilesLoaded[0]).toMatch(/^\/api\/projects\/2\/tasks\/TASK\/orthophoto\/tiles\/\d+\/\d+\/\d+\?formula=Celsius&bands=L&color_map=magma&rescale=10.5%2C50.3&size=256$/);
    expect(drawn).toHaveLength(tilesLoaded.length);
    // Whole pixels: a tile drawn at a fractional offset leaves a blended seam at its edge
    expect(drawn.flat().every(Number.isInteger)).toBe(true);
    const img = document.querySelector("img.explorer-thumbnail");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,DRAWN");
});

test("a tile that fails keeps the placeholder, and so does metadata that fails", async () => {
    window.fetch = jest.fn(() => ok(metadata));
    tileOutcome = "error";
    card(`<div class="explorer-thumbnail explorer-no-thumbnail" data-draw="dsm" data-api="${API}"><i></i></div>`);
    for (let i = 0; i < 5; i++) await settle();
    expect(document.querySelector(".explorer-no-thumbnail")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();

    window.fetch = jest.fn(() => Promise.resolve({ok: false, status: 404}));
    card(`<div class="explorer-thumbnail explorer-no-thumbnail" data-draw="dsm" data-api="${API}"><i></i></div>`);
    for (let i = 0; i < 5; i++) await settle();
    expect(document.querySelector(".explorer-no-thumbnail")).not.toBeNull();
});

test("a WebODM thumbnail that fails becomes the layer drawn from tiles, or the placeholder without one", async () => {
    window.fetch = jest.fn(() => ok(metadata));
    card(`<img class="explorer-thumbnail" src="/thumb" data-placeholder-icon="fa fa-cube" data-draw="dsm" data-api="${API}">`);
    document.querySelector("img").dispatchEvent(new Event("error"));
    for (let i = 0; i < 5; i++) await settle();
    expect(window.fetch.mock.calls[0][0]).toBe(API + "dsm/metadata?hillshade=6&color_map=viridis");
    expect(document.querySelector("img").getAttribute("src")).toBe("data:image/png;base64,DRAWN");

    window.fetch = jest.fn();
    card(`<img class="explorer-thumbnail" src="/thumb" data-placeholder-icon="fa fa-cube">`);
    document.querySelector("img").dispatchEvent(new Event("error"));
    await settle();
    expect(document.querySelector(".explorer-no-thumbnail .fa-cube")).not.toBeNull();
    expect(window.fetch).not.toHaveBeenCalled();
});

test("a drawing waits until its card is near the screen", async () => {
    let seen;
    window.IntersectionObserver = function (callback) {
        seen = callback;
        return {observe: jest.fn(), disconnect: jest.fn()};
    };
    window.fetch = jest.fn(() => ok(metadata));
    card(`<div class="explorer-thumbnail explorer-no-thumbnail" data-draw="dsm" data-api="${API}"><i></i></div>`);
    await settle();
    expect(window.fetch).not.toHaveBeenCalled();
    seen([{isIntersecting: true}]);
    expect(window.fetch).toHaveBeenCalledTimes(1);
});

test("the Explorer Settings page saves a change at once and undoes it when saving fails", async () => {
    document.body.innerHTML = `
        <form data-settings-api="/api/plugins/explorer/settings/" data-error="Not saved.">
            <input type="hidden" name="csrfmiddlewaretoken" value="CSRF">
            <input type="checkbox" name="basemaps_on_links" checked>
            <div class="explorer-settings-error" hidden></div>
        </form>`;
    window.fetch = jest.fn(() => ok({basemaps_on_links: false}));
    init(document);
    const form = document.querySelector("form");

    const box = form.elements.basemaps_on_links;
    box.click();
    await settle(); await settle();
    const [url, options] = window.fetch.mock.calls[0];
    expect(url).toBe("/api/plugins/explorer/settings/");
    expect(options.method).toBe("PATCH");
    expect(options.headers["X-CSRFToken"]).toBe("CSRF");
    expect(JSON.parse(options.body)).toEqual({basemaps_on_links: false});
    expect(box.checked).toBe(false);

    window.fetch = jest.fn(() => Promise.resolve({ok: false, status: 403}));
    box.click();
    await settle(); await settle(); await settle();
    expect(box.checked).toBe(false);
    expect(form.querySelector(".explorer-settings-error").hidden).toBe(false);
    expect(box.disabled).toBe(false);
});

test("the Public Address is saved when left or on Enter, shown as the server cleaned it, and put back when refused", async () => {
    document.body.innerHTML = `
        <button type="button" data-explorer-settings-toggle aria-expanded="false">Settings</button>
        <form data-settings-api="/api/plugins/explorer/settings/" data-error="Not saved." hidden>
            <input type="hidden" name="csrfmiddlewaretoken" value="CSRF">
            <input type="checkbox" name="basemaps_on_links" checked>
            <input type="url" name="public_address" value="">
            <div class="explorer-settings-error" hidden></div>
        </form>`;
    window.fetch = jest.fn(() => ok({basemaps_on_links: true, public_address: "https://maps.example.com"}));
    init(document);
    const form = document.querySelector("form");
    const address = form.elements.public_address;
    address.value = " https://Maps.Example.com/ ";
    address.dispatchEvent(new Event("change"));
    await settle(); await settle();
    expect(JSON.parse(window.fetch.mock.calls[0][1].body)).toEqual({public_address: "https://Maps.Example.com/"});
    expect(address.value).toBe("https://maps.example.com");

    // Enter submits the form: saved the same way, the page not reloaded; an unchanged value isn't sent again
    window.fetch = jest.fn(() => Promise.resolve({ok: false, status: 400}));
    const submit = new Event("submit", {cancelable: true});
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(window.fetch).not.toHaveBeenCalled();
    address.value = "maps.example.com";
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    await settle(); await settle(); await settle();
    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(address.value).toBe("https://maps.example.com");
    expect(form.querySelector(".explorer-settings-error").hidden).toBe(false);
    expect(address.disabled).toBe(false);
});

test("Links for Public Projects Only is saved by its own name, beside Basemaps on Links", async () => {
    document.body.innerHTML = `
        <form data-settings-api="/api/plugins/explorer/settings/" data-error="Not saved.">
            <input type="hidden" name="csrfmiddlewaretoken" value="CSRF">
            <input type="checkbox" name="basemaps_on_links" checked>
            <input type="checkbox" name="public_projects_only">
            <div class="explorer-settings-error" hidden></div>
        </form>`;
    window.fetch = jest.fn(() => ok({basemaps_on_links: true, public_projects_only: true}));
    init(document);
    const box = document.querySelector("[name=public_projects_only]");
    box.click();
    await settle(); await settle();
    expect(JSON.parse(window.fetch.mock.calls[0][1].body)).toEqual({public_projects_only: true});
    expect(box.checked).toBe(true);
    expect(document.querySelector("[name=basemaps_on_links]").checked).toBe(true);
});

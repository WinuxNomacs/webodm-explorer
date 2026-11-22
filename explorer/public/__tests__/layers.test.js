const Layers = require("../layers.js");
const Frame = require("../frame.js");

const API = "/api/plugins/explorer/s/TOKEN/tasks/TASK/";
const RGB_BANDS = [{description: "red"}, {description: "green"}, {description: "blue"}, {description: "alpha"}];
const STATS = {"1": {min: 10, max: 200}, "2": {min: 5, max: 210}, "3": {min: 20, max: 190}, "4": {min: 0, max: 255}};
const THERMAL_STATS = {"1": {min: -74.9, max: 128.4, percentiles: [10.5, 50.3]}};

test("a colour orthophoto stretches between its RGB bands' min and max, as WebODM's map does", () => {
    expect(Layers.rescale("orthophoto", STATS, RGB_BANDS)).toBe("5,210");
});

test("other rasters stretch over every band, and missing statistics fall back to -1,1", () => {
    expect(Layers.rescale("orthophoto", {"1": {min: 0, max: 255}, "2": {min: 0, max: 255}}, [])).toBe("0,255");
    expect(Layers.rescale("dsm", {"1": {min: 101.5, max: 140.25}}, [])).toBe("101.5,140.25");
    expect(Layers.rescale("dsm", {}, [])).toBe("-1,1");
});

test("a thermal layer stretches between its 2nd and 98th percentiles, not its outliers", () => {
    expect(Layers.range("thermal", THERMAL_STATS, [])).toEqual([10.5, 50.3]);
});

test("tile and metadata URLs point at the task's API with WebODM's parameters for each layer", () => {
    expect(Layers.metadataUrl(API, "orthophoto", false)).toBe(API + "orthophoto/metadata");
    expect(Layers.metadataUrl(API, "dsm", true)).toBe(API + "dsm/metadata?hillshade=6&color_map=viridis&crop=1");
    expect(Layers.metadataUrl(API, "thermal", false))
        .toBe(API + "orthophoto/metadata?formula=Celsius&bands=L&color_map=magma");
    expect(Layers.tileUrl(API, "orthophoto", {statistics: STATS}, RGB_BANDS, false))
        .toBe(API + "orthophoto/tiles/{z}/{x}/{y}?rescale=5%2C210&size=512");
    expect(Layers.tileUrl(API, "dtm", {}, [], true))
        .toBe(API + "dtm/tiles/{z}/{x}/{y}?hillshade=6&color_map=viridis&size=512&crop=1");
    expect(Layers.tileUrl(API, "thermal", {statistics: THERMAL_STATS}, [], false, 256))
        .toBe(API + "orthophoto/tiles/{z}/{x}/{y}?formula=Celsius&bands=L&color_map=magma&rescale=10.5%2C50.3&size=256");
});

test("a colour ramp decodes the metadata's packed RGBA colours of the layer's own colour map", () => {
    const packed = (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
    const metadata = {color_maps: [
        {key: "viridis", color_map: [packed(1, 2, 3)]},
        {key: "magma", color_map: [packed(0, 0, 4), packed(128, 37, 130), packed(252, 253, 191)]},
    ]};
    expect(Layers.colorRamp("thermal", metadata, 3)).toEqual(["rgb(0,0,4)", "rgb(128,37,130)", "rgb(252,253,191)"]);
    expect(Layers.colorRamp("orthophoto", metadata)).toBeNull();
    expect(Layers.colorRamp("dsm", {color_maps: []})).toBeNull();
});

test("legend values convert between metric and imperial units", () => {
    const [celsius, fahrenheit] = Layers.units("thermal");
    expect(Layers.format(20, celsius)).toBe("20 °C");
    expect(Layers.format(20, fahrenheit)).toBe("68 °F");
    const [metres, feet] = Layers.units("dsm");
    expect(Layers.format(212.75, metres)).toBe("213 m");
    expect(Layers.format(3.048, feet)).toBe("10 ft");
    expect(Layers.units("orthophoto")).toEqual([]);
});

test("a thumbnail covers the bounds with the fewest tiles at the deepest zoom that fits", () => {
    // A made-up area of about 38 m by 43 m, at sea
    const bounds = [-40.00000000, 42.00000000, -39.99953634, 42.00038846];
    const area = Layers.cover(bounds, 26, 512);
    expect(area.width).toBeLessThanOrEqual(512);
    expect(area.height).toBeLessThanOrEqual(512);
    expect(area.width).toBeGreaterThan(256);
    expect((area.x1 - area.x0 + 1) * (area.y1 - area.y0 + 1)).toBeLessThanOrEqual(9);
    const deeper = Layers.cover(bounds, area.z + 5, 512);
    expect(deeper.z).toBe(area.z);
    // Never deeper than the layer's own zoom levels
    expect(Layers.cover(bounds, 15, 512).z).toBe(15);
    // The bounds' corner sits inside the first tile
    const nw = Layers.toPixels(bounds[0], bounds[3], area.z);
    expect(area.left).toBeCloseTo(nw.x - area.x0 * 256);
    expect(area.left).toBeGreaterThanOrEqual(0);
    expect(area.left).toBeLessThan(256);
});

test("framing centres on most of the points and leaves stray fragments out", () => {
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < 900; i++) { xs.push((i % 30) - 15); ys.push(Math.floor(i / 30) - 15); zs.push(0); }
    // A tenth of the points in a fragment far away
    for (let i = 0; i < 100; i++) { xs.push(400 + i * 0.1); ys.push(300); zs.push(50); }
    const found = Frame.sphere(xs, ys, zs);
    expect(Math.abs(found.center[0])).toBeLessThan(2);
    expect(Math.abs(found.center[1])).toBeLessThan(2);
    expect(found.radius).toBeLessThan(30);
    expect(found.radius).toBeGreaterThan(15);
    expect(Frame.sphere([], [], [])).toBeNull();
});

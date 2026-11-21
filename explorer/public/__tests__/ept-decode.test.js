const { decode, readTransform } = require("../ept-decode.js");

// An uncompressed LAS file with the header fields decode reads; laz-perf's stand-in below "decompresses" it
function lasFile({format, length, points, scale = [0.01, 0.01, 0.01], offset = [1000, 2000, 300]}) {
    const header = 227;
    const buffer = new ArrayBuffer(header + points.length * length);
    const view = new DataView(buffer);
    [0x4C, 0x41, 0x53, 0x46].forEach((b, i) => view.setUint8(i, b)); // LASF
    view.setUint32(96, header, true);
    view.setUint8(104, format | 0x80); // the compression bit LAZ files set
    view.setUint16(105, length, true);
    view.setUint32(107, points.length, true);
    scale.forEach((s, i) => view.setFloat64(131 + 8 * i, s, true));
    offset.forEach((o, i) => view.setFloat64(155 + 8 * i, o, true));
    points.forEach((p, n) => {
        const at = header + n * length;
        view.setInt32(at, p.xyz[0], true);
        view.setInt32(at + 4, p.xyz[1], true);
        view.setInt32(at + 8, p.xyz[2], true);
        if (p.rgb) p.rgb.forEach((c, i) => view.setUint16(at + p.rgbAt + 2 * i, c, true));
    });
    return buffer;
}

// laz-perf's module as decode uses it: a heap, malloc and free, and LASZip reading the file from the heap
function fakeLazPerf({growAfter = -1, failAt = -1} = {}) {
    const module = {HEAPU8: new Uint8Array(1 << 16), next: 8, freed: [], deleted: 0};
    module._malloc = (n) => { const p = module.next; module.next += n; return p; };
    module._free = (p) => module.freed.push(p);
    module.LASZip = class {
        open(pointer) {
            const view = new DataView(module.HEAPU8.buffer);
            this.at = pointer + view.getUint32(pointer + 96, true);
            this.format = view.getUint8(pointer + 104);
            this.length = view.getUint16(pointer + 105, true);
            this.count = view.getUint32(pointer + 107, true);
            this.read = 0;
        }
        getCount() { return this.count; }
        getPointLength() { return this.length; }
        getPointFormat() { return this.format; }
        getPoint(dest) {
            if (this.read === failAt) throw new Error("corrupt");
            if (this.read === growAfter) {
                // The wasm memory grew: a new, bigger buffer with the same contents
                const grown = new Uint8Array(module.HEAPU8.length * 2);
                grown.set(module.HEAPU8);
                module.HEAPU8 = grown;
            }
            const src = this.at + this.read * this.length;
            module.HEAPU8.copyWithin(dest, src, src + this.length);
            this.read++;
        }
        delete() { module.deleted++; }
    };
    return module;
}

test("points are scaled, offset and made relative to the cloud's centre", () => {
    const file = lasFile({format: 3, length: 34, points: [{xyz: [100, 200, 50], rgbAt: 28, rgb: [10, 20, 30]}]});
    const result = decode(fakeLazPerf(), file, {origin: [1000, 2000, 300], sixteenBit: false});
    expect(result.count).toBe(1);
    expect(Array.from(result.positions)).toEqual([1, 2, 0.5]);
    expect(Array.from(result.colors)).toEqual([10, 20, 30]);
});

test("16-bit colours are found automatically and brought to 8 bits", () => {
    const file = lasFile({format: 3, length: 38, points: [
        {xyz: [0, 0, 0], rgbAt: 28, rgb: [65535, 32768, 0]}, {xyz: [1, 1, 1], rgbAt: 28, rgb: [256, 255, 0]}]});
    const result = decode(fakeLazPerf(), file, {origin: [1000, 2000, 300], sixteenBit: "auto"});
    expect(result.sixteenBit).toBe(true);
    expect(Array.from(result.colors)).toEqual([255, 128, 0, 1, 0, 0]);
});

test("8-bit colours stored in 16-bit fields are kept as they are", () => {
    const file = lasFile({format: 3, length: 38, points: [{xyz: [0, 0, 0], rgbAt: 28, rgb: [62, 200, 255]}]});
    const auto = decode(fakeLazPerf(), file, {origin: [0, 0, 0], sixteenBit: "auto"});
    expect(auto.sixteenBit).toBe(false);
    expect(Array.from(auto.colors)).toEqual([62, 200, 255]);
    // A cloud found to be 16-bit from its root node decodes every node that way
    expect(Array.from(decode(fakeLazPerf(), file, {origin: [0, 0, 0], sixteenBit: true}).colors)).toEqual([0, 0, 0]);
});

test("RGB is read where each point format keeps it", () => {
    const file = lasFile({format: 7, length: 36, points: [{xyz: [0, 0, 0], rgbAt: 30, rgb: [1, 2, 3]}]});
    expect(Array.from(decode(fakeLazPerf(), file, {origin: [0, 0, 0], sixteenBit: false}).colors)).toEqual([1, 2, 3]);
    const format2 = lasFile({format: 2, length: 26, points: [{xyz: [0, 0, 0], rgbAt: 20, rgb: [4, 5, 6]}]});
    expect(Array.from(decode(fakeLazPerf(), format2, {origin: [0, 0, 0], sixteenBit: false}).colors)).toEqual([4, 5, 6]);
});

test("points of a format without colour are grey", () => {
    const file = lasFile({format: 1, length: 28, points: [{xyz: [0, 0, 0]}, {xyz: [1, 1, 1]}]});
    const result = decode(fakeLazPerf(), file, {origin: [0, 0, 0], sixteenBit: "auto"});
    expect(Array.from(result.colors)).toEqual([200, 200, 200, 200, 200, 200]);
});

test("points keep decoding after the wasm memory grows", () => {
    const points = [0, 1, 2, 3].map((i) => ({xyz: [i * 100, 0, 0], rgbAt: 28, rgb: [i, i, i]}));
    const file = lasFile({format: 3, length: 34, points});
    const result = decode(fakeLazPerf({growAfter: 2}), file, {origin: [1000, 2000, 300], sixteenBit: false});
    expect(Array.from(result.positions).filter((_, i) => i % 3 === 0)).toEqual([0, 1, 2, 3]);
    expect(Array.from(result.colors).filter((_, i) => i % 3 === 0)).toEqual([0, 1, 2, 3]);
});

test("memory is freed and the reader deleted, also when decoding fails", () => {
    const file = lasFile({format: 3, length: 34, points: [{xyz: [0, 0, 0], rgbAt: 28, rgb: [0, 0, 0]}, {xyz: [0, 0, 0], rgbAt: 28, rgb: [0, 0, 0]}]});
    const ok = fakeLazPerf();
    decode(ok, file, {origin: [0, 0, 0], sixteenBit: false});
    expect(ok.freed).toHaveLength(2);
    expect(ok.deleted).toBe(1);
    const broken = fakeLazPerf({failAt: 1});
    expect(() => decode(broken, file, {origin: [0, 0, 0], sixteenBit: false})).toThrow("corrupt");
    expect(broken.freed).toHaveLength(2);
    expect(broken.deleted).toBe(1);
});

test("a file that isn't LAS is refused before laz-perf sees it", () => {
    const module = fakeLazPerf();
    expect(() => decode(module, new ArrayBuffer(300), {origin: [0, 0, 0], sixteenBit: false})).toThrow(/LASF/);
    expect(() => readTransform(new Uint8Array(10))).toThrow(/too short/);
    expect(module.next).toBe(8);
});

/*
 * Turns one EPT node (a LAZ file) into what three.js draws: float32 positions relative to the cloud's centre and 8-bit
 * RGB colours. Runs in the point cloud worker (ept-worker.js) with laz-perf's wasm module; Jest gives it a stand-in.
 */
(function () {
    "use strict";

    // Where RGB starts in each LAS point format that has it (LAS 1.4 specification, tables 7-17)
    var RGB_OFFSET = {2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30};
    // Points of a format without colour
    var GREY = 200;

    // The LAS header's scale and offset for X, Y and Z (public header block, bytes 131 to 178)
    function readTransform(bytes) {
        if (bytes.byteLength < 179) throw new Error("Not a LAS file: too short");
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, false) !== 0x4C415346) throw new Error("Not a LAS file: no LASF signature"); // "LASF"
        return {
            scale: [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)],
            offset: [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)]
        };
    }

    /*
     * lazPerf: laz-perf's module (createLazPerf's result). buffer: the node's LAZ file (ArrayBuffer). options.origin:
     * the cloud's centre, subtracted from every point. options.sixteenBit: true when the cloud's colours use 16 bits
     * (as LAS says they should), false for 0-255 values, "auto" to decide from this node (any value over 255).
     * Returns {count, positions, colors, sixteenBit}.
     */
    function decode(lazPerf, buffer, options) {
        var bytes = new Uint8Array(buffer);
        var transform = readTransform(bytes);
        var origin = options.origin;
        var filePointer = lazPerf._malloc(bytes.byteLength);
        var pointPointer = 0;
        var laszip = null;
        try {
            lazPerf.HEAPU8.set(bytes, filePointer);
            laszip = new lazPerf.LASZip();
            laszip.open(filePointer, bytes.byteLength);
            var count = laszip.getCount();
            var length = laszip.getPointLength();
            var format = laszip.getPointFormat() & 0x3F;
            var rgb = RGB_OFFSET[format];
            if (rgb !== undefined && length < rgb + 6) rgb = undefined;
            pointPointer = lazPerf._malloc(length);
            var positions = new Float32Array(count * 3);
            var raw = new Uint16Array(rgb === undefined ? 0 : count * 3);
            var maxColor = 0;
            var heap = null, view = null;
            var sx = transform.scale[0], sy = transform.scale[1], sz = transform.scale[2];
            var ox = transform.offset[0] - origin[0], oy = transform.offset[1] - origin[1], oz = transform.offset[2] - origin[2];
            for (var i = 0; i < count; i++) {
                laszip.getPoint(pointPointer);
                // The wasm memory can grow, which replaces its buffer
                if (heap !== lazPerf.HEAPU8.buffer) {
                    heap = lazPerf.HEAPU8.buffer;
                    view = new DataView(heap, pointPointer, length);
                }
                positions[i * 3] = view.getInt32(0, true) * sx + ox;
                positions[i * 3 + 1] = view.getInt32(4, true) * sy + oy;
                positions[i * 3 + 2] = view.getInt32(8, true) * sz + oz;
                if (rgb !== undefined) {
                    for (var c = 0; c < 3; c++) {
                        var value = view.getUint16(rgb + 2 * c, true);
                        raw[i * 3 + c] = value;
                        if (value > maxColor) maxColor = value;
                    }
                }
            }
            var sixteenBit = options.sixteenBit === "auto" ? maxColor > 255 : options.sixteenBit === true;
            var colors = new Uint8Array(count * 3);
            if (rgb === undefined) {
                for (var g = 0; g < colors.length; g++) colors[g] = GREY;
            } else {
                for (var j = 0; j < colors.length; j++) colors[j] = sixteenBit ? raw[j] >> 8 : Math.min(raw[j], 255);
            }
            return {count: count, positions: positions, colors: colors, sixteenBit: sixteenBit};
        } finally {
            if (laszip) laszip.delete();
            if (pointPointer) lazPerf._free(pointPointer);
            lazPerf._free(filePointer);
        }
    }

    var api = {decode: decode, readTransform: readTransform, RGB_OFFSET: RGB_OFFSET};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        self.ExplorerEptDecode = api;
    }
})();

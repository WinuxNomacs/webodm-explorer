/*
 * Where the 3D page's camera looks first: at most of the model, not at every point of it. Photogrammetry leaves stray
 * fragments and long splats far out, which a box around every point, or one trimmed per axis, still frames (the house
 * of HomerunObliqueRGB sat low and small, 2026-11-21). The centre is the median point, the radius the distance within
 * which SHARE of the points lie. No three.js here: viewer/scene.js gives it sampled positions.
 */
(function () {
    "use strict";
    var SHARE = 0.9;

    function median(values) {
        var sorted = Float64Array.from(values).sort();
        return sorted[Math.floor((sorted.length - 1) / 2)];
    }

    // The sampled points' centre and radius as {center: [x, y, z], radius}; null without points
    function sphere(xs, ys, zs, share) {
        if (!xs.length) return null;
        var center = [median(xs), median(ys), median(zs)];
        var distances = new Float64Array(xs.length);
        for (var i = 0; i < xs.length; i++) {
            var dx = xs[i] - center[0], dy = ys[i] - center[1], dz = zs[i] - center[2];
            distances[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        distances.sort();
        var at = Math.min(distances.length - 1, Math.round((share || SHARE) * (distances.length - 1)));
        return {center: center, radius: distances[at]};
    }

    var Frame = {sphere: sphere, SHARE: SHARE};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = Frame;
    } else {
        window.ExplorerFrame = Frame;
    }
})();

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

    // The model's bottom, for the Grid's floor: the lowest sampled point within BOTTOM_REACH times the frame's radius of
    // its centre (measured across, not up), so stray fragments off to the side don't pull it down, while the model's
    // own low edges (a mesh's skirt, with few points) stay above it; null without points
    var BOTTOM_REACH = 1.5;
    function bottom(xs, ys, zs, found) {
        found = found || sphere(xs, ys, zs);
        if (!found) return null;
        var reach = BOTTOM_REACH * found.radius, lowest = Infinity;
        for (var i = 0; i < zs.length; i++) {
            var dx = xs[i] - found.center[0], dy = ys[i] - found.center[1];
            if (zs[i] < lowest && dx * dx + dy * dy <= reach * reach) lowest = zs[i];
        }
        return lowest === Infinity ? found.center[2] : lowest;
    }

    var Frame = {sphere: sphere, bottom: bottom, SHARE: SHARE};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = Frame;
    } else {
        window.ExplorerFrame = Frame;
    }
})();

/*
 * An EPT point cloud's octree (https://entwine.io/en/latest/entwine-point-tile.html) and the choice of which of its
 * nodes to show: the nodes biggest on screen first, within a point budget, as Potree does on WebODM's own 3D page.
 * No three.js here: viewer/ept.js gives it the camera and draws what it picks.
 */
(function () {
    "use strict";

    // Coordinates are kept relative to the cloud's centre, so float32 positions keep millimetres far from the origin
    function parseEpt(json) {
        if (!json || typeof json !== "object") throw new Error("ept.json is not an object");
        if (json.dataType !== "laszip") throw new Error("Unsupported EPT dataType: " + json.dataType);
        if (json.hierarchyType !== undefined && json.hierarchyType !== "json") {
            throw new Error("Unsupported EPT hierarchyType: " + json.hierarchyType);
        }
        var bounds = json.bounds;
        if (!isBox(bounds) || !(json.span > 0)) throw new Error("ept.json has no valid bounds or span");
        var conforming = isBox(json.boundsConforming) ? json.boundsConforming : bounds;
        var origin = [(conforming[0] + conforming[3]) / 2, (conforming[1] + conforming[4]) / 2,
            (conforming[2] + conforming[5]) / 2];
        return {
            bounds: relative(bounds, origin),
            conforming: relative(conforming, origin),
            origin: origin,
            span: json.span,
            points: json.points || 0
        };
    }

    function isBox(b) {
        if (!b || b.length !== 6) return false;
        for (var i = 0; i < 6; i++) if (typeof b[i] !== "number" || !isFinite(b[i])) return false;
        return b[3] >= b[0] && b[4] >= b[1] && b[5] >= b[2];
    }

    function relative(b, origin) {
        return [b[0] - origin[0], b[1] - origin[1], b[2] - origin[2], b[3] - origin[0], b[4] - origin[1], b[5] - origin[2]];
    }

    // The cube of node D-X-Y-Z: the root's bounds halved D times
    function keyBounds(root, d, x, y, z) {
        var n = Math.pow(2, d);
        var sx = (root[3] - root[0]) / n, sy = (root[4] - root[1]) / n, sz = (root[5] - root[2]) / n;
        return [root[0] + x * sx, root[1] + y * sy, root[2] + z * sz,
            root[0] + (x + 1) * sx, root[1] + (y + 1) * sy, root[2] + (z + 1) * sz];
    }

    // The distance between a node's points: the root's width over its span, halved at each depth
    function spacing(info, depth) {
        return (info.bounds[3] - info.bounds[0]) / info.span / Math.pow(2, depth);
    }

    function createTree(info) {
        var root = makeNode(info, 0, 0, 0, 0, null);
        root.pendingHierarchy = true;
        return {info: info, root: root, nodes: {"0-0-0-0": root}};
    }

    function makeNode(info, d, x, y, z, parent) {
        var b = keyBounds(info.bounds, d, x, y, z);
        var dx = b[3] - b[0], dy = b[4] - b[1], dz = b[5] - b[2];
        return {
            key: d + "-" + x + "-" + y + "-" + z,
            depth: d,
            bounds: b,
            center: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2],
            radius: Math.sqrt(dx * dx + dy * dy + dz * dz) / 2,
            count: null,
            parent: parent,
            children: [],
            // Its count and children are in ept-hierarchy/<key>.json, not loaded yet
            pendingHierarchy: false
        };
    }

    function parseKey(key) {
        var parts = typeof key === "string" ? key.split("-") : [];
        if (parts.length !== 4) return null;
        var numbers = [];
        for (var i = 0; i < 4; i++) {
            if (!/^[0-9]+$/.test(parts[i])) return null;
            numbers.push(parseInt(parts[i], 10));
        }
        return numbers;
    }

    // Adds a hierarchy file's entries ({key: point count}, -1 for a node whose subtree has its own file). Entries whose
    // parent is unknown or whose value isn't a count are ignored; returns how many nodes were added or updated.
    function addHierarchy(tree, json) {
        var entries = [];
        for (var key in json) {
            if (!Object.prototype.hasOwnProperty.call(json, key)) continue;
            var k = parseKey(key);
            var value = json[key];
            if (k && typeof value === "number" && (value > 0 || value === -1)) entries.push({k: k, key: key, value: value});
        }
        // Parents before children
        entries.sort(function (a, b) { return a.k[0] - b.k[0]; });
        var changed = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i], d = e.k[0], x = e.k[1], y = e.k[2], z = e.k[3];
            var node = tree.nodes[e.key];
            if (!node) {
                var parent = d > 0 ? tree.nodes[(d - 1) + "-" + (x >> 1) + "-" + (y >> 1) + "-" + (z >> 1)] : null;
                if (!parent) continue;
                node = makeNode(tree.info, d, x, y, z, parent);
                parent.children.push(node);
                tree.nodes[e.key] = node;
            }
            if (e.value === -1) {
                if (node.count === null) node.pendingHierarchy = true;
            } else {
                node.count = e.value;
                node.pendingHierarchy = false;
            }
            changed++;
        }
        return changed;
    }

    // A max-heap on weight
    function Heap() { this.items = []; }
    Heap.prototype.push = function (item) {
        var a = this.items, i = a.length;
        a.push(item);
        while (i > 0) {
            var p = (i - 1) >> 1;
            if (a[p].weight >= a[i].weight) break;
            var t = a[p]; a[p] = a[i]; a[i] = t; i = p;
        }
    };
    Heap.prototype.pop = function () {
        var a = this.items, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            var i = 0;
            for (;;) {
                var l = 2 * i + 1, r = l + 1, m = i;
                if (l < a.length && a[l].weight > a[m].weight) m = l;
                if (r < a.length && a[r].weight > a[m].weight) m = r;
                if (m === i) break;
                var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
            }
        }
        return top;
    };

    /*
     * The nodes to show, most important first, as Potree picks them: from the root, the node biggest on screen next,
     * while the point budget lasts. Children are considered only below nodes already loaded, so a view fills in level
     * by level. view: {position: [x, y, z] (relative), fov (degrees), height (pixels), budget, minPixels,
     * visible(node), loaded(node)}. Returns {nodes, hierarchy}: hierarchy lists nodes whose subtree file is needed.
     */
    function select(tree, view) {
        var heap = new Heap();
        var nodes = [], hierarchy = [];
        var points = 0;
        var projection = view.height / 2 / Math.tan(view.fov * Math.PI / 360);
        heap.push({node: tree.root, weight: Infinity});
        while (heap.items.length) {
            var node = heap.pop().node;
            if (node.pendingHierarchy) {
                hierarchy.push(node);
                continue;
            }
            if (node.count === null || !view.visible(node)) continue;
            if (points + node.count > view.budget && nodes.length) break;
            points += node.count;
            nodes.push(node);
            if (!view.loaded(node)) continue;
            for (var i = 0; i < node.children.length; i++) {
                var child = node.children[i];
                var dx = view.position[0] - child.center[0], dy = view.position[1] - child.center[1],
                    dz = view.position[2] - child.center[2];
                var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (distance <= child.radius) {
                    heap.push({node: child, weight: Infinity});
                    continue;
                }
                var pixels = child.radius * projection / distance;
                if (pixels >= view.minPixels) heap.push({node: child, weight: pixels});
            }
        }
        return {nodes: nodes, hierarchy: hierarchy, points: points};
    }

    // For each shown node, the depth of the deepest shown node in its subtree (itself included), keyed by node key:
    // where finer nodes show, a node's points are drawn at their spacing, so coarse points don't blot them out.
    function deepestShown(nodes) {
        var deepest = {};
        for (var i = 0; i < nodes.length; i++) {
            for (var n = nodes[i]; n; n = n.parent) {
                // Every ancestor of a node already this deep has been raised at least as far
                if (deepest[n.key] !== undefined && deepest[n.key] >= nodes[i].depth) break;
                deepest[n.key] = nodes[i].depth;
            }
        }
        return deepest;
    }

    // Where a ray (origin, unit direction) enters a node's box grown by `margin`: 0 from inside, null if it misses
    function rayEntry(bounds, margin, origin, dir) {
        var near = 0, far = Infinity;
        for (var a = 0; a < 3; a++) {
            var lo = bounds[a] - margin, hi = bounds[a + 3] + margin;
            if (Math.abs(dir[a]) < 1e-12) {
                if (origin[a] < lo || origin[a] > hi) return null;
                continue;
            }
            var t1 = (lo - origin[a]) / dir[a], t2 = (hi - origin[a]) / dir[a];
            if (t1 > t2) { var swap = t1; t1 = t2; t2 = swap; }
            near = Math.max(near, t1);
            far = Math.min(far, t2);
            if (near > far) return null;
        }
        return near;
    }

    /*
     * The point nearest the camera within `threshold` of a ray, at the cloud's full detail (the Measure tool,
     * public/viewer/ept.js): EPT nodes add points to their parents', so every node the ray passes near is searched, at
     * every depth, front to back; a node is skipped once a point nearer than where the ray enters it is found, so only
     * the nodes around the first surface are fetched. origin and dir (unit) are in the nodes' coordinates.
     * positionsOf(node) -> Promise of a flat [x, y, z, ...] array (or null), loadHierarchy(node) -> Promise for a node
     * whose subtree file isn't read yet. At most maxNodes nodes. Resolves with [x, y, z] or null; rejects as they do,
     * when a subtree is still unread after loadHierarchy, or when the node limit is reached with nearer nodes left.
     */
    function pickNearest(tree, origin, dir, threshold, positionsOf, loadHierarchy, maxNodes) {
        var queue = [], best = null, bestT = Infinity, visited = 0, limit = threshold * threshold;
        function enqueue(node) {
            var t = rayEntry(node.bounds, threshold, origin, dir);
            if (t !== null && t < bestT) queue.push({node: node, t: t});
        }
        function search(positions) {
            for (var i = 0; positions && i < positions.length; i += 3) {
                var x = positions[i] - origin[0], y = positions[i + 1] - origin[1], z = positions[i + 2] - origin[2];
                var along = x * dir[0] + y * dir[1] + z * dir[2];
                if (along <= 0 || along >= bestT) continue;
                if (x * x + y * y + z * z - along * along < limit) {
                    bestT = along;
                    best = [positions[i], positions[i + 1], positions[i + 2]];
                }
            }
        }
        function next() {
            queue.sort(function (a, b) { return a.t - b.t; });
            var item = queue.shift();
            if (!item || item.t >= bestT) return Promise.resolve(best);
            // Nodes nearer than the point found are left: what was found may not be the nearest
            if (visited >= maxNodes) return Promise.reject(new Error("EPT: the pick reached its node limit (" + maxNodes + ")"));
            visited++;
            var node = item.node;
            var ready = node.pendingHierarchy ? loadHierarchy(node) : Promise.resolve();
            return ready.then(function () {
                // Searching on without its subtree could give a coarser or farther point
                if (node.pendingHierarchy) throw new Error("EPT: the subtree of " + node.key + " could not be read");
                return node.count > 0 ? positionsOf(node) : null;
            }).then(function (positions) {
                search(positions);
                for (var i = 0; i < node.children.length; i++) enqueue(node.children[i]);
                return next();
            });
        }
        enqueue(tree.root);
        return next();
    }

    var api = {
        parseEpt: parseEpt, keyBounds: keyBounds, spacing: spacing, createTree: createTree, addHierarchy: addHierarchy,
        select: select, deepestShown: deepestShown, parseKey: parseKey, rayEntry: rayEntry, pickNearest: pickNearest
    };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        window.ExplorerEptTree = api;
    }
})();

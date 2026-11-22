/*
 * Streams an EPT point cloud into the 3D scene: reads ept.json and the hierarchy, asks ept-tree.js which nodes to
 * show for the camera, fetches them through the link's asset view, decodes them in workers (ept-worker.js with
 * laz-perf) and draws each as THREE.Points. Nodes that leave the view are freed once the cache is full.
 *
 * Failures: ept.json, the root's hierarchy, the root node or every worker failing rejects open(); a node or a subtree
 * file that fails is retried once after RETRY_DELAY_MS, then skipped, and onFailure(status) is called (the page then
 * checks whether the link was revoked); a worker that errs or takes over DECODE_TIMEOUT_MS is replaced.
 */
import * as THREE from "three";

const Tree = window.ExplorerEptTree;

// As Potree on WebODM's own 3D page (minimumNodePixelSize)
const MIN_NODE_PIXELS = 150;
const MAX_FETCHES = 4;
export const FETCH_TIMEOUT_MS = 60000;
const DECODE_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 1000;
// Loaded points kept beyond the budget, so turning back doesn't fetch again
const CACHE_FACTOR = 1.5;
// Point size in node spacings, and its limits in CSS pixels
const POINT_SIZE = 1.4;
const MIN_POINT_PIXELS = 1.5;
const MAX_POINT_PIXELS = 40;

export class HttpError extends Error {
    constructor(status) {
        super("HTTP " + status);
        this.status = status;
    }
}

async function fetchWithTimeout(url, as) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new HttpError(response.status);
        return as === "json" ? await response.json() : await response.arrayBuffer();
    } finally {
        clearTimeout(timer);
    }
}

export async function withRetry(load) {
    try {
        return await load();
    } catch (e) {
        if (e instanceof HttpError && e.status === 404) throw e; // a revoked link: retrying won't help
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return load();
    }
}

// Decodes in up to `size` workers; a worker that fails is replaced, and the pool fails once none can start
class WorkerPool {
    constructor(scripts, size) {
        this.scripts = scripts;
        this.size = size;
        this.idle = [];
        this.queue = [];
        this.live = 0;
        this.nextId = 1;
        this.disposed = false;
        this.broken = null;
    }

    async start() {
        const starts = [];
        for (let i = 0; i < this.size; i++) starts.push(this.spawn());
        const results = await Promise.allSettled(starts);
        if (!results.some((r) => r.status === "fulfilled")) {
            throw results[0].reason;
        }
    }

    spawn() {
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker(this.scripts.worker);
            } catch (e) {
                reject(e);
                return;
            }
            const fail = (message) => {
                worker.terminate();
                reject(new Error("Point cloud worker: " + message));
            };
            worker.onerror = (e) => { e.preventDefault(); fail(e.message || "error"); };
            worker.onmessage = (event) => {
                if (event.data.type === "ready") {
                    worker.onmessage = null;
                    worker.onerror = null;
                    this.live++;
                    this.release(worker);
                    resolve();
                } else if (event.data.type === "init-error") {
                    fail(event.data.message);
                }
            };
            worker.postMessage({ type: "init", lazPerf: this.scripts.lazPerf, wasm: this.scripts.wasm,
                decode: this.scripts.decode });
        });
    }

    decode(buffer, origin, sixteenBit) {
        if (this.broken) return Promise.reject(this.broken);
        return new Promise((resolve, reject) => {
            this.queue.push({ buffer, origin, sixteenBit, resolve, reject });
            this.pump();
        });
    }

    pump() {
        while (this.idle.length && this.queue.length && !this.disposed) {
            this.run(this.idle.pop(), this.queue.shift());
        }
    }

    release(worker) {
        if (this.disposed) {
            worker.terminate();
            return;
        }
        this.idle.push(worker);
        this.pump();
    }

    run(worker, job) {
        const id = this.nextId++;
        const done = (ok, value) => {
            clearTimeout(timer);
            worker.onmessage = null;
            worker.onerror = null;
            (ok ? job.resolve : job.reject)(value);
        };
        const lost = (reason) => {
            done(false, new Error("Point cloud worker: " + reason));
            worker.terminate();
            this.live--;
            this.replace();
        };
        const timer = setTimeout(() => lost("timed out"), DECODE_TIMEOUT_MS);
        worker.onerror = (e) => { e.preventDefault(); lost(e.message || "error"); };
        worker.onmessage = (event) => {
            const m = event.data;
            if (m.id !== id) return;
            if (m.type === "decoded") done(true, m);
            else done(false, new Error("Point cloud decode: " + m.message));
            this.release(worker);
        };
        worker.postMessage({ type: "decode", id, buffer: job.buffer, origin: job.origin, sixteenBit: job.sixteenBit },
            [job.buffer]);
    }

    replace() {
        if (this.disposed) return;
        this.spawn().catch((e) => {
            if (this.live > 0) return;
            this.broken = e;
            for (const job of this.queue.splice(0)) job.reject(e);
        });
    }

    dispose() {
        this.disposed = true;
        for (const worker of this.idle.splice(0)) worker.terminate();
    }
}

// Elevation is coloured between the root node's 2nd and 98th percentile heights, as WebODM's map stretches a DSM
const ELEVATION_PERCENTILES = [0.02, 0.98];

// Colour by Elevation: z (relative to the cloud's centre) between zMin and zMax on the ramp's stops (layers.js)
const vertexShader = `
    uniform float size;
    uniform float projection;
    uniform float minPixels;
    uniform float maxPixels;
    uniform float sizeScale;
    uniform float colorMode;
    uniform float zMin;
    uniform float zMax;
    uniform vec3 ramp[${(window.ExplorerLayers ? window.ExplorerLayers.VIRIDIS.length : 9)}];
    varying vec3 vColor;
    void main() {
        if (colorMode > 0.5) {
            float t = clamp((position.z - zMin) / max(zMax - zMin, 0.001), 0.0, 1.0) * float(ramp.length() - 1);
            int i = int(min(floor(t), float(ramp.length() - 2)));
            vColor = mix(ramp[i], ramp[i + 1], t - float(i));
        } else {
            vColor = color;
        }
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * sizeScale * projection / -mvPosition.z, minPixels * sizeScale, maxPixels);
        gl_Position = projectionMatrix * mvPosition;
    }`;

function rampUniform() {
    const stops = window.ExplorerLayers ? window.ExplorerLayers.VIRIDIS : [[0, 0, 0], [255, 255, 255]];
    return stops.map((c) => new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255));
}

// The heights at the given fractions of the sorted z values (every third value is a z)
export function zPercentiles(positions, fractions) {
    const zs = new Float32Array(positions.length / 3);
    for (let i = 0; i < zs.length; i++) zs[i] = positions[i * 3 + 2];
    zs.sort();
    return fractions.map((f) => zs.length ? zs[Math.min(zs.length - 1, Math.floor(f * zs.length))] : 0);
}

const fragmentShader = `
    varying vec3 vColor;
    void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        if (dot(c, c) > 1.0) discard;
        gl_FragColor = vec4(vColor, 1.0);
    }`;

export class EptCloud {
    // base: the entwine_pointcloud/ URL, ending in a slash. options: {scripts, budget, onFailure}
    constructor(base, options) {
        this.base = base;
        this.budget = options.budget;
        this.onFailure = options.onFailure || (() => {});
        const workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
        this.pool = new WorkerPool(options.scripts, workers);
        this.group = new THREE.Group();
        this.loaded = new Map(); // key -> {points, count, used}
        this.loading = new Set();
        this.failed = new Set();
        this.hierarchyLoading = new Set();
        this.fetches = 0;
        this.dirty = true;
        this.lastCamera = new THREE.Matrix4();
        this.frustum = new THREE.Frustum();
        this.box = new THREE.Box3();
        this.disposed = false;
        this.frameCount = 0;
        this.shown = { nodes: 0, points: 0 };
        // Shared by every node's material: a change of size or colour applies at once, with no node rebuilt
        this.style = { sizeScale: { value: 1 }, colorMode: { value: 0 }, zMin: { value: 0 }, zMax: { value: 1 },
            ramp: { value: rampUniform() } };
        this.zRange = [0, 1];
    }

    // style: {size (a scale, 1 the default), colour ("rgb" or "elevation")}
    setStyle(style) {
        if (style.size) this.style.sizeScale.value = style.size;
        if (style.colour) this.style.colorMode.value = style.colour === "elevation" ? 1 : 0;
    }

    // The elevation range coloured, in the cloud's own units and coordinates (absolute heights)
    elevationRange() {
        const z = this.info ? this.info.origin[2] : 0;
        return [this.zRange[0] + z, this.zRange[1] + z];
    }

    // Reads the cloud and its root node; resolves with the root's points, for framing
    async open() {
        const json = await withRetry(() => fetchWithTimeout(this.base + "ept.json", "json"));
        this.info = Tree.parseEpt(json);
        this.tree = Tree.createTree(this.info);
        const [hierarchy] = await Promise.all([
            withRetry(() => fetchWithTimeout(this.base + "ept-hierarchy/0-0-0-0.json", "json")),
            this.pool.start(),
        ]);
        Tree.addHierarchy(this.tree, hierarchy);
        if (this.tree.root.count === null) throw new Error("The EPT hierarchy has no root node");
        const buffer = await withRetry(() => fetchWithTimeout(this.base + "ept-data/0-0-0-0.laz"));
        const decoded = await this.pool.decode(buffer, this.info.origin, "auto");
        this.sixteenBit = decoded.sixteenBit;
        this.zRange = zPercentiles(decoded.positions, ELEVATION_PERCENTILES);
        this.style.zMin.value = this.zRange[0];
        this.style.zMax.value = this.zRange[1];
        this.add(this.tree.root, decoded);
        return decoded.positions;
    }

    add(node, decoded) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(decoded.colors, 3, true));
        const material = new THREE.ShaderMaterial({
            uniforms: { size: { value: Tree.spacing(this.info, node.depth) * POINT_SIZE }, projection: { value: 1 },
                minPixels: { value: MIN_POINT_PIXELS }, maxPixels: { value: MAX_POINT_PIXELS }, ...this.style },
            vertexShader, fragmentShader, vertexColors: true,
        });
        const points = new THREE.Points(geometry, material);
        // ept-tree.js culls by node; three's own culling would compute every node's bounding sphere
        points.frustumCulled = false;
        points.visible = false;
        this.group.add(points);
        this.loaded.set(node.key, { points, count: decoded.count, used: this.frameCount });
        this.dirty = true;
    }

    remove(key) {
        const entry = this.loaded.get(key);
        if (!entry) return;
        this.group.remove(entry.points);
        entry.points.geometry.dispose();
        entry.points.material.dispose();
        this.loaded.delete(key);
    }

    // Called every frame while the cloud shows; does nothing until the camera moves or a node arrives
    update(camera, renderer) {
        if (this.disposed || !this.tree) return;
        this.frameCount++;
        camera.updateMatrixWorld();
        const moved = !this.lastCamera.equals(camera.matrixWorld);
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!moved && !this.dirty && size.y === this.lastHeight) return;
        this.lastCamera.copy(camera.matrixWorld);
        this.lastHeight = size.y;
        this.dirty = false;

        // The nodes' bounds are in the cloud's own coordinates: the group is moved (never turned) to line up with the
        // other views (scene.js), so the camera is taken into the group's coordinates
        this.group.updateMatrixWorld();
        this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,
            camera.matrixWorldInverse).multiply(this.group.matrixWorld));
        const ratio = renderer.getPixelRatio();
        const selection = Tree.select(this.tree, {
            position: camera.position.clone().sub(this.group.position).toArray(), fov: camera.fov, height: size.y / ratio,
            budget: this.budget, minPixels: MIN_NODE_PIXELS,
            visible: (node) => {
                const b = node.bounds;
                this.box.min.set(b[0], b[1], b[2]);
                this.box.max.set(b[3], b[4], b[5]);
                return this.frustum.intersectsBox(this.box);
            },
            loaded: (node) => this.loaded.has(node.key),
        });

        const shown = selection.nodes.filter((node) => this.loaded.has(node.key));
        const deepest = Tree.deepestShown(shown);
        const projection = size.y / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const showing = new Set();
        let points = 0;
        for (const node of shown) {
            const entry = this.loaded.get(node.key);
            const uniforms = entry.points.material.uniforms;
            uniforms.size.value = Tree.spacing(this.info, deepest[node.key]) * POINT_SIZE;
            uniforms.projection.value = projection;
            uniforms.minPixels.value = MIN_POINT_PIXELS * ratio;
            uniforms.maxPixels.value = MAX_POINT_PIXELS * ratio;
            entry.points.visible = true;
            entry.used = this.frameCount;
            showing.add(node.key);
            points += entry.count;
        }
        for (const [key, entry] of this.loaded) if (!showing.has(key)) entry.points.visible = false;
        this.shown = { nodes: shown.length, points };

        for (const node of selection.hierarchy) this.loadHierarchy(node);
        for (const node of selection.nodes) {
            if (this.fetches >= MAX_FETCHES) break;
            if (!this.loaded.has(node.key) && !this.loading.has(node.key) && !this.failed.has(node.key)) this.loadNode(node);
        }
        this.evict(showing);
    }

    // Frees the least recently shown nodes beyond the cache size
    evict(showing) {
        let total = 0;
        for (const entry of this.loaded.values()) total += entry.count;
        if (total <= this.budget * CACHE_FACTOR) return;
        const candidates = [...this.loaded.entries()].filter(([key]) => !showing.has(key) && key !== "0-0-0-0")
            .sort((a, b) => a[1].used - b[1].used);
        for (const [key, entry] of candidates) {
            if (total <= this.budget * CACHE_FACTOR) break;
            total -= entry.count;
            this.remove(key);
        }
    }

    failure(key, error) {
        this.failed.add(key);
        console.warn("Explorer: point cloud node " + key + " skipped", error);
        this.onFailure(error instanceof HttpError ? error.status : null);
    }

    async loadNode(node) {
        this.loading.add(node.key);
        this.fetches++;
        try {
            let buffer;
            try {
                buffer = await withRetry(() => fetchWithTimeout(this.base + "ept-data/" + node.key + ".laz"));
            } finally {
                // Decoding doesn't hold a fetch slot
                this.fetches--;
            }
            const decoded = await this.pool.decode(buffer, this.info.origin, this.sixteenBit);
            if (!this.disposed) this.add(node, decoded);
        } catch (e) {
            if (!this.disposed) this.failure(node.key, e);
        } finally {
            this.loading.delete(node.key);
            this.dirty = true;
        }
    }

    async loadHierarchy(node) {
        if (this.hierarchyLoading.has(node.key) || this.failed.has(node.key)) return;
        this.hierarchyLoading.add(node.key);
        try {
            const json = await withRetry(() => fetchWithTimeout(this.base + "ept-hierarchy/" + node.key + ".json", "json"));
            if (!this.disposed) Tree.addHierarchy(this.tree, json);
        } catch (e) {
            if (!this.disposed) this.failure(node.key, e);
        } finally {
            this.hierarchyLoading.delete(node.key);
            this.dirty = true;
        }
    }

    dispose() {
        this.disposed = true;
        this.pool.dispose();
        for (const key of [...this.loaded.keys()]) this.remove(key);
    }
}

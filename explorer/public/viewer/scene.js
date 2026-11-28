/*
 * The 3D scene of a link's 3D page: three.js with orbit controls, the EPT point cloud streamed by ept.js, the textured
 * model as 3D Tiles streamed by 3DTilesRendererJS once Explorer has built them (tiles_build.py) or else WebODM's Draco
 * GLB, and its Gaussian splats with Spark (paged, as WebODM's own 3D page loads them). One type shows at a time,
 * framed to fit, over the background chosen (backdrop.js). viewer-ui.js owns the page around it.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { TilesRenderer } from "3d-tiles-renderer/three";
import { GLTFExtensionsPlugin, TilesFadePlugin } from "3d-tiles-renderer/three/plugins";
import { createBackdrop } from "./backdrop.js";
import { EptCloud, FETCH_TIMEOUT_MS, HttpError, withRetry } from "./ept.js";
import { startMeasure } from "./measure3d.js";

// A paged splat file's bounds fill in as its first pages arrive
const BOUNDS_WAIT_MS = 10000;
// Framing samples at most this many points
const FRAME_SAMPLES = 50000;
// The mesh tiles' first view: its root tile (1-2 MB) should arrive well before this
const TILES_TIMEOUT_MS = 60000;
// Screen-space error in pixels before a tile is refined (3DTilesRendererJS's default)
const TILES_ERROR_TARGET = 16;
// Focus: the camera turns to a double-clicked point over this long; a point cloud's point counts within this many
// pixels of the click; two taps this close in time and space are a double-tap
const FOCUS_MS = 350;
// Failed mesh tiles: tried again after this, doubling to the most, this many times
const TILES_RETRY_MS = 5000;
const TILES_RETRY_MAX_MS = 60000;
const TILES_RETRIES = 6;
const PICK_PIXELS = 6;
// Measuring picks at full detail (the user, 2026-11-27): the cloud's nodes within FINE_PIXELS of the ray first, then
// PICK_PIXELS; the mesh's finest tiles along the ray, waited for at most FINEST_TIMEOUT_MS
const FINE_PIXELS = 2;
const FINEST_TIMEOUT_MS = 30000;
const FINEST_SETTLE_FRAMES = 3;
const FINEST_MEMORY = 128 * 1024 * 1024;
// The full-detail picks' textures: none (a pick needs the geometry only, and transcoding a tile's textures took most of
// its time, 100 to 400 ms a tile on a model with large ones, 2026-11-27). GLTFLoader hands KTX2 images to parse().
const NO_TEXTURES = { isKTX2Loader: true, parse: (buffer, onLoad) => onLoad(new THREE.Texture()), dispose() {} };
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PIXELS = 24;

// A cube around where most of the sampled points are (frame.js), its diagonal the frame's diameter; null without
// points. frame() fits a box's diagonal, so the camera fits that sphere.
export function robustBox(xs, ys, zs) {
    return cubeAround(window.ExplorerFrame.sphere(xs, ys, zs));
}

function cubeAround(found) {
    if (!found) return null;
    const center = new THREE.Vector3(...found.center);
    const half = Math.max(found.radius, 0.01) / Math.sqrt(3);
    return new THREE.Box3(center.clone().subScalar(half), center.clone().addScalar(half));
}

// A view's frame from sampled points (world coordinates): {box: robustBox's cube, floor: the points' bottom (frame.js),
// where the Grid goes}, or null without points. The cube's own bottom is far below a wide, flat model.
function frameOf(xs, ys, zs) {
    const found = window.ExplorerFrame.sphere(xs, ys, zs);
    return found ? { box: cubeAround(found), floor: window.ExplorerFrame.bottom(xs, ys, zs, found) } : null;
}

// parent (optional): a matrix applied after the object's own, for a tile not yet in its turned group
function meshFrame(object, parent) {
    const xs = [], ys = [], zs = [];
    const point = new THREE.Vector3();
    object.updateMatrixWorld(true);
    let total = 0;
    object.traverse((child) => { if (child.isMesh) total += child.geometry.attributes.position.count; });
    const step = Math.max(1, Math.floor(total / FRAME_SAMPLES));
    object.traverse((child) => {
        if (!child.isMesh) return;
        const positions = child.geometry.attributes.position;
        for (let i = 0; i < positions.count; i += step) {
            point.fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld);
            if (parent) point.applyMatrix4(parent);
            xs.push(point.x); ys.push(point.y); zs.push(point.z);
        }
    });
    return frameOf(xs, ys, zs) || { box: new THREE.Box3().setFromObject(object), floor: null };
}

// One pass over the loaded splats, sampled evenly: Spark decodes every splat it visits, and can't skip any
function splatFrame(mesh, count) {
    const xs = [], ys = [], zs = [];
    const point = new THREE.Vector3();
    const step = Math.max(1, Math.ceil(count / FRAME_SAMPLES));
    mesh.updateMatrixWorld(true);
    try {
        mesh.forEachSplat((index, center) => {
            if (index % step) return;
            point.copy(center).applyMatrix4(mesh.matrixWorld);
            xs.push(point.x); ys.push(point.y); zs.push(point.z);
        });
    } catch (e) {
        console.warn("Explorer: framing the splats by their bounds", e);
    }
    return frameOf(xs, ys, zs) || { box: mesh.getBoundingBox(true).applyMatrix4(mesh.matrixWorld), floor: null };
}

function cloudFrame(positions) {
    const xs = [], ys = [], zs = [];
    const count = positions.length / 3;
    const step = Math.max(1, Math.floor(count / FRAME_SAMPLES));
    for (let i = 0; i < count; i += step) {
        xs.push(positions[i * 3]); ys.push(positions[i * 3 + 1]); zs.push(positions[i * 3 + 2]);
    }
    return frameOf(xs, ys, zs) || { box: new THREE.Box3(), floor: null };
}

// Tile requests as point cloud nodes: a deadline, one retry (not on 404), and the renderer's own abort signal; a tile
// the renderer cancelled is not tried again, so it frees its download slot at once
function tilesFetch(url, options) {
    const signal = options && options.signal;
    return withRetry(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
        if (signal) {
            if (signal.aborted) abort();
            signal.addEventListener("abort", abort, { once: true });
        }
        try {
            const response = await fetch(url, { ...options, credentials: "same-origin", signal: controller.signal });
            if (!response.ok) throw new HttpError(response.status);
            return response;
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", abort);
        }
    }, signal);
}

// options: {draco (the decoder's folder), basis (the KTX2 transcoder's folder), cloud: {scripts, budget} for ept.js,
// tiles: {memory (bytes of tiles kept)}, small: a phone}
function createScene(container, options) {
    // Throws where WebGL 2 is unavailable (three.js needs it)
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio());
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
    // WebODM's outputs are Z-up: its 3D page adds them to Potree's Z-up scene unrotated
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new SparkRenderer({ renderer }));
    const backdrop = createBackdrop(scene, renderer, camera, { small: options.small });

    const dracoLoader = new DRACOLoader().setDecoderPath(options.draco);
    const gltfLoader = new GLTFLoader().setDRACOLoader(dracoLoader);
    let ktx2Loader = null; // made for the first tiles: it starts transcoder workers
    const views = {}; // type -> Promise of {object, box}
    let current = null;
    let cloud = null; // the EptCloud once open
    let tiles = null; // the TilesRenderer once its first tile shows
    let tilesUrl = null;
    // Views still opening, by type: in the scene while they load, shown only while their type is the one chosen
    const opening = new Map();

    function resize() {
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;
        // Browser zoom, or the window moved to another screen, changes the pixel ratio
        if (renderer.getPixelRatio() !== pixelRatio()) renderer.setPixelRatio(pixelRatio());
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        // The tiles refine for the canvas's size: after Fullscreen, a turned phone or a resized window too
        if (tiles) tiles.setResolutionFromRenderer(camera, renderer);
    }
    new ResizeObserver(resize).observe(container);
    resize();

    // Whether the visitor has moved the camera since it was last framed: a late, better frame then doesn't jump
    let moved = false;
    // Whether a view has been shown (and the camera placed), and whether the view opening keeps that camera
    let placed = false;
    let keeping = false;
    let shownBox = null;
    // WebODM's offset for the task (the mesh's and the splats' origin in the model's coordinates), or null
    const offset = options.offset ? new THREE.Vector3(...options.offset) : null;
    controls.addEventListener("start", () => { moved = true; });

    // The model's radius, for the camera's clipping planes and how far out it can zoom
    let modelRadius = 1;
    let focus = null; // {from, to, start}: a double-click's turn to a point
    function frame(box, floor) {
        if (!box || box.isEmpty()) return;
        moved = false;
        focus = null; // a double-click's turn still running would pull the target back
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
        modelRadius = radius;
        // Fit the narrower of the two angles: on a phone held upright, the horizontal one
        const vertical = THREE.MathUtils.degToRad(camera.fov);
        const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
        const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
        // From the south-east and above, as an oblique aerial view
        const direction = new THREE.Vector3(0.6, -0.6, 0.55).normalize();
        camera.position.copy(center).addScaledVector(direction, distance);
        controls.maxDistance = distance * 20;
        controls.target.copy(center);
        controls.update();
        clip();
        backdrop.fit(box, floor);
    }

    // The clipping planes follow the camera's distance: the model never vanishes zoomed out, nor clips zoomed in
    let clipDistance = 0;
    function clip() {
        const distance = Math.max(camera.position.distanceTo(controls.target), 0.01);
        if (Math.abs(distance - clipDistance) < distance * 0.01) return;
        clipDistance = distance;
        camera.near = Math.max(distance / 500, 0.01);
        camera.far = distance + modelRadius * 10;
        camera.updateProjectionMatrix();
    }

    // A switch to another view of the same model: the camera stays, the grid goes under the new view, and a late,
    // better frame doesn't move it
    function keep(box, floor) {
        if (!box || box.isEmpty()) return;
        moved = true;
        modelRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, modelRadius);
        clipDistance = 0;
        backdrop.fit(box, floor);
    }

    // Reset View: the shown view framed again
    function reset() {
        const view = current && views[current];
        if (view) view.then((v) => frame(v.box, v.floor), () => {});
    }

    // The point of the shown model under a screen position (client pixels), or null: three's raycast on the mesh, its
    // tiles or the splats; on the point cloud, the nearest shown point within PICK_PIXELS of the ray
    const raycaster = new THREE.Raycaster();
    async function pick(clientX, clientY) {
        const view = current && views[current] ? await views[current].catch(() => null) : null;
        if (!view) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        if (current === "cloud" && cloud) {
            // ept.js's own search: only the nodes the ray crosses, with no object made per point
            const distance = camera.position.distanceTo(controls.target);
            const perPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / rect.height;
            return cloud.pick(raycaster.ray, perPixel * PICK_PIXELS);
        }
        const hits = raycaster.intersectObjects([view.object], true).filter((hit) => hit.point && isFinite(hit.point.x));
        if (!hits.length) return null;
        hits.sort((a, b) => a.distance - b.distance);
        return hits[0].point;
    }

    // The Measure tool's drawing (measure3d.js): over the model wherever the camera is, never picked
    const overlay = new THREE.Group();
    overlay.renderOrder = 998;
    scene.add(overlay);

    // The point under a screen position at the data's full detail, whatever the view shows (for measuring): on the
    // point cloud every node the ray passes through, to the deepest (EPT nodes add points to their parents'); on the
    // mesh tiles the finest tiles along the ray (finestTiles); WebODM's GLB is its full detail already. onLoading()
    // when data has to come first.
    async function pickFinest(clientX, clientY, onLoading) {
        const view = current && views[current] ? await views[current].catch(() => null) : null;
        if (!view) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
        const caster = new THREE.Raycaster();
        caster.setFromCamera(ndc, camera);
        const ray = caster.ray.clone();
        if (current === "cloud" && cloud) {
            const distance = camera.position.distanceTo(controls.target);
            const perPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / rect.height;
            return (await cloud.pickFinest(ray, perPixel * FINE_PIXELS, onLoading))
                || cloud.pickFinest(ray, perPixel * PICK_PIXELS, onLoading);
        }
        if (current === "splats") {
            // Splats are measured on the point cloud (the user, 2026-11-27): Spark's own hit test catches large faint
            // splats metres off the surface, so the point is the cloud's nearest real one along the click
            if (!views.cloud && options.cloudUrl && onLoading) onLoading();
            const measured = await measureCloud();
            if (!measured) return null;
            const distance = camera.position.distanceTo(controls.target);
            const perPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / rect.height;
            return (await measured.pickFinest(ray, perPixel * FINE_PIXELS, onLoading))
                || measured.pickFinest(ray, perPixel * PICK_PIXELS, onLoading);
        }
        if (current === "mesh" && tiles && tilesUrl) return finestTiles(ray, onLoading);
        return pick(clientX, clientY);
    }

    // The point cloud for measuring on the splats, opened hidden (its hierarchy and root only: it streams nodes only
    // while its own view shows) as the cloud view, which then reuses it; null without one. A node failing later goes to
    // the cloud view's handler once it has shown.
    let cloudFailure = () => {};
    function measureCloud() {
        if (!options.cloudUrl) return Promise.resolve(null);
        if (!views.cloud) {
            const opened = loadCloud(options.cloudUrl, () => {}, (status) => cloudFailure(status));
            views.cloud = opened;
            opened.catch(() => { if (views.cloud === opened) delete views.cloud; });
        }
        return views.cloud.then(() => cloud);
    }

    // A second TilesRenderer, never drawn, whose camera looks down the ray through a fraction of a degree with an error
    // target that only the finest tiles meet: it loads just the finest tiles along the ray, through the renderer's own
    // loading (and the browser's cache: tiles are immutable), and the ray is cast on them. Kept between picks.
    let finest = null;
    let finestQueue = Promise.resolve();
    function finestTiles(ray, onLoading) {
        const run = finestQueue.then(() => castFinest(ray, onLoading));
        finestQueue = run.catch(() => null);
        return run;
    }
    async function castFinest(ray, onLoading) {
        if (!finest || finest.url !== tilesUrl) {
            if (finest) finest.renderer.dispose();
            const r = new TilesRenderer(tilesUrl);
            r.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader, ktxLoader: NO_TEXTURES, meshoptDecoder: MeshoptDecoder,
                autoDispose: false }));
            r.registerPlugin({ name: "EXPLORER_FETCH", fetchData: tilesFetch });
            r.errorTarget = 0.01;
            // Only the finest tiles in its view: not their coarser ancestors, nor the siblings a drawn view loads to
            // swap a parent for its children at once (75 to 150 tiles a pick otherwise, seconds on a heavy model)
            r.loadSiblings = false;
            r.loadAncestors = false;
            // 3DTilesRendererJS 0.5.4 gives all its renderers one shared cache and shared queues by default: this one gets
            // its own (their classes aren't exported: the shared ones'), or the view's tiles fill the cache and every
            // finest tile is refused, and the view's loading keeps its tiles waiting to be parsed (a close view picked
            // nothing, 2026-11-27); the cache's limits would be the view's too
            const cache = new r.lruCache.constructor();
            cache.unloadPriorityCallback = r.lruCache.unloadPriorityCallback;
            cache.maxBytesSize = FINEST_MEMORY;
            cache.minBytesSize = FINEST_MEMORY / 4;
            r.lruCache = cache;
            const own = (shared, settings) => Object.assign(new shared.constructor(), settings, { priorityCallback: shared.priorityCallback });
            r.downloadQueue = own(r.downloadQueue, { maxJobsPerOrigin: r.downloadQueue.maxJobsPerOrigin });
            r.parseQueue = own(r.parseQueue, { maxJobs: r.parseQueue.maxJobs });
            r.processNodeQueue = own(r.processNodeQueue, { maxJobs: r.processNodeQueue.maxJobs });
            r.group.rotation.x = -Math.PI / 2; // as the shown tiles (loadTiles)
            const holder = new THREE.Scene();
            holder.add(r.group);
            const eye = new THREE.PerspectiveCamera(0.1, 1, 0.01, 1e7);
            r.setCamera(eye);
            r.setResolution(eye, 64, 64);
            finest = { url: tilesUrl, renderer: r, holder, eye };
        }
        const { renderer: r, holder, eye } = finest;
        // Tiles that failed for an earlier pick are tried again; any that fails now fails the pick, so a coarser tile
        // left in its place never gives a value
        r.resetFailedTiles();
        const failedBefore = r.stats.failed;
        eye.position.copy(ray.origin);
        eye.lookAt(ray.origin.clone().add(ray.direction));
        eye.updateMatrixWorld();
        holder.updateMatrixWorld(true);
        const started = performance.now();
        let settled = 0, told = false;
        while (settled < FINEST_SETTLE_FRAMES) {
            r.update();
            const s = r.stats;
            // Tiles refused while the cache is full wait for older ones to be unloaded
            const busy = s.downloading + s.parsing + (s.queued || 0) + s.refused > 0 || !r.root;
            if (busy && !told && onLoading) { told = true; onLoading(); }
            settled = busy ? 0 : settled + 1;
            if (performance.now() - started > FINEST_TIMEOUT_MS) {
                throw new Error(s.refused ? "too many of the finest tiles along the ray" : "the finest tiles took too long");
            }
            await new Promise((resolve) => setTimeout(resolve, 16));
        }
        if (r.stats.failed > failedBefore) throw new Error("some of the finest tiles could not load");
        holder.updateMatrixWorld(true);
        const caster = new THREE.Raycaster(ray.origin, ray.direction);
        const hits = caster.intersectObject(r.group, true).filter((hit) => hit.point && isFinite(hit.point.x));
        if (!hits.length) return null;
        hits.sort((a, b) => a.distance - b.distance);
        return hits[0].point;
    }

    // Source Frames' spot (frames.js): a ring of one size on screen, drawn over the model wherever the camera is;
    // colours are CSS colours (the theme's). null removes it.
    let marker = null;
    function setMarker(point, colours) {
        if (marker) {
            scene.remove(marker);
            marker.material.map.dispose();
            marker.material.dispose();
            marker = null;
        }
        if (!point) return;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.beginPath();
        ctx.arc(32, 32, 22, 0, 2 * Math.PI);
        ctx.lineWidth = 11;
        ctx.strokeStyle = colours.outline;
        ctx.stroke();
        ctx.lineWidth = 6;
        ctx.strokeStyle = colours.spot;
        ctx.stroke();
        const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false,
            depthWrite: false, sizeAttenuation: false, transparent: true });
        marker = new THREE.Sprite(material);
        marker.position.copy(point);
        marker.scale.set(0.06, 0.06, 1);
        marker.renderOrder = 999;
        marker.raycast = () => {};
        scene.add(marker);
    }

    // Double-click (double-tap): the camera turns to orbit the point under it, where there is one (declared with the
    // camera's state above, as framing cancels it)
    async function focusAt(clientX, clientY) {
        const point = await pick(clientX, clientY);
        if (!point) return;
        moved = true;
        focus = { from: controls.target.clone(), to: point.clone(), start: performance.now() };
    }
    renderer.domElement.addEventListener("dblclick", (event) => focusAt(event.clientX, event.clientY));
    let lastTap = null;
    let touchDown = null; // where and when the finger came down: a tap is short and still, a drag's end isn't one
    renderer.domElement.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "touch") touchDown = { time: performance.now(), x: event.clientX, y: event.clientY };
    });
    renderer.domElement.addEventListener("pointerup", (event) => {
        if (event.pointerType !== "touch") return;
        const now = performance.now();
        const tap = touchDown && now - touchDown.time < DOUBLE_TAP_MS &&
            Math.hypot(event.clientX - touchDown.x, event.clientY - touchDown.y) < DOUBLE_TAP_PIXELS / 2;
        touchDown = null;
        if (!tap) {
            lastTap = null;
            return;
        }
        if (lastTap && now - lastTap.time < DOUBLE_TAP_MS &&
            Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_PIXELS) {
            lastTap = null;
            focusAt(event.clientX, event.clientY);
        } else {
            lastTap = { time: now, x: event.clientX, y: event.clientY };
        }
    });

    function progress(onProgress) {
        return (event) => onProgress(event && event.lengthComputable ? event.loaded / event.total : null);
    }

    async function loadGlb(url, onProgress) {
        const gltf = await gltfLoader.loadAsync(url, progress(onProgress));
        scene.add(gltf.scene);
        return { object: gltf.scene, ...meshFrame(gltf.scene) };
    }

    // The mesh tiles, open once the root tile shows; rejects if the tileset or the root can't load
    function loadTiles(url, onFailure) {
        tilesUrl = url;
        if (!ktx2Loader) {
            ktx2Loader = new KTX2Loader().setTranscoderPath(options.basis).detectSupport(renderer);
            // Geometry decoding off the main thread, so tiles arriving don't stall a frame
            MeshoptDecoder.useWorkers(2);
        }
        const opened = new TilesRenderer(url);
        // autoDispose off: disposing a renderer would otherwise dispose the page's shared Draco and KTX2 loaders
        opened.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader, ktxLoader: ktx2Loader, meshoptDecoder: MeshoptDecoder,
            autoDispose: false }));
        opened.registerPlugin(new TilesFadePlugin());
        opened.registerPlugin({ name: "EXPLORER_FETCH", fetchData: tilesFetch });
        opened.errorTarget = TILES_ERROR_TARGET;
        opened.lruCache.maxBytesSize = options.tiles.memory;
        opened.lruCache.minBytesSize = options.tiles.memory * 0.75;
        opened.setCamera(camera);
        opened.setResolutionFromRenderer(camera, renderer);
        // Obj2Tiles 1.10.3 --local keeps the OBJ's Z-up coordinates in its glTF tiles, and writes bounding volumes that
        // match them once turned as glTF's Y-up is: the renderer turns both, so turning the group back puts the model
        // Z-up as WebODM's GLB, with tiles and their bounds still agreeing (checked on the user's meshes, 2026-11-21)
        opened.group.rotation.x = -Math.PI / 2;
        return new Promise((resolve, reject) => {
            let shown = false, failed = false;
            // Counted while the page is visible only: a hidden tab draws no frames, and the tiles load from frames
            let timer = null;
            const arm = () => {
                clearTimeout(timer);
                timer = document.hidden ? null : setTimeout(() => fail(new Error("the mesh tiles took too long")), TILES_TIMEOUT_MS);
            };
            const settled = () => {
                clearTimeout(timer);
                document.removeEventListener("visibilitychange", arm);
            };
            document.addEventListener("visibilitychange", arm);
            arm();
            function fail(error) {
                failed = true;
                settled();
                opening.delete("mesh");
                if (tiles === opened) tiles = null;
                opened.dispose();
                scene.remove(opened.group);
                reject(error);
            }
            const view = { object: opened.group, box: null, floor: null };
            let framedOnRoot = false;
            // Frame on the tileset's bounds first: tiles outside the camera's view are never loaded, the root included
            opened.addEventListener("load-root-tileset", () => {
                if (failed) return; // after the fallback: the model shown instead keeps the camera
                const box = new THREE.Box3();
                opened.group.updateMatrixWorld(true);
                if (opened.getBoundingBox(box) && !framedOnRoot) {
                    view.box = box.applyMatrix4(opened.group.matrixWorld);
                    // Not while another view is shown: the visitor switched away while the tiles opened
                    if (!keeping && current === "mesh") frame(view.box);
                }
            });
            // The view opens with its first tile, framed on the bounds; the root tile, which a smaller child tile can
            // beat to it, then frames it on its points as the GLB is (stray fragments left out), unless the visitor
            // has moved the camera by then
            opened.addEventListener("load-model", (event) => {
                if (failed) return;
                opened.group.updateMatrixWorld(true);
                if (!framedOnRoot && event.tile === opened.root) {
                    framedOnRoot = true;
                    // The tile may not be in the (turned) group yet: its points then need the group's turn added
                    let attached = false;
                    for (let node = event.scene.parent; node; node = node.parent) attached = attached || node === opened.group;
                    Object.assign(view, meshFrame(event.scene, attached ? null : opened.group.matrixWorld));
                    if (shown && current === "mesh") {
                        if (moved) keep(view.box, view.floor);
                        else frame(view.box, view.floor);
                    }
                }
                if (shown) return;
                shown = true;
                settled();
                opening.delete("mesh");
                tiles = opened;
                if (!view.box) view.box = new THREE.Box3().setFromObject(opened.group);
                resolve(view);
            });
            // A tile that fails once the view is open (a phone's connection dropping) is tried again after a pause that
            // grows, as the point cloud's nodes are
            let retries = 0, retry = null;
            opened.addEventListener("load-error", (event) => {
                const status = event.error instanceof HttpError ? event.error.status : null;
                if (!shown) return fail(event.error || new Error("the mesh tiles failed"));
                onFailure(status);
                if (retry || retries >= TILES_RETRIES || status === 404) return;
                retry = setTimeout(() => {
                    retry = null;
                    retries += 1;
                    if (tiles === opened) opened.resetFailedTiles();
                }, Math.min(TILES_RETRY_MS * 2 ** retries, TILES_RETRY_MAX_MS));
            });
            opened.group.visible = current === "mesh";
            opening.set("mesh", opened.group);
            scene.add(opened.group);
            // Loading starts with the render loop's first update, and goes on while another view is chosen
            tiles = opened;
        });
    }

    // The tiles when built (fallback: WebODM's GLB, used if they can't load), else the GLB
    async function loadMesh(url, onProgress, onFailure, fallback) {
        if (!fallback) return loadGlb(url, onProgress);
        try {
            onProgress(null);
            return await loadTiles(url, onFailure);
        } catch (e) {
            console.warn("Explorer: the mesh tiles could not load; showing the model instead", e);
            tiles = null;
            return loadGlb(fallback, onProgress);
        }
    }

    async function loadSplats(url, onProgress) {
        // Spark's paged mode reports no file it can't read (it logs it and carries on with nothing): the file's head is
        // asked for first, so a revoked link or a missing file fails here and says so
        const head = await fetch(url, { method: "HEAD", credentials: "same-origin" });
        if (!head.ok) throw new HttpError(head.status);
        let splats = null;
        // Kept among the views opening until its first pages come, so another view chosen meanwhile hides it
        const done = () => { if (opening.get("splats") === splats) opening.delete("splats"); };
        const mesh = await new Promise((resolve, reject) => {
            splats = new SplatMesh({ url, paged: true, onProgress: progress(onProgress), onLoad: () => resolve(splats) });
            splats.initialized.catch(reject);
            splats.visible = current === "splats";
            opening.set("splats", splats);
            scene.add(splats);
        }).catch((e) => {
            // A failed load leaves nothing behind (opening Gaussian Splats again starts afresh)
            done();
            if (splats) {
                scene.remove(splats);
                splats.dispose();
            }
            throw e;
        });
        // Waits for the first pages by the splat count, which is cheap to read (bounds decode every splat each time)
        const count = () => {
            const n = mesh.splats && mesh.splats.numSplats;
            if (Number.isFinite(n)) return n;
            return mesh.getBoundingBox().isEmpty() ? 0 : FRAME_SAMPLES;
        };
        const view = { object: mesh, box: new THREE.Box3(), floor: null };
        const until = performance.now() + BOUNDS_WAIT_MS;
        while (!count() && performance.now() < until) await new Promise((r) => setTimeout(r, 200));
        done();
        if (count()) return Object.assign(view, splatFrame(mesh, count()));
        // Pages still to come (a slow connection, or a hidden tab, where Spark doesn't page): the view opens now and is
        // framed when they come, unless the visitor has placed the camera by then; given up once the splats are gone
        (async () => {
            while (!count() && mesh.parent) await new Promise((r) => setTimeout(r, 500));
            if (!mesh.parent) return;
            Object.assign(view, splatFrame(mesh, count()));
            if (current !== "splats") return;
            if (placed && (keeping || moved)) keep(view.box, view.floor);
            else frame(view.box, view.floor);
            placed = true;
            shownBox = view.box;
        })();
        return view;
    }

    async function loadCloud(url, onProgress, onFailure) {
        onProgress(null);
        const opened = new EptCloud(url, { ...options.cloud, onFailure });
        let positions;
        try {
            positions = await opened.open();
        } catch (e) {
            opened.dispose();
            throw e;
        }
        cloud = opened;
        opened.setStyle(cloudStyle);
        // Hidden when opened for measuring on the splats (measureCloud)
        opened.group.visible = current === "cloud";
        // The cloud is drawn relative to its centre; WebODM's offset puts it where the mesh and the splats are
        const { box, floor } = cloudFrame(positions);
        if (offset) {
            opened.group.position.set(...opened.info.origin).sub(offset);
            box.translate(opened.group.position);
        }
        scene.add(opened.group);
        return { object: opened.group, box, floor: floor === null ? null : floor + opened.group.position.z };
    }

    const loaders = { cloud: loadCloud, mesh: loadMesh, splats: loadSplats };

    // onFailure(status): a point cloud node or a tile failed after the view opened (status: the HTTP status, or null).
    // fallback: for the mesh tiles, WebODM's GLB, shown if they can't load.
    async function show(type, url, onProgress, onFailure, fallback) {
        current = type;
        // With WebODM's offset known, the views line up, so a switch keeps the camera where the visitor left it
        keeping = Boolean((offset || restoring) && placed);
        restoring = false;
        for (const [other, object] of opening) object.visible = other === type;
        for (const [other, view] of Object.entries(views)) {
            if (other !== type) view.then((v) => { v.object.visible = current === other; }, () => {});
        }
        if (type === "cloud" && onFailure) cloudFailure = onFailure;
        if (!views[type]) {
            const opened = loaders[type](url, onProgress, type === "cloud" ? (status) => cloudFailure(status) : onFailure || (() => {}), fallback);
            views[type] = opened;
            // Only this load's entry: a load started again meanwhile (after a lost context) keeps its own
            opened.catch(() => { if (views[type] === opened) delete views[type]; });
        }
        let view;
        try {
            view = await views[type];
        } catch (e) {
            if (current !== type) return; // the visitor has moved on: not this view's failure to show
            throw e;
        }
        view.object.visible = current === type;
        if (current !== type) return;
        if (keeping) keep(view.box, view.floor);
        else frame(view.box, view.floor);
        // A view with no bounds (splats whose pages never came) leaves the camera unplaced, for the next view to frame
        if (view.box && !view.box.isEmpty()) {
            placed = true;
            shownBox = view.box;
        }
    }

    renderer.setAnimationLoop(() => {
        if (focus) {
            const t = Math.min(1, (performance.now() - focus.start) / FOCUS_MS);
            controls.target.lerpVectors(focus.from, focus.to, 1 - Math.pow(1 - t, 3));
            if (t >= 1) focus = null;
        }
        controls.update();
        clip();
        if (cloud && current === "cloud") cloud.update(camera, renderer);
        if (tiles && (current === "mesh" || opening.has("mesh"))) {
            camera.updateMatrixWorld();
            tiles.update();
        }
        backdrop.update();
        renderer.render(scene, camera);
    });

    // For live checks: what the point cloud and the mesh tiles show
    function stats() {
        if (current === "mesh" && tiles) {
            const s = tiles.stats;
            return { tiles: true, visible: tiles.visibleTiles.size, loaded: s.loaded, downloading: s.downloading,
                parsing: s.parsing, failed: s.failed, bytes: tiles.lruCache.cachedBytes,
                camera: camera.position.toArray().map(Math.round), target: controls.target.toArray().map(Math.round) };
        }
        return cloud ? { ...cloud.shown, loaded: cloud.loaded.size, failed: cloud.failed.size } : null;
    }

    // For live checks: the camera, what it orbits, and the centre of the shown view's frame, to 1 cm
    function place() {
        const round = (vector) => vector.toArray().map((v) => Math.round(v * 100) / 100);
        return { camera: round(camera.position), target: round(controls.target),
            frame: shownBox ? round(shownBox.getCenter(new THREE.Vector3())) : null };
    }

    // The point cloud's Point Size and Colour (EptCloud.setStyle), kept for a cloud still opening
    let cloudStyle = {};
    function setCloudStyle(style) {
        cloudStyle = { ...cloudStyle, ...style };
        if (cloud) cloud.setStyle(cloudStyle);
    }
    function cloudRange() {
        return cloud ? cloud.elevationRange() : null;
    }

    // A lost WebGL context (a phone short of graphics memory): three stops drawing; lost() lets the page say so, and
    // restored() follows if the browser gives the context back, for the page to show its view again. The backgrounds
    // drawn into textures are drawn again; Spark doesn't rebuild its splats' textures, so the splats open again (their
    // file from the browser's cache)
    let restoring = false; // the view shown again after a lost context: the same view, so the camera stays
    function watchContext(lost, restored) {
        renderer.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault(); // asks the browser to restore it
            lost();
        });
        renderer.domElement.addEventListener("webglcontextrestored", () => {
            backdrop.restore();
            restoring = true;
            const splats = views.splats;
            if (splats) {
                delete views.splats;
                splats.then((view) => { scene.remove(view.object); view.object.dispose(); }, () => {});
            }
            restored();
        });
    }

    return { show, resize, stats, place, reset, setCloudStyle, cloudRange, pick, pickFinest, setMarker, watchContext,
        // Measuring: whether the shown view can be measured (splats through the point cloud), and getting it ready
        measurable: () => current !== "splats" || Boolean(options.cloudUrl),
        prepareMeasure: () => { if (current === "splats") measureCloud().catch(() => {}); },
        setBackground: backdrop.set, offset: offset ? offset.clone() : null, overlay,
        shown: () => current, size: () => [renderer.domElement.clientWidth, renderer.domElement.clientHeight] };
}

// "x y" (the page's data-offset) as [x, y, 0], or null
export function offsetOf(text) {
    const parts = (text || "").trim().split(/\s+/).map(Number);
    return parts.length === 2 && parts.every(Number.isFinite) ? [parts[0], parts[1], 0] : null;
}

const page = document.querySelector("[data-explorer-viewer]");
if (page && window.ExplorerViewer) {
    let scene = null;
    try {
        scene = createScene(page.querySelector(".explorer-scene"), {
            draco: page.getAttribute("data-draco"),
            basis: page.getAttribute("data-basis"),
            tiles: { memory: window.ExplorerViewer.tilesMemory },
            small: window.ExplorerViewer.small,
            offset: offsetOf(page.getAttribute("data-offset")),
            // The point cloud, which also measures the splats
            cloudUrl: (page.querySelector("[data-type=cloud]") || { getAttribute: () => null }).getAttribute("data-url"),
            cloud: {
                budget: window.ExplorerViewer.pointBudget,
                scripts: {
                    worker: page.getAttribute("data-ept-worker"),
                    decode: new URL(page.getAttribute("data-ept-decode"), window.location.href).href,
                    lazPerf: new URL(page.getAttribute("data-lazperf"), window.location.href).href,
                    wasm: new URL(page.getAttribute("data-lazperf-wasm"), window.location.href).href,
                },
            },
        });
    } catch (e) {
        console.error(e);
        window.ExplorerViewer.fail();
    }
    if (scene) {
        window.ExplorerViewer.start(scene);
        startMeasure(page, scene);
    }
}

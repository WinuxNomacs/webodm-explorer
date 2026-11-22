/*
 * The 3D scene of a link's 3D page: three.js with orbit controls, the EPT point cloud streamed by ept.js, the textured
 * model as 3D Tiles streamed by 3DTilesRendererJS once Explorer has built them (tiles_build.py) or else WebODM's Draco
 * GLB, and its Gaussian splats with Spark (paged, as WebODM's own 3D page loads them). One type shows at a time,
 * framed to fit. viewer-ui.js owns the page around it.
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
import { EptCloud, FETCH_TIMEOUT_MS, HttpError, withRetry } from "./ept.js";

// A paged splat file's bounds fill in as its first pages arrive
const BOUNDS_WAIT_MS = 10000;
// Framing samples at most this many points
const FRAME_SAMPLES = 50000;
// The mesh tiles' first view: its root tile (1-2 MB) should arrive well before this
const TILES_TIMEOUT_MS = 60000;
// Screen-space error in pixels before a tile is refined (3DTilesRendererJS's default)
const TILES_ERROR_TARGET = 16;

// A cube around where most of the sampled points are (frame.js), its diagonal the frame's diameter; null without
// points. frame() fits a box's diagonal, so the camera fits that sphere.
export function robustBox(xs, ys, zs) {
    const found = window.ExplorerFrame.sphere(xs, ys, zs);
    if (!found) return null;
    const center = new THREE.Vector3(...found.center);
    const half = Math.max(found.radius, 0.01) / Math.sqrt(3);
    return new THREE.Box3(center.clone().subScalar(half), center.clone().addScalar(half));
}

function meshFrameBox(object) {
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
            xs.push(point.x); ys.push(point.y); zs.push(point.z);
        }
    });
    return robustBox(xs, ys, zs) || new THREE.Box3().setFromObject(object);
}

function splatFrameBox(mesh) {
    const xs = [], ys = [], zs = [];
    try {
        mesh.forEachSplat((index, center) => {
            if (xs.length < FRAME_SAMPLES) { xs.push(center.x); ys.push(center.y); zs.push(center.z); }
        });
    } catch (e) {
        console.warn("Explorer: framing the splats by their bounds", e);
    }
    const box = robustBox(xs, ys, zs) || mesh.getBoundingBox(true);
    return box.applyMatrix4(mesh.matrixWorld);
}

function cloudFrameBox(positions) {
    const xs = [], ys = [], zs = [];
    const count = positions.length / 3;
    const step = Math.max(1, Math.floor(count / FRAME_SAMPLES));
    for (let i = 0; i < count; i += step) {
        xs.push(positions[i * 3]); ys.push(positions[i * 3 + 1]); zs.push(positions[i * 3 + 2]);
    }
    return robustBox(xs, ys, zs);
}

// Tile requests as point cloud nodes: a deadline, one retry (not on 404), and the renderer's own abort signal
function tilesFetch(url, options) {
    return withRetry(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
        if (options && options.signal) {
            if (options.signal.aborted) abort();
            options.signal.addEventListener("abort", abort, { once: true });
        }
        try {
            const response = await fetch(url, { ...options, credentials: "same-origin", signal: controller.signal });
            if (!response.ok) throw new HttpError(response.status);
            return response;
        } finally {
            clearTimeout(timer);
        }
    });
}

// options: {draco (the decoder's folder), basis (the KTX2 transcoder's folder), cloud: {scripts, budget} for ept.js,
// tiles: {memory (bytes of tiles kept)}}
function createScene(container, options) {
    // Throws where WebGL 2 is unavailable (three.js needs it)
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
    // WebODM's outputs are Z-up: its 3D page adds them to Potree's Z-up scene unrotated
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new SparkRenderer({ renderer }));

    const dracoLoader = new DRACOLoader().setDecoderPath(options.draco);
    const gltfLoader = new GLTFLoader().setDRACOLoader(dracoLoader);
    let ktx2Loader = null; // made for the first tiles: it starts transcoder workers
    const views = {}; // type -> Promise of {object, box}
    let current = null;
    let cloud = null; // the EptCloud once open
    let tiles = null; // the TilesRenderer once its first tile shows

    function resize() {
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);
    resize();

    // Whether the visitor has moved the camera since it was last framed: a late, better frame then doesn't jump
    let moved = false;
    controls.addEventListener("start", () => { moved = true; });

    function frame(box) {
        if (!box || box.isEmpty()) return;
        moved = false;
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
        // Fit the narrower of the two angles: on a phone held upright, the horizontal one
        const vertical = THREE.MathUtils.degToRad(camera.fov);
        const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
        const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
        // From the south-east and above, as an oblique aerial view
        const direction = new THREE.Vector3(0.6, -0.6, 0.55).normalize();
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.near = Math.max(distance / 1000, 0.01);
        camera.far = distance * 20;
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();
    }

    function progress(onProgress) {
        return (event) => onProgress(event && event.lengthComputable ? event.loaded / event.total : null);
    }

    async function loadGlb(url, onProgress) {
        const gltf = await gltfLoader.loadAsync(url, progress(onProgress));
        scene.add(gltf.scene);
        return { object: gltf.scene, box: meshFrameBox(gltf.scene) };
    }

    // The mesh tiles, open once the root tile shows; rejects if the tileset or the root can't load
    function loadTiles(url, onFailure) {
        if (!ktx2Loader) {
            ktx2Loader = new KTX2Loader().setTranscoderPath(options.basis).detectSupport(renderer);
            // Geometry decoding off the main thread, so tiles arriving don't stall a frame
            MeshoptDecoder.useWorkers(2);
        }
        const opened = new TilesRenderer(url);
        opened.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader, ktxLoader: ktx2Loader, meshoptDecoder: MeshoptDecoder }));
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
            let shown = false;
            const timer = setTimeout(() => fail(new Error("the mesh tiles took too long")), TILES_TIMEOUT_MS);
            function fail(error) {
                clearTimeout(timer);
                opened.dispose();
                scene.remove(opened.group);
                reject(error);
            }
            const view = { object: opened.group, box: null };
            let framedOnRoot = false;
            // Frame on the tileset's bounds first: tiles outside the camera's view are never loaded, the root included
            opened.addEventListener("load-root-tileset", () => {
                const box = new THREE.Box3();
                opened.group.updateMatrixWorld(true);
                if (opened.getBoundingBox(box) && !framedOnRoot) {
                    view.box = box.applyMatrix4(opened.group.matrixWorld);
                    frame(view.box);
                }
            });
            // The view opens with its first tile, framed on the bounds; the root tile, which a smaller child tile can
            // beat to it, then frames it on its points as the GLB is (stray fragments left out), unless the visitor
            // has moved the camera by then
            opened.addEventListener("load-model", (event) => {
                opened.group.updateMatrixWorld(true);
                if (!framedOnRoot && event.tile === opened.root) {
                    framedOnRoot = true;
                    // The tile may not be in the (turned) group yet: its box then needs the group's turn added
                    const box = meshFrameBox(event.scene);
                    let attached = false;
                    for (let node = event.scene.parent; node; node = node.parent) attached = attached || node === opened.group;
                    view.box = attached ? box : box.applyMatrix4(opened.group.matrixWorld);
                    if (shown && current === "mesh" && !moved) frame(view.box);
                }
                if (shown) return;
                shown = true;
                clearTimeout(timer);
                tiles = opened;
                if (!view.box) view.box = new THREE.Box3().setFromObject(opened.group);
                resolve(view);
            });
            opened.addEventListener("load-error", (event) => {
                const status = event.error instanceof HttpError ? event.error.status : null;
                if (!shown) fail(event.error || new Error("the mesh tiles failed"));
                else onFailure(status);
            });
            scene.add(opened.group);
            // Loading starts with the render loop's first update
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
        const mesh = await new Promise((resolve, reject) => {
            const splats = new SplatMesh({ url, paged: true, onProgress: progress(onProgress), onLoad: () => resolve(splats) });
            splats.initialized.catch(reject);
            scene.add(splats);
        });
        const until = performance.now() + BOUNDS_WAIT_MS;
        let box = mesh.getBoundingBox();
        while (box.isEmpty() && performance.now() < until) {
            await new Promise((r) => setTimeout(r, 200));
            box = mesh.getBoundingBox();
        }
        return { object: mesh, box: box.isEmpty() ? box : splatFrameBox(mesh) };
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
        scene.add(opened.group);
        return { object: opened.group, box: cloudFrameBox(positions) };
    }

    const loaders = { cloud: loadCloud, mesh: loadMesh, splats: loadSplats };

    // onFailure(status): a point cloud node or a tile failed after the view opened (status: the HTTP status, or null).
    // fallback: for the mesh tiles, WebODM's GLB, shown if they can't load.
    async function show(type, url, onProgress, onFailure, fallback) {
        current = type;
        for (const [other, view] of Object.entries(views)) {
            if (other !== type) view.then((v) => { v.object.visible = current === other; }, () => {});
        }
        if (!views[type]) {
            views[type] = loaders[type](url, onProgress, onFailure || (() => {}), fallback);
            views[type].catch(() => { delete views[type]; });
        }
        const view = await views[type];
        view.object.visible = current === type;
        if (current === type) frame(view.box);
    }

    renderer.setAnimationLoop(() => {
        controls.update();
        if (cloud && current === "cloud") cloud.update(camera, renderer);
        if (tiles && current === "mesh") {
            camera.updateMatrixWorld();
            tiles.update();
        }
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

    return { show, resize, stats };
}

const page = document.querySelector("[data-explorer-viewer]");
if (page && window.ExplorerViewer) {
    let scene = null;
    try {
        scene = createScene(page.querySelector(".explorer-scene"), {
            draco: page.getAttribute("data-draco"),
            basis: page.getAttribute("data-basis"),
            tiles: { memory: window.ExplorerViewer.tilesMemory },
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
    if (scene) window.ExplorerViewer.start(scene);
}

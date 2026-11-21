/*
 * The 3D scene of a link's 3D page: three.js with orbit controls, WebODM's textured model as a Draco GLB, and its
 * Gaussian splats with Spark (paged, as WebODM's own 3D page loads them). One type shows at a time, framed to fit.
 * viewer-ui.js owns the page around it.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

// A paged splat file's bounds fill in as its first pages arrive
const BOUNDS_WAIT_MS = 10000;
// Framing ignores the outermost points on each axis: photogrammetry leaves stray fragments and long splats far out
const FRAME_PERCENTILE = 0.02;
const FRAME_SAMPLES = 50000;

// The box holding all but the outermost FRAME_PERCENTILE of the points on each axis; null without points
export function robustBox(xs, ys, zs) {
    if (!xs.length) return null;
    const range = (values) => {
        const sorted = Float64Array.from(values).sort();
        const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
        return [at(FRAME_PERCENTILE), at(1 - FRAME_PERCENTILE)];
    };
    const [x, y, z] = [range(xs), range(ys), range(zs)];
    return new THREE.Box3(new THREE.Vector3(x[0], y[0], z[0]), new THREE.Vector3(x[1], y[1], z[1]));
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

function createScene(container, dracoPath) {
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

    const gltfLoader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath(dracoPath));
    const views = {}; // type -> Promise of {object, box}
    let current = null;

    function resize() {
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);
    resize();

    function frame(box) {
        if (!box || box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
        const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
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

    async function loadMesh(url, onProgress) {
        const gltf = await gltfLoader.loadAsync(url, progress(onProgress));
        scene.add(gltf.scene);
        return { object: gltf.scene, box: meshFrameBox(gltf.scene) };
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

    async function show(type, url, onProgress) {
        current = type;
        for (const [other, view] of Object.entries(views)) {
            if (other !== type) view.then((v) => { v.object.visible = current === other; }, () => {});
        }
        if (!views[type]) {
            views[type] = type === "mesh" ? loadMesh(url, onProgress) : loadSplats(url, onProgress);
            views[type].catch(() => { delete views[type]; });
        }
        const view = await views[type];
        view.object.visible = current === type;
        if (current === type) frame(view.box);
    }

    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
    });

    return { show, resize };
}

const page = document.querySelector("[data-explorer-viewer]");
if (page && window.ExplorerViewer) {
    let scene = null;
    try {
        scene = createScene(page.querySelector(".explorer-scene"), page.getAttribute("data-draco"));
    } catch (e) {
        console.error(e);
        window.ExplorerViewer.fail();
    }
    if (scene) window.ExplorerViewer.start(scene);
}

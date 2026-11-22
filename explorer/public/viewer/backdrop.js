/*
 * What fills the 3D view around the model (the 3D page's Background menu, viewer-ui.js):
 * - Grid: a dark background and a floor of lines under the model, one plane drawn by a small shader;
 * - Sky: a gradient sky, Z-up as WebODM's outputs;
 * - Space: a dark sky with a faint grey galactic band and stars;
 * - Plain: nothing, so the page's theme colour shows through the transparent canvas.
 * Sky and Space's gradients are drawn once into a cube texture, the scene's background (one draw a frame); the stars
 * are points that keep their directions as the camera moves, so they stay sharp at any screen size. Everything is
 * drawn in code (the user, 2026-11-22: no image files). The colours are the scene's own, as the elevation ramp's are,
 * not UI colours.
 */
import * as THREE from "three";

export const BACKGROUNDS = ["grid", "sky", "space", "plain"];

const GRID = { background: 0x15181d, minor: 0x353d4a, major: 0x5b6676 };
const SKY = { zenith: 0x2a63ad, horizon: 0xdbe9f5, ground: 0x9fb8cc };
// Space without a hue (the user, 2026-11-22): the band is a faint grey, as starlight is to the eye
const SPACE = { deep: 0x020203, band: 0x1e1e20, core: 0x424244 };
// The floor reaches this many times the model's horizontal radius, fading out from FADE_START times it
const GRID_REACH = 14;
const FADE_START = 3;
const STARS = 5000;
const STARS_SMALL = 2500;

const gridVertex = /* glsl */ `
uniform float halfSize;
uniform vec2 offset;
varying vec2 vLocal;
varying vec2 vGrid;
void main() {
    // Line positions from the plane's centre, plus the centre's remainder on the major spacing (worked out in
    // script, in double precision): projected coordinates in the millions would lose the lines in float
    vLocal = position.xy * halfSize;
    vGrid = vLocal + offset;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const gridFragment = /* glsl */ `
uniform vec3 minorColor;
uniform vec3 majorColor;
uniform float spacing;
uniform float fadeStart;
uniform float fadeEnd;
varying vec2 vLocal;
varying vec2 vGrid;
// 1 on a line (about width pixels wide), 0 between; cells shrinking under a few pixels fade instead of shimmering
float lines(vec2 coord, float size, float width) {
    vec2 c = coord / size;
    vec2 w = fwidth(c);
    vec2 g = abs(fract(c - 0.5) - 0.5) / (w * width);
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    return line * (1.0 - smoothstep(0.12, 0.35, max(w.x, w.y)));
}
void main() {
    float minor = lines(vGrid, spacing, 1.0);
    float major = lines(vGrid, spacing * 10.0, 1.5);
    float edge = 1.0 - smoothstep(fadeStart, fadeEnd, length(vLocal));
    float alpha = max(minor * 0.7, major) * edge;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(mix(minorColor, majorColor, major), alpha);
    #include <colorspace_fragment>
}`;

const domeVertex = /* glsl */ `
varying vec3 vDirection;
void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const skyFragment = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 ground;
varying vec3 vDirection;
void main() {
    float h = normalize(vDirection).z;
    vec3 color = h >= 0.0 ? mix(horizon, zenith, pow(smoothstep(0.0, 1.0, h), 0.6))
                          : mix(horizon, ground, smoothstep(0.0, 0.6, -h));
    gl_FragColor = vec4(color, 1.0);
}`;

const spaceFragment = /* glsl */ `
uniform vec3 deep;
uniform vec3 band;
uniform vec3 core;
uniform vec3 pole;
varying vec3 vDirection;
float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
    float sum = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        sum += amplitude * noise(p);
        p *= 2.03;
        amplitude *= 0.5;
    }
    return sum;
}
void main() {
    vec3 d = normalize(vDirection);
    // A band around the great circle whose pole is "pole", brighter and patchier near its middle
    float across = dot(d, pole);
    float glow = exp(-across * across / 0.03);
    float clouds = fbm(d * 3.0) * 0.8 + fbm(d * 9.0) * 0.4;
    float dust = smoothstep(0.45, 0.75, fbm(d * 6.0 + 4.0)) * exp(-across * across / 0.004);
    vec3 color = deep + band * glow * clouds * 1.6 + core * pow(glow, 3.0) * clouds * clouds;
    color *= 1.0 - 0.6 * dust;
    gl_FragColor = vec4(color, 1.0);
}`;

const starVertex = /* glsl */ `
attribute float size;
attribute vec3 tint;
uniform float pixelRatio;
varying vec3 vTint;
void main() {
    vTint = tint;
    gl_PointSize = size * pixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const starFragment = /* glsl */ `
varying vec3 vTint;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = 1.0 - smoothstep(0.3, 1.0, r);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(vTint, alpha);
    #include <colorspace_fragment>
}`;

// The minor lines' spacing in metres, a power of ten: about a tenth of the model's width, the major lines ten times it
export function gridSpacing(width) {
    return Math.pow(10, Math.floor(Math.log10(Math.max(width, 1) / 10)));
}

// The same stars each time: a small seeded generator (mulberry32)
function random(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function colors(values) {
    const out = {};
    for (const [name, hex] of Object.entries(values)) out[name] = { value: new THREE.Color(hex) };
    return out;
}

// options: {small: a phone (smaller cube texture, fewer stars)}
export function createBackdrop(scene, renderer, camera, options = {}) {
    const small = !!options.small;
    const gridColor = new THREE.Color(GRID.background);
    // The band crosses the first view (from the south-east and above, scene.js's frame) diagonally
    const pole = new THREE.Vector3(0.7, 0.55, -0.17).normalize();

    const grid = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        vertexShader: gridVertex,
        fragmentShader: gridFragment,
        uniforms: {
            minorColor: { value: new THREE.Color(GRID.minor) },
            majorColor: { value: new THREE.Color(GRID.major) },
            halfSize: { value: 1 },
            offset: { value: new THREE.Vector2() },
            spacing: { value: 1 },
            fadeStart: { value: 1 },
            fadeEnd: { value: 2 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    }));
    grid.renderOrder = -1; // before the splats, which are drawn over it
    grid.frustumCulled = false;
    grid.visible = false;
    grid.raycast = () => {};
    scene.add(grid);
    let fitted = false;

    let stars = null;
    function makeStars() {
        const count = small ? STARS_SMALL : STARS;
        const next = random(20261122);
        const positions = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        const tints = new Float32Array(count * 3);
        const direction = new THREE.Vector3();
        const tint = new THREE.Color();
        for (let i = 0; i < count; i++) {
            // A third of them crowd the band
            direction.set(next() * 2 - 1, next() * 2 - 1, next() * 2 - 1);
            if (direction.lengthSq() > 1 || direction.lengthSq() < 1e-6) { i--; continue; }
            direction.normalize();
            if (i % 3 === 0) direction.addScaledVector(pole, -direction.dot(pole) * (0.85 + next() * 0.15)).normalize();
            direction.toArray(positions, i * 3);
            // Mostly faint, a few bright
            const bright = Math.pow(next(), 6);
            sizes[i] = 1 + bright * 2.5;
            const warmth = next();
            tint.setRGB(0.75 + 0.25 * warmth, 0.8 + 0.1 * next(), 1 - 0.25 * warmth).multiplyScalar(0.5 + 0.5 * Math.max(bright, next() * 0.7));
            tint.toArray(tints, i * 3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
        geometry.setAttribute("tint", new THREE.BufferAttribute(tints, 3));
        const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
            vertexShader: starVertex,
            fragmentShader: starFragment,
            uniforms: { pixelRatio: { value: renderer.getPixelRatio() } },
            // Not "transparent": three draws those after the model, and these must go under it. Additive blending
            // applies all the same.
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        points.renderOrder = -2; // first, under everything
        points.frustumCulled = false;
        points.raycast = () => {};
        scene.add(points);
        return points;
    }

    // The gradients, drawn once into a cube texture: the sky's or space's
    const domes = {};
    function dome(kind) {
        if (domes[kind]) return domes[kind];
        const target = new THREE.WebGLCubeRenderTarget(small ? 256 : 512, { type: THREE.HalfFloatType });
        const cubeCamera = new THREE.CubeCamera(0.1, 10, target);
        const uniforms = kind === "sky" ? colors(SKY) : { ...colors(SPACE), pole: { value: pole } };
        const material = new THREE.ShaderMaterial({ vertexShader: domeVertex, fragmentShader: kind === "sky" ? skyFragment : spaceFragment,
            uniforms, side: THREE.BackSide, depthWrite: false });
        const geometry = new THREE.SphereGeometry(5, 64, 32);
        const bake = new THREE.Scene();
        bake.add(new THREE.Mesh(geometry, material));
        cubeCamera.update(renderer, bake);
        geometry.dispose();
        material.dispose();
        domes[kind] = target.texture;
        return domes[kind];
    }

    let chosen = null;
    function set(kind) {
        if (!BACKGROUNDS.includes(kind)) kind = BACKGROUNDS[0];
        chosen = kind;
        grid.visible = kind === "grid" && fitted;
        if (kind === "space" && !stars) stars = makeStars();
        if (stars) stars.visible = kind === "space";
        if (kind === "grid") scene.background = gridColor;
        else if (kind === "plain") scene.background = null;
        else scene.background = dome(kind);
    }

    // The floor under the box the view is framed on: just below its bottom, so flat ground doesn't flicker against it
    function fit(box) {
        if (!box || box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, 1) / 2;
        const spacing = gridSpacing(radius * 2);
        const major = spacing * 10;
        const half = radius * GRID_REACH;
        const u = grid.material.uniforms;
        u.halfSize.value = half;
        u.spacing.value = spacing;
        u.offset.value.set(((center.x % major) + major) % major, ((center.y % major) + major) % major);
        u.fadeStart.value = radius * FADE_START;
        u.fadeEnd.value = half;
        grid.scale.set(half, half, 1);
        grid.position.set(center.x, center.y, box.min.z - Math.max(size.z, radius) * 0.01);
        grid.updateMatrixWorld();
        fitted = true;
        grid.visible = chosen === "grid";
    }

    // Each frame: the stars around the camera, between its near and far planes
    function update() {
        if (!stars || !stars.visible) return;
        stars.position.copy(camera.position);
        stars.scale.setScalar(Math.sqrt(camera.near * camera.far));
        stars.material.uniforms.pixelRatio.value = renderer.getPixelRatio();
    }

    return { set, fit, update, chosen: () => chosen };
}

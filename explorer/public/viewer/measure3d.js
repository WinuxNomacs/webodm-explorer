/*
 * The 3D page's Measure tool (upcoming-changes.md, "Plan: measurement tools", step B): Distance, Area, Point and Angle
 * on points picked on the textured model or the point cloud (scene.pick: the exact triangle, or a real point of the
 * cloud). The panel, keys and tool switching are measure.js's; this is the scene's surface: clicks that pick, the
 * drawing over the model, and the values. The scene is the task's projected grid less WebODM's offset in x and y, so
 * heights are as they are and horizontal parts are divided by the grid's scale factor at the model (data-grid-scale,
 * pyproj's on the server) to be lengths on the ground, as the map's. No measuring on Gaussian splats.
 */
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const CLICK_SLOP = 6; // pixels a press may move and still be a click (a drag orbits)

function themeColour(page) {
    const probe = document.createElement("div");
    probe.className = "theme-color-button-primary";
    probe.hidden = true;
    page.appendChild(probe);
    const colour = window.getComputedStyle(probe).color;
    page.removeChild(probe);
    return colour || "#2a9fd6";
}

function dot(colour) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.arc(16, 16, 11, 0, 2 * Math.PI);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.stroke();
    return new THREE.CanvasTexture(canvas);
}

// The surface for measure.js's create(): `Measure` is window.ExplorerMeasure (the helpers and the formats)
export function sceneSurface(Measure, scene, canvas, texts, scale, colour) {
    let handlers = null;
    let picks = 0;
    let down = null;
    const texture = dot(colour);
    const lineMaterial = new LineMaterial({ color: new THREE.Color(colour).getHex(), linewidth: 3, depthTest: false,
        depthWrite: false, transparent: true });

    function clear() {
        for (const child of scene.overlay.children.slice()) {
            scene.overlay.remove(child);
            if (child.isSprite) child.material.dispose();
            else if (child.geometry) child.geometry.dispose();
        }
    }

    function onDown(e) {
        down = e.button === 0 || e.pointerType === "touch" ? { x: e.clientX, y: e.clientY } : null;
    }

    function onUp(e) {
        const at = down;
        down = null;
        if (!handlers || !at || Math.abs(e.clientX - at.x) > CLICK_SLOP || Math.abs(e.clientY - at.y) > CLICK_SLOP) return;
        if (scene.shown() === "splats") {
            handlers.say(texts.noSplats);
            return;
        }
        const mine = ++picks;
        Promise.resolve(scene.pick(e.clientX, e.clientY)).then((p) => {
            if (!handlers || mine !== picks) return;
            if (!p) handlers.say(texts.nothing);
            else handlers.click([p.x, p.y, p.z]);
        });
    }

    function onDouble() {
        if (handlers) handlers.finish();
    }

    const height = (metres, imperial) => Measure.formatHeight(metres, imperial);
    const signed = (metres, imperial) => (metres > 0 ? "+" : "") + height(metres, imperial);

    return {
        start(h) {
            handlers = h;
            canvas.addEventListener("pointerdown", onDown);
            canvas.addEventListener("pointerup", onUp);
            canvas.addEventListener("dblclick", onDouble);
        },
        stop() {
            handlers = null;
            picks++;
            canvas.removeEventListener("pointerdown", onDown);
            canvas.removeEventListener("pointerup", onUp);
            canvas.removeEventListener("dblclick", onDouble);
            clear();
        },
        // The points as dots of one size on screen, and the line through them (closed for an area)
        draw(state) {
            clear();
            const pts = state.points;
            const [w, h] = scene.size();
            lineMaterial.resolution.set(w, h);
            const path = pts.slice();
            if (state.mode === "area" && state.done && pts.length >= 3) path.push(pts[0]);
            if (path.length >= 2 && state.mode !== "point") {
                const geometry = new LineGeometry();
                geometry.setPositions(path.flat());
                const line = new Line2(geometry, lineMaterial);
                line.computeLineDistances();
                line.renderOrder = 998;
                line.raycast = () => {};
                scene.overlay.add(line);
            }
            for (const p of pts) {
                const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false,
                    sizeAttenuation: false, transparent: true }));
                sprite.position.set(p[0], p[1], p[2]);
                sprite.scale.set(0.022, 0.022, 1);
                sprite.renderOrder = 999;
                sprite.raycast = () => {};
                scene.overlay.add(sprite);
            }
        },
        hint(state) {
            if (state.mode === "point") return texts.hintPoint3d;
            if (state.done) return texts.hintDone3d;
            return { distance: texts.hintDistance, area: texts.hintArea3d, angle: texts.hintAngle }[state.mode];
        },
        rows(state, imperial) {
            const pts = state.points, n = pts.length;
            const fmt = (m) => Measure.formatLength(m, imperial);
            if (state.mode === "point" && n === 1) return [[texts.elevation, height(pts[0][2], imperial)]];
            if (state.mode === "distance" && n === 2) {
                const d = Measure.distance3d(pts[0], pts[1], scale);
                return [[texts.distance, fmt(d.length)], [texts.horizontal, fmt(d.horizontal)],
                    [texts.heightDifference, signed(d.vertical, imperial)],
                    [texts.slope, Measure.number(d.degrees, 1) + "°" + (d.percent === null ? "" : " (" + Measure.number(d.percent, 1) + "%)")]];
            }
            if (state.mode === "area" && n >= 3) {
                const a = Measure.area3d(pts, scale);
                return [[texts.horizontalArea, Measure.formatArea(a.horizontal, imperial)],
                    [texts.slopedArea, Measure.formatArea(a.sloped, imperial)], [texts.perimeter, fmt(a.perimeter)]];
            }
            if (state.mode === "angle" && n === 3) {
                return [[texts.angle, Measure.number(Measure.angle3d(pts[0], pts[1], pts[2], scale), 1) + "°"]];
            }
            return [];
        },
    };
}

// The page's Measure button, once the scene exists (scene.js)
export function startMeasure(page, scene) {
    const Measure = window.ExplorerMeasure;
    const toggle = page.querySelector("[data-tool=measure]");
    const view = page.querySelector(".explorer-scene");
    const textsScript = document.getElementById("explorer-measure-texts");
    if (!Measure || !toggle || !view || !textsScript || !scene.overlay) return null;
    const texts = JSON.parse(textsScript.textContent);
    const scale = parseFloat(toggle.getAttribute("data-grid-scale")) || 1;
    const surface = sceneSurface(Measure, scene, view.querySelector("canvas"), texts, scale, themeColour(page));
    const tool = Measure.create({ page, view, toggle, texts, surface, units: true,
        modes: ["distance", "area", "point", "angle"] });
    // On the page, for the live checks
    page.explorerMeasure = tool;
    return tool;
}

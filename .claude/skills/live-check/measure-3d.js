// Live check of the 3D page's Measure tool on the dev server (http://localhost:8008), Chromium on the real GPU.
// 1. Signed in, the textured model: Distance between two picked points; its horizontal part against pyproj's exact
//    geodesic between the same points (their task coordinates converted to WGS84 in the web container: pyproj's Geod
//    is Karney's, as GeographicLib), and the uncorrected grid length for comparison; Point, Angle, Area.
//    Full detail: ordinary and full-detail picks at the same pixels (moved, cold and warm times), repeatable; the
//    full-detail tiles answering 500 say so.
// 2. The point cloud: Area; full-detail picks.
// 3. A link (one "Live check" link, revoked at the end, also on failure): Distance on the cloud as an anonymous
//    visitor, the panel's unit switch, Gaussian splats (when the task has them) measured on the point cloud with the
//    cloud view's points and refused without a cloud (the page served without its cloud button), no long tasks
//    while picking, phone width.
// Usage: node .claude/skills/live-check/measure-3d.js <repo> <screenshot folder> <user> <password> <project id> <task id>
//        <task EPSG code>
const path = require("path");
const { execFileSync } = require("child_process");
const [repo, out, user, password, project, task, epsg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`); };
const errors = [];
const watch = (page, label) => {
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("CONNECTION_REFUSED")) errors.push(`${label}: ${m.text().slice(0, 160)}`); });
};
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png") }).catch(() => {});
const metres = (text) => parseFloat(text.replace(/[^\d.+-]/g, ""));

// pyproj in the web container: the geodesic between two task-coordinate points (x, y in the task's EPSG)
function geodesic(a, b) {
    const code = `import sys, json
from pyproj import Geod, Transformer
a, b, epsg = json.loads(sys.argv[1])
t = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
(lon1, lat1), (lon2, lat2) = t.transform(*a), t.transform(*b)
print(Geod(ellps="WGS84").inv(lon1, lat1, lon2, lat2)[2])`;
    return parseFloat(execFileSync("docker", ["exec", "ex-webapp", "/webodm/venv/bin/python", "-c", code, JSON.stringify([a, b, Number(epsg)])]).toString());
}

async function open3d(page, url) {
    await page.goto(url);
    await page.waitForTimeout(12000);
    return page.$eval(".explorer-scene canvas", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
}
// Clicks until the tool has `count` points (a click on a gap of the cloud picks nothing), each answered before the next
async function pickPoints(page, c, spots, count) {
    for (const [fx, fy] of spots) {
        const n = await page.evaluate(() => document.querySelector("[data-explorer-viewer]").explorerMeasure.state().points.length);
        if (n >= count) break;
        await page.mouse.click(c.x + c.w * fx, c.y + c.h * fy);
        // A pick loads full detail first: wait for its answer (a new point, or a message), not a fixed time
        await page.waitForFunction((before) => {
            const tool = document.querySelector("[data-explorer-viewer]").explorerMeasure.state();
            return tool.points.length !== before || tool.done || (tool.message && !/Loading/.test(tool.message));
        }, n, { timeout: 60000 }).catch(() => {});
    }
}
const panel = (page) => page.$$eval(".explorer-measure-results dt, .explorer-measure-results dd", (els) => els.map((e) => e.textContent));
const SPOTS = [];
for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) SPOTS.push([0.3 + 0.07 * i, 0.3 + 0.07 * j]);

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
    const admin = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await admin.newPage();
    watch(page, "signed-in");
    let token = null;
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", user);
        await page.fill("input[name=password]", password);
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);

        // 1. The textured model
        let c = await open3d(page, `${BASE}/plugins/explorer/project/${project}/3d/${task}/?t=mesh`);
        const scale = parseFloat(await page.getAttribute("[data-tool=measure]", "data-grid-scale"));
        const offset = (await page.getAttribute("[data-explorer-viewer]", "data-offset")).split(" ").map(Number);
        console.log(`grid scale ${scale}`);
        await page.click("[data-tool=measure]");
        await pickPoints(page, c, [[0.35, 0.5], [0.65, 0.5], [0.3, 0.45], [0.7, 0.55]], 2);
        const dist = await panel(page);
        const pts = await page.evaluate(() => document.querySelector("[data-explorer-viewer]").explorerMeasure.state().points);
        const exact = geodesic([pts[0][0] + offset[0], pts[0][1] + offset[1]], [pts[1][0] + offset[0], pts[1][1] + offset[1]]);
        const grid = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const shown = metres(dist[3]);
        check("Distance's horizontal part is the WGS84 geodesic between the points (to the centimetre shown)", Math.abs(shown - exact) <= 0.006,
            `${dist[3]} vs pyproj ${exact.toFixed(4)} m (the grid alone: ${grid.toFixed(4)} m)`);
        console.log("  distance:", JSON.stringify(dist));
        await page.click("[data-mode=point]");
        await pickPoints(page, c, [[0.5, 0.5], [0.45, 0.5], [0.55, 0.5]], 1);
        const point = await panel(page);
        check("Point reads the picked point's elevation", point[0] === "Elevation" && isFinite(metres(point[1])), JSON.stringify(point));
        await page.click("[data-mode=angle]");
        await pickPoints(page, c, [[0.4, 0.4], [0.5, 0.5], [0.6, 0.4], [0.62, 0.42]], 3);
        const ang = await panel(page);
        check("Angle reads an angle", ang[0] === "Angle" && metres(ang[1]) > 0 && metres(ang[1]) <= 180, JSON.stringify(ang));
        await page.click("[data-mode=area]");
        await pickPoints(page, c, [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.42, 0.62]], 4);
        await page.keyboard.press("Enter");
        const area = await panel(page);
        check("Area reads a horizontal and a sloped area, the sloped no smaller", metres(area[3]) >= metres(area[1]) - 0.01, JSON.stringify(area));
        await shot(page, "measure3d-01-mesh");
        check("the panel's content fits it (no sideways scroll inside)", await page.$eval(".explorer-measure", (e) => e.scrollWidth <= e.clientWidth + 1));
        check("no mode's name is cut short", await page.$$eval(".explorer-measure-modes .btn", (bs) => bs.every((b) => b.scrollWidth <= b.clientWidth)));

        // Full detail (the user, 2026-11-27: measurements download the data they need): ordinary picks of what the view
        // shows against full-detail picks at the same pixels, which repeat exactly; then the full-detail tiles refused
        const detail = async (view) => page.evaluate(async () => {
            const scene = window.ExplorerViewer.scene, r = document.querySelector(".explorer-scene canvas").getBoundingClientRect();
            const rows = [];
            for (const [fx, fy] of [[0.45, 0.5], [0.55, 0.45], [0.5, 0.55], [0.4, 0.6]]) {
                const x = r.left + r.width * fx, y = r.top + r.height * fy;
                const coarse = await scene.pick(x, y);
                let t0 = performance.now(); const fine = await scene.pickFinest(x, y); const cold = performance.now() - t0;
                t0 = performance.now(); const again = await scene.pickFinest(x, y); const warm = performance.now() - t0;
                const d = (a, b) => a && b ? a.distanceTo(b) : null;
                rows.push({ moved: d(coarse, fine), repeat: d(fine, again), cold: Math.round(cold), warm: Math.round(warm), found: Boolean(fine) });
            }
            return rows;
        });
        const meshDetail = await detail();
        check("mesh: full-detail picks repeat exactly", meshDetail.filter((r) => r.found).every((r) => r.repeat < 1e-9), JSON.stringify(meshDetail));
        // In a fresh context (empty caches, so the tiles must be fetched), the finest tiles refused: the pick says so
        const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const injected = await fresh.newPage();
        // Its console fills with the refused tiles on purpose: only uncaught errors count
        injected.on("pageerror", (e) => errors.push(`refused tiles pageerror: ${e.message.slice(0, 160)}`));
        let refusedTiles = 0;
        await injected.route(/\/LOD-0\/.*\.glb/, (route) => { refusedTiles++; return route.fulfill({ status: 500, body: "" }); });
        await injected.goto(BASE + "/login/");
        await injected.fill("input[name=username]", user);
        await injected.fill("input[name=password]", password);
        await Promise.all([injected.waitForNavigation(), injected.click("button[type=submit], input[type=submit]")]);
        const ic = await open3d(injected, `${BASE}/plugins/explorer/project/${project}/3d/${task}/?t=mesh`);
        await injected.click("[data-tool=measure]");
        await injected.click("[data-mode=point]");
        await injected.mouse.click(ic.x + ic.w * 0.5, ic.y + ic.h * 0.5);
        await injected.waitForFunction(() => /could not be loaded|Nothing there/.test(document.querySelector(".explorer-measure-hint").textContent) || /Elevation/.test(document.querySelector(".explorer-measure-results").textContent), null, { timeout: 90000 }).catch(() => {});
        const refused = await injected.$eval(".explorer-measure-hint", (e) => e.textContent);
        const value = await injected.$eval(".explorer-measure-results", (e) => e.textContent);
        check("mesh: full-detail tiles refused say so, with no value from coarser tiles", /could not be loaded/.test(refused) && !/Elevation/.test(value),
            `${refused} (${refusedTiles} tile requests refused)`);
        await fresh.close();
        // Close up (the user's report, 2026-11-27: a close view picked nothing, the view's tiles filling the cache the
        // full-detail picks shared): wherever the view's own surface is, a full-detail point is found near it
        await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
        for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
        await page.waitForTimeout(8000);
        const close = await page.evaluate(async () => {
            const scene = window.ExplorerViewer.scene, r = document.querySelector(".explorer-scene canvas").getBoundingClientRect();
            const rows = [];
            for (let j = 1; j < 5; j++) for (let i = 1; i < 6; i++) {
                const x = r.left + r.width * i / 6, y = r.top + r.height * j / 5;
                const coarse = await scene.pick(x, y);
                if (!coarse) continue;
                const t0 = performance.now();
                let fine = null, error = null;
                try { fine = await scene.pickFinest(x, y); } catch (e) { error = e.message; }
                rows.push({ d: fine ? +coarse.distanceTo(fine).toFixed(3) : null, ms: Math.round(performance.now() - t0), error });
            }
            return { camera: scene.place(), rows };
        });
        check("mesh close up: every spot on the view's surface has a full-detail point near it",
            close.rows.length >= 10 && close.rows.every((r) => r.d !== null && r.d < 0.25),
            `${close.rows.length} spots, ${JSON.stringify(close.rows.filter((r) => r.d === null || r.d >= 0.25).slice(0, 3))}, ` +
            `slowest ${Math.max(...close.rows.map((r) => r.ms))} ms, camera ${JSON.stringify(close.camera.camera)}`);

        // 2. The point cloud
        c = await open3d(page, `${BASE}/plugins/explorer/project/${project}/3d/${task}/?t=cloud`);
        await page.click("[data-tool=measure]");
        await page.click("[data-mode=area]");
        await pickPoints(page, c, SPOTS, 4);
        await page.keyboard.press("Enter");
        const cloudArea = await panel(page);
        const cloudDetail = await detail();
        check("cloud: full-detail picks repeat exactly", cloudDetail.filter((r) => r.found).every((r) => r.repeat < 1e-9), JSON.stringify(cloudDetail));
        check("the cloud: Area from picked points", cloudArea[0] === "Horizontal Area", JSON.stringify(cloudArea));
        await shot(page, "measure3d-02-cloud");

        // 3. A link's visitor
        token = await page.evaluate(async (pid) => {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/);
            const res = await fetch(`/api/plugins/explorer/projects/${pid}/links/`, { method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf ? csrf[1] : "" }, body: JSON.stringify({ label: "Live check", expires_days: 7 }) });
            return (await res.json()).token;
        }, project);
        check("a Live check link was created", Boolean(token));
        const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const visitor = await visitorContext.newPage();
        watch(visitor, "visitor");
        c = await open3d(visitor, `${BASE}/plugins/explorer/s/${token}/3d/${task}/?t=cloud`);
        await visitor.click("[data-tool=measure]");
        await visitor.evaluate(() => { window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: "longtask" }); });
        await pickPoints(visitor, c, SPOTS, 2);
        const vDist = await panel(visitor);
        check("a visitor measures a distance on the cloud", vDist[0] === "Distance", JSON.stringify(vDist));
        check("no long tasks while picking", (await visitor.evaluate(() => window.__long)).length === 0, JSON.stringify(await visitor.evaluate(() => window.__long)));
        await visitor.click("[data-units]");
        const feet = await panel(visitor);
        check("the panel's unit switch reads in feet", /ft/.test(feet[1]), JSON.stringify(feet));
        await visitor.click("[data-units]");
        if (await visitor.$("[data-type=splats]")) {
            // Splats measured on the point cloud (the user, 2026-11-27), opened straight on the splats so the cloud is
            // opened hidden for measuring
            const splatPage = await visitorContext.newPage();
            watch(splatPage, "splats");
            const sc = await open3d(splatPage, `${BASE}/plugins/explorer/s/${token}/3d/${task}/?t=splats`);
            await splatPage.click("[data-tool=measure]");
            await splatPage.evaluate(() => { window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: "longtask" }); });
            const onCloud = await splatPage.$eval(".explorer-measure-hint", (e) => e.textContent);
            await pickPoints(splatPage, sc, SPOTS, 2);
            const sDist = await panel(splatPage);
            check("splats: a visitor measures a distance, on the point cloud", sDist[0] === "Distance" && /point cloud/.test(onCloud),
                `${JSON.stringify(sDist)}; ${onCloud}`);
            check("splats: no long tasks while picking", (await splatPage.evaluate(() => window.__long)).length === 0, JSON.stringify(await splatPage.evaluate(() => window.__long)));
            await shot(splatPage, "measure3d-04-splats");
            // The same pixels on the cloud view (the camera kept across the switch) give the same points
            const at = (pg) => pg.evaluate(async () => {
                const scene = window.ExplorerViewer.scene, r = document.querySelector(".explorer-scene canvas").getBoundingClientRect();
                const out = [];
                for (const [fx, fy] of [[0.4, 0.4], [0.5, 0.5], [0.6, 0.45], [0.45, 0.6], [0.55, 0.55]]) {
                    const p = await scene.pickFinest(r.left + r.width * fx, r.top + r.height * fy).catch(() => null);
                    out.push(p && p.toArray());
                }
                return { shown: scene.shown(), out };
            });
            const onSplats = await at(splatPage);
            await splatPage.click("[data-type=cloud]");
            await splatPage.waitForTimeout(6000);
            const onCloudView = await at(splatPage);
            const same = onSplats.out.every((p, k) => (p === null) === (onCloudView.out[k] === null)
                && (p === null || Math.hypot(p[0] - onCloudView.out[k][0], p[1] - onCloudView.out[k][1], p[2] - onCloudView.out[k][2]) < 1e-6));
            check("splats: the points are the cloud view's at the same pixels", onSplats.shown === "splats" && onCloudView.shown === "cloud"
                && same && onSplats.out.some(Boolean), `${onSplats.out.filter(Boolean).length} of 5 found`);
            await splatPage.close();
            // Without a point cloud (the page served with its cloud button removed), splats are refused with a message
            const bare = await visitorContext.newPage();
            watch(bare, "splats without a cloud");
            await bare.route(/\/3d\/[^/]+\/\?t=splats$/, async (route) => {
                const response = await route.fetch();
                const html = (await response.text()).replace(/<button[^>]*data-type="cloud"[\s\S]*?<\/button>/, "");
                await route.fulfill({ response, body: html });
            });
            const bc = await open3d(bare, `${BASE}/plugins/explorer/s/${token}/3d/${task}/?t=splats`);
            const removed = !(await bare.$("[data-type=cloud]"));
            await bare.click("[data-tool=measure]");
            await bare.mouse.click(bc.x + bc.w / 2, bc.y + bc.h / 2);
            await bare.waitForTimeout(300);
            const hint = await bare.$eval(".explorer-measure-hint", (e) => e.textContent);
            check("splats without a point cloud are refused with a message", removed && /needs the task's point cloud/.test(hint), hint);
            await bare.close();
        }
        await visitor.setViewportSize({ width: 390, height: 844 });
        await visitor.waitForTimeout(500);
        check("phone: no horizontal scroll", !(await visitor.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
        const box = await visitor.$eval(".explorer-measure", (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, w: window.innerWidth }; });
        check("phone: the panel fits the width", box.left >= 0 && box.right <= box.w, JSON.stringify(box));
        await shot(visitor, "measure3d-03-phone");
        await visitorContext.close();
    } catch (e) {
        failed++;
        console.log("FAIL exception: " + e.message.split("\n")[0]);
    } finally {
        if (token) {
            const status = await page.evaluate(async ([pid, tok]) => {
                const csrf = document.cookie.match(/csrftoken=([^;]+)/);
                return (await fetch(`/api/plugins/explorer/projects/${pid}/links/${tok}/`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf ? csrf[1] : "" } })).status;
            }, [project, token]).catch((e) => "failed: " + e.message);
            console.log("cleanup: the Live check link revoked:", status);
        }
        await browser.close();
        console.log(`${passed} passed, ${failed} failed`);
        console.log("errors:\n" + errors.join("\n"));
    }
})();

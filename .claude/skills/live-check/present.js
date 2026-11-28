// Live check of the presentation tools (Laser Pointer and Area Highlight) on the signed-in map and 3D pages of one
// task against the dev server (http://localhost:8008): the laser drawn while the mouse still pans and orbits, a
// highlight drawn without moving the view and fading, Shift keeping one until Esc, Spotlight, the 3D page's frame
// times with and without the laser moving (headless Chromium on Metal), and a phone with touch: one finger points
// without moving the map, and no sideways scroll. Creates nothing on the server; the browser profile is thrown away.
// Usage: node .claude/skills/live-check/present.js <repo> <screenshot folder> <user> <password> [project id]
const path = require("path");
const [repo, out, user, password, projectArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = process.env.EXPLORER_BASE || "http://localhost:8008";
const PROJECT = Number(projectArg || 2);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), timeout: 90000 })
    .catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const errors = [];
const checks = [];
const check = (ok, what) => { checks.push((ok ? "ok   " : "FAIL ") + what); };
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error" && !/35729|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${label}: ${m.text().slice(0, 160)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${r.url()}`); });
};
// How many of the marks canvas's pixels are drawn on
const inked = (page) => page.evaluate(() => {
    const c = document.querySelector(".explorer-present-canvas");
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
    return n;
});
const mapPane = (page) => page.evaluate(() => {
    const pane = document.querySelector(".leaflet-map-pane");
    return pane ? pane.style.transform : null;
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits until the map stops moving by itself (a pan's inertia, the first fit), up to 5 s
async function settled(page) {
    let last = await mapPane(page);
    for (let i = 0; i < 20; i++) {
        await sleep(250);
        const now = await mapPane(page);
        if (now === last) return now;
        last = now;
    }
    return last;
}

async function login(page) {
    await page.goto(BASE + "/login/");
    await page.fill("input[name=username]", user);
    await page.fill("input[name=password]", password);
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
}

// Frame times from requestAnimationFrame over `ms` while `act` runs
async function frameTimes(page, ms, act) {
    await page.evaluate((duration) => {
        window.__frames = [];
        let last = performance.now();
        const end = last + duration;
        const step = (t) => { window.__frames.push(t - last); last = t; if (t < end) requestAnimationFrame(step); };
        requestAnimationFrame(step);
    }, ms);
    await act();
    await sleep(200);
    const frames = (await page.evaluate(() => window.__frames)).slice(1).sort((a, b) => a - b);
    const at = (q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))] || 0;
    return { n: frames.length, p50: at(0.5).toFixed(1), p95: at(0.95).toFixed(1), max: at(1).toFixed(1),
        over33: frames.filter((f) => f > 33.4).length };
}

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const page = await context.newPage();
        watch(page, "desktop");
        await login(page);
        const tasks = await page.evaluate(async (p) => (await fetch(`/api/projects/${p}/tasks/`)).json(), PROJECT);
        const task = tasks.find((t) => (t.available_assets || []).includes("orthophoto.tif") &&
            (t.available_assets || []).includes("textured_model.glb"));
        if (!task) throw new Error("no task with an orthophoto and a mesh in project " + PROJECT);
        const own = `${BASE}/plugins/explorer/project/${PROJECT}/`;
        console.log("task " + task.id.slice(0, 8));

        // Map: the laser while the mouse still pans
        await page.goto(`${own}map/${task.id}/`);
        await page.waitForSelector(".leaflet-tile-loaded", { timeout: 30000 }).catch(() => null);
        const box = await page.locator(".explorer-map").boundingBox();
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        check(await page.locator("[data-present]").isVisible(), "the Present group shows on the map page");
        await page.keyboard.press("l");
        check(await page.getAttribute("[data-tool=laser]", "aria-pressed") === "true", "L turns the Laser Pointer on");
        for (let i = 0; i < 12; i++) await page.mouse.move(cx - 150 + i * 25, cy + Math.sin(i / 2) * 40);
        check(await inked(page) > 0, "the laser and its trail are drawn");
        await shot(page, "present-map-laser");
        const before = await mapPane(page);
        await page.mouse.down();
        await page.mouse.move(cx + 80, cy + 60, { steps: 8 });
        await page.mouse.up();
        check(await mapPane(page) !== before, "a drag with the laser on still pans the map");

        // Map: a highlight that doesn't move the map, then fades
        await page.keyboard.press("h");
        const still = await settled(page);
        await page.mouse.move(cx - 120, cy - 60);
        await page.mouse.down();
        for (let i = 0; i <= 16; i++) {
            const a = (i / 16) * 2 * Math.PI;
            await page.mouse.move(cx + Math.cos(a) * 120, cy + Math.sin(a) * 70);
        }
        await page.mouse.up();
        check(await mapPane(page) === still, "drawing a highlight doesn't move the map");
        check(await inked(page) > 0, "the highlight is drawn");
        await shot(page, "present-map-highlight");
        await sleep(3400);
        check(await inked(page) === 0, "the highlight is gone after about 3 seconds");
        await page.keyboard.down("Shift");
        await page.mouse.move(cx - 100, cy - 50);
        await page.mouse.down();
        await page.mouse.move(cx + 100, cy + 50, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up("Shift");
        await sleep(3400);
        check(await inked(page) > 0, "a highlight drawn with Shift stays");
        await page.keyboard.press("Escape");
        await sleep(100);
        check(await inked(page) === 0 && await page.getAttribute("[data-tool=highlight]", "aria-pressed") === "false",
            "Esc clears it and turns the tool off");

        // Spotlight with an ellipse, from the menu
        await page.click("[data-present] .dropdown-toggle");
        await page.click("[data-shape=ellipse]");
        await page.click("[data-present] .dropdown-toggle");
        await page.click("[data-spotlight]");
        await page.mouse.move(cx - 140, cy - 80);
        await page.mouse.down();
        await page.mouse.move(cx + 140, cy + 80, { steps: 6 });
        await page.mouse.up();
        await shot(page, "present-map-spotlight");
        check(await inked(page) > box.width * box.height * 0.5, "Spotlight dims the map around the ellipse");
        await page.keyboard.press("Escape");

        // 3D: frame times without and with the laser moving, and orbit still works
        await page.goto(`${own}3d/${task.id}/?t=mesh`);
        await page.waitForFunction(() => !document.querySelector(".explorer-status:not([hidden])"), null, { timeout: 60000 }).catch(() => null);
        await sleep(3000);
        const scene = await page.locator(".explorer-scene").boundingBox();
        const sx = scene.x + scene.width / 2, sy = scene.y + scene.height / 2;
        const wave = async () => {
            for (let i = 0; i < 90; i++) {
                await page.mouse.move(sx + Math.cos(i / 6) * 200, sy + Math.sin(i / 4) * 120);
                await sleep(16);
            }
        };
        const off = await frameTimes(page, 2500, wave);
        await page.keyboard.press("l");
        const on = await frameTimes(page, 2500, wave);
        console.log(`3D frames, mouse moving, tool off: ${JSON.stringify(off)}`);
        console.log(`3D frames, mouse moving, laser on: ${JSON.stringify(on)}`);
        check(Number(on.p95) <= Math.max(Number(off.p95) * 1.25, 20), "the laser leaves the 3D page's frame times as they were");
        const a = await page.locator(".explorer-scene").screenshot();
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx + 160, sy + 30, { steps: 10 });
        await page.mouse.up();
        await sleep(500);
        const b = await page.locator(".explorer-scene").screenshot();
        check(!a.equals(b), "a drag with the laser on still orbits the model");
        await shot(page, "present-3d-laser");
        await page.keyboard.press("h");
        await page.mouse.move(sx - 120, sy - 70);
        await page.mouse.down();
        await page.mouse.move(sx + 120, sy + 70, { steps: 8 });
        await page.mouse.up();
        check(await inked(page) > 0, "a highlight is drawn on the 3D page");
        await shot(page, "present-3d-highlight");
        await context.close();

        // Phone with touch: one finger points without moving the map; no sideways scroll
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await login(mobile);
        await mobile.goto(`${own}map/${task.id}/`);
        await mobile.waitForSelector(".leaflet-tile-loaded", { timeout: 30000 }).catch(() => null);
        const scroll = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(scroll <= 0, "no sideways scroll at phone width (" + scroll + "px)");
        await mobile.tap("[data-tool=laser]");
        const mb = await mobile.locator(".explorer-map").boundingBox();
        const mx = mb.x + mb.width / 2, my = mb.y + mb.height / 2;
        const held = await settled(mobile);
        const cdp = await phone.newCDPSession(mobile);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mx, y: my }] });
        for (let i = 1; i <= 8; i++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: mx + i * 12, y: my + i * 6 }] });
        }
        check(await inked(mobile) > 0, "one finger points on a phone");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        check(await mapPane(mobile) === held, "pointing with one finger doesn't move the map");
        // Two fingers still pinch: the map's zoom changes
        const zoomBefore = await mobile.evaluate(() => document.querySelector(".leaflet-tile-container") &&
            document.querySelector(".leaflet-tile-container").style.transform);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mx - 20, y: my, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mx - 20, y: my, id: 1 }, { x: mx + 20, y: my, id: 2 }] });
        for (let i = 1; i <= 10; i++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
                touchPoints: [{ x: mx - 20 - i * 10, y: my, id: 1 }, { x: mx + 20 + i * 10, y: my, id: 2 }] });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(800);
        const zoomAfter = await mobile.evaluate(() => document.querySelector(".leaflet-tile-container") &&
            document.querySelector(".leaflet-tile-container").style.transform);
        check(zoomAfter !== zoomBefore || await mapPane(mobile) !== held, "two fingers still pinch the map with the laser on");
        await shot(mobile, "present-phone");
        await phone.close();
    } catch (e) {
        console.log("ERROR " + e.message.split("\n")[0]);
    } finally {
        await browser.close();
        checks.forEach((c) => console.log(c));
        console.log(errors.length ? "errors:\n" + errors.join("\n") : "no console or HTTP errors");
    }
})();

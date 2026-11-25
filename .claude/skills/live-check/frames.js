// Live check of Source Frames, step A, on the signed-in map and 3D pages of a task with camera shots against the dev
// server (http://localhost:8008): a click on the map lists the photos with the spot on them, Open Full Frame steps
// and gives the focus back, a click on the textured model and on the point cloud finds photos with the spot near
// their middle (the scene's coordinates plus WebODM's offset are right), frame times on the 3D page while the
// window loads (headless Chromium on Metal), the Laser Pointer and Source Frames turning each other off, View as
// Visitor showing it unavailable, and a phone (the window as a sheet, no sideways scroll). Creates nothing.
// Usage: node .claude/skills/live-check/frames.js <repo> <screenshot folder> <user> <password> [project id] [task id prefix]
const path = require("path");
const [repo, out, user, password, projectArg, taskArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bestSpot = (page) => page.evaluate(() => {
    const e = document.querySelector(".explorer-sf-main-photo ellipse");
    return e ? [Number(e.getAttribute("cx")), Number(e.getAttribute("cy"))] : null;
});
const nearMiddle = (spot) => spot && Math.abs(spot[0] - 0.5) < 0.25 && Math.abs(spot[1] - 0.5) < 0.25;

async function login(page) {
    await page.goto(BASE + "/login/");
    await page.fill("input[name=username]", user);
    await page.fill("input[name=password]", password);
    await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
}

async function frameTimes(page, ms, act) {
    await page.evaluate((duration) => {
        window.__frames = [];
        window.__long = [];
        try {
            new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration)))
                .observe({ type: "longtask", buffered: false });
        } catch (e) { /* no long task timing */ }
        let last = performance.now();
        const end = last + duration;
        const step = (t) => { window.__frames.push(t - last); last = t; if (t < end) requestAnimationFrame(step); };
        requestAnimationFrame(step);
    }, ms);
    await act();
    await sleep(ms + 200);
    const { frames, long } = await page.evaluate(() => ({ frames: window.__frames, long: window.__long }));
    const sorted = frames.slice(1).sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 0;
    return { n: sorted.length, p50: at(0.5).toFixed(1), p95: at(0.95).toFixed(1), max: at(1).toFixed(1),
        over33: sorted.filter((f) => f > 33.4).length, long: long.map((d) => Math.round(d)) };
}

async function clickAndWait(page, x, y) {
    const t0 = Date.now();
    await page.mouse.click(x, y);
    // Answered: the title counts the photos, or the window says why there are none
    await page.waitForFunction(() => {
        const title = document.querySelector(".explorer-sf-title");
        return (title && /\(\d+\)/.test(title.textContent)) || document.querySelector(".explorer-sf-message.text-danger");
    }, null, { timeout: 20000 }).catch(() => null);
    return Date.now() - t0;
}

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const page = await context.newPage();
        watch(page, "desktop");
        await login(page);
        const tasks = await page.evaluate(async (p) => (await fetch(`/api/projects/${p}/tasks/`)).json(), PROJECT);
        const task = tasks.find((t) => (taskArg ? t.id.startsWith(taskArg) : true) &&
            (t.available_assets || []).includes("shots.geojson") && (t.available_assets || []).includes("orthophoto.tif"));
        if (!task) throw new Error("no task with camera shots and an orthophoto in project " + PROJECT);
        const own = `${BASE}/plugins/explorer/project/${PROJECT}/`;
        console.log("task " + task.id.slice(0, 8));

        // Map
        await page.goto(`${own}map/${task.id}/`);
        await page.waitForSelector(".leaflet-tile-loaded", { timeout: 30000 }).catch(() => null);
        await sleep(1000);
        const box = await page.locator(".explorer-map").boundingBox();
        check(await page.locator("[data-tool=frames]").isVisible(), "the Source Frames button shows on the map page");
        await page.keyboard.press("l");
        await page.keyboard.press("s");
        check(await page.getAttribute("[data-tool=laser]", "aria-pressed") === "false" &&
            await page.getAttribute("[data-tool=frames]", "aria-pressed") === "true", "S turns Source Frames on and the Laser Pointer off");
        check(await page.locator(".explorer-sf-label").isVisible(), "the label says to click");
        const mapTime = await clickAndWait(page, box.x + box.width / 2, box.y + box.height / 2 + 30);
        const mapCount = await page.locator(".explorer-sf-item").count();
        console.log(`map: ${mapCount} photos in ${mapTime} ms`);
        check(mapCount > 0, "a click on the map lists the photos that show the spot");
        check(await page.locator(".explorer-sf-busy").isHidden(), "no spinner once they are listed");
        check(await page.locator(".leaflet-interactive, path.leaflet-interactive, .leaflet-overlay-pane path").count() > 0,
            "the spot is marked on the map");
        await sleep(1000);
        await shot(page, "frames-map");
        await page.click(".explorer-sf-open");
        await page.waitForSelector(".explorer-sf-viewer img");
        await page.keyboard.press("ArrowRight");
        const name = await page.textContent(".explorer-sf-viewer-name");
        check(/^2 \/ /.test(name), "the arrow keys step through the photos in Open Full Frame");
        await sleep(800);
        await shot(page, "frames-full");
        await page.keyboard.press("Escape");
        check(await page.locator(".explorer-sf-viewer").count() === 0 && await page.locator(".explorer-sf-window").isVisible(),
            "Esc closes Open Full Frame only");
        check(await page.evaluate(() => document.activeElement.classList.contains("explorer-sf-open")), "the focus is back on Open Full Frame");
        check(await page.getAttribute(".explorer-sf-item:nth-child(2)", "aria-selected") === "true", "the window shows the photo it ended on");
        await page.keyboard.press("Escape");
        check(await page.locator(".explorer-sf-window").count() === 0 && await page.getAttribute("[data-tool=frames]", "aria-pressed") === "false",
            "Esc again turns Source Frames off");

        // 3D: the textured model, then the point cloud
        for (const kind of ["mesh", "cloud"]) {
            if (!(task.available_assets || []).includes(kind === "mesh" ? "textured_model.glb" : "georeferenced_model.laz")) continue;
            await page.goto(`${own}3d/${task.id}/?t=${kind}`);
            await page.waitForFunction(() => window.ExplorerViewer && window.ExplorerViewer.scene, null, { timeout: 60000 }).catch(() => null);
            await sleep(6000);
            const scene = await page.locator(".explorer-scene").boundingBox();
            await page.keyboard.press("s");
            let time = 0;
            const frames = await frameTimes(page, 2500, async () => { time = await clickAndWait(page, scene.x + scene.width / 2, scene.y + scene.height / 2); });
            const count = await page.locator(".explorer-sf-item").count();
            const spot = await bestSpot(page);
            console.log(`3d ${kind}: ${count} photos in ${time} ms, best spot ${JSON.stringify(spot)}; frames ${JSON.stringify(frames)}`);
            check(count > 0, `a click on the ${kind === "mesh" ? "textured model" : "point cloud"} lists photos`);
            check(nearMiddle(spot), `the best photo shows the ${kind} spot near its middle (the offset is right)`);
            check(frames.long.every((d) => d < 100), `no long task over 100 ms while the ${kind} window loads`);
            await sleep(1000);
            await shot(page, "frames-3d-" + kind);
        }

        // View as Visitor: shown unavailable
        await page.goto(`${own}preview/map/${task.id}/`);
        check(await page.getAttribute("[data-tool=frames]", "aria-disabled") === "true", "View as Visitor shows Source Frames unavailable");
        await context.close();

        // Phone
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await login(mobile);
        await mobile.goto(`${own}map/${task.id}/`);
        await mobile.waitForSelector(".leaflet-tile-loaded", { timeout: 30000 }).catch(() => null);
        await sleep(1000);
        await mobile.tap("[data-tool=frames]");
        const mb = await mobile.locator(".explorer-map").boundingBox();
        await mobile.tap(".explorer-map", { position: { x: mb.width / 2, y: mb.height / 3 } });
        await mobile.waitForSelector(".explorer-sf-item", { timeout: 20000 }).catch(() => null);
        await sleep(1000);
        // Both measured now: the tap may have scrolled the page
        const sheet = await mobile.locator(".explorer-sf-window").boundingBox();
        const mapNow = await mobile.locator(".explorer-map").boundingBox();
        console.log("phone: sheet " + JSON.stringify(sheet) + ", map " + JSON.stringify(mapNow));
        check(sheet && sheet.y + sheet.height <= mapNow.y + mapNow.height + 1 && sheet.width >= mapNow.width - 24, "on a phone the window is a sheet along the bottom");
        const scroll = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(scroll <= 0, "no sideways scroll at phone width (" + scroll + "px)");
        await shot(mobile, "frames-phone");
        await phone.close();
    } catch (e) {
        console.log("ERROR " + e.message.split("\n")[0]);
    } finally {
        await browser.close();
        checks.forEach((c) => console.log(c));
        console.log(errors.length ? "errors:\n" + errors.join("\n") : "no console or HTTP errors");
    }
})();

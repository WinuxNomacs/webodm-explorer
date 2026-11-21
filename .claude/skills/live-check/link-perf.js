// Smoothness of a link's 3D page on the real GPU (headless Chromium on Metal), against the dev server
// (http://localhost:8008). Creates one "Live check" link on the project through the links API and revokes it, also
// on failure.
// Usage: node .claude/skills/live-check/link-perf.js <repo> <user> <password> [project id] [task id prefix] [types]
// types: comma-separated, default "cloud,mesh,splats" (those the task has). For each type, from a fresh page:
// time to the first view, then frame times and long tasks while it streams (load), while orbiting and zooming
// (interact) and while still (idle). Frame times come from requestAnimationFrame; long tasks are main-thread tasks
// over 50 ms (PerformanceObserver). Other heavy processes on the machine skew the numbers: check before running.
const [repo, user, password, projectArg, taskPrefix, typesArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
const PROJECT = Number(projectArg || 1);
const TYPES = (typesArg || "cloud,mesh,splats").split(",");
const masked = (url) => url.replace(/s\/[A-Za-z0-9_-]{43}/, "s/<token>");

// Injected before any page script: records every frame interval and long task, tagged with the current phase
const RECORDER = () => {
    const rec = { phase: "load", frames: { load: [], interact: [], idle: [] }, long: { load: [], interact: [], idle: [] } };
    window.__perf = rec;
    let last = null;
    const tick = (t) => { if (last !== null) rec.frames[rec.phase].push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) rec.long[rec.phase].push(e.duration); })
            .observe({ type: "longtask", buffered: true });
    } catch (e) { rec.noLongTasks = true; }
};

function summary(frames, long) {
    if (!frames.length) return "no frames";
    const s = Float64Array.from(frames).sort();
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
    const over = (ms) => frames.filter((f) => f > ms).length;
    return `${frames.length} frames, p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms, max ${s[s.length - 1].toFixed(0)} ms, ` +
        `>33 ms ${over(33.4)}, >100 ms ${over(100)}; long tasks ${long.length}` +
        (long.length ? ` (max ${Math.max(...long).toFixed(0)} ms, total ${long.reduce((a, b) => a + b, 0).toFixed(0)} ms)` : "");
}

async function interact(page, seconds) {
    const box = await page.$eval(".explorer-scene canvas", (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
    const until = Date.now() + seconds * 1000;
    let step = 0;
    while (Date.now() < until) {
        // Orbit: a slow drag around the centre, then zoom in or out a notch, as a visitor looking around
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 1; i <= 20; i++) await page.mouse.move(cx + Math.sin(i / 20 * Math.PI) * box[2] * 0.25, cy + i * 2, { steps: 2 });
        await page.mouse.up();
        await page.mouse.wheel(0, step % 4 < 2 ? -400 : 400);
        await page.waitForTimeout(150);
        step++;
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
    const admin = await (await browser.newContext()).newPage();
    let token = null;
    const revoke = () => admin.evaluate(async ([pid, tok]) => {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/);
        return (await fetch(`/api/plugins/explorer/projects/${pid}/links/${tok}/`, { method: "DELETE", credentials: "same-origin",
            headers: { "X-CSRFToken": csrf ? csrf[1] : "" } })).status;
    }, [PROJECT, token]);
    try {
        await admin.goto(BASE + "/login/");
        await admin.fill("input[name=username]", user);
        await admin.fill("input[name=password]", password);
        await Promise.all([admin.waitForNavigation(), admin.click("button[type=submit], input[type=submit]")]);
        await admin.goto(`${BASE}/plugins/explorer/project/${PROJECT}/`);
        const link = await admin.evaluate(async (pid) => {
            const csrf = document.querySelector("input[name=csrfmiddlewaretoken]").value;
            const r = await fetch(`/api/plugins/explorer/projects/${pid}/links/`, { method: "POST", credentials: "same-origin",
                headers: { "X-CSRFToken": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ label: "Live check", expires_days: 7 }) });
            return r.json();
        }, PROJECT);
        token = link.token;
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        await context.addInitScript(RECORDER);
        const listing = await context.newPage();
        await listing.goto(BASE + link.path);
        const renderer = await listing.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl && gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "unknown"; });
        console.log("GPU:", renderer);
        for (const type of TYPES) {
            const selector = (taskPrefix ? `.explorer-outputs a[href*="${taskPrefix}"]` : ".explorer-outputs a") + `[href*="t=${type}"]`;
            const href = await listing.$eval(selector, (a) => a.href).catch(() => null);
            if (!href) { console.log(`${type}: not on this task`); continue; }
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
            const t0 = Date.now();
            await page.goto(href);
            await page.waitForFunction(() => document.querySelector(".explorer-status").hidden, null, { timeout: 180000 });
            const first = Date.now() - t0;
            await page.waitForTimeout(6000);
            await page.evaluate(() => { window.__perf.phase = "interact"; });
            await interact(page, 15);
            await page.evaluate(() => { window.__perf.phase = "idle"; });
            await page.waitForTimeout(5000);
            const rec = await page.evaluate(() => window.__perf);
            const stats = await page.evaluate(() => window.ExplorerViewer.scene && window.ExplorerViewer.scene.stats && window.ExplorerViewer.scene.stats());
            console.log(`\n${type} (${masked(href)}): first view ${first} ms${stats ? ", " + JSON.stringify(stats) : ""}`);
            for (const phase of ["load", "interact", "idle"]) console.log(`  ${phase}: ${summary(rec.frames[phase], rec.long[phase])}`);
            if (rec.noLongTasks) console.log("  (long tasks not observable)");
            if (errors.length) console.log("  page errors:", errors.join(" | "));
            await page.close();
        }
    } finally {
        if (token) console.log("\nrevoke", await revoke().catch((e) => "failed: " + e.message));
        await browser.close();
    }
})();

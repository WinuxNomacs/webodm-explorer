// Live check of the mesh tiles on a link's 3D page, against the dev server (http://localhost:8008). The task's tiles
// must be built (open its mesh once and wait: the build's state is in the task's folder,
// app/media/project/<project>/task/<task id>/explorer-tiles/state.json in the web container).
// Creates one "Live check" link on the project through the links API (which queues the project's other builds) and
// revokes it, also on failure.
// Usage: node .claude/skills/live-check/link-tiles.js <repo> <screenshot folder> <user> <password> [project id] [task id prefix]
// Checks: the tiles' first view and tile counts as the camera zooms (window.ExplorerViewer.scene.stats()), phone
// width, tileset.json answering 500 (WebODM's GLB shows instead), a tile answering 500 after the view opened (skipped,
// no message), and a revoke while the tiles are open ("no longer valid" once a tile is refused).
const path = require("path");
const [repo, out, user, password, projectArg, taskPrefix] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = process.env.EXPLORER_BASE || "http://localhost:8008";
const PROJECT = Number(projectArg || 1);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), timeout: 90000 }).catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const masked = (url) => url.replace(/s\/[A-Za-z0-9_-]{43}/, "s/<token>");
const errors = [];
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_CONNECTION_REFUSED")) errors.push(`${label}: ${m.text().slice(0, 200)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 200)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${masked(r.url())}`); });
};
const stats = (page) => page.evaluate(() => window.ExplorerViewer.scene && window.ExplorerViewer.scene.stats());
const status = (page) => page.$eval(".explorer-status", (e) => e.hidden ? "(hidden)" : e.textContent);
const opened = (page) => page.waitForFunction(() => document.querySelector(".explorer-status").hidden
    || document.querySelector(".explorer-status").textContent.indexOf("faster view") >= 0, null, { timeout: 120000 });
const meshUrl = (page) => page.$eval("[data-type=mesh]", (b) => b.getAttribute("data-url"));

async function zoomIn(page, steps) {
    const c = await page.$eval(".explorer-scene canvas", (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await page.mouse.move(c[0], c[1]);
    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(300); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
    const admin = await (await browser.newContext()).newPage();
    watch(admin, "admin");
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

        const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const page = await desktop.newPage();
        watch(page, "visitor");
        await page.goto(BASE + link.path);
        const selector = taskPrefix ? `.explorer-outputs a[href*="${taskPrefix}"][href*="t=mesh"]` : '.explorer-outputs a[href*="t=mesh"]';
        const pageUrl = await page.$eval(selector, (a) => a.href);
        console.log("mesh page:", masked(pageUrl));
        const t0 = Date.now();
        await page.goto(pageUrl);
        const url = await meshUrl(page);
        console.log("mesh url:", masked(url));
        if (!url.endsWith("tileset.json")) {
            await opened(page);
            console.log("no tiles yet: the GLB shows; status", await status(page), "- build queued; run again once built");
            return;
        }
        await opened(page);
        console.log("first view after", Date.now() - t0, "ms");
        await page.waitForTimeout(5000);
        console.log("settled:", JSON.stringify(await stats(page)));
        await shot(page, "tiles-01-desktop");
        await zoomIn(page, 8);
        await page.waitForTimeout(8000);
        console.log("zoomed:", JSON.stringify(await stats(page)), "status", await status(page));
        await shot(page, "tiles-02-zoomed");

        // Phone width
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
            userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await mobile.goto(pageUrl);
        await opened(mobile);
        await mobile.waitForTimeout(5000);
        console.log("phone:", JSON.stringify(await stats(mobile)), "memory", await mobile.evaluate(() => window.ExplorerViewer.tilesMemory),
            "horizontal scroll", await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
        await shot(mobile, "tiles-03-phone");
        await phone.close();

        // The tileset can't load: WebODM's GLB instead
        const broken = await desktop.newPage();
        watch(broken, "no-tileset");
        await broken.route(/\/tiles\/[0-9a-f]{16}\/tileset\.json$/, (route) => route.fulfill({ status: 500, body: "" }));
        await broken.goto(pageUrl);
        await opened(broken);
        console.log("tileset answering 500:", JSON.stringify(await stats(broken)), "status", await status(broken),
            "GLB fetched", await broken.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/textured_model/"))));
        await broken.close();

        // Tiles failing once the view is open: skipped, and no message while the link is valid
        const flaky = await desktop.newPage();
        watch(flaky, "flaky");
        let refused = 0;
        await flaky.route(/\/tiles\/[0-9a-f]{16}\/LOD-0\/.*\.glb$/, (route) => { refused++; return route.fulfill({ status: 500, body: "" }); });
        await flaky.goto(pageUrl);
        await opened(flaky);
        await zoomIn(flaky, 10);
        await flaky.waitForTimeout(8000);
        console.log("finest tiles answering 500:", refused, "requests;", JSON.stringify(await stats(flaky)), "status", await status(flaky));
        await flaky.close();

        // Revoked while the tiles are open: the next refused tile says so
        console.log("revoke:", await revoke());
        token = null;
        await zoomIn(page, 6);
        await page.waitForTimeout(8000);
        console.log("after revoke, status:", await status(page));
        await shot(page, "tiles-04-revoked");
    } finally {
        if (token) console.log("cleanup revoke", await revoke().catch((e) => "failed: " + e.message));
        await browser.close();
        console.log("errors:\n" + errors.join("\n"));
    }
})();

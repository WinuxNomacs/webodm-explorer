// Live check of the streamed EPT point cloud on a link's 3D page, against the dev server (http://localhost:8008).
// Creates one "Live check" link on the project through the links API and revokes it, also on failure.
// Usage: node .claude/skills/live-check/link-cloud.js <repo> <screenshot folder> <user> <password> [project id] [task id prefix]
// Checks: first view and node counts as the camera zooms (window.ExplorerViewer.scene.stats()), switching to another
// type and back, phone width, a node answering 500 (skipped, no message), laz-perf's wasm failing to load (the error
// message), and a revoke while the cloud is open ("no longer valid" once a node is refused).
const path = require("path");
const [repo, out, user, password, projectArg, taskPrefix] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
const PROJECT = Number(projectArg || 1);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), timeout: 90000 }).catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const masked = (url) => url.replace(/s\/[A-Za-z0-9_-]{43}/, "s/<token>");
const errors = [];
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error" || (m.type() === "warning" && !m.text().includes("GPU stall"))) errors.push(`${label}: ${m.text().slice(0, 200)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 200)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${masked(r.url())}`); });
};
const stats = (page) => page.evaluate(() => window.ExplorerViewer.scene && window.ExplorerViewer.scene.stats());
const status = (page) => page.$eval(".explorer-status", (e) => e.hidden ? "(hidden)" : e.textContent);
const opened = (page) => page.waitForFunction(() => document.querySelector(".explorer-status").hidden, null, { timeout: 120000 });

async function zoomIn(page, steps) {
    const c = await page.$eval(".explorer-scene canvas", (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await page.mouse.move(c[0], c[1]);
    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(300); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
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
        const selector = taskPrefix ? `.explorer-outputs a[href*="${taskPrefix}"][href*="t=cloud"]` : '.explorer-outputs a[href*="t=cloud"]';
        const cloudUrl = await page.$eval(selector, (a) => a.href);
        console.log("cloud page:", masked(cloudUrl));
        const t0 = Date.now();
        await page.goto(cloudUrl);
        await opened(page);
        console.log("first view after", Date.now() - t0, "ms");
        await page.waitForTimeout(8000);
        console.log("settled:", JSON.stringify(await stats(page)));
        await shot(page, "cloud-01-desktop");
        await zoomIn(page, 8);
        await page.waitForTimeout(15000);
        console.log("zoomed:", JSON.stringify(await stats(page)), "status", await status(page));
        await shot(page, "cloud-02-zoomed");

        // Another type and back
        const other = await page.$("[data-type=mesh], [data-type=splats]");
        if (other) {
            await other.click();
            await opened(page).catch(() => console.log("other type: status still showing"));
            await page.waitForTimeout(3000);
            await page.click("[data-type=cloud]");
            await page.waitForTimeout(3000);
            console.log("back to the cloud:", JSON.stringify(await stats(page)), "status", await status(page));
            await shot(page, "cloud-03-back");
        }

        // Phone width
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
            userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await mobile.goto(cloudUrl);
        await opened(mobile);
        await mobile.waitForTimeout(8000);
        console.log("phone:", JSON.stringify(await stats(mobile)), "budget", await mobile.evaluate(() => window.ExplorerViewer.pointBudget),
            "horizontal scroll", await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
        await shot(mobile, "cloud-04-phone");
        await phone.close();

        // A node that fails: skipped, and no message while the link is valid
        const flaky = await desktop.newPage();
        watch(flaky, "flaky");
        let refused = 0;
        await flaky.route(/ept-data\/[1-9][0-9-]*\.laz$/, (route) => { refused++; return route.fulfill({ status: 500, body: "" }); });
        await flaky.goto(cloudUrl);
        await opened(flaky);
        await zoomIn(flaky, 4);
        await flaky.waitForTimeout(8000);
        console.log("nodes answering 500:", refused, "requests;", JSON.stringify(await stats(flaky)), "status", await status(flaky));
        await flaky.close();

        // laz-perf's wasm doesn't load: the page's error message
        const nowasm = await desktop.newPage();
        watch(nowasm, "no-wasm");
        await nowasm.route(/laz-perf\.wasm$/, (route) => route.fulfill({ status: 404, body: "" }));
        await nowasm.goto(cloudUrl);
        await nowasm.waitForFunction(() => !document.querySelector(".explorer-status").hidden
            && !document.querySelector(".explorer-status").textContent.startsWith("Loading"), null, { timeout: 60000 })
            .catch(() => console.log("no-wasm: still loading after 60 s"));
        console.log("wasm missing, status:", await status(nowasm));
        await nowasm.close();

        // Revoked while the cloud is open: the next node refused says so
        console.log("revoke:", await revoke());
        token = null;
        await zoomIn(page, 6);
        await page.waitForTimeout(8000);
        console.log("after revoke, status:", await status(page));
        await shot(page, "cloud-05-revoked");
    } finally {
        if (token) console.log("cleanup revoke", await revoke().catch((e) => "failed: " + e.message));
        await browser.close();
        console.log("errors:\n" + errors.join("\n"));
    }
})();

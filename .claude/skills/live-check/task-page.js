// Live check of the task page against the dev server (http://localhost:8008): a card's title opens it from the
// project page; the signed-in page (views, Open in WebODM, Download, footprint map, processing details, report,
// Previous / Next) at desktop and phone widths; View as Visitor; and through a link as a visitor, without the node,
// the report or WebODM's pages. Creates one "Live check" link and revokes it, also on failure.
// Usage: node .claude/skills/live-check/task-page.js <repo> <screenshot folder> <user> <password> [project id]
const path = require("path");
const [repo, out, user, password, projectArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = process.env.EXPLORER_BASE || "http://localhost:8008";
const PROJECT = Number(projectArg || 2);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), fullPage: true, timeout: 90000 })
    .catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const masked = (url) => url.replace(/[A-Za-z0-9_-]{43}/, "<token>");
const errors = [];
const checks = [];
const check = (ok, what) => { checks.push((ok ? "ok   " : "FAIL ") + what); };
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error" && !/35729|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${label}: ${m.text().slice(0, 160)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${masked(r.url())}`); });
};

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    watch(page, "admin");
    let token = null;
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", user);
        await page.fill("input[name=password]", password);
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);

        // From the project page: a card's title opens the task page
        await page.goto(`${BASE}/plugins/explorer/project/${PROJECT}/`);
        const title = page.locator(".explorer-card-title.explorer-title-link").first();
        const href = await title.getAttribute("href");
        check(/\/task\/[0-9a-f-]{36}\/$/.test(href), "a card's title points at its task page");
        await Promise.all([page.waitForNavigation(), title.click()]);
        await page.waitForTimeout(2500); // the footprint map's tiles and the thumbnail
        check(await page.locator(".explorer-task-page .explorer-cover-title").count() === 1, "the task page shows the task");
        check(await page.locator(".explorer-task-page .explorer-outputs a.btn").count() >= 1, "it offers the task's views");
        check(await page.locator("button:has-text('Open in WebODM')").count() === 1, "it offers Open in WebODM");
        check(await page.locator("button:has-text('Download')").count() === 1, "it offers Download");
        check(await page.locator(".explorer-footprint-map.leaflet-container").count() === 1, "the footprint map is drawn");
        // Shown only when WebODM still records the task's node (it is cleared when a node is removed)
        console.log("processing node shown: " + await page.locator("dt:has-text('Processing Node')").count());
        const report = await page.locator("a:has-text('Processing Report')").count();
        console.log("report button: " + report);
        console.log("options rows: " + await page.locator(".explorer-options tr").count());
        await shot(page, "task-signed-in");
        const next = page.locator(".explorer-neighbours a[rel=next]");
        if (await next.count()) {
            const nextHref = await next.getAttribute("href");
            check(/\/task\/[0-9a-f-]{36}\/$/.test(nextHref), "Next goes to the next task's page");
        }
        const taskPath = new URL(page.url()).pathname;
        const taskId = taskPath.match(/task\/([0-9a-f-]{36})\//)[1];

        // A view from the task page opens and comes back
        await page.locator(".explorer-task-page .explorer-outputs a.btn").first().click();
        await page.waitForLoadState("domcontentloaded");
        check(/\/(map|3d)\//.test(page.url()), "a view button opens the view");

        // Phone width
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(BASE + taskPath);
        await page.waitForTimeout(1500);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(scroll <= 0, "no sideways scroll at phone width (" + scroll + "px)");
        await shot(page, "task-phone");
        await page.setViewportSize({ width: 1280, height: 860 });

        // View as Visitor
        await page.goto(`${BASE}/plugins/explorer/project/${PROJECT}/preview/task/${taskId}/`);
        check(await page.locator(".explorer-preview-bar").count() === 1, "View as Visitor shows its bar");
        check(await page.locator("dt:has-text('Processing Node')").count() === 0, "View as Visitor hides the node");

        // Through a link, as a visitor
        const csrf = (await context.cookies()).find((c) => c.name === "csrftoken").value;
        const made = await page.evaluate(async ({ pid, csrf }) => (await fetch(`/api/plugins/explorer/projects/${pid}/links/`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
            body: JSON.stringify({ label: "Live check", expires_days: 7 }) })).json(), { pid: PROJECT, csrf });
        token = made.token;
        const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const visitor = await visitorContext.newPage();
        watch(visitor, "visitor");
        await visitor.goto(`${BASE}/plugins/explorer/s/${token}/`);
        const cover = await visitor.locator(".explorer-cover-picture").getAttribute("href");
        check(cover.includes("/task/"), "the link page's cover opens the task page");
        await visitor.goto(`${BASE}/plugins/explorer/s/${token}/task/${taskId}/`);
        await visitor.waitForTimeout(2000);
        check(await visitor.locator(".explorer-cover-title").count() === 1, "the link's task page opens for a visitor");
        check(await visitor.locator("dt:has-text('Processing Node')").count() === 0, "a link hides the node");
        check(await visitor.locator("a:has-text('Processing Report'), button:has-text('Open in WebODM'), button:has-text('Download')").count() === 0,
            "a link without downloads offers no report, WebODM pages or downloads");
        await shot(visitor, "task-link");
        await visitorContext.close();
    } catch (e) {
        console.log("ERROR " + e.message.split("\n")[0]);
    } finally {
        if (token) {
            const status = await page.evaluate(async ({ pid, t }) => {
                const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
                return (await fetch(`/api/plugins/explorer/projects/${pid}/links/${t}/`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf } })).status;
            }, { pid: PROJECT, t: token }).catch((e) => "failed: " + e.message);
            console.log("revoked the Live check link: " + status);
        }
        await browser.close();
        checks.forEach((c) => console.log(c));
        console.log(errors.length ? "errors:\n" + errors.join("\n") : "no console or HTTP errors");
    }
})();

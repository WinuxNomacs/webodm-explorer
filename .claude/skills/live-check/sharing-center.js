// Live check of the Sharing Center against the dev server (http://localhost:8008): the Explorer menu's drop-down, the
// page at desktop and phone widths, Create Link for a project, Edit (label and expiry), Embed, an expired link's Renew
// (the link made to expire through the dev container's shell) and the Share panel's Edit and Sharing Center link.
// Creates one link labelled "Live check" and revokes it, also on failure.
// Usage: node .claude/skills/live-check/sharing-center.js <repo> <screenshot folder> <user> <password> [project id]
const path = require("path");
const { execFileSync } = require("child_process");
const [repo, out, user, password, projectArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const WEBAPP = process.env.EXPLORER_WEBAPP || "ex-webapp";
const BASE = process.env.EXPLORER_BASE || "http://localhost:8008";
const PROJECT = Number(projectArg || 2);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), fullPage: true, timeout: 90000 })
    .catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const masked = (url) => url.replace(/[A-Za-z0-9_-]{43}/, "<token>");
const errors = [];
const checks = [];
const check = (ok, what) => { checks.push((ok ? "ok   " : "FAIL ") + what); };
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("35729")) errors.push(`${label}: ${m.text().slice(0, 160)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${masked(r.url())}`); });
};

// Moves the link's expiry to yesterday, as if it had expired (the token passed in the environment, never printed)
function expire(token) {
    const code = "import os\nfrom datetime import timedelta\nfrom django.utils import timezone\n" +
        "from coreplugins.explorer import links\n" +
        `with links._locked():\n    saved = links._read(${PROJECT})\n    for link in saved:\n` +
        "        if link['token'] == os.environ['T']:\n" +
        "            link['expires'] = (timezone.now() - timedelta(days=1)).isoformat()\n" +
        `    links.store().set_json(links.links_key(${PROJECT}), saved)\n`;
    execFileSync("docker", ["exec", "-e", "T=" + token, "-w", "/webodm", WEBAPP, "python", "manage.py", "shell", "-c", code],
        { stdio: ["ignore", "ignore", "inherit"] });
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    watch(page, "admin");
    const created = [];
    const allLinks = () => page.evaluate(async () => (await fetch("/api/plugins/explorer/links/", { credentials: "same-origin" })).json());
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", user);
        await page.fill("input[name=password]", password);
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
        const before = (await allLinks()).map((l) => l.token);
        console.log("links before: " + before.length);

        // The menu: Explorer opens a drop-down with Projects and Sharing Center
        await page.goto(BASE + "/dashboard/");
        await page.click("#side-menu a:has-text('Explorer'):not(:has-text('Settings'))");
        await page.waitForTimeout(500);
        check(await page.locator("#side-menu a[href='/plugins/explorer/sharing/']").isVisible(), "menu drop-down shows Sharing Center");
        check(await page.locator("#side-menu a[href='/plugins/explorer/']").isVisible(), "menu drop-down shows Projects");
        await page.screenshot({ path: path.join(out, "menu.png"), clip: { x: 0, y: 0, width: 400, height: 600 } });
        await page.click("#side-menu a[href='/plugins/explorer/sharing/']");
        await page.waitForSelector(".explorer-sharing-filters");
        await page.waitForTimeout(800);
        check(await page.locator("#side-menu a.active[href='/plugins/explorer/sharing/']").count() === 1, "menu marks the Sharing Center active");
        const shown = await page.locator("tr.explorer-sharing-row").count();
        console.log("rows shown (active): " + shown);
        await shot(page, "center-desktop");

        // Create Link
        await page.click("[data-sharing-create]");
        await page.selectOption(".explorer-sharing-create select[name=project]", String(PROJECT));
        await page.fill(".explorer-sharing-create input[name=label]", "Live check");
        await page.selectOption(".explorer-sharing-create select[name=expires_days]", "30");
        await page.click(".explorer-sharing-create [type=submit]");
        await page.waitForFunction((n) => document.querySelectorAll("tr.explorer-sharing-row").length > n, shown);
        const token = (await allLinks()).map((l) => l.token).find((t) => !before.includes(t));
        if (token) created.push(token);
        check(!!token, "Create Link made a link");
        const row = page.locator(`tr.explorer-sharing-row[data-token="${token}"]`);
        check(await row.locator(".explorer-card-title").textContent() === "Live check", "the new row shows its label");
        check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("explorer-link-address")),
            "the new link's address is focused, ready to copy");
        check((await row.textContent()).includes("by " + user), "the row names who made it");

        // Edit: label and a 7-day expiry, which marks it Expires Soon
        await row.locator("button:has-text('Edit')").click();
        const editForm = page.locator(`tr.explorer-sharing-row[data-token="${token}"] + tr .explorer-link-edit`);
        await editForm.locator("input[name=label]").fill("Live check edited");
        await editForm.locator("select").selectOption("7");
        await shot(page, "center-edit");
        await editForm.locator("[type=submit]").click();
        await page.waitForFunction((t) => {
            const r = document.querySelector(`tr.explorer-sharing-row[data-token="${t}"]`);
            return r && r.textContent.includes("Live check edited");
        }, token);
        check((await row.textContent()).includes("Expires Soon"), "a 7-day expiry shows Expires Soon");

        // Embed
        await row.locator("button:has-text('Embed')").click();
        const code = await page.locator(`tr.explorer-sharing-row[data-token="${token}"] + tr textarea`).inputValue();
        check(code.startsWith("<iframe") && code.includes("embed=1"), "Embed gives iframe code");
        const views = await page.locator(`tr.explorer-sharing-row[data-token="${token}"] + tr select option`).count();
        console.log("embed choices: " + views);
        await shot(page, "center-embed");

        // Filters: the search goes into the address
        await page.fill(".explorer-sharing-filters input[name=q]", "Live check edited");
        await page.waitForTimeout(200);
        check((await page.locator("tr.explorer-sharing-row").count()) === 1, "the search narrows to the edited link");
        check(page.url().includes("q=Live%20check%20edited"), "the search is in the address");

        // Expired: Renew brings the same URL back
        expire(token);
        await page.goto(BASE + "/plugins/explorer/sharing/?status=expired&q=Live%20check");
        await page.waitForSelector(`tr.explorer-sharing-row[data-token="${token}"]`);
        const expiredRow = page.locator(`tr.explorer-sharing-row[data-token="${token}"]`);
        const buttons = await expiredRow.locator("button, a.btn").allTextContents();
        check(JSON.stringify(buttons.map((b) => b.trim())) === JSON.stringify(["Renew", "Delete"]), "an expired row offers Renew and Delete: " + buttons.join(", "));
        const visitor = await browser.newContext();
        const status = async () => (await visitor.request.get(`${BASE}/plugins/explorer/s/${token}/`)).status();
        check(await status() === 404, "the expired link opens nothing");
        await shot(page, "center-expired");
        await expiredRow.locator("button:has-text('Renew')").click();
        await page.locator(`tr.explorer-sharing-row[data-token="${token}"] + tr .explorer-link-edit [type=submit]`).click();
        await page.waitForFunction((t) => !document.querySelector(`tr.explorer-sharing-row[data-token="${t}"]`), token);
        check(await status() === 200, "after Renew, the same URL opens again");
        await visitor.close();

        // Phone width
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(BASE + "/plugins/explorer/sharing/?q=Live%20check");
        await page.waitForSelector(`tr.explorer-sharing-row[data-token="${token}"]`);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(scroll <= 0, "no sideways scroll at phone width (" + scroll + "px)");
        await shot(page, "center-phone");
        await page.setViewportSize({ width: 1280, height: 860 });

        // The Share panel: Edit and the link to the Sharing Center
        await page.goto(`${BASE}/plugins/explorer/project/${PROJECT}/#share`);
        await page.waitForSelector(`.explorer-link[data-token="${token}"]`);
        check(await page.locator(`.explorer-link[data-token="${token}"] button:has-text('Edit')`).count() === 1, "the Share panel offers Edit");
        check(await page.locator(`a.explorer-sharing-center-link[href="/plugins/explorer/sharing/?project=${PROJECT}&status=all"]`).count() === 1,
            "the Share panel links to the project's links in the Sharing Center");
        await page.locator(`.explorer-link[data-token="${token}"]`).scrollIntoViewIfNeeded();
        await shot(page, "share-panel");
    } catch (e) {
        console.log("ERROR " + e.message.split("\n")[0]);
    } finally {
        for (const token of created) {
            const code = await page.evaluate(async ({ pid, t }) => {
                const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
                return (await fetch(`/api/plugins/explorer/projects/${pid}/links/${t}/`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf } })).status;
            }, { pid: PROJECT, t: token }).catch((e) => "failed: " + e.message);
            console.log("revoked the Live check link: " + code);
        }
        const after = await allLinks().catch(() => null);
        if (after) console.log("links after: " + after.length);
        await browser.close();
        checks.forEach((c) => console.log(c));
        console.log(errors.length ? "errors:\n" + errors.join("\n") : "no console or HTTP errors");
    }
})();

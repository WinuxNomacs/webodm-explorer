// Live check of the home's List view against the dev server (http://localhost:8008): the folder pane by name with the
// first project selected, choosing another without reloading the page, Up and Down, a task row opening the task page
// and Back returning to it, the remembered view, and the phone layout with Back to Projects. Choosing a view saves
// it for the user: the view the user had before is put back at the end, also on failure. Creates nothing else.
// Usage: node .claude/skills/live-check/list-view.js <repo> <screenshot folder> <user> <password>
const path = require("path");
const [repo, out, user, password] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
const HOME = BASE + "/plugins/explorer/";
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), fullPage: true, timeout: 90000 })
    .catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const errors = [];
const checks = [];
const check = (ok, what) => { checks.push((ok ? "ok   " : "FAIL ") + what); };
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error" && !/35729|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${label}: ${m.text().slice(0, 160)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${r.url()}`); });
};
const activeView = (page) => page.evaluate(() => {
    const active = document.querySelector(".explorer-view-switch .active i");
    return active ? ({ "fa fa-th-large": "grid", "fa fa-list": "list", "fa fa-map": "map" })[active.className] : null;
});
const paneProject = (page) => page.getAttribute("[data-pane-project]", "data-pane-project");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    watch(page, "admin");
    let before = null;
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", user);
        await page.fill("input[name=password]", password);
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
        await page.goto(HOME);
        before = await activeView(page);
        console.log("saved view before: " + before);

        await page.goto(HOME + "?view=list");
        await page.waitForTimeout(1500);
        const names = await page.locator(".explorer-folder-name").allTextContents();
        console.log("projects listed: " + names.length);
        const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        check(JSON.stringify(names) === JSON.stringify(sorted), "the folder pane is by name");
        const items = page.locator(".explorer-folder-item");
        check(await items.first().getAttribute("aria-current") === "true", "the first project is selected");
        check(await paneProject(page) === await items.first().getAttribute("data-project"), "the pane shows the first project");
        check(await page.locator("select[name=sort]").count() === 0, "no Sort in List view");
        await shot(page, "list-desktop");

        if (names.length > 1) {
            // Choosing another project: no reload (a marker on window survives), the address and pane follow
            await page.evaluate(() => { window.explorerMarker = 1; });
            const second = items.nth(1);
            const id = await second.getAttribute("data-project");
            await second.click();
            await page.waitForFunction((pid) => {
                const p = document.querySelector("[data-pane-project]");
                return p && p.getAttribute("data-pane-project") === pid && !document.querySelector("[aria-busy]");
            }, id);
            check(await page.evaluate(() => window.explorerMarker === 1), "choosing a project doesn't reload the page");
            check(page.url().includes("project=" + id), "the address names the chosen project");
            await shot(page, "list-second");
            await second.press("ArrowUp");
            const firstId = await items.first().getAttribute("data-project");
            await page.waitForFunction((pid) => {
                const p = document.querySelector("[data-pane-project]");
                return p && p.getAttribute("data-pane-project") === pid;
            }, firstId);
            check(true, "Up moves to the project above and loads it");
            // Up replaced the history entry; a click adds one, and Back returns to the project before it
            await second.click();
            await page.waitForFunction((pid) => {
                const p = document.querySelector("[data-pane-project]");
                return p && p.getAttribute("data-pane-project") === pid;
            }, id);
            await page.goBack();
            await page.waitForFunction((pid) => {
                const p = document.querySelector("[data-pane-project]");
                return p && p.getAttribute("data-pane-project") === pid && !document.querySelector("[aria-busy]");
            }, firstId, { timeout: 5000 }).catch(() => null);
            check(await paneProject(page) === firstId, "the browser's Back returns to the previous project");
        }

        // A task row opens the task page; Back returns to the list
        const row = page.locator(".explorer-task-row .explorer-title-link").first();
        if (await row.count()) {
            const listUrl = page.url();
            await Promise.all([page.waitForNavigation(), row.click()]);
            check(/\/task\/[0-9a-f-]{36}\/$/.test(new URL(page.url()).pathname), "a task row opens its task page");
            await page.goBack();
            await page.waitForSelector("[data-explorer-list]");
            check(page.url() === listUrl, "Back returns to the List view");
        }

        // Remembered: the home without a view opens List
        await page.goto(HOME);
        check(await activeView(page) === "list", "the home opens in the view last chosen");

        // Phone: the folder pane alone, then the chosen project with Back to Projects
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(HOME + "?view=list");
        await page.waitForTimeout(800);
        check(await page.locator(".explorer-folder").isVisible() && !(await page.locator(".explorer-pane").isVisible()),
            "on a phone the folder pane comes first");
        await shot(page, "list-phone-folder");
        await items.first().click();
        await page.waitForTimeout(800);
        check(await page.locator(".explorer-pane").isVisible() && !(await page.locator(".explorer-folder").isVisible()),
            "choosing a project on a phone shows its pane");
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(scroll <= 0, "no sideways scroll at phone width (" + scroll + "px)");
        await shot(page, "list-phone-pane");
        await page.click(".explorer-pane-back");
        check(await page.locator(".explorer-folder").isVisible(), "Back to Projects shows the folder pane");
    } catch (e) {
        console.log("ERROR " + e.message.split("\n")[0]);
    } finally {
        if (before) {
            await page.goto(HOME + "?view=" + before).catch(() => null);
            await page.goto(HOME).catch(() => null);
            console.log("saved view after: " + await activeView(page).catch(() => "unknown"));
        }
        await browser.close();
        checks.forEach((c) => console.log(c));
        console.log(errors.length ? "errors:\n" + errors.join("\n") : "no console or HTTP errors");
    }
})();

// Live check of the home's Search Projects & Tasks against the dev server (http://localhost:8008), on the user's own
// projects (read-only). Grid: one letter filters nothing, two filter in place after a pause (timed), the address
// follows, the box keeps the focus; emptying shows everything; one letter and Enter filters. List view: a search opens
// on Search Results (every project's matching tasks), a project's heading opens its narrowed pane, Show All Tasks,
// Back to Search Results and the browser's Back. Map view: a search redraws the map, or says nothing
// matches. Phone width. The home's view is saved per user when an address names one: the view the user had is put
// back at the end, also on failure.
// Usage: node .claude/skills/live-check/search.js <repo> <screenshot folder> <user> <password> [task word] [no-match word] [word in several projects' tasks]
const path = require("path");
const [repo, out, user, password, wordArg, noneArg, sharedArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
const HOME = BASE + "/plugins/explorer/";
const WORD = wordArg || "homerun";  // part of one task's name, not of its project's name
const NONE = noneArg || "zzqq";
const SHARED = sharedArg || "ro";  // part of task names in more than one project
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png") }).catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const errors = [];
let passed = 0, failed = 0;
const check = (name, ok, detail) => {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
};

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_CONNECTION_REFUSED")) errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 160)));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${r.status()} ${r.url()}`); });
    const searches = [];  // the home pages the live search asked for
    page.on("request", (r) => { if (r.url().startsWith(HOME + "?") || r.url() === HOME) searches.push({ url: r.url(), at: Date.now() }); });
    let savedView = null;
    const cards = () => page.$$eval("[data-explorer-results] .explorer-card-title", (els) => els.map((e) => e.textContent.trim()));
    const settle = async (n) => { await page.waitForFunction((count) => !document.querySelector("[data-explorer-results][aria-busy]"), n, { timeout: 15000 }); await page.waitForTimeout(150); };
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", user);
        await page.fill("input[name=password]", password);
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
        await page.goto(HOME);
        savedView = await page.$eval('input[name=view]', (i) => i.value);
        console.log("the user's view:", savedView);

        await page.goto(HOME + "?view=grid");
        const all = await cards();
        check("placeholder", await page.getAttribute("input[name=q]", "placeholder") === "Search Projects & Tasks");
        searches.length = 0;
        await page.click("input[name=q]");
        await page.keyboard.type(WORD[0]);
        await page.waitForTimeout(900);
        check("one letter asks nothing", searches.length === 0, searches.length);
        const typedAt = Date.now();
        await page.keyboard.type(WORD.slice(1, 3), { delay: 60 });
        await page.waitForFunction((n) => document.querySelectorAll("[data-explorer-results] .explorer-card-title").length !== n || location.search.includes("q="), all.length, { timeout: 15000 });
        await settle();
        const swappedIn = Date.now() - typedAt;
        check("two letters filter in place", searches.length === 1 && page.url().includes("q=" + WORD.slice(0, 3)), `${searches.length} request(s), ${swappedIn} ms from the first of the two keys to the swap`);
        check("the box keeps the focus", await page.evaluate(() => document.activeElement && document.activeElement.name === "q"));
        await page.keyboard.type(WORD.slice(3), { delay: 40 });
        await page.waitForTimeout(400);
        await settle();
        const found = await cards();
        const matches = await page.$$eval(".explorer-matches", (els) => els.map((e) => e.textContent.trim()));
        check("the task's project is found and the card names the task", found.length >= 1 && matches.some((m) => m.toLowerCase().includes(WORD)), `${JSON.stringify(found)} ${JSON.stringify(matches)}`);
        await shot(page, "01-grid-search");

        await page.fill("input[name=q]", "");
        await page.dispatchEvent("input[name=q]", "input");
        await page.waitForTimeout(400);
        await settle();
        check("emptying shows everything", JSON.stringify(await cards()) === JSON.stringify(all) && !page.url().includes("q="), (await cards()).length + " of " + all.length);

        searches.length = 0;
        await page.fill("input[name=q]", NONE[0]);
        await page.press("input[name=q]", "Enter");
        await page.waitForTimeout(300);
        await settle();
        check("one letter and Enter filters without a reload", searches.length === 1 && page.url().includes("q=" + NONE[0]) && await page.evaluate(() => document.activeElement && document.activeElement.name === "q"), searches.length);

        // List view: a search opens on Search Results, every project's matching tasks under it
        await page.goto(HOME + "?view=list");
        await page.click("input[name=q]");
        await page.keyboard.type(SHARED, { delay: 40 });
        await page.waitForTimeout(500);
        await settle();
        const groups = await page.$$eval(".explorer-results-group", (els) => els.map((g) => ({ project: g.querySelector("[data-pane-open]").textContent.trim(), tasks: g.querySelectorAll(".explorer-task-row").length })));
        const subItems = await page.$$eval(".explorer-folder-tasks a", (els) => els.length);
        check("List view opens on Search Results with each project's tasks", groups.length >= 1 && await page.$eval(".explorer-folder-results", (e) => e.classList.contains("active")), JSON.stringify(groups) + `, ${subItems} task(s) in the folder pane`);
        await shot(page, "02-list-results");
        const target = groups.find((g) => g.tasks > 0) || groups[0];
        await page.locator(".explorer-results-group [data-pane-open]", { hasText: target.project }).first().click();
        await page.waitForSelector("[data-pane-results]", { timeout: 15000 });
        const note = await page.$eval(".explorer-pane-matched", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
        const rows = await page.$$eval(".explorer-task-row", (els) => els.length);
        check("a project's heading opens its pane in place, narrowed", page.url().includes("project=") && rows >= 1, `${note || "(the project itself matches)"} (${rows} rows)`);
        await shot(page, "03-list-project");
        if (await page.$("[data-pane-all]")) {
            await page.click("[data-pane-all]");
            await page.waitForFunction((n) => document.querySelectorAll(".explorer-task-row").length > n && !document.querySelector(".explorer-pane-matched"), rows, { timeout: 15000 });
            check("Show All Tasks brings every task", true, (await page.$$eval(".explorer-task-row", (els) => els.length)) + " rows");
        }
        await page.click("[data-pane-results]");
        await page.waitForSelector(".explorer-results-group", { timeout: 15000 });
        check("Back to Search Results", !page.url().includes("project=") && (await page.$$(".explorer-results-group")).length === groups.length);
        await page.goBack();
        await page.waitForSelector("[data-pane-results]", { timeout: 15000 });
        check("the browser's Back returns to the project", page.url().includes("project="));

        // Map view
        await page.goto(HOME + "?view=map");
        await page.waitForTimeout(1500);
        await page.fill("input[name=q]", WORD);
        await page.dispatchEvent("input[name=q]", "input");
        await page.waitForTimeout(500);
        await settle();
        await page.waitForTimeout(1500);
        const map = await page.evaluate(() => ({ leaflet: !!document.querySelector("[data-explorer-results] .leaflet-container"), places: JSON.parse((document.getElementById("explorer-footprints") || {}).textContent || "[]").length }));
        check("Map view redraws for the search", map.leaflet && map.places >= 1, JSON.stringify(map));
        await shot(page, "04-map-search");
        await page.fill("input[name=q]", NONE);
        await page.dispatchEvent("input[name=q]", "input");
        await page.waitForTimeout(500);
        await settle();
        check("Map view says when nothing matches", await page.$eval("[data-explorer-results]", (e) => e.textContent.includes("No projects match")));

        // Phone
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(HOME + "?view=grid");
        await page.fill("input[name=q]", WORD);
        await page.dispatchEvent("input[name=q]", "input");
        await page.waitForTimeout(500);
        await settle();
        check("phone: no horizontal scroll", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
        await shot(page, "05-phone-search");
    } catch (e) {
        failed++;
        console.log("FAIL exception: " + e.message.split("\n")[0]);
    } finally {
        if (savedView) {
            await page.goto(HOME + "?view=" + savedView).catch(() => {});
            console.log("the user's view put back:", await page.$eval('input[name=view]', (i) => i.value).catch(() => "unknown"));
        }
        await browser.close();
        console.log(`${passed} passed, ${failed} failed`);
        console.log("errors:\n" + errors.join("\n"));
    }
})();

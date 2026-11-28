// Live check of Allow All Task Files against the dev server (http://localhost:8008), on the user's project 1 (task
// 358acbe0 by default). Creates one link labelled "Live check files" through the Share panel (Allow Downloads and
// Allow All Task Files), checks the greyed-out box, the visitor's menus and Processing Report, downloads the small
// cameras.json, asks for All Assets and stops reading after its headers, turns the option off (404), looks at the
// Sharing Center, at desktop and phone widths, and revokes the link, also on failure. Tokens are masked in the output.
// Usage: node .claude/skills/live-check/all-files.js <repo> <screenshot folder> <user> <password> [project id] [task id prefix]
const path = require("path");
const [repo, out, user, password, projectArg, taskArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = process.env.EXPLORER_BASE || "http://localhost:8008";
const PROJECT = Number(projectArg || 1);
const TASK = taskArg || "358acbe0";
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), timeout: 90000 }).catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const masked = (text) => String(text).replace(/[A-Za-z0-9_-]{43}/g, "<token>");
const errors = [];
const refusalsExpected = []; // URLs whose 404 the check asks for
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label}: ${masked(m.text().slice(0, 160))}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${masked(e.message.slice(0, 160))}`));
    page.on("response", (r) => {
        if (r.status() >= 400 && !r.url().includes("35729") && !refusalsExpected.includes(r.url())) errors.push(`${label}: ${r.status()} ${masked(r.url())}`);
    });
};
let passed = 0, failed = 0;
const check = (name, ok, detail) => {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + masked(detail)}`);
};

(async () => {
    const browser = await chromium.launch({ headless: true });
    const signedIn = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const admin = await signedIn.newPage();
    watch(admin, "admin");
    let token = null;
    const apiLink = async () => (await admin.evaluate(async (pid) => (await fetch(`/api/plugins/explorer/projects/${pid}/links/`, { credentials: "same-origin" })).json(), PROJECT)).find((l) => l.token === token);
    try {
        await admin.goto(BASE + "/login/");
        await admin.fill("input[name=username]", user);
        await admin.fill("input[name=password]", password);
        await Promise.all([admin.waitForNavigation(), admin.click("button[type=submit], input[type=submit]")]);
        await admin.goto(`${BASE}/plugins/explorer/project/${PROJECT}/`);
        await admin.click("[data-explorer-share]");
        await admin.waitForTimeout(500);

        // The create form: Allow All Task Files only with Allow Downloads
        const form = ".explorer-link-form";
        check("form box greyed out without Allow Downloads", await admin.isDisabled(`${form} input[name=all_files]`));
        await admin.check(`${form} input[name=downloads]`);
        check("form box usable with Allow Downloads", await admin.isEnabled(`${form} input[name=all_files]`));
        await admin.check(`${form} input[name=all_files]`);
        await admin.fill(`${form} input[name=label]`, "Live check files");
        await admin.selectOption(`${form} select`, "7");
        const before = await admin.locator(".explorer-link").count();
        await admin.click(`${form} [type=submit]`);
        await admin.waitForFunction((n) => document.querySelectorAll(".explorer-link").length > n, before);
        const links = await admin.evaluate(async (pid) => (await fetch(`/api/plugins/explorer/projects/${pid}/links/`, { credentials: "same-origin" })).json(), PROJECT);
        const link = links.find((l) => l.label === "Live check files");
        token = link.token;
        check("created with both options", link.downloads === true && link.all_files === true);
        check("form reset, box greyed out again", !(await admin.isChecked(`${form} input[name=all_files]`)) && await admin.isDisabled(`${form} input[name=all_files]`));
        const row = admin.locator(`.explorer-link[data-token="${token}"]`);
        const rowAll = row.locator("input[name=all_files]");
        check("row box ticked and usable", await rowAll.isChecked() && await rowAll.isEnabled());
        await shot(admin, "01-share-panel");
        await row.locator("input[name=downloads]").uncheck();
        await admin.waitForTimeout(800);
        check("row box greyed out with downloads off, value kept", await rowAll.isDisabled() && await rowAll.isChecked() && (await apiLink()).all_files === true);
        await row.locator("input[name=downloads]").check();
        await admin.waitForTimeout(800);
        check("row box usable again", await rowAll.isEnabled());

        // The visitor: task page, map page
        const anon = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
        const page = await anon.newPage();
        watch(page, "visitor");
        await page.goto(BASE + link.path);
        const taskHref = await page.$eval(`a[href*="/task/${TASK}"]`, (a) => a.getAttribute("href"));
        const taskId = taskHref.match(/task\/([0-9a-f-]{36})/)[1];
        await page.goto(`${BASE}${link.path}task/${taskId}/`);
        await page.waitForTimeout(1000);
        const items = await page.$$eval(".explorer-task-more .dropdown-menu a[download]", (as) => as.map((a) => a.textContent.trim()));
        console.log("task page menu:", JSON.stringify(items));
        check("menu has the extra files, All Assets last", items.includes("Camera Parameters") && items[items.length - 1] === "All Assets");
        const report = page.locator("a", { hasText: "Processing Report" });
        check("Processing Report button", await report.count() === 1, await report.count());
        await page.click(".explorer-task-more .dropdown-toggle");
        await page.waitForTimeout(300);
        await shot(page, "02-task-page-menu");
        const menuFits = await page.$eval(".explorer-task-more .dropdown-menu", (m) => { const r = m.getBoundingClientRect(); return { bottom: Math.round(r.bottom), height: Math.round(r.height), vh: window.innerHeight }; });
        console.log("task page menu box:", JSON.stringify(menuFits));

        const cameras = page.locator('.explorer-task-more a[href$="/download/cameras.json"]');
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), cameras.click({ force: true })]);
        const file = await download.path();
        const text = require("fs").readFileSync(file, "utf8");
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* reported below */ }
        check("cameras.json downloaded as JSON", parsed !== null, `${download.suggestedFilename()}, ${text.length} bytes`);
        await download.delete();

        const zip = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: "same-origin" });
            const head = { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), length: res.headers.get("content-length") };
            const reader = res.body.getReader();
            const first = await reader.read();
            head.magic = first.value ? String.fromCharCode(first.value[0], first.value[1]) : "";
            await reader.cancel();
            return head;
        }, `${link.path.replace("/plugins/explorer/s/", "/api/plugins/explorer/s/")}tasks/${taskId}/download/all.zip`);
        check("All Assets starts streaming a zip", zip.status === 200 && zip.magic === "PK", JSON.stringify(zip));

        await page.goto(`${BASE}${link.path}map/${taskId}/`);
        await page.waitForTimeout(2000);
        const mapItems = await page.$$eval(".dropdown-menu a[download]", (as) => as.map((a) => a.textContent.trim()));
        check("map page menu has the extra files", mapItems.includes("Quality Report") && mapItems.includes("All Assets"), mapItems.length + " items");
        await page.click(".explorer-tool.dropdown-toggle");
        await page.waitForTimeout(300);
        await shot(page, "03-map-menu");
        const mapMenu = await page.$eval(".open > .dropdown-menu", (m) => { const r = m.getBoundingClientRect(); return { bottom: Math.round(r.bottom), scrollable: m.scrollHeight > m.clientHeight, vh: window.innerHeight }; });
        console.log("map menu box:", JSON.stringify(mapMenu));

        // Phone width
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await mobile.goto(`${BASE}${link.path}task/${taskId}/`);
        await mobile.waitForTimeout(1000);
        await mobile.tap(".explorer-task-more .dropdown-toggle");
        await mobile.waitForTimeout(400);
        check("phone: no horizontal scroll", !(await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
        const phoneMenu = await mobile.$eval(".explorer-task-more .dropdown-menu", (m) => { const r = m.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: window.innerHeight, vw: window.innerWidth }; });
        console.log("phone menu box:", JSON.stringify(phoneMenu));
        await shot(mobile, "04-phone-task-menu");
        await mobile.goto(`${BASE}${link.path}map/${taskId}/`);
        await mobile.waitForTimeout(2000);
        await mobile.tap(".explorer-tool.dropdown-toggle");
        await mobile.waitForTimeout(400);
        const phoneMap = await mobile.$eval(".open > .dropdown-menu", (m) => { const r = m.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), scrollable: m.scrollHeight > m.clientHeight, vh: window.innerHeight }; });
        console.log("phone map menu box:", JSON.stringify(phoneMap));
        await shot(mobile, "05-phone-map-menu");

        // The Sharing Center's Files cell
        await admin.goto(`${BASE}/plugins/explorer/sharing/`);
        await admin.waitForSelector(`tr[data-token="${token}"]`);
        const files = admin.locator(`tr[data-token="${token}"] td`).filter({ has: admin.locator("input[name=downloads]") }).locator("input");
        check("Sharing Center: three file boxes", await files.count() === 3, await files.count());
        await shot(admin, "06-sharing-center");
        await admin.setViewportSize({ width: 390, height: 844 });
        await admin.waitForTimeout(300);
        check("Sharing Center phone: no horizontal scroll", !(await admin.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
        await shot(admin, "07-phone-sharing-center");
        await admin.setViewportSize({ width: 1280, height: 860 });

        // Unticking stops the extra files at once; the outputs still download
        const camerasUrl = `${BASE}${link.path.replace("/plugins/explorer/s/", "/api/plugins/explorer/s/")}tasks/${taskId}/download/cameras.json`;
        refusalsExpected.push(camerasUrl);
        await admin.locator(`tr[data-token="${token}"] input[name=all_files]`).uncheck();
        await admin.waitForTimeout(800);
        check("after unticking, cameras.json refused", (await anon.request.get(camerasUrl)).status() === 404);
        const ortho = await anon.request.head(camerasUrl.replace("cameras.json", "orthophoto.tif"));
        check("the orthophoto still downloads", ortho.status() === 200, ortho.status());
    } catch (e) {
        failed++;
        console.log("FAIL exception: " + masked(e.message.split("\n")[0]));
    } finally {
        if (token) {
            const status = await admin.evaluate(async ([pid, tok]) => {
                const csrf = document.cookie.match(/csrftoken=([^;]+)/);
                const res = await fetch(`/api/plugins/explorer/projects/${pid}/links/${tok}/`, {
                    method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf ? csrf[1] : "" } });
                return res.status;
            }, [PROJECT, token]).catch((e) => "failed: " + e.message);
            console.log("cleanup revoke", status);
        }
        await browser.close();
        console.log(`${passed} passed, ${failed} failed`);
        console.log("errors:\n" + errors.join("\n"));
    }
})();

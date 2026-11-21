// Live check of downloads through "anyone with the link" shares against the dev server (http://localhost:8008), on
// the user's project 2. Creates two links labelled "Live check" through the Share panel (one with Allow Downloads,
// one without, then toggled), downloads one file as a visitor, and revokes both links, also on failure. Playwright
// deletes the downloaded file when the browser closes.
// Usage: node .claude/skills/live-check/link-downloads.js <repo> <screenshot folder> <user> <password> [project id]
const path = require("path");
const [repo, out, user, password, projectArg] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
const PROJECT = Number(projectArg || 2);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), timeout: 90000 }).catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const masked = (url) => url.replace(/s\/[A-Za-z0-9_-]{43}/, "s/<token>");
const errors = [];
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label}: ${m.text().slice(0, 160)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${masked(r.url())}`); });
};

(async () => {
    const browser = await chromium.launch({ headless: true });
    const signedIn = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const admin = await signedIn.newPage();
    watch(admin, "admin");
    const created = []; // tokens
    const linkRow = (token) => admin.locator(`.explorer-link[data-token="${token}"]`);
    const apiLinks = () => admin.evaluate(async (pid) => (await fetch(`/api/plugins/explorer/projects/${pid}/links/`, { credentials: "same-origin" })).json(), PROJECT);
    try {
        await admin.goto(BASE + "/login/");
        await admin.fill("input[name=username]", user);
        await admin.fill("input[name=password]", password);
        await Promise.all([admin.waitForNavigation(), admin.click("button[type=submit], input[type=submit]")]);
        await admin.goto(`${BASE}/plugins/explorer/project/${PROJECT}/`);
        await admin.click("[data-explorer-share]");

        async function createLink(downloads) {
            const before = (await apiLinks()).map((l) => l.token);
            await admin.fill(".explorer-link-form input[name=label]", "Live check");
            await admin.selectOption(".explorer-link-form select", "7");
            await admin.setChecked(".explorer-link-form input[name=downloads]", downloads);
            await admin.click(".explorer-link-form [type=submit]");
            await admin.waitForFunction((n) => document.querySelectorAll(".explorer-link").length > n, before.length);
            const link = (await apiLinks()).find((l) => !before.includes(l.token));
            created.push(link.token);
            console.log("created, downloads:", link.downloads, "form box reset:", !(await admin.isChecked(".explorer-link-form input[name=downloads]")));
            return link;
        }

        const withDownloads = await createLink(true);
        const viewOnly = await createLink(false);
        await shot(admin, "01-share-panel");

        // Toggle on the existing view-only link, then off again
        const box = linkRow(viewOnly.token).locator(".explorer-link-downloads input");
        await box.check();
        await admin.waitForTimeout(800);
        console.log("toggled on, saved:", (await apiLinks()).find((l) => l.token === viewOnly.token).downloads);
        await box.uncheck();
        await admin.waitForTimeout(800);
        console.log("toggled off, saved:", (await apiLinks()).find((l) => l.token === viewOnly.token).downloads);
        await admin.reload();
        await admin.click("[data-explorer-share]");
        await admin.waitForSelector(".explorer-link");
        console.log("after reload, boxes:", await linkRow(withDownloads.token).locator(".explorer-link-downloads input").isChecked(),
            await linkRow(viewOnly.token).locator(".explorer-link-downloads input").isChecked());

        // Visitor on the link that allows downloads
        const anon = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
        const page = await anon.newPage();
        watch(page, "visitor");
        await page.goto(BASE + withDownloads.path);
        await page.waitForTimeout(1500);
        const items = await page.$$eval(".dropdown-menu a[download]", (as) => as.map((a) => a.textContent.trim() + " " + a.getAttribute("href").split("/download/")[1]));
        console.log("download menu:", JSON.stringify(items));
        await page.click(".explorer-outputs .dropdown-toggle");
        await page.waitForTimeout(400);
        await shot(page, "02-link-download-menu");
        const glb = page.locator('.dropdown-menu a[href$="/download/textured_model.glb"]').first();
        if (await glb.count()) {
            const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), glb.click()]);
            const file = await download.path();
            const size = require("fs").statSync(file).size;
            console.log("downloaded:", download.suggestedFilename(), size, "bytes");
            await download.delete();
        }

        // Visitor on the view-only link
        await page.goto(BASE + viewOnly.path);
        await page.waitForTimeout(1000);
        console.log("view-only link has a download menu:", (await page.$$(".dropdown-menu a[download]")).length > 0);
        const taskDownload = await anon.newPage().then(async (p) => {
            await p.goto(BASE + withDownloads.path);
            const url = await p.$eval(".dropdown-menu a[download]", (a) => a.href);
            await p.close();
            return url;
        });
        const viewOnlyUrl = taskDownload.replace(withDownloads.token, viewOnly.token);
        console.log("view-only link, direct download:", (await anon.request.get(viewOnlyUrl)).status());
        const renamed = await anon.request.get(taskDownload + "?filename=a.exe");
        console.log("?filename ignored:", renamed.status(), renamed.headers()["content-disposition"]);

        // Phone width
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await mobile.goto(BASE + withDownloads.path);
        await mobile.waitForTimeout(1500);
        await mobile.tap(".explorer-outputs .dropdown-toggle");
        await mobile.waitForTimeout(400);
        console.log("phone horizontal scroll:", await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
        await shot(mobile, "03-phone-download-menu");
        await admin.setViewportSize({ width: 390, height: 844 });
        await admin.waitForTimeout(300);
        console.log("phone share panel horizontal scroll:", await admin.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
        await shot(admin, "04-phone-share-panel");
        await admin.setViewportSize({ width: 1280, height: 860 });

        // Turning downloads off stops them at once
        await linkRow(withDownloads.token).locator(".explorer-link-downloads input").uncheck();
        await admin.waitForTimeout(800);
        console.log("after turning off, direct download:", (await anon.request.get(taskDownload)).status());
    } finally {
        for (const token of created) {
            const status = await admin.evaluate(async ([pid, tok]) => {
                const csrf = document.cookie.match(/csrftoken=([^;]+)/);
                const res = await fetch(`/api/plugins/explorer/projects/${pid}/links/${tok}/`, {
                    method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf ? csrf[1] : "" } });
                return res.status;
            }, [PROJECT, token]).catch((e) => "failed: " + e.message);
            console.log("cleanup revoke", status);
        }
        await browser.close();
        console.log("errors:\n" + errors.join("\n"));
    }
})();

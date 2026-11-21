// Live check of "anyone with the link" shares against the dev server (http://localhost:8008), on the user's projects 1
// and 2. Creates one link labelled "Live check" on each through the Share panel and revokes both, also on failure.
// Usage: node .claude/skills/live-check/link-shares.js <repo> <screenshot folder> <user> <password>
const path = require("path");
const [repo, out, user, password] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = "http://localhost:8008";
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png"), timeout: 90000 }).catch((e) => console.log("screenshot " + name + " failed: " + e.message.split("\n")[0]));
const errors = [];
const watch = (page, label) => {
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label}: ${m.text().slice(0, 160)}`); });
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("35729")) errors.push(`${label}: ${r.status()} ${r.url().replace(/s\/[A-Za-z0-9_-]{43}/, "s/<token>")}`); });
};

(async () => {
    const browser = await chromium.launch({ headless: true });
    const signedIn = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const admin = await signedIn.newPage();
    watch(admin, "admin");
    const created = []; // [projectId, token]
    try {
        await admin.goto(BASE + "/login/");
        await admin.fill("input[name=username]", user);
        await admin.fill("input[name=password]", password);
        await Promise.all([admin.waitForNavigation(), admin.click("button[type=submit], input[type=submit]")]);

        async function createLink(projectId) {
            await admin.goto(`${BASE}/plugins/explorer/project/${projectId}/`);
            await admin.click("[data-explorer-share]");
            await admin.fill(".explorer-link-form input[name=label]", "Live check");
            await admin.selectOption(".explorer-link-form select", "7");
            await admin.click(".explorer-link-form [type=submit]");
            await admin.waitForSelector(".explorer-link");
            const row = admin.locator(".explorer-link", { hasText: "Live check" }).first();
            const url = await row.locator("input").inputValue();
            const token = url.match(/s\/([A-Za-z0-9_-]{43})\//)[1];
            created.push([projectId, token]);
            return url;
        }

        const url1 = await createLink(1);
        await shot(admin, "01-share-panel");
        const url2 = await createLink(2);

        const anon = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const page = await anon.newPage();
        watch(page, "visitor");
        let r = await page.goto(url1);
        console.log("link page", r.status(), r.headers()["referrer-policy"], r.headers()["cache-control"]);
        await page.waitForTimeout(2500);
        await shot(page, "02-link-page");
        const hrefs = await page.$$eval(".explorer-outputs a", (as) => as.map((a) => a.getAttribute("href").replace(/s\/[A-Za-z0-9_-]{43}/, "s/<token>")));
        console.log("buttons", JSON.stringify(hrefs));

        const mapHref = await page.$eval('.explorer-outputs a[href*="/map/"]', (a) => a.href);
        await page.goto(mapHref);
        await page.waitForSelector(".leaflet-tile-loaded", { timeout: 60000 });
        await page.waitForTimeout(4000);
        await shot(page, "03-map-ortho");
        if (await page.$("[data-layer=dsm]")) {
            await page.click("[data-layer=dsm]");
            await page.waitForTimeout(6000);
            await shot(page, "04-map-dsm");
        }

        await page.goto(url1);
        const meshHref = await page.$eval('.explorer-outputs a[href*="t=mesh"]', (a) => a.href);
        await page.goto(meshHref);
        await page.waitForFunction(() => document.querySelector(".explorer-status").hidden, null, { timeout: 120000 }).catch(() => console.log("mesh: status still showing"));
        await page.waitForTimeout(3000);
        console.log("mesh status:", await page.$eval(".explorer-status", (e) => e.hidden ? "(hidden)" : e.textContent));
        await shot(page, "05-3d-mesh");
        await page.click("[data-type=splats]");
        await page.waitForFunction(() => document.querySelector(".explorer-status").hidden, null, { timeout: 120000 }).catch(() => console.log("splats: status still showing"));
        await page.waitForTimeout(6000);
        console.log("splats status:", await page.$eval(".explorer-status", (e) => e.hidden ? "(hidden)" : e.textContent));
        await shot(page, "06-3d-splats");

        // Phone width
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
            userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" });
        const mobile = await phone.newPage();
        watch(mobile, "phone");
        await mobile.goto(url1);
        await mobile.waitForTimeout(2500);
        console.log("phone horizontal scroll:", await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
        await shot(mobile, "07-phone-link");
        await mobile.goto(mapHref);
        await mobile.waitForSelector(".leaflet-tile-loaded", { timeout: 60000 }).catch(() => {});
        await mobile.waitForTimeout(3000);
        await shot(mobile, "08-phone-map");
        await mobile.goto(meshHref);
        await mobile.waitForFunction(() => document.querySelector(".explorer-status").hidden, null, { timeout: 120000 }).catch(() => {});
        await mobile.waitForTimeout(3000);
        await shot(mobile, "09-phone-mesh");
        await admin.goto(`${BASE}/plugins/explorer/project/1/`);
        await admin.setViewportSize({ width: 390, height: 844 });
        await admin.click("[data-explorer-share]");
        await admin.waitForSelector(".explorer-link");
        console.log("phone share panel horizontal scroll:", await admin.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
        await shot(admin, "10-phone-share-panel");
        await admin.setViewportSize({ width: 1280, height: 860 });

        // Greyscale orthophoto (project 2)
        await page.goto(url2);
        await page.waitForTimeout(2000);
        await shot(page, "11-link-page-project2");
        const map2 = await page.$eval('.explorer-outputs a[href*="/map/"]', (a) => a.href);
        await page.goto(map2);
        await page.waitForSelector(".leaflet-tile-loaded", { timeout: 60000 }).catch(() => console.log("project 2 map: no tile"));
        await page.waitForTimeout(4000);
        await shot(page, "12-map-project2");

        // Revoke through the Share panel while the visitor's map is open
        await page.goto(mapHref);
        await page.waitForSelector(".leaflet-tile-loaded", { timeout: 60000 });
        await admin.goto(`${BASE}/plugins/explorer/project/1/`);
        await admin.click("[data-explorer-share]");
        await admin.waitForSelector(".explorer-link");
        admin.once("dialog", (d) => d.accept());
        await admin.locator(".explorer-link", { hasText: "Live check" }).first().locator(".btn-danger").click();
        await admin.waitForTimeout(1500);
        created.splice(created.findIndex((c) => c[0] === 1), 1);
        if (await page.$("[data-layer=dsm]")) await page.click("[data-layer=dsm]");
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(4000);
        console.log("after revoke, map status:", await page.$eval(".explorer-status", (e) => e.hidden ? "(hidden)" : e.textContent));
        await shot(page, "13-map-after-revoke");
        r = await page.goto(url1);
        console.log("after revoke, link page", r.status());
        await shot(page, "14-revoked-link-page");
    } finally {
        // Revoke whatever the check created and is still live
        for (const [projectId, token] of created) {
            const status = await admin.evaluate(async ([pid, tok]) => {
                const csrf = document.cookie.match(/csrftoken=([^;]+)/);
                const res = await fetch(`/api/plugins/explorer/projects/${pid}/links/${tok}/`, {
                    method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf ? csrf[1] : "" } });
                return res.status;
            }, [projectId, token]).catch((e) => "failed: " + e.message);
            console.log("cleanup revoke project", projectId, status);
        }
        await browser.close();
        console.log("errors:\n" + errors.join("\n"));
    }
})();

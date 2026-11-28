// Explorer's state on the throwaway WebODM, for an upgrade rehearsal (the release-check skill):
//   node dev/rehearsal/state.js <repo> write <project id>   settings, Allow Links and three links, as the old version
//                                                           (its API: what its Share panel and Settings page send)
//   node dev/rehearsal/state.js <repo> read <project id>    a JSON snapshot: settings, links, what visitors get
// Signs in as REHEARSAL_USER with REHEARSAL_PASSWORD (environment), at REHEARSAL_URL (default http://127.0.0.1:8010).
// Writes go through the signed-in page with its CSRF token (WebODM's CSRF check covers a plugin's API).
const [repo, action, project] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = process.env.REHEARSAL_URL || "http://127.0.0.1:8010";
const API = "/api/plugins/explorer/";

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", process.env.REHEARSAL_USER || "rehearsal");
        await page.fill("input[name=password]", process.env.REHEARSAL_PASSWORD || "");
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
        const call = (method, url, body) => page.evaluate(async ([m, u, b]) => {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/);
            const response = await fetch(u, { method: m, credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf ? csrf[1] : "" },
                body: b === undefined ? undefined : JSON.stringify(b) });
            const text = await response.text();
            let json;
            try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
            return { status: response.status, json };
        }, [method, url, body]);

        if (action === "write") {
            const steps = [
                ["PATCH", API + "settings/", { public_address: BASE, basemaps_on_links: false }],
                ["PATCH", API + `projects/${project}/links-allowed/`, { allowed: true }],
                ["PATCH", API + "settings/", { private_links: "none" }],
                ["POST", API + `projects/${project}/links/`, { label: "Rehearsal Downloads", expires_days: 30, downloads: true }],
                ["POST", API + `projects/${project}/links/`, { label: "Rehearsal Sign-In", expires_days: null, sign_in: true }],
                ["POST", API + `projects/${project}/links/`, { label: "Rehearsal Plain", expires_days: 7 }],
            ];
            for (const [method, url, body] of steps) {
                const result = await call(method, url, body);
                console.log(method, url, result.status, result.status >= 400 ? JSON.stringify(result.json) : "");
                if (result.status >= 400) process.exitCode = 1;
            }
            return;
        }

        // read: what the admin sees, and what a visitor gets through each link
        const settings = await call("GET", API + "settings/");
        const listed = await call("GET", API + `projects/${project}/links/`);
        const links = Array.isArray(listed.json) ? listed.json : [];
        const visitor = await browser.newContext();
        const visits = {};
        for (const link of links) {
            const v = await visitor.newPage();
            const response = await v.goto(`${BASE}/plugins/explorer/s/${link.token}/`);
            visits[link.label] = { status: response.status(), login: /\/login/.test(v.url()) };
            await v.close();
        }
        await visitor.close();
        const keep = (link) => ({ token: link.token, label: link.label, expires: link.expires, downloads: link.downloads,
            sign_in: link.sign_in });
        console.log(JSON.stringify({ settings: settings.json, links: links.map(keep), visits }, null, 1));
    } finally {
        await browser.close();
    }
})();

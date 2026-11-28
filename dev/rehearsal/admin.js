// The throwaway WebODM's Administration > Plugins, driven as a user would (the release-check skill):
//   node dev/rehearsal/admin.js <repo> load <zip>              Load Plugin (.zip)
//   node dev/rehearsal/admin.js <repo> update <zip> <sha256>   the plugin browser's Update (the same upload, upgrade=1)
//   node dev/rehearsal/admin.js <repo> delete <plugin>         the plugin's Delete
//   node dev/rehearsal/admin.js <repo> list                    the plugins and their versions
// Signs in as REHEARSAL_USER with REHEARSAL_PASSWORD (environment, never arguments), at REHEARSAL_URL
// (default http://127.0.0.1:8010).
const path = require("path");
const [repo, action, ...args] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const BASE = process.env.REHEARSAL_URL || "http://127.0.0.1:8010";

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", process.env.REHEARSAL_USER || "rehearsal");
        await page.fill("input[name=password]", process.env.REHEARSAL_PASSWORD || "");
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
        await page.goto(BASE + "/admin/app/plugin/");
        if (action === "load") {
            await Promise.all([page.waitForNavigation(), page.setInputFiles("#plugin-upload-file", path.resolve(args[0]))]);
        } else if (action === "update") {
            // What WebODM's PluginBrowser.jsx sends for Update: the zip, its sha256, upgrade=1, json=1
            // Sent by Playwright's request API with the page's cookies (a 27 MB zip doesn't go through page.evaluate)
            const response = await page.request.post(BASE + "/admin/app/plugin/actions/upload/", {
                headers: { Referer: BASE + "/admin/app/plugin/" },
                multipart: {
                    file: { name: path.basename(args[0]), mimeType: "application/zip", buffer: require("fs").readFileSync(args[0]) },
                    sha256: args[1], upgrade: "1", json: "1",
                    csrfmiddlewaretoken: await page.$eval("[name=csrfmiddlewaretoken]", (e) => e.value),
                },
            });
            console.log("update:", response.status(), await response.text());
            await page.goto(BASE + "/admin/app/plugin/");
        } else if (action === "delete") {
            page.on("dialog", (d) => d.accept());
            await page.goto(BASE + `/admin/app/plugin/${args[0]}/delete/`).catch(() => {});
            await page.goto(BASE + "/admin/app/plugin/");
        }
        const messages = await page.$$eval(".messagelist li, .alert", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
        if (messages.length) console.log("messages:", JSON.stringify(messages));
        const rows = await page.$$eval("#result_list tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll("td, th")].map((c) => c.textContent.trim()).slice(0, 5).join(" | ")));
        console.log(rows.filter((r) => /explorer|Explorer/.test(r)).join("\n") || "(no Explorer row)");
    } finally {
        await browser.close();
    }
})();

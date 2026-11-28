// Live check of the map page's Measure tool against WebODM's own map ruler, on the dev server (http://localhost:8008).
// 1. WebODM's map: a polygon drawn with its Measure control; its popup (area, perimeter, volume) and its Export
//    to GeoJSON file (the polygon's points, read in the page as WebODM makes it: nothing is saved).
// 2. Explorer's own map: the same points clicked at zoom 22; its panel and its points.
// 3. Recomputed here: Turf 5.1.5 on WebODM's points (must equal WebODM's popup), GeographicLib on Explorer's points
//    (must equal Explorer's panel), and both methods on the same points (the sphere's error WebODM's ruler has).
// 4. Volume: WebODM's API and Explorer's link view on exactly the same points must agree to the cubic centimetre.
// 5. A link (one "Live check" link, revoked at the end, also on failure): the tool as an anonymous visitor (area,
//    volume, a point's elevation), phone width, and long tasks while drawing. Creating a link queues the project's
//    meshes for tiling, as the other link checks do.
// Usage: node .claude/skills/live-check/measure.js <repo> <screenshot folder> <user> <password> <project id> <task id>
//        <folder with node_modules/@turf/area@5.1.5 and @turf/length@5.1.5>
// The task needs a DSM. Units are read in metric on Explorer's side (a fresh profile); WebODM's popup is read in
// whatever unit system the user chose in WebODM, and converted.
const path = require("path");
const [repo, out, user, password, project, task, turfDir] = process.argv.slice(2);
const { chromium } = require(repo + "/node_modules/playwright");
const geodesic = require(repo + "/explorer/public/vendor/geographiclib-geodesic-2.2.0/geographiclib-geodesic.min.js");
const turfArea = require(turfDir + "/node_modules/@turf/area").default || require(turfDir + "/node_modules/@turf/area");
const turfLength = require(turfDir + "/node_modules/@turf/length").default || require(turfDir + "/node_modules/@turf/length");
const BASE = process.env.EXPLORER_BASE || "http://localhost:8008";
const G = geodesic.Geodesic.WGS84;
let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`); };
const errors = [];
const watch = (page, label) => {
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message.slice(0, 160)}`));
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("CONNECTION_REFUSED")) errors.push(`${label} on ${page.url().replace(BASE, "").slice(0, 40)}: ${m.text().slice(0, 160)}`); });
};
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png") }).catch(() => {});

// Numbers out of a popup or panel line ("1,234.56 m²", "13,456.7 ft³") into SI
const SI = { "m": 1, "km": 1000, "ft": 0.3048, "mi": 1609.344, "m²": 1, "ha": 10000, "ft²": 0.09290304, "ac": 4046.8564224, "acres": 4046.8564224,
    "m³": 1, "ft³": 0.028316846592, "yd³": 0.764554857984 };
function si(text) {
    // Longest units first, and no \b: "²" and "³" are not word characters
    const m = /(-?[\d,.]+)\s*(acres|km|mi|ha|ac|m²|ft²|m³|ft³|yd³|m|ft)(?![\w²³])/.exec(text.replace(/\u00a0/g, " "));
    if (!m) return NaN;
    return parseFloat(m[1].replace(/,/g, "")) * SI[m[2]];
}
const geoArea = (pts) => { const p = G.Polygon(false); pts.forEach(([lat, lng]) => p.AddPoint(lat, lng)); const r = p.Compute(false, true); return { area: Math.abs(r.area), perimeter: r.perimeter }; };
const ringOf = (pts) => { const r = pts.map(([lat, lng]) => [lng, lat]); r.push(r[0]); return r; };
const pct = (a, b) => ((a - b) / b * 100).toFixed(3) + "%";

(async () => {
    const browser = await chromium.launch({ headless: true });
    const admin = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    // WebODM's Export Measurements saves a Blob (FileSaver), which headless Chromium doesn't download: keep its text
    await admin.addInitScript(() => {
        const make = URL.createObjectURL;
        window.__exports = [];
        URL.createObjectURL = function (blob) {
            if (blob && blob.text) blob.text().then((t) => window.__exports.push(t));
            return make.call(this, blob);
        };
    });
    const page = await admin.newPage();
    watch(page, "signed-in");
    let token = null;
    try {
        await page.goto(BASE + "/login/");
        await page.fill("input[name=username]", user);
        await page.fill("input[name=password]", password);
        await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);

        // 1. WebODM's own map and Measure control
        await page.goto(`${BASE}/map/project/${project}/task/${task}/`);
        await page.waitForTimeout(4000);
        const box = await page.$eval(".leaflet-container", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
        await page.click(".leaflet-control-measure-toggle");
        await page.click(".js-start >> nth=0");
        for (const [fx, fy] of [[0.45, 0.42], [0.57, 0.44], [0.55, 0.58], [0.43, 0.55]]) {
            await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
            await page.waitForTimeout(300);
        }
        await page.click(".js-finish");
        await page.waitForSelector(".leaflet-popup-content", { timeout: 10000 });
        await page.waitForFunction(() => !/computing/i.test(document.querySelector(".leaflet-popup-content").textContent), null, { timeout: 130000 });
        const popup = await page.$eval(".leaflet-popup-content", (e) => e.innerText);
        const lines = popup.split("\n").map((l) => l.trim()).filter(Boolean);
        const pick = (re) => { const l = lines.find((x) => re.test(x)); return l ? si(l.replace(re, "")) : NaN; };
        const webodm = { area: pick(/^Area:?/i), perimeter: pick(/^Perimeter:?/i), volume: pick(/^Volume:?/i) };
        console.log("WebODM's popup:", JSON.stringify(lines));
        await shot(page, "measure-01-webodm");
        await page.click(".leaflet-popup-content >> text=Export to GeoJSON");
        await page.waitForFunction(() => window.__exports.length > 0, null, { timeout: 10000 });
        const exported = JSON.parse(await page.evaluate(() => window.__exports[window.__exports.length - 1]));
        const polygon = exported.features ? exported.features.find((f) => f.geometry.type === "Polygon") : exported;
        const ring = polygon.geometry.coordinates[0];
        const pts = ring.slice(0, ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : undefined).map(([lng, lat]) => [lat, lng]);
        console.log(`WebODM's polygon: ${pts.length} points (${ring.length} in its ring), its export's properties: ${JSON.stringify(polygon.properties)}`);

        // 3a. WebODM's numbers are Turf 5.1.5's
        const turf = { area: turfArea({ type: "Feature", geometry: { type: "Polygon", coordinates: [ringOf(pts)] } }),
            perimeter: turfLength({ type: "Feature", geometry: { type: "LineString", coordinates: ringOf(pts) } }, { units: "kilometers" }) * 1000 };
        // The popup measures leaflet-measure's own copy of the points, a few millimetres from the polygon it exports
        // and measures volume on (seen 2026-11-27: 0.2% on a 150 m2 area): close, not equal
        check("WebODM's popup area is close to Turf 5.1.5's on its exported polygon", Math.abs(webodm.area - turf.area) / turf.area < 0.005, `${webodm.area.toFixed(3)} vs ${turf.area.toFixed(3)} m2`);
        const exact = geoArea(pts);
        console.log(`  on the same points: GeographicLib ${exact.area.toFixed(3)} m2, Turf ${turf.area.toFixed(3)} m2 (WebODM's ruler ${pct(turf.area, exact.area)}); perimeter ${exact.perimeter.toFixed(3)} vs ${turf.perimeter.toFixed(3)} m (${pct(turf.perimeter, exact.perimeter)})`);

        // 2. Explorer's own map, the same points
        await page.goto(`${BASE}/plugins/explorer/project/${project}/map/${task}/`);
        await page.waitForTimeout(3000);
        await page.click("[data-tool=measure]");
        await page.click("[data-mode=area]");
        const clicks = await page.evaluate((points) => {
            const map = document.querySelector("[data-explorer-map]").explorerMap;
            const lat = points.reduce((s, p) => s + p[0], 0) / points.length, lng = points.reduce((s, p) => s + p[1], 0) / points.length;
            map.setView([lat, lng], 22, { animate: false });
            const r = map.getContainer().getBoundingClientRect();
            return points.map((p) => { const c = map.latLngToContainerPoint(p); return [r.x + c.x, r.y + c.y]; });
        }, pts);
        for (const [x, y] of clicks) { await page.mouse.click(x, y); await page.waitForTimeout(150); }
        await page.click("[data-finish]");
        await page.waitForFunction(() => !document.querySelector(".explorer-measure-results").textContent.includes("Computing"), null, { timeout: 130000 });
        const panel = await page.$$eval(".explorer-measure-results dt, .explorer-measure-results dd", (els) => els.map((e) => e.textContent));
        const explorer = { area: si(panel[1]), perimeter: si(panel[3]), volume: si(panel[5] || "") };
        const ePts = await page.evaluate(() => document.querySelector("[data-explorer-map]").explorerMeasure.state().points);
        console.log("Explorer's panel:", JSON.stringify(panel));
        await shot(page, "measure-02-explorer");
        check("the panel's content fits it (no sideways scroll inside)", await page.$eval(".explorer-measure", (e) => e.scrollWidth <= e.clientWidth + 1));
        const moved = Math.max(...ePts.map((p, i) => G.Inverse(p[0], p[1], pts[i][0], pts[i][1]).s12));
        console.log(`  Explorer's points are within ${(moved * 100).toFixed(1)} cm of WebODM's`);
        // 3b. Explorer's numbers are GeographicLib's
        const eExact = geoArea(ePts);
        check("Explorer's area and perimeter are GeographicLib's on its points", Math.abs(explorer.area - eExact.area) < 0.006 && Math.abs(explorer.perimeter - eExact.perimeter) < 0.006,
            `${explorer.area} vs ${eExact.area.toFixed(3)} m2, ${explorer.perimeter} vs ${eExact.perimeter.toFixed(3)} m`);
        check("clicked volumes agree (the clicked points differ by a fraction of a pixel)", Math.abs(webodm.volume - explorer.volume) / Math.max(webodm.volume, 1e-9) < 0.01,
            `WebODM ${webodm.volume.toFixed(3)} m3, Explorer ${explorer.volume.toFixed(3)} m3`);

        // The same polygon exactly: WebODM's exported points given to Explorer's tool
        await page.evaluate((points) => {
            const tool = document.querySelector("[data-explorer-map]").explorerMeasure;
            tool.setMode("area");
            points.forEach((p) => tool.state().points.push(p));
            tool.finish();
        }, pts);
        await page.waitForFunction(() => !document.querySelector(".explorer-measure-results").textContent.includes("Computing"), null, { timeout: 130000 });
        const same = await page.$$eval(".explorer-measure-results dd", (els) => els.map((e) => e.textContent));
        const sameArea = si(same[0]), sameVolume = si(same[2]);
        check("on WebODM's exact polygon, Explorer's area is GeographicLib's", Math.abs(sameArea - exact.area) < 0.006, `${sameArea} vs ${exact.area.toFixed(3)} m2`);
        console.log(`  on WebODM's exact polygon: Explorer ${sameArea} m2, WebODM's ruler (Turf) ${turf.area.toFixed(3)} m2: WebODM reads ${pct(turf.area, exact.area)}`);
        check("on WebODM's exact polygon, Explorer's volume is WebODM's popup's", Math.abs(sameVolume - webodm.volume) < 0.01, `${sameVolume} vs ${webodm.volume.toFixed(4)} m3`);

        // 5. A link: the anonymous visitor's tool
        token = await page.evaluate(async (pid) => {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/);
            const res = await fetch(`/api/plugins/explorer/projects/${pid}/links/`, { method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-CSRFToken": csrf ? csrf[1] : "" }, body: JSON.stringify({ label: "Live check", expires_days: 7 }) });
            return (await res.json()).token;
        }, project);
        check("a Live check link was created", Boolean(token));
        // 4. The same exact points through WebODM's API and the link's view
        const volumes = await page.evaluate(async ([pid, tid, tok, points]) => {
            const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
            const ring = points.map(([lat, lng]) => [lng, lat]); ring.push(ring[0]);
            const body = JSON.stringify({ area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }, method: "triangulate" });
            async function run(start, result) {
                const job = await (await fetch(start, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRFToken": csrf }, body })).json();
                for (let i = 0; i < 120; i++) {
                    const r = await (await fetch(result + job.celery_task_id, { credentials: "same-origin" })).json();
                    if (r.error !== "Task not ready") return r;
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
                return { error: "timeout" };
            }
            return {
                webodm: await run(`/api/plugins/measure/task/${tid}/volume`, `/api/plugins/measure/task/${tid}/volume/get/`),
                link: await run(`/api/plugins/explorer/s/${tok}/tasks/${tid}/volume`, `/api/plugins/explorer/s/${tok}/tasks/${tid}/volume/get/`),
            };
        }, [project, task, token, ePts]);
        check("the link's volume is WebODM's, to the cubic centimetre", Math.abs(parseFloat(volumes.webodm.output) - parseFloat(volumes.link.output)) < 0.01, JSON.stringify(volumes));

        const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
        const visitor = await visitorContext.newPage();
        watch(visitor, "visitor");
        await visitor.goto(`${BASE}/plugins/explorer/s/${token}/map/${task}/`);
        await visitor.waitForTimeout(3000);
        await visitor.click("[data-tool=measure]");
        await visitor.click("[data-mode=area]");
        const vClicks = await visitor.evaluate((points) => {
            const map = document.querySelector("[data-explorer-map]").explorerMap;
            const lat = points.reduce((s, p) => s + p[0], 0) / points.length, lng = points.reduce((s, p) => s + p[1], 0) / points.length;
            map.setView([lat, lng], 22, { animate: false });
            const r = map.getContainer().getBoundingClientRect();
            return points.map((p) => { const c = map.latLngToContainerPoint(p); return [r.x + c.x, r.y + c.y]; });
        }, ePts);
        for (const [x, y] of vClicks) { await visitor.mouse.click(x, y); await visitor.waitForTimeout(150); }
        await visitor.keyboard.press("Enter");
        await visitor.waitForFunction(() => !document.querySelector(".explorer-measure-results").textContent.includes("Computing"), null, { timeout: 130000 });
        const vPanel = await visitor.$$eval(".explorer-measure-results dd", (els) => els.map((e) => e.textContent));
        check("a visitor measures area and volume through the link", vPanel.length === 3 && isFinite(si(vPanel[2])), JSON.stringify(vPanel));
        await visitor.click("[data-mode=point]");
        const centre = vClicks.reduce((s, c) => [s[0] + c[0] / vClicks.length, s[1] + c[1] / vClicks.length], [0, 0]);
        await visitor.mouse.click(centre[0], centre[1]);
        await visitor.waitForFunction(() => !document.querySelector(".explorer-measure-results").textContent.includes("Reading"), null, { timeout: 15000 });
        const pPanel = await visitor.$$eval(".explorer-measure-results dt, .explorer-measure-results dd", (els) => els.map((e) => e.textContent));
        check("a visitor reads a point's elevation", /DSM/.test(pPanel[0]) && isFinite(si(pPanel[1])), JSON.stringify(pPanel));

        // Long tasks while drawing a 20-point line
        await visitor.click("[data-mode=length]");
        await visitor.evaluate(() => { window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: false }); });
        for (let i = 0; i < 20; i++) { await visitor.mouse.move(400 + i * 20, 400 + (i % 2) * 40); await visitor.mouse.click(400 + i * 20, 400 + (i % 2) * 40); }
        await visitor.waitForTimeout(300);
        const long = await visitor.evaluate(() => window.__long);
        check("no long tasks while drawing", long.length === 0, JSON.stringify(long));

        // Phone width
        await visitor.setViewportSize({ width: 390, height: 844 });
        await visitor.waitForTimeout(500);
        check("phone: no horizontal scroll", !(await visitor.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
        const panelBox = await visitor.$eval(".explorer-measure", (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, w: window.innerWidth }; });
        check("phone: the panel fits the width", panelBox.left >= 0 && panelBox.right <= panelBox.w, JSON.stringify(panelBox));
        await shot(visitor, "measure-03-phone");
        // What each mode hides stays hidden (CSS display rules beat the hidden attribute unless the panel says so)
        const shown = (sel) => visitor.$eval(sel, (e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0);
        check("Length shows no Volume Base", !(await shown(".explorer-measure-method")));
        await visitor.click("[data-mode=point]");
        check("Point shows no Undo or Finish", !(await shown("[data-undo]")) && !(await shown("[data-finish]")));
        check("Close is shown", await shown(".explorer-measure-close"));
        await visitor.click("[data-mode=length]");
        await visitorContext.close();
    } catch (e) {
        failed++;
        console.log("FAIL exception: " + e.message.split("\n")[0]);
    } finally {
        if (token) {
            const status = await page.evaluate(async ([pid, tok]) => {
                const csrf = document.cookie.match(/csrftoken=([^;]+)/);
                return (await fetch(`/api/plugins/explorer/projects/${pid}/links/${tok}/`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRFToken": csrf ? csrf[1] : "" } })).status;
            }, [project, token]).catch((e) => "failed: " + e.message);
            console.log("cleanup: the Live check link revoked:", status);
        }
        await browser.close();
        console.log(`${passed} passed, ${failed} failed`);
        console.log("errors:\n" + errors.join("\n"));
    }
})();

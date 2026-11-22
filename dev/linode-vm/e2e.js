// End to end on a server set up by docs/public/linode/setup.sh (dev/linode-vm/vm.sh e2e), the guide's steps:
// through the SSH tunnel, create WebODM's admin (first visit), install Explorer's zip (Administration > Plugins),
// restart with `sudo webodm restart`, set Public Address, import a task, create a link; then as a visitor on the
// public name, open the link's page, map and 3D views, and list every request the proxy refused. Measures the VM's
// memory while the mesh tiles build. Arguments: repo, VM IP, SSH key, name, user, state folder.
// The task zip: EX_TASK_ZIP, or task 819e6ca7 of the local dev stack's project 2 (WO_USER, WO_PASS).
const { chromium } = require(process.argv[2] + "/node_modules/playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [repo, ip, key, domain, user, state] = process.argv.slice(2);
const TUNNEL = "http://localhost:18000", PUBLIC = `https://${domain}`;
const baseArgs = ["-i", key, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"];
// Commands share one connection; the tunnel has its own, as the guide's ssh -N -L does
const sshArgs = [...baseArgs, "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/exvm-%C", "-o", "ControlPersist=60"];
const onVm = (cmd) => execFileSync("ssh", [...sshArgs, `${user}@${ip}`, cmd], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adminPassword() {
  const file = path.join(state, "admin-password");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(18).toString("base64url"), { mode: 0o600 });
  return fs.readFileSync(file, "utf8");
}

async function taskZip() {
  if (process.env.EX_TASK_ZIP) return process.env.EX_TASK_ZIP;
  const file = path.join(state, "task.zip");
  if (fs.existsSync(file)) return file;
  // Read-only: the dev stack's task as WebODM's own Download Assets > All Assets gives it
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto("http://localhost:8008/login/");
  await page.fill("input[name=username]", process.env.WO_USER);
  await page.fill("input[name=password]", process.env.WO_PASS);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
  const r = await page.request.get("http://localhost:8008/api/projects/2/tasks/819e6ca7-773e-4dd0-8915-68ca26dabedf/download/all.zip", { timeout: 600000 });
  if (!r.ok()) throw new Error("task zip: " + r.status());
  fs.writeFileSync(file, await r.body());
  await browser.close();
  console.log("task zip", (fs.statSync(file).size / 1e6).toFixed(0), "MB");
  return file;
}

function pluginZip() {
  const dist = path.join(repo, "dist");
  const zips = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => /^explorer-.*\.zip$/.test(f)).sort() : [];
  if (!zips.length) throw new Error("no dist/explorer-*.zip: run dev/package.sh first");
  return path.join(dist, zips[zips.length - 1]);
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url, { redirect: "manual" }); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error("no answer from " + url);
    await sleep(3000);
  }
}

(async () => {
  const zip = await taskZip();
  const tunnel = spawn("ssh", [...baseArgs, "-N", "-o", "ExitOnForwardFailure=yes", "-L", "18000:127.0.0.1:8000", `${user}@${ip}`], { stdio: "inherit" });
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist",
    `--host-resolver-rules=MAP ${domain} ${ip}`] });
  let failures = 0;
  const check = (ok, what) => { console.log((ok ? "  ok   " : "  FAIL ") + what); if (!ok) failures++; };
  try {
    await waitFor(TUNNEL + "/", 60000);
    const admin = await browser.newContext();
    const page = await admin.newPage();
    const csrf = async () => (await admin.cookies()).find((c) => c.name === "csrftoken").value;
    const hdr = async () => ({ "X-CSRFToken": await csrf(), Referer: TUNNEL + "/" });

    // 1. The first visit creates the admin (the guide's step 4), later runs sign in
    await page.goto(TUNNEL + "/");
    if (page.url().includes("/welcome/")) {
      await page.fill("input[name=username]", "admin");
      await page.fill("input[name=password]", adminPassword());
      await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
      console.log("created the admin through the tunnel");
    } else if (page.url().includes("/login/")) {
      await page.fill("input[name=username]", "admin");
      await page.fill("input[name=password]", adminPassword());
      await Promise.all([page.waitForNavigation(), page.click("button[type=submit], input[type=submit]")]);
    }
    check(!page.url().includes("/login/") && !page.url().includes("/welcome/"), "signed in through the tunnel");

    // 2. Explorer's zip through Administration > Plugins (the page's own upload form), then sudo webodm restart
    const installed = (await page.request.get(TUNNEL + "/plugins/explorer/")).status() === 200;
    if (!installed) {
      await page.goto(TUNNEL + "/admin/app/plugin/");
      const chooser = page.waitForEvent("filechooser");
      await page.getByText("Load Plugin (.zip)").click();
      await (await chooser).setFiles(pluginZip());
      await page.waitForLoadState("networkidle");
      console.log("WebODM says:", (await page.locator(".messagelist, .alert").allInnerTexts()).join(" | ").slice(0, 200));
      onVm("sudo webodm restart >/dev/null 2>&1");
      await waitFor(TUNNEL + "/", 600000);
      await sleep(5000);
    }
    check((await page.request.get(TUNNEL + "/plugins/explorer/")).status() === 200, "Explorer installed and answering");
    check(!/0\.0\.0\.0:8000|\[::\]:8000|\*:8000/.test(onVm("sudo ss -Hltn")), "after the restart, still on 127.0.0.1:8000 only");
    check(!/node-odx|nodeodx/.test(onVm("sudo docker ps --format '{{.Image}}'")), "no processing node");

    // 3. Public Address, as in the guide's step 5
    const settings = await page.request.patch(TUNNEL + "/api/plugins/explorer/settings/", { headers: await hdr(), data: { public_address: PUBLIC } });
    check(settings.ok() && (await settings.json()).public_address === PUBLIC, "Public Address set");

    // 4. A project and the imported task
    let project = (await (await page.request.get(TUNNEL + "/api/projects/?name=Live%20check")).json()).find?.((p) => p.name === "Live check");
    if (!project) project = await (await page.request.post(TUNNEL + "/api/projects/", { headers: await hdr(), data: { name: "Live check" } })).json();
    let tasks = await (await page.request.get(`${TUNNEL}/api/projects/${project.id}/tasks/`)).json();
    if (!tasks.length) {
      const t0 = Date.now();
      const r = await page.request.post(`${TUNNEL}/api/projects/${project.id}/tasks/import`, { headers: await hdr(), timeout: 1200000,
        multipart: { name: "Imported", file: { name: "all.zip", mimeType: "application/zip", buffer: fs.readFileSync(zip) } } });
      check(r.ok(), `task uploaded through the tunnel (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    const end = Date.now() + 1800000;
    for (;;) {
      tasks = await (await page.request.get(`${TUNNEL}/api/projects/${project.id}/tasks/`)).json();
      if (tasks[0] && tasks[0].status === 40) break;
      if (tasks[0] && [30, 50].includes(tasks[0].status)) throw new Error("import failed: " + tasks[0].last_error);
      if (Date.now() > end) throw new Error("import not done after 30 minutes");
      await sleep(10000);
    }
    check(true, "task imported");

    // 5. A link, its address from the Share panel
    await page.goto(`${TUNNEL}/plugins/explorer/project/${project.id}/`);
    await page.click("[data-explorer-share]");
    await page.locator(".explorer-link-form input[name=label]").fill("Live check");
    await page.locator(".explorer-link-form button[type=submit]").click();
    await page.waitForTimeout(1500);
    const address = await page.locator(".explorer-link-address").first().inputValue();
    check(address.startsWith(PUBLIC + "/plugins/explorer/s/"), "the Share panel copies the public address");

    // 6. As a visitor, on the public name: the page, the map, each 3D view
    const visitor = await browser.newContext({ ignoreHTTPSErrors: true });
    const v = await visitor.newPage();
    const refused = new Map(), errors = [];
    v.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(PUBLIC)) { const p = new URL(r.url()).pathname; refused.set(p, r.status()); } });
    v.on("pageerror", (e) => errors.push(e.message));
    let peak = 0;
    const memory = setInterval(() => {
      try { const used = Number(onVm("free -m | awk '/^Mem:/ { print $3 }'").trim()); peak = Math.max(peak, used); } catch { /* busy */ }
    }, 5000);
    await v.goto(address);
    await v.waitForTimeout(3000);
    check(await v.locator("h1, h2, h3").count() > 0, "the link page opens on the public name");
    const hrefs = await v.evaluate(() => [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => /\/(map|3d)\//.test(h)))]);
    for (const h of hrefs) {
      await v.goto(new URL(h, PUBLIC).href);
      await v.waitForTimeout(8000);
      for (const t of ["cloud", "mesh", "splats"]) {
        if (h.includes("/3d/") && await v.locator(`[data-type=${t}]`).count()) {
          await v.click(`[data-type=${t}]`);
          await v.waitForTimeout(t === "mesh" ? 20000 : 8000);
        }
      }
    }
    // The mesh tiles: wait for the build the link started, then open the mesh again
    const tileEnd = Date.now() + 900000;
    while (Date.now() < tileEnd && !/"ready"/.test(onVm("sudo docker exec webapp sh -c 'cat /webodm/app/media/plugins/explorer/tiles/*/state.json 2>/dev/null' || true"))) await sleep(10000);
    clearInterval(memory);
    check(/"ready"/.test(onVm("sudo docker exec webapp sh -c 'cat /webodm/app/media/plugins/explorer/tiles/*/state.json 2>/dev/null' || true")), "mesh tiles built on the server");
    console.log(`  VM memory in use, peak while viewing and building: ${peak} MB of ${onVm("free -m | awk '/^Mem:/ { print $2 }'").trim()} MB`);
    const meshPage = hrefs.find((h) => h.includes("/3d/"));
    if (meshPage) {
      let tiles = 0;
      v.on("response", (r) => { if (/\/tiles\/.+\.(glb|json)/.test(r.url()) && r.status() === 200) tiles++; });
      await v.goto(new URL(meshPage.split("?")[0] + "?t=mesh", PUBLIC).href);
      await v.waitForTimeout(10000);
      check(tiles > 0, `the mesh streams as tiles through the proxy (${tiles} tile files)`);
    }
    const blocked = [...refused.entries()].filter(([p]) => !p.startsWith("/api/plugins/dji-thermal/"));
    console.log("  refused requests:", JSON.stringify([...refused.entries()]));
    check(blocked.length === 0, "nothing a link needs was refused");
    check(errors.length === 0, "no script errors on the link pages" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  } finally {
    await browser.close();
    tunnel.kill();
  }
  console.log(failures ? `${failures} check(s) failed` : "End to end passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

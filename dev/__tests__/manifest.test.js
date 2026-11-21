// The manifest WebODM and its plugin directory read: the fields they need, and the rules this repo keeps
const fs = require("fs");
const path = require("path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../explorer/manifest.json"), "utf8"));

test("the manifest has every field WebODM's plugin list shows", () => {
    for (const field of ["name", "webodmMinVersion", "description", "version", "author", "repository", "homepage", "tags"]) {
        expect(manifest[field]).toBeTruthy();
    }
});

test("the version is semantic and the minimum WebODM is 4.0 or later", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number(manifest.webodmMinVersion.split(".")[0])).toBeGreaterThanOrEqual(4);
});

test("the plugin stays experimental and not deprecated", () => {
    expect(manifest.experimental).toBe(true);
    expect(manifest.deprecated).toBe(false);
});

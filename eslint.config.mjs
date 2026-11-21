// ESLint for the plugin's front end: `npm run lint` at the repo root, or the VSCode ESLint extension
import js from "@eslint/js";
import globals from "globals";

export default [
    {ignores: ["**/node_modules/", ".venv/", "**/build/", "**/dist/", "ignored/", "explorer/public/vendor/"]},
    {
        // The plugin's scripts: plain ES5, loaded by <script> tags on every WebODM page (include_js_files) and by Jest
        files: ["explorer/public/*.js"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 5,
            sourceType: "script",
            // ES5 syntax, but the ES2015 Promise and typed arrays the browsers have; module and require for a UMD wrapper
            globals: {...globals.browser, Promise: "readonly", Symbol: "readonly", module: "readonly", require: "readonly", PluginsAPI: "readonly",
                DataView: "readonly", Uint8Array: "readonly", Uint16Array: "readonly", Float32Array: "readonly"},
        },
        // ES5 has no catch without a binding, so one left unused is no mistake
        rules: {...js.configs.recommended.rules, "no-unused-vars": ["error", {caughtErrors: "none"}]},
    },
    {
        // The point cloud worker: plain ES5 too, in a worker's scope
        files: ["explorer/public/ept-worker.js"],
        languageOptions: {globals: {...globals.worker}},
    },
    {
        // The 3D scene: an ES module, loaded through the import map in link_3d.html (three.js ships ES modules only)
        files: ["explorer/public/viewer/**/*.js"],
        ...js.configs.recommended,
        languageOptions: {ecmaVersion: 2022, sourceType: "module", globals: {...globals.browser}},
    },
    {
        files: ["explorer/public/__tests__/**/*.js", "dev/**/*.js"],
        ...js.configs.recommended,
        languageOptions: {ecmaVersion: 2022, sourceType: "commonjs", globals: {...globals.browser, ...globals.node, ...globals.jest}},
    },
];

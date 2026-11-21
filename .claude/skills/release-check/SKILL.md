---
name: release-check
description: Check a release of the Explorer plugin before merging its release/X.Y.Z branch - build the zip, install it in WebODM through Administration > Plugins as a user would, and check it live.
---

# Release check

On the `release/X.Y.Z` branch, with the version in `explorer/manifest.json`, `CHANGELOG.md` and `README.md` updated
and committed.

1. **The tests** (the `test` skill), including WebODM's `app.tests.test_plugins`.
2. **The zip:** `dev/package.sh`. Check its listing: one root folder `explorer/` with `manifest.json`, `plugin.py`,
   `LICENSE`; no `tests/`, `public/__tests__/`, `node_modules` or `__pycache__`. Note the sha256.
3. **WebODM without the mounted plugin:** ask the user first (this restarts their stack), then
   `EX_PLUGIN_DIR=<an empty folder in the scratchpad> dev/webodm.sh up --force-recreate webapp worker` and wait for
   http://localhost:8008 to answer. WebODM logs "Cleaned [explorer] plugin from database": only its row in the
   plugin list, not its data stores. If `/webodm/app/media/plugins/explorer` exists in `ex-webapp`, the upload is
   refused ("already exist"): move it aside, and back after step 6.
4. **Install the zip as a user would:** log in as the dev admin (the `live-check` skill), Administration >
   Plugins, Load Plugin (.zip). Restart the webapp if WebODM asks to.
5. **Live check on the installed copy** (the `live-check` skill): every feature in the README.
6. **Leave it as found:** remove the installed plugin in Administration > Plugins, then
   `dev/webodm.sh up --force-recreate webapp worker` without `EX_PLUGIN_DIR` to mount `explorer/` again.

Then merge the release branch into `main` and tell the user: the zip and its sha256, the tag to make
(`vX.Y.Z`), where to attach the zip (the GitHub release), and the `directory.json` entry for WebODM-Plugins
(a branch on the user's fork from upstream's current `main`, pushed only with the user's approval).

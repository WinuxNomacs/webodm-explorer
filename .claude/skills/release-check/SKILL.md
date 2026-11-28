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
3. **A throwaway WebODM** (`dev/rehearsal/`), never the dev stack: `dev/rehearsal/stack.sh up` runs WebODM 4.0.1 as
   users do (production settings, the image's own code, no plugin mounted, the dev stack's pinned images) on
   http://127.0.0.1:8010 only, containers `exr-*`, volumes `webodm-explorer-rehearsal_*`. Create its admin with a
   generated password kept in the scratchpad (`docker exec -it exr-webapp python manage.py createsuperuser` or
   WebODM's first-run page), and export `REHEARSAL_USER` and `REHEARSAL_PASSWORD` for the scripts below. Import a
   task with textured model, point cloud and orthophoto: the user's Roof Sample from the dev stack (its `all.zip`,
   downloaded as the dev account) through `POST /api/projects/<id>/tasks/import` (JWT from `/api/token-auth/`).
4. **Rehearse the upgrade** from the last published version (skip it for a release that changes neither code nor
   saved state, and say so):
   - `node dev/rehearsal/admin.js <repo> load <old zip>` (from its GitHub release), then
     `dev/rehearsal/stack.sh restart webapp worker`;
   - `node dev/rehearsal/state.js <repo> write <project>` (settings, Allow Links, three links), then
     `read <project> > before.json`; open a textured model through a link so its 3D Tiles build;
   - start a second build and, while its `state.json` says building, upgrade as users will:
     `admin.js <repo> update <new zip> <sha256>` (the same upload as the plugin browser's Update) or `delete explorer`
     then `load <new zip>`; restart webapp and worker;
   - `state.js read` again and compare with `before.json` (it must be identical); the first build is still served,
     and the interrupted one builds again when its model is opened.
5. **Live check on the installed copy:** the live-check scripts take `EXPLORER_BASE=http://127.0.0.1:8010` and
   `EXPLORER_WEBAPP=exr-webapp` (at least `link-tiles.js`, `link-cloud.js` and `measure-3d.js` on the imported task),
   and every other README feature by hand where no script covers it.
6. **Leave nothing behind:** `dev/rehearsal/stack.sh down -v` (the containers and volumes), and the scratchpad's
   password, zips and downloads. The dev stack on 8008 was never touched.

Then merge the release branch into `main` and tell the user: the zip and its sha256, the tag to make
(`vX.Y.Z`), where to attach the zip (the GitHub release), and the `directory.json` entry for WebODM-Plugins
(a branch on the user's fork from upstream's current `main`, pushed only with the user's approval).

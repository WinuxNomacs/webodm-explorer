# CLAUDE.md

What Claude needs to know to work on Explorer, a WebODM 4.0+ plugin. General working rules (branches, phases,
testing) live in the user's own CLAUDE.md; this file holds what is specific to this repository. It is committed and
public: nothing private, nothing true only on one machine. Keep it short; edit in place.

## Rules for this repository

- **The plugin is `explorer/`**: the released zip has that folder as its single root. Dev tools (`dev/`,
  `package.json`, `eslint.config.mjs`, `ruff.toml`, `requirements-dev.txt`) stay outside it.
- **Official plugin rules only**: the guide (https://docs.webodm.org/plugin-development-guide, also
  `ignored/WebODM-Docs/src/content/docs/plugin-development-guide.md`) and `ignored/WebODM-Plugins/guidance/index.md`:
  - Extension points are only those of `app/plugins/plugin_base.py` (`include_js_files`, `include_css_files`,
    `build_jsx_components`, `main_menu`, `root_mount_points`, `app_mount_points`, `api_mount_points`, data stores,
    `get_dynamic_script`, `python_imports` with a plugin `requirements.txt`, `enable`/`disable`), the server signals
    of `app/plugins/signals.py` (`task_completed`, `task_removing`, `task_removed`, `task_failed`,
    `task_resizing_images`, `task_duplicated`, `processing_node_removed`) and the `PluginsAPI` hooks and callbacks
    in `app/static/app/js/classes/plugins/` (`App.ready`, `Dashboard.*`, `Map.*`, `ModelView.addActionButton`,
    `SharePopup.addLinkControl`, `Workers.*`). No Django models or migrations (data goes in the plugin's data
    stores, `GlobalDataStore` and `UserDataStore`, which store it unencrypted).
  - One approved exception: share-link views subclass WebODM's tile and asset API views (`app/api/tiler.py`,
    `app/api/tasks.py`) and override only `get_and_check_task` with the link's token check (`upcoming-changes.md`,
    decision D1). Tests import those classes, so a WebODM release that changes them fails the tests. No other
    WebODM internals without the user's approval.
  - **No changes to WebODM itself; avoid pull requests to it.** A feature that needs a hook WebODM lacks is
    reported to the user first, with the ways to do without it; a pull request to WebODM is made only after the
    user approves that specific change.
  - No hard-coded colours: WebODM's theme variables (`app/templates/app/theme.css`). Look like the rest of
    WebODM, work on mobile, vanilla code over libraries (Python modules only from WebODM's `requirements.txt`),
    async work through `run_function_async` (`app/plugins/worker.py`, imports inside the function, JSON-only
    arguments). Imports work both from `coreplugins/` (dev) and `app/media/plugins/` (installed): relative
    imports inside the plugin, never `coreplugins.explorer` outside the tests.
  - The manifest says `"experimental": true` until the user decides otherwise; licence AGPL-3.0.
  - The guide's "no tests unless asked" does not apply: the user's rules ask for tests.
- **WebODM 4.0.0 and later**: Python 3.14, Django 5.2, DRF 3.18, Postgres 18 without GIS. The manifest's
  `webodmMinVersion` is 4.0.0; the dev stack runs the latest release (4.0.1). Ruff targets py314.
- **Never push and never tag.** No workflow runs yet. A release: Claude prepares a `release/X.Y.Z` branch (manifest
  version, `CHANGELOG.md`, `README.md`), builds the zip with `dev/package.sh` (`dist/explorer-X.Y.Z.zip` and its
  sha256), runs the `release-check` skill and merges; the user tags `vX.Y.Z`, attaches the zip to the GitHub release
  and adds `{url, sha256}` to WebODM-Plugins' `directory.json`.
- **Names in the UI are in Title Case**: headings, buttons, menu items and setting names; descriptions and messages
  are sentences.
- Planned in `upcoming-changes.md`; new requests arrive in `new.md` (untracked).

## Dev environment

- `ignored/WebODM` is a checkout of https://github.com/WebODM/WebODM (ignored by git) at the tag the pinned images
  were built from (`v4.0.1`, detached). The dev server runs that checkout, so a branch checked out there is live.
  `ignored/WebODM-Docs` is https://github.com/WebODM/Docs and `ignored/WebODM-Plugins`
  https://github.com/WebODM/WebODM-Plugins (the directory and its guidance).
- `dev/webodm.sh up | down | logs [service] | ps` runs WebODM 4.0.1 in dev mode with `explorer/` mounted as
  `/webodm/coreplugins/explorer`, on http://localhost:8008 (livereload 35736), containers `ex-webapp`, `ex-worker`,
  `ex-db`, `ex-broker`, `ex-node-odx-1`, project and volumes `webodm-explorer`, so it runs beside other WebODMs
  (TweakUI's stacks use 8005-8007). Images are pinned by digest in `dev/webodm.sh`. The processing node uses an
  NVIDIA GPU when Docker can (`EX_GPU=auto`, `dev/compose.gpu.yml`); `EX_GPU=0` runs it on the CPU.
- **`explorer/` is mounted live** and the server reloads on every save: check a Python change with Ruff on a scratch
  copy before it lands in `explorer/`, and have a scripted edit assert that every replacement matched before
  writing anything.
- The first start runs WebODM's dev setup (npm install, webpack, migrations) for several minutes before the server
  answers. The startup log then shows `Registered [coreplugins.explorer.plugin]`.
- JSX components (`build_jsx_components`) are built by webpack inside the dev container; plain scripts in
  `explorer/public/*.js` are ES5 (ESLint enforces it).
- Host tools: `uv venv --python 3.14 .venv && uv pip install -r requirements-dev.txt` (Django and DRF for the IDE,
  Ruff); `npm install` (Jest, ESLint, Playwright). VSCode: interpreter `.venv`, `ignored/WebODM` on Pylance's
  extra paths (local `.vscode/settings.json`); extensions Python, Pylance, Ruff, ESLint, Docker.

## Tests and checks

The `test`, `live-check` and `release-check` skills in `.claude/skills` have the steps.

- Django: `docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests.test_explorer`.
  One run at a time: runs share the stack's test database.
- Jest: `npm test` at the repo root (jsdom). ESLint: `npm run lint`.
- Ruff: `.venv/bin/ruff check .`
- Live checks: headless Playwright (Node) against http://localhost:8008 with a dev account from the user. Expected
  console error in dev mode: `localhost:35729/livereload.js` refused.
- WebODM's Django CSRF check applies to a plugin's API (WebODM routes it through a plain Django view): a POST,
  PATCH or DELETE needs the session's CSRF token even with basic or JWT authentication.

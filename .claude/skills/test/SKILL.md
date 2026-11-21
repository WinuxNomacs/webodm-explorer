---
name: test
description: Run the Explorer plugin's checks (Ruff, ESLint, Jest, Django tests in the dev container) before committing or merging.
---

# Tests and checks

From the repo root, with the dev stack up (`dev/webodm.sh ps`; start it with `dev/webodm.sh up`): WebODM 4.0.1,
container `ex-webapp`, http://localhost:8008.

1. **Ruff** (Python 3.14, WebODM 4.0's, and lint): `.venv/bin/ruff check .`
2. **ESLint** (the ES5 scripts in `explorer/public`, the dev scripts): `npm run lint`
3. **Jest**: `npm test` (add a path or `-t "<name>"` to run fewer).
4. **Django**: `docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests`.
   Before a merge, also WebODM's plugin tests: `app.tests.test_plugins`. Never two Django runs at once: they share
   the stack's test database.
   A test run starts WebODM in test mode, which adds a `test` plugin row to the dev database; until the webapp
   restarts, Administration > Plugins fails (500). Remove the row afterwards:
   `docker exec -w /webodm ex-webapp python manage.py shell -c "from app.plugins.functions import sync_plugin_db; sync_plugin_db()"`
5. **WebODM's own Jest** (only for a change to `ignored/WebODM`, which needs the user's approval): `docker exec -w
   /webodm ex-webapp npx jest`. Some suites need the UI mocks first:
   `docker exec -w /webodm ex-webapp python manage.py test app.tests.test_generate_ui_mocks --noinput`.

A failure is reported with its output. Before calling one pre-existing, check whether it also fails on `main`.

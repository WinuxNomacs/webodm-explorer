# Upcoming changes

## Phases (current and upcoming)

Up next:

1. **Define the plugin**: what Explorer does, who uses it and on which WebODM pages; then plan its first feature
   phase here.

Then: (from the definition)

Later: docs site (VitePress on GitHub Pages, as TweakUI) and screenshots, once there are features to show.

## Done

- **Project setup** (2026-11-21): plugin skeleton `explorer/` (manifest, `plugin.py`, Django tests in
  `explorer/tests/`), dev stack `dev/webodm.sh` (WebODM 4.0.1 by digest, http://localhost:8008), release zip
  `dev/package.sh`, Ruff/ESLint/Jest configs, skills `test`, `live-check`, `release-check`.

## Decisions

- **WebODM 4.0.0 minimum, dev stack on 4.0.1** (2026-11-21, Claude's default from the request "WebODM 4.0+"): one
  stack only; no 3.3.x support. The user may change it.
- **Plugin id `explorer`, name "Explorer"** (2026-11-21, from the repository name). Renaming is cheap until the
  first release.
- **Dev dependencies** (2026-11-21): the same pinned versions TweakUI vetted (ESLint 10.12.0, Jest 30.5.2,
  Playwright 1.64.1, Ruff 0.17.3; Django 5.2.18 and DRF 3.18.3 as WebODM v4.0.1's `requirements.txt`). Re-vet when
  upgrading.

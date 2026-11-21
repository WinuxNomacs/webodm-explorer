---
name: live-check
description: Check a UI change in a real headless browser against the plugin's dev server (WebODM 4.0.1 on http://localhost:8008), then remove whatever the check created. Use after building or fixing anything visible.
---

# Live browser check

## Login

Log in at http://localhost:8008/login/ with the dev account the user has given for this machine (kept in the
project memory, never in the repo). Without one, ask the user. Never look for credentials or cookies in files,
transcripts, the database or the environment.

## Driving the browser

Prefer the Playwright MCP tools (`mcp__playwright__*`) when they are loaded. Otherwise, write a Node script in
the scratchpad that loads Playwright from this repo (`require('<repo>/node_modules/playwright')`), launches
Chromium with `headless: true` and a fresh profile, logs in, and saves screenshots to the scratchpad. Read the
screenshots back to look at them, and read the page's console messages.

3D pages (WebODM's 3D view, Explorer's viewer): headless Chromium has WebGL2 through SwiftShader (software
rendering) on machines without a usable GPU. It renders correctly but slowly, so wait for the canvas to draw
(a few seconds, or a page signal) before taking a screenshot.

## What to check

- The change itself, on the pages it touches (Dashboard, Map, 3D Model view, ...), at desktop and phone widths,
  in the light and the dark theme where colours are involved.
- The plugin's scripts and stylesheets load (`/plugins/explorer/...`, no 404).
- The browser console has no new errors. Expected in dev mode: `localhost:35729/livereload.js` refused (WebODM's
  pages ask for that port; this stack maps livereload to 35736).

## Before and afterwards

Note what is there already: the user works on this server too. Give everything the check creates a name of its
own (e.g. starting "Live check"), delete only that afterwards, and say what was checked and what was removed.

## Scripted checks

- `link-shares.js` (in this folder): anyone-with-the-link shares end to end, the Share panel, the link page, the
  map and 3D pages at desktop and phone widths, and a revoke while the map is open. Run it from the repo root with
  the scratchpad as the screenshot folder, then read the screenshots and delete them. It assumes projects 1 and 2
  have completed tasks; adjust the ids for other data.
- `link-cloud.js` (same arguments, plus an optional project id, default 1, and task id prefix): the streamed point
  cloud on a link's 3D page, node counts as the camera zooms, switching type and back, phone width, a node
  answering 500, laz-perf's wasm missing, and a revoke while the cloud is open (the message shows once a node is
  refused: on a small cloud already fully loaded, none is). Creates one "Live check" link and revokes it.
- `link-downloads.js` (same arguments, plus an optional project id, default 2): Allow Downloads on the create form
  and on an existing link, the link page's Download menu at desktop and phone widths, one file downloaded as a
  visitor (deleted when the browser closes), 404s for a view-only link and once downloads are turned off, and
  `?filename=` ignored. Creates two "Live check" links and revokes both, also on failure.

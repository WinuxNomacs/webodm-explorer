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
- `link-tiles.js` (same arguments as `link-cloud.js`): the mesh tiles on a link's 3D page (built tiles needed:
  open the mesh once and wait for `state.json` to say ready), first view and tile counts as the camera zooms, phone
  width, `tileset.json` answering 500 (the GLB shows instead), the finest tiles answering 500 (skipped, no message),
  and a revoke while open. Creating its link queues the project's other meshes. Read the screenshots for the model's
  orientation (Z-up, as the GLB) and framing.
- `link-perf.js` (repo, user, password, then optional project id, task id prefix and types, default
  `cloud,mesh,splats`): smoothness on the real GPU (headless Chromium on Metal): time to the first view, then frame
  times (p50/p95/p99/max, frames over 33 and 100 ms) and long tasks while loading, orbiting and zooming, and idle.
  No screenshots. List the busy processes first (`ps -Ao pcpu,comm -r | head`, `docker stats --no-stream`) and
  report them with the numbers. Baseline (2026-11-21, M4 Pro, task 358acbe0): steady 16.7 ms frames while
  interacting for all three; one long task while loading: cloud 155 ms, mesh 543 ms, splats 114 ms.
- `list-view.js` (repo, screenshot folder, user, password): the home's List view, choosing projects without a
  reload, Up and Down, Back, a task row and back, the remembered view, and the phone layout. Choosing a view saves it
  for the user: the script puts back the view the user had. Creates nothing else.
- `task-page.js` (same arguments, plus an optional project id, default 2): the task page from a card's title, its
  views, menus, footprint map, details and Previous / Next at desktop and phone widths, View as Visitor, and through a
  link as a visitor (no node, report, WebODM pages or downloads). Creates one "Live check" link and revokes it.
- `sharing-center.js` (same arguments, plus an optional project id, default 2): the Sharing Center, the Explorer
  menu's drop-down, Create Link, Edit, Embed, the search in the address, an expired link's Renew (the link made to
  expire through the dev container's shell) and the same URL opening again, phone width, and the Share panel's Edit
  and its link to the Sharing Center. Creates one "Live check" link and revokes it, also on failure.
- `link-downloads.js` (same arguments, plus an optional project id, default 2): Allow Downloads on the create form
  and on an existing link, the link page's Download menu at desktop and phone widths, one file downloaded as a
  visitor (deleted when the browser closes), 404s for a view-only link and once downloads are turned off, and
  `?filename=` ignored. Creates two "Live check" links and revokes both, also on failure.

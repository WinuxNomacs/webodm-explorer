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
- `all-files.js` (repo, folder, user, password, optional project id, default 1, and task id prefix, default
  358acbe0): Allow All Task Files: the create form's box greyed out until Allow Downloads, a link's box greyed out
  (value kept) while downloads are off, the visitor's task page and map menus (All Assets last) and Processing
  Report, `cameras.json` downloaded, All Assets read up to its first bytes only, the menus' size at desktop and phone
  widths, the Sharing Center's Files cell, and a 404 once unticked. Creates one "Live check files" link and revokes
  it, also on failure; tokens masked.
- `search.js` (repo, folder, user, password, optional task word, default `homerun`, part of one task's name but not
  of its project's, and a word nothing matches): the home's Search Projects & Tasks, read-only: one letter asks
  nothing, two filter in place (timed from the keys to the swap), focus kept, emptying, one letter and Enter; List
  view's Search Results (a seventh argument, default `ro`, should be in several projects' task names), a project's
  narrowed pane, Show All Tasks, Back to Search Results and the browser's Back; Map view redrawn or saying nothing matches; phone width. Puts back the
  user's saved home view at the end.
- `present.js` (repo, folder, user, password, optional project id, default 2): the presentation tools on the
  signed-in map and 3D pages of a task with an orthophoto and a mesh: the laser drawn while the mouse still pans and
  orbits, a highlight drawn without moving the map and fading, Shift keeping one until Esc, Spotlight, the 3D page's
  frame times with and without the laser moving (Metal), and a phone with touch: one finger points without moving
  the map, two fingers still pinch, no sideways scroll. Creates nothing on the server.
- `frames.js` (repo, folder, user, password, optional project id, default 2, and task id prefix): Source Frames on
  the signed-in map and 3D pages of a task with camera shots: the map's window and Open Full Frame (arrows, Esc, the
  focus given back), the textured model's and the point cloud's spot near the best photo's middle (the offset is
  right), frame times and long tasks while the window loads, the Laser Pointer and Source Frames turning each other
  off, View as Visitor showing it unavailable, and a phone (the window as a sheet). Step B: a "Live check photos" link
  with Allow Source Photos used as a visitor (photos through the link, no Download until it allows downloads, a stray
  path refused, a revoke while open), revoked at the end, also on failure; its output masks tokens. On the point
  cloud a click can pick a stray point floating in front of the ground (task 25cdbf17, 2026-11-25): its best photos
  then show the spot in the sky, which is right for that point.
- `measure.js` (repo, screenshot folder, user, password, project id, task id with a DSM, then a folder holding
  `@turf/area` and `@turf/length` at 5.1.5, WebODM's versions: `npm install --ignore-scripts @turf/area@5.1.5
  @turf/length@5.1.5` in a scratch folder): the map page's Measure tool against WebODM's own ruler. Draws a polygon
  in WebODM's map, reads its popup and its Export to GeoJSON (in the page, nothing saved), then the same polygon in
  Explorer: Explorer's area is GeographicLib's, WebODM's is Turf's (the sphere's error between them is printed), and
  on WebODM's exact polygon Explorer's volume equals WebODM's popup's. Then one "Live check" link (revoked at the end,
  also on failure): a visitor's area, volume and elevation, the link's volume equal to WebODM's API's on the same
  points, no long tasks while drawing, and phone width. WebODM's popup reads leaflet-measure's own copy of the
  points, a few millimetres from the polygon it exports (2026-11-27: 0.2% on 150 m2), so it is compared loosely.
- `measure-3d.js` (repo, screenshot folder, user, password, project id, task id, the task's EPSG code; Chromium on the
  Metal GPU): the 3D page's Measure tool. Distance on the textured model, its horizontal part against pyproj's exact
  geodesic between the same points (run in `ex-webapp`), Point, Angle and Area; Area on the point cloud; then one
  "Live check" link (revoked at the end, also on failure): a visitor's distance on the cloud, the panel's unit switch,
  splats measured on the point cloud (a visitor's distance, the same points as the cloud view at the same pixels, no
  long tasks) and refused when the page is served without its cloud button, no long tasks while picking, the panel's
  fit (no mode name cut short), phone width. Picks slowed on purpose (`scene.pickFinest` wrapped with a delay): a
  double-click must finish an area with its own corner, and Clear must drop a pick still loading.
  Full detail: the same spots picked as the view shows them and at full detail (how far apart, cold and warm times),
  the cloud's picks against the DSM, and a fresh context with the full-detail tiles (`/LOD-0/`) refused, which must
  say the detail could not be loaded and measure nothing (its console fills with the refused requests on purpose:
  only its uncaught errors count); then close up (12 wheel steps in), where every spot on the view's surface must have
  a full-detail point within 25 cm (a close view once picked nothing).
  Baseline (2026-11-27, task 358acbe0, grid scale 0.9997): 39.64 m shown, 39.6411 m by pyproj, 39.6291 m in the grid
  alone.

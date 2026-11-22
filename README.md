# Explorer

A plugin for [WebODM](https://github.com/WebODM/WebODM) 4.0 and later, to browse and share a project's outputs.
Under development.

## Features

- **Explorer** in the main menu lists the projects you can view (WebODM's admins: every project), with **Search**
  (names, descriptions and tags), **All**, **Mine** or **Shared with Me**, sorting by **Recent Activity**, **Name**
  or **Created**, and **Has 3D** and **Shared by Link** filters, 24 projects to a page; the page's address keeps
  them, so a view can be bookmarked. Each card shows the project's picture, description, tags, a count per output
  type, its last activity, its owner when it isn't you, and its active links (marked when one expires within 7 days)
  for users who can share it. **Map** shows the projects where their tasks were flown, over WebODM's basemap.
- **A project's Explorer page** has the owner, tags and task count, an **Overview Map** of the tasks' footprints
  (folded when there is one task; a footprint opens its task), and a card per completed task with outputs: its
  thumbnail, date, images, size and processing time, tags, and buttons for its **Map** (orthophoto, DSM, DTM, thermal),
  **Point Cloud**, **Textured Model** and **Gaussian Splats**. These open in Explorer's own viewer, with a
  **Download** menu and **Open in WebODM** (WebODM's map and 3D pages, for their measurement tools); each card's
  "..." menu has the same. The page's "..." menu has **Open in Dashboard** and **View All on Map**. Where WebODM
  can't make a thumbnail (a thermal orthophoto, or a task with elevation models only), the card draws one from the
  task's map tiles, in the colours of its map.
- **View as Visitor** on a project's Explorer page shows the project as anyone with a link sees it (the link page,
  its maps and 3D views, with tiled models), without creating a link, for any signed-in user who can view the
  project.
- **Share** on a project's Explorer page shows and copies the page's link. It opens only for signed-in users the
  project is shared with (Dashboard: the project's Edit dialog, Permissions).
- **Anyone with the Link**, in the Share panel for users who can change the project: links that open the project
  without signing in, each with a label and an expiry (7, 30 or 90 days, or never), copied again or revoked at any
  time, or opened with **Open** to see them as visitors do. A link opens a page of the project's tasks, each with a **Map** and a 3D
  view of its **Point Cloud** (streamed node by node from WebODM's EPT, within the point budget WebODM's own 3D page
  uses: 10 million points on a computer, 2 million on a phone, 1 million on iOS), **Textured Model** and **Gaussian
  Splats**. The textured model streams as 3D Tiles (only what is on screen, finer close up), which Explorer builds
  from the task's mesh in WebODM's worker the first time it is shared or opened (a minute or two per mesh, at low
  priority, one at a time, kept in the plugin's folder in WebODM's media until the task is removed); until they are
  ready, the link shows WebODM's own model. A link serves only what these views stream, unless it has
  **Allow Downloads** (ticked when creating it, or on the link later): its task cards and views then get a **Download** menu
  with the orthophoto, DSM, DTM, point cloud (LAZ) and textured model (zip and glTF), but not the report, camera
  positions or All Assets. Links are kept in plain text in WebODM's database (so they can be copied again), and
  revoking one, or unticking Allow Downloads, takes effect at once.
- **A link's map** shows the orthophoto, DSM and DTM as WebODM's map draws them, and a thermal orthophoto as
  **Thermal** (degrees in the magma colours, first). Elevation and thermal layers get a legend, in metric or imperial
  units (the visitor's choice, remembered in their browser). Under the layer, one of the basemaps set in WebODM's
  Administration, Basemaps (its default first; the visitor can pick another or none).
- **Settings** on the Explorer page, for WebODM's admins: **Basemaps on Links** (on by default). Each visitor's
  browser loads a basemap's tiles from its provider (Google, Esri or OpenStreetMap with WebODM's own list), which
  then sees the visitor's address and the area viewed; turn it off where that matters.

## Install

When released: in WebODM, Administration > Plugins > Load Plugin (.zip), with `explorer-X.Y.Z.zip` from this
repository's releases.

## Development

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node.js 26 (`.nvmrc`), git.

```bash
git clone https://github.com/WebODM/WebODM ignored/WebODM && git -C ignored/WebODM switch --detach v4.0.1
uv venv --python 3.14 .venv && uv pip install -r requirements-dev.txt
npm install
dev/webodm.sh up        # WebODM 4.0.1 in dev mode on http://localhost:8008, with explorer/ mounted live
```

Checks:

```bash
.venv/bin/ruff check .
npm run lint
npm test
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
```

`dev/vendor.sh` fetches the pinned browser libraries (three.js, Spark, Leaflet, laz-perf, 3DTilesRendererJS) from
npm into `explorer/public/vendor/`. `dev/tools.sh` fetches the mesh tiling tools ([Obj2Tiles](https://github.com/OpenDroneMap/Obj2Tiles)
for Linux x64 and arm64, and [gltfpack](https://github.com/zeux/meshoptimizer), run by the Node.js in WebODM's
image) into `explorer/bin/`, which is not committed: run it once before `dev/webodm.sh up` so the dev worker can
build tiles. `dev/package.sh` runs it and builds the release zip `dist/explorer-X.Y.Z.zip` (about 27 MB, the tools
included), and prints its sha256.

## Licence

AGPL-3.0, see [LICENSE](LICENSE).

# Upcoming changes

## Phases (current and upcoming)

Up next:

1. **"Anyone with the link" shares, with 2D maps, splats and meshes** (planned 2026-11-21, ready to build): links
   made and revoked in the Explorer page's Share panel, a link page for visitors without an account, token-checked
   plugin views (D1), a Leaflet page for orthophoto/DSM/DTM, and Explorer's own three.js viewer with Spark splats
   and WebODM's downscaled GLB mesh. Details under "Plan: anyone-with-the-link shares" below.

Then:

2. **EPT point cloud streamer** in Explorer's viewer, written in the plugin (the user, 2026-11-21): `ept.json` and
   its hierarchy, nodes chosen by screen size, LAZ decoded in a worker (laz-perf, to vet when planning), drawn as
   `THREE.Points`; served through the token asset view's `entwine_pointcloud/`.
3. **On-demand mesh tiling and 3D Tiles in the viewer**: Obj2Tiles, bundled (D3, Linux x64/arm64), builds 3D Tiles
   for a task's mesh the first time it is shared or opened, cached in the plugin's persistent path; the viewer
   streams them with 3DTilesRendererJS (and ODX `--3d-tiles` output where it exists), replacing the GLB.

Later: COPC point clouds and a Range/caching asset endpoint (only if EPT through WebODM proves too slow);
docs site (VitePress on GitHub Pages, as TweakUI) and screenshots, once there are features to show.

## Explorer: sharing streamed viewers of a project's outputs

### The request (2026-11-21)

Share a link that lets someone open an Explorer viewer in WebODM and browse the orthophotos, 3D models and Gaussian
splats available, in a lightweight viewer built for large (multi-GB) geographic models that streams them, as
DroneDB does, so no one downloads gigabytes at a time. First step: research WebODM's built-in capabilities.

The user's answers (2026-11-21):

- **Recipients:** both kinds, chosen per share: anyone with the link, or WebODM users only.
- **Scope of a link:** a whole project, which stays current as tasks are added.
- **Conversion to streamable formats:** inside WebODM, on demand (the first time an output is shared or opened),
  then cached.

### Research findings (2026-11-21, WebODM v4.0.1)

Sources: WebODM's code in `ignored/WebODM` at v4.0.1 (paths below are relative to it; the key ones checked
by hand), WebODM's docs in `ignored/WebODM-Docs`, the plugin directory in `ignored/WebODM-Plugins`, and the
projects' GitHub repos, releases and registries, read 2026-11-21.

**What WebODM already streams** (the main finding: most of the streaming exists already):

| Output | Stored as | Served and shown | Streamed today? |
|---|---|---|---|
| Orthophoto, DSM, DTM | COG (made on import by `assure_cogs`, `app/cogeo.py`) | XYZ tiles rendered per request by a vendored rio-tiler (`app/api/tiler.py`), Leaflet | Yes |
| Point cloud | EPT (`entwine_pointcloud/`, entwine run on import if missing, `task.py` `check_ept`) | Potree 1.8.0 loads the octree node by node through `/assets/` | Yes |
| Gaussian splats | `splats/model.rad` (any uploaded .ply/.spz/.splat/.ksplat/.sog is converted by splat-tools) | Spark (`vendor/threedgs.umd.min.js`) `SplatMesh({paged: true})`, HTTP Range on `/assets/` (`api/tasks.py:753`, Range for `.rad` only) | Yes, with LOD |
| Textured mesh | `textured_model.glb` or OBJ+MTL | One full download; over 120 MB (60 mobile, 5 iOS) WebODM serves a texture-downscaled Draco copy (`task.py` `get_safe_textured_model`) | **No** |
| Mesh and point cloud as 3D Tiles | `assets/3d_tiles/{model,pointcloud}` when ODX ran with `--3d-tiles` | Download zip only; no viewer uses them | Not shown |

Splats are not produced by ODX: WebODM exports a COLMAP dataset, the user trains the splat elsewhere and uploads it
(since WebODM 3.3.0). Every asset byte passes through Django (gunicorn sync workers), with a permission check per
request and no cache headers; there is no X-Accel-Redirect.

**Sharing in WebODM:**

- A task or a project can be made public (`Task.public`, `Project.public`, plus `public_edit`). A public project
  gets a `public_id` UUID and one page: `/public/project/<public_id>/map/` (and `/iframe/map/`), a single 2D map of
  its tasks' orthophotos and DEMs. A public task has `/public/task/<id>/map/`, `/3d/?t=cloud|mesh|splats`, their
  iframes, and `/json/` (`app/urls.py:30-34`).
- Public means everything of the task to anyone with the link: tiles, every download including the full backup
  zip, and starting a splat training export (`get_and_check_task`, `api/tasks.py:479-490`).
- Between users: django-guardian permissions on the project ("r" view, "rw" edit), granted to users or groups by
  anyone who can edit the project. Tasks inherit their project's permissions.
- There is **no** public project page with 3D or with a list of its tasks, no expiring or revocable link apart
  from turning `public` off, no password, and no token access to a task that is not public.
- The Share popup's `PluginsAPI.SharePopup.addLinkControl` hook lets a plugin add a control (it receives the popup,
  with `props.task` or `props.project`). The shortlinks and editshortlinks plugins use it: their links only redirect
  to WebODM's public pages, so the task must still be public. **The popup makes its task or project public as soon
  as it opens** (`SharePopup.jsx` `componentDidMount` calls `handleEnableSharing` when `public` is false), so it
  cannot hold a "WebODM users only" control; it opens only from the Share button on the map and 3D pages.
- **Hard limit for a plugin:** a link token cannot make WebODM's own endpoints (tiles, assets, 3D view) serve a
  project that is not public. Only three ways round it: (a) the plugin turns the project's `public` on;
  (b) plugin endpoints check the token and serve tiles and assets themselves; (c) a hook in WebODM (a pull
  request, which we avoid).

**DroneDB** (github.com/DroneDB, read 2026-11-21): the approach is the useful part, not the code.

- Approach: on upload, `ddb build` turns each file into a streamable form (COG served as XYZ tiles; COPC;
  meshes into 3D Tiles with Obj2Tiles and its own bm3d/Nexus formats; splats into SPZ then Spark `.rad` with
  LOD). It then serves the results as static files read by Range requests. Viewers: OpenLayers, Potree with
  copc.js, Nexus, Spark, Giro3D.
- The code doesn't fit: Registry and Hub are AGPL-3.0 for non-profits and individuals only (a paid licence for
  companies), which is not compatible with a plain AGPL plugin. The ddb core is native C++ (a 116 MB package).
  The project is essentially one maintainer.
- WebODM-Plugins' `dronedb` plugin only uploads a task's outputs to a DroneDB server (hub.dronedb.app). It
  stores the user's DroneDB password in plain text in its data store.

**Formats and renderers for streaming** (vetted 2026-11-21 from repos and registries; re-vet before adding any):

| Output | Format | Build tool | Renderer | Licence | Health |
|---|---|---|---|---|---|
| Ortho, DEMs | COG as XYZ tiles | none (WebODM does it) | Leaflet (WebODM's) | BSD | n/a: WebODM's own |
| Point cloud | EPT (now); COPC optional | entwine (WebODM); PDAL `writers.copc` (PDAL 2.6.2 in the image) | Potree 1.8 (WebODM's 1.8.0; 1.8.2 also reads COPC) | BSD-2 | Potree: slow, but repackaged on npm 2026-11-20 |
| Textured mesh | OGC 3D Tiles (glTF/b3dm) | Obj2Tiles (OpenDroneMap, AGPL-3.0, v1.10.3 2026-11-17; in ODX, **not** in the WebODM image) | 3DTilesRendererJS (NASA-AMMOS, Apache-2.0, v0.5.4 2026-11-03, 15 authors in 6 months) on three.js | AGPL / Apache-2.0 / MIT | Healthy |
| Splats | Spark `.rad`, paged, LOD | splat-tools (in the image) | Spark (MIT, v2.4.0 2026-10-20) | MIT | Healthy, WebODM's choice |

Rejected: mkkellogg GaussianSplats3D ("no longer in active development", recommends Spark); CesiumJS (covers
mesh, point cloud and splat 3D Tiles but not EPT or `.rad`, and is by far the heaviest); client-side COG reading
(geotiff.js is the least active, and would need Range on `.tif`, which WebODM doesn't serve); PlayCanvas
streamed SOG (a second 3D engine); Nexus (needs `nxsbuild`, in no image).

Unverified: the exact Spark version WebODM vendors. How WebODM runs Spark (three.js 0.180+) beside Potree's
three.js r124. Whether a plugin template can mount WebODM's `ModelView` bundle (`render_bundle 'ModelView'`).
How PDAL's COPC writer holds up on multi-GB clouds.

### What the plugin adds (within the plugin rules)

- **A project Explorer page** (`app_mount_points`): it lists the project's tasks with thumbnails and their outputs.
  The 2D map comes from WebODM's tile endpoints; point clouds and splats are streamed as WebODM streams them;
  meshes come as 3D Tiles where they exist. Signed-in access checks `view_project`.
- **Share links** stored in the plugin's global data store (token -> project, mode, creator, created; revocable),
  created and revoked through an `api_mount_points` view and the Explorer page's Share button (not WebODM's Share
  popup, which makes the project public on opening). Removed on project or task deletion (signals) where they
  apply.
- **On-demand mesh tiling** through `run_function_async`, written to the plugin's persistent path
  (`get_persistent_path`), never to the task's folder.

### Plan: anyone-with-the-link shares (decided 2026-11-21)

Checked in WebODM v4.0.1's code unless marked otherwise.

- **Who makes links:** users with `change_project`, the permission WebODM's own public toggle needs
  (`DjangoObjectPermissions` on PATCH). The Explorer page's Share panel gains a list of the project's links (label,
  created, expires, Copy, Revoke) and a form: label, expiry (never, 7, 30 or 90 days; 30 by default). Users without
  `change_project` see only the "WebODM users only" link, as now.
- **Links:** `secrets.token_urlsafe(32)`, kept in plain text so they can be copied again (the user's choice;
  plugin data is unencrypted, so a database dump exposes live links). One `GlobalDataStore` key per project,
  `links:<project_id>`, holds its links; a second key per link, `token:<token>` -> project id, finds it (the data
  store has no listing or prefix query). Every write runs in `transaction.atomic()` under
  `pg_advisory_xact_lock` (Postgres always: Docker installs only), so a revoke and a create at the same moment
  cannot bring a revoked link back. Expired links are refused on read and dropped at the next write. A deleted
  project's links are refused (the project is gone) and their keys dropped at lookup; WebODM has no
  project-removed signal.
- **API** (`api_mount_points`, session auth, CSRF as WebODM requires): list, create and revoke under
  `/api/plugins/explorer/projects/<id>/links/`; each checks `change_project`.
- **Link page** `/plugins/explorer/s/<token>/` (`app_mount_points`, no login): the project's name and the same task
  cards as the signed-in page, the buttons opening Explorer's own pages below. An unknown, revoked or expired link
  gets one plain 404 page (no hint which). Link pages and token views send `Referrer-Policy: strict-origin`, and the
  HTML `Cache-Control: private, no-store`, so the token doesn't leak through Referer headers or shared caches.
- **Token views** (D1; `api_mount_points` under `/api/plugins/explorer/s/<token>/tasks/<task_id>/...`): subclasses
  of `TileJson`, `Bounds`, `Metadata`, `Tiles`, `TaskThumbnail`, `TaskAssets` and `TaskSafeTexturedModel` (added by
  the user's choice of a GLB until meshes are tiled), overriding only `get_and_check_task`: the token must be live
  and the task must be in its project and completed. `dispatch` takes the token out of the URL kwargs (WebODM's
  `get` methods don't accept it). The asset subclass serves only `entwine_pointcloud/` and `splats/model.rad` (and
  `3d_tiles/` from phase 3), because WebODM's own `TaskAssets` serves anything under `assets/` (the full point
  cloud, report, camera positions). `TileJson`'s tile URLs point at WebODM's own tile view, so the token map page
  builds its tile URL itself. No downloads.
- **2D map page** `/plugins/explorer/s/<token>/map/<task_id>/`: Leaflet 1.9.4, vendored (D4), an XYZ layer from the
  token tile view with an Orthophoto/DSM/DTM switch, fitted to `Bounds`; no basemap (one would send visitors'
  addresses to a tile provider; to revisit if wanted).
- **3D viewer page** `/plugins/explorer/s/<token>/3d/<task_id>/?t=mesh|splats`: three.js r187 with an import map,
  Spark 2.4.0 `SplatMesh({paged: true})` on the token `.rad` URL, the GLB from the token `TaskSafeTexturedModel`
  view (`?platform=mobile|ios` as WebODM's 3D page does) with three's `GLTFLoader` and `DRACOLoader`; orbit
  controls; a switch between the types the task has. Point clouds come in phase 2.
  **To check first when building (UNVERIFIED):** that Spark 2.4.0 reads the `.rad` files WebODM 4.0.1 writes
  (WebODM loads them with its own Spark build on three r124, `threedgs.umd.min.js`), and whether WebODM's GLB is
  Draco-compressed and which decoder three r187 needs.
- **How it can fail and what happens:** a link revoked or expired mid-visit: the next tile or asset request gets a
  404 and the page says "This link is no longer valid". A task removed after sharing: 404 for that task only. A
  data store entry that doesn't parse: treated as no links for that project, logged, replaced at the next write
  (never a 500). A lock wait past Postgres's timeout: a 503, and the Share panel says so. Heavy tile rendering by
  anonymous visitors costs what WebODM's public projects cost; no rate limit in this phase (noted for later).
- **Tests:** Django: link create/list/revoke permissions and CSRF; each token view refusing an unknown, revoked or
  expired token, a task from another project, a task not completed, and an asset outside the allowed folders
  (including `../` and URL-encoded traversal); imports of the subclassed WebODM views (they fail loudly if WebODM
  renames them); concurrent revoke and create (two threads) never bringing a link back; a broken data store
  entry. Jest: the Share panel's list and form, the viewer's type switch with stand-in loaders. Live: a link opened
  in a fresh browser without login on the user's projects, at desktop and phone widths; a revoke while it is open.

### Phase 1 plan: Project Explorer page and "WebODM users only" links (decided 2026-11-21, built: see "Done")

Checked in WebODM v4.0.1's code:

- **Pages** (`app_mount_points`, `login_required`, server-rendered templates extending `app/logged_in_base.html`,
  no webpack build):
  - `/plugins/explorer/`: the projects the user can view (`view_project`), each linking to its Explorer page.
    Reached from an **"Explorer" item in the left main menu** (`main_menu`), shown to every signed-in user.
  - `/plugins/explorer/project/<id>/`: 404 without `view_project`, as WebODM's own `/map/project/<id>/` does
    (`app/views/app.py`). One card per **completed task with at least one viewable output** (queued, running,
    failed and cancelled tasks left out; new tasks appear on reload): thumbnail
    (`/api/projects/<p>/tasks/<t>/thumbnail`, when an orthophoto exists), name, date, and a button per output in
    `available_assets`: one **Map** button naming the layers it has (Orthophoto, DSM, DTM) opens
    `/map/project/<p>/task/<t>/` (found while building: WebODM's map page cannot pick a layer from its URL, so
    three buttons would all open the same page); Point Cloud, Textured Model
    and Gaussian Splats open `/3d/project/<p>/task/<t>/?t=cloud|mesh|splats` (the `t` parameter WebODM's
    `model_display` passes to `ModelView`). A "View All on Map" button opens `/map/project/<p>/`.
- **Share button** on the project's Explorer page: copies the page's URL and says that only users the project is
  shared with (Dashboard > project panel > Edit > permissions) can open it. Nothing is stored for these links.
- **Not used:** a button in the Dashboard's project panel (`Dashboard.addNewTaskButton` is drawn only for users
  with `add` permission, `ProjectListItem.jsx`), and WebODM's Share popup (see the research findings).
- Tests: Django tests for the menu item, the project list (only viewable projects), the 404 without permission,
  which tasks get cards and which buttons each gets; a live check in the browser on mobile and desktop widths.

### The options weighed for D1-D4 (all decided 2026-11-21: see "Decisions")

- **D1: how an anonymous link grants access.**
  - (a) The plugin turns on WebODM's own project sharing and the link works only while it is on. Simple, and
    WebODM's endpoints serve everything. But anyone with a task's id gets all of it, the backup zip included,
    and revoking means turning the project's `public` off.
  - (b) The plugin serves what the viewer needs behind its token: tiles, EPT nodes, `.rad` ranges, 3D Tiles. The
    project stays private, and links can expire or be revoked one by one. Checked in code: WebODM's `Tiles`,
    `TileJson`, `Metadata`, `Bounds` (`app/api/tiler.py`) and `TaskAssets`, `TaskThumbnail` (`app/api/tasks.py`)
    all call `self.get_and_check_task`. So plugin views mounted with `api_mount_points` can subclass them and
    override only that check, which reuses WebODM's tile rendering and Range serving rather than re-implementing
    them. Costs:
    - It subclasses WebODM internals, which are not a plugin API, so a WebODM release can break it (tests catch it).
    - WebODM's map and 3D pages hard-code `/api/projects/...` URLs, so anonymous links need Explorer's own viewer.
    - The token is in the URL.
    - The check also runs per tile and node: the token, and that the task belongs to the token's project
      (`get_and_check_task` ignores `project_pk`).
    - It exposes only viewing: no downloads, backup zip or exports.
  - (c) Ask WebODM for a share hook in `get_and_check_task`. A pull request: only with the user's approval.
- **D2: which viewer to start from.** Link to WebODM's existing map and 3D pages first (phase 2 delivers
  quickly), or build the Explorer's own three.js viewer from the start (one viewer to switch between tasks and
  types, needed anyway for 3D Tiles meshes).
- **D3: tasks without 3D Tiles.** Ship or fetch the Obj2Tiles binary (.NET, AGPL-3.0, per platform; not a
  Python module, so outside the "WebODM's requirements.txt" rule as written), or ask users to process with ODX's
  `--3d-tiles` and fall back to WebODM's GLB otherwise.
- **D4: how JS libraries ship.** Vendored prebuilt files in `explorer/public/vendor/` (works on every install,
  plain ES5 scripts) or a JSX build (`build_jsx_components`, marked experimental, needs webpack where the plugin
  is installed).

## Done

- **Project Explorer page and "WebODM users only" links** (2026-11-21): `explorer/plugin.py` (main menu item, the
  two pages), `explorer/pages.py` (viewable projects, which tasks get cards, their buttons),
  `explorer/templates/`, `explorer/public/explorer.{js,css}` (Share panel, thumbnail fallback). Tests:
  `explorer/tests/test_explorer.py` (Django), `explorer/public/__tests__/explorer.test.js` (Jest). Checked live on
  WebODM 4.0.1 at desktop and phone widths with the user's projects. Found live: WebODM's thumbnail endpoint answers
  404 for a greyscale orthophoto, so a thumbnail that fails falls back to the placeholder.

- **Project setup** (2026-11-21): plugin skeleton `explorer/` (manifest, `plugin.py`, Django tests in
  `explorer/tests/`), dev stack `dev/webodm.sh` (WebODM 4.0.1 by digest, http://localhost:8008), release zip
  `dev/package.sh`, Ruff/ESLint/Jest configs, skills `test`, `live-check`, `release-check`.

## Decisions

- **Docker installs of WebODM only, not the native Windows app** (the user, 2026-11-21): Postgres is always the
  database (link storage may use its locks); bundled binaries are Linux x64 and arm64 only (D3).
- **WebODM 4.0.0 minimum, dev stack on 4.0.1** (2026-11-21, Claude's default from the request "WebODM 4.0+"): one
  stack only; no 3.3.x support. The user may change it.
- **Plugin id `explorer`, name "Explorer"** (2026-11-21, from the repository name). Renaming is cheap until the
  first release.
- **Dev dependencies** (2026-11-21): the same pinned versions TweakUI vetted (ESLint 10.12.0, Jest 30.5.2,
  Playwright 1.64.1, Ruff 0.17.3; Django 5.2.18 and DRF 3.18.3 as WebODM v4.0.1's `requirements.txt`). Re-vet when
  upgrading.
- **D1: anonymous links are tokens checked by the plugin, which serves what its viewer needs** (the user,
  2026-11-21): plugin views (`api_mount_points`) subclass WebODM's `Tiles`, `TileJson`, `Metadata`, `Bounds`,
  `TaskAssets`, `TaskThumbnail` and (2026-11-21) `TaskSafeTexturedModel`, and override only `get_and_check_task`. The project stays private, and links
  are view-only, can expire and can be revoked. This is an exception to "official extension points only",
  approved for this use; tests import those classes so a WebODM release that changes them fails loudly.
- **D2: WebODM's viewers first** (the user, 2026-11-21): the project page links to WebODM's map and 3D views;
  Explorer's own viewer comes with the mesh phase.
- **D3: Obj2Tiles bundled in the zip** (the user, 2026-11-21): v1.10.3 (2026-11-17) release zips are 10-11 MB
  each for Linux x64/arm64 and macOS, 21-22 MB for Windows x64/arm64. Platforms: Linux x64 and arm64 only (Docker
  installs only, decided 2026-11-21). AGPL-3.0, like the plugin.
- **D4: vendored prebuilt JS** (the user, 2026-11-21): pinned builds in `explorer/public/vendor/`.
- **Phase 1** (the user, 2026-11-21): reached from a main menu item and a project list; lists completed tasks with
  outputs only; merged with the "WebODM users only" links phase.
- **Anyone-with-the-link shares** (the user, 2026-11-21): point clouds through an EPT streamer written in the
  plugin (its own phase); meshes as WebODM's downscaled GLB (`TaskSafeTexturedModel` subclassed too, widening D1
  by one view) until they are tiled; links kept so they can be copied again.
- **Viewer libraries** (vetted 2026-11-21 from npm and GitHub): three.js 0.187.0 (MIT, 2026-10-30, ~10 releases a
  year); Spark 2.4.0 (MIT, 2026-10-20, releases every 1-2 months, ~4 active contributors, peer three >=0.180,
  paged `.rad` in the release, prebuilt `dist/spark.module.min.js`); 3DTilesRendererJS 0.5.4 (Apache-2.0,
  2026-11-03, monthly, mostly one maintainer, peer three >=0.167, `preprocessURL`/`fetchOptions` for tokens,
  advisory GHSA-x68m-9hr9-xr2j fixed in 0.5.1; for phase 3); Leaflet 1.9.4 (BSD-2-Clause, 2023-05-18, the current
  stable; 2.0 in betas, repo active 2026-11-20, no advisories). Rejected for EPT: potree-core 2.0.17 (dropped EPT),
  @pnext/three-loader 1.0.0 (no EPT, three ~0.160), iTowns 2.46.0 (three ^0.174), Giro3D 2.0.7 (no EPT found,
  three ^0.180, OpenLayers). Running Spark and 3DTilesRendererJS together on r187 is unverified.
- **Playwright MCP** (the user, 2026-11-21): `@playwright/mcp@0.0.86` (Microsoft, Apache-2.0, 2026-11-18; pins a
  Playwright 1.66 pre-release), added with local scope for this project only, headless and isolated; the scripted
  Playwright 1.64.1 checks stay.
- **Explorer's share control lives on the Explorer page, not in WebODM's Share popup** (the user, 2026-11-21):
  the popup makes its project or task public as soon as it opens.
- **Share links**: per project; per share, "anyone with the link" or "WebODM users only"; streamable formats
  built inside WebODM on demand and cached (the user, 2026-11-21).

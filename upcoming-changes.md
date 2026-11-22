# Upcoming changes

## Phases (current and upcoming)

Up next: **3D backgrounds** (the request 2026-11-22, plan below): Grid, Sky or Space behind the 3D views.

Built: **Explorer UX: the project hub** (the request 2026-11-21, plan below) is built, all four
steps (see "Done"). Its steps, each a phase: 1. defects (single-band colours and legend, thumbnail fallback, 3D
framing; done); 2. navigation hub (home and project pages, with Explorer's viewer for signed-in users and Open in
WebODM; done); 3. viewer polish (done); 4. showcase (link landing page, embed; done).

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

### Plan: anyone-with-the-link shares (decided 2026-11-21, built: see "Done")

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
  Both checks made first when building passed (see "Done"): Spark 2.4.0 reads WebODM 4.0.1's `.rad` in paged
  mode, and the GLB requires Draco, which three r187's glTF Draco decoder handles.
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
- **Build order:**
  1. Run the two checks above before writing anything else, as a throwaway page in the scratchpad: Spark 2.4.0
     loading one of the user's `splats/model.rad` files, and the GLB's Draco use. If Spark can't read WebODM's
     `.rad`, stop and bring the options to the user.
  2. Link storage and API, then token views with their tests.
  3. Share panel, link page, 2D map page, 3D viewer, then README and the live check.
- **Tooling this phase needs** (checked 2026-11-21 unless marked otherwise):
  - **Fetching the libraries:** npm reaches three 0.187.0, `@sparkjsdev/spark` 2.4.0 and leaflet 1.9.4. Vendor
    them with `dev/vendor.sh` (written):
    - `npm pack` each pinned version into the scratchpad;
    - copy only the files the pages load, plus each library's licence, into
      `explorer/public/vendor/<lib>-<version>/`;
    - print their sha256 sums.
  - **ESLint and Jest:** the viewer is ES modules (three r187 ships ESM only), while ESLint holds
    `explorer/public/*.js` to ES5.
    - ESLint: give the viewer its own folder, `explorer/public/viewer/`, and its own config block (ecmaVersion
      2022, `sourceType: "module"`).
    - Jest: as built, the viewer's logic (type switch, URLs, messages) is in `viewer-ui.js`, an ES5 script like
      `explorer.js`, tested with a stand-in scene; only `viewer/scene.js` imports three. Jest's ESM support was not
      needed.
  - **Browser checks:** headless Chromium (Playwright 1.64.1, already installed with its browsers) gives WebGL2
    through SwiftShader, which is software rendering. That is enough for Spark and three in a live check, but slow,
    so allow longer waits. The Playwright MCP (`mcp__playwright__*`) is configured, but its tools did not load
    in the session that built this phase; the Node script route in the `live-check` skill was used.

### Plan: downloads through links (decided 2026-11-21, built: see "Done")

- **Setting it** (Share panel on a project's Explorer page, Anyone with the Link section): an Allow Downloads
  checkbox on the create form (off by default) and a toggle on each existing link; links made before this phase
  have it off. Stored on the link (`downloads: true|false`), changed under the same advisory lock.
- **What can be downloaded** (output files only): the point cloud (`georeferenced_model.laz`, and `.las`/`.ply`/
  `.csv` where they exist), the textured model (`textured_model.zip`, `textured_model.glb`), `orthophoto.tif`,
  `dsm.tif`, `dtm.tif`, from the task's `available_assets`. Not `all.zip`, the report, camera positions, tiles zips
  or other files.
- **Serving** (D1 widened by `TaskDownloads`, approved 2026-11-21): a token view subclassing WebODM's
  `TaskDownloads` (`app/api/tasks.py`), overriding only `get_and_check_task`, plus the allowlist above and a check
  that the link allows downloads; 404 otherwise. Deferred zips (`textured_model.zip`) are built by WebODM's own
  code path.
- **Link page**: each task card gets a Download menu listing that task's allowed files, only on links that allow
  downloads.

### Plan: on-demand mesh tiling and 3D Tiles (decided 2026-11-21, built: see "Done")

- **The user's answers** (2026-11-21): measure Obj2Tiles on the user's meshes in the dev worker before building;
  KTX2 textures (WebP if KTX2's quality proves poor on the user's meshes); the Explorer page for signed-in users
  keeps WebODM's own 3D page, never Explorer's viewer.

- **Why** (checked 2026-11-21 on the user's three tasks): ODM's textured meshes have 684k-831k faces and 56-126
  textures of 4096x4096 each (the OBJ). WebODM's GLB, which the link's 3D page loads whole, is that mesh with Draco
  geometry and downscaled JPEG textures: 6, 25 and 64 MB, holding 18, 81 and 261 Mpx of texture, all on the GPU at
  once (about 4 bytes a pixel uncompressed: roughly 1 GB for the biggest). No task has ODX's `--3d-tiles` output.
  Tiles load only what is on screen, with finer detail than the GLB close up.
- **Obj2Tiles measured** (2026-11-21, the dev worker, arm64, 14 cores; the user's three meshes):
  - `--preset standard --local --glb --unlit --texture-format Ktx2`: 47, 60 and 91 s; 162-275 MB in 3,500-4,100
    files; project 2's TIFF textures read fine. The finest level keeps 65, 186 and 517 Mpx of texture (2-3.6 times the
    GLB's) but in 23,000-46,000 textures, about 11 per tile (one per source texture it touches: many draw calls).
  - The root tile is the problem for a first view: 8-12 MB, of which almost all is geometry (246k-360k faces stored
    uncompressed, about 33 bytes a face), whatever `--lods` is. Obj2Tiles has no geometry compression (issue 87,
    a Draco request, closed).
  - `--single-material-per-part` (one atlas per tile) halves the size (85-99 MB, 1,360 files on project 2, 27-29 s)
    but keeps only 22-29 Mpx at the finest level, less detail than the default; `--max-texture-size 0` doesn't change
    that. `--no-root-content` drops the root but the coarsest level is then 16 tiles of up to 1.2 MB each.
  - So Obj2Tiles alone doesn't give a smooth first view. A post-pass that compresses geometry (and simplifies the
    root) is needed; candidate: gltfpack 1.3.0 (meshoptimizer, MIT, 2026-09-25, releases every 3 months, essentially
    one maintainer with 4,213 of the commits, no advisories; its npm build is 348 KB of WebAssembly with no
    dependencies, run by the Node 20 that WebODM's image already has, so one copy serves x64 and arm64; three.js
    reads its output with its own `meshopt_decoder` in `examples/jsm/libs`, to vendor beside Draco and basis). Approved by the user (2026-11-21), widening D3.
  - gltfpack measured (2026-11-21, project 2's build): `-cc` (meshopt compression and quantization) takes the root
    from 12.4 MB to 3.1 MB in 0.15 s; with `-si 0.25` (a quarter of the faces) to 1.25 MB, `-si 0.1` to 0.75 MB
    (WebODM's GLB: 6 MB). Across a sample of finer tiles, 34% smaller (their KTX2 textures dominate). The same output
    from WebODM's Node 20 in the worker, about 30 ms a tile with one process each: about 2 minutes for 4,100 tiles,
    less in parallel or with its library in one process. KTX2 textures pass through untouched.
  - To check while building: hairline cracks between neighbouring tiles from per-tile quantization (else `-vpf`),
    and the simplified root's `geometricError` raised to match, so the renderer refines it at the right distance.
- **Baseline** (2026-11-21, `link-perf.js`, headless Chromium on an Apple M4 Pro through Metal, task 358acbe0,
  light background load): all three viewers keep 16.7 ms frames (60 fps) while orbiting and zooming and when idle;
  each has one long task while loading: point cloud 155 ms (first view 0.5 s), mesh 543 ms (first view 1.0 s),
  splats 114 ms (0.4 s). The mesh's 543 ms freeze is what tiles should remove; the other two are worth finding.
  Phones are untested and will be slower.
- **Smoothness first** (the user's rule, 2026-11-21): the phase starts by adding a frame-time measurement to the
  live checks (a real GPU through headless Chromium on Metal, frame times and long tasks while orbiting and zooming)
  and measuring today's three viewers, so the tiles are judged against the GLB, and anything poor in the point cloud
  or splats is fixed first.
- **Build**: Obj2Tiles 1.10.3 (D3), Linux x64 and arm64 binaries in the zip (12 MB each zipped; each comes with
  `libktx.so` for KTX2 textures). WebODM's plugin install unzips with `zipfile`, which drops the executable bit, so
  the plugin copies the binary into its persistent path and makes it executable before the first build. Run through
  `run_function_async` on the worker: `--preset standard --local --glb --unlit --progress --texture-format Ktx2` (octree tiles, decimated
  LODs, half-size textures per coarser LOD, textures as baked). Not yet run on the user's meshes: build time and size
  to be measured first; project 2's textures are TIFFs that Pillow can't read, so whether Obj2Tiles reads them is to
  be checked.
- **When**: as decided, the first time a mesh is shared or opened: creating an anyone-with-the-link share queues every
  task of the project that has a mesh, a task completed in a shared project is queued, and opening a mesh with no
  tiles queues it. One build at a time.
- **While it builds, the visitor sees the GLB as today**, with a quiet note ("Preparing a faster view"); when the tiles
  are ready, the next open uses them. Nothing waits on a build.
- **Cache**: `<persistent path>/tiles/<task id>/<build id>/`, built in a temporary folder and renamed when
  `tileset.json` has been read back; removed when the task is removed or reprocessed. As built: ODX's
  `3d_tiles/model` output is not used (no task has it, and its tiles' geometry isn't compressed); the build's state is
  a `state.json` file beside the builds under a file lock (`fcntl.flock`, shared by the web and worker containers
  through WebODM's media volume) rather than the plugin's data store, so the state goes with the tiles.
- **Serving**: a token view serving that folder (only `.json`, `.glb`, `.b3dm`, `.jpg`, `.webp`, `.ktx2`, paths
  resolved inside the build folder only: no path traversal), with long cache headers since a build id never changes,
  so a second visit loads from the browser's cache.
- **Viewer**: 3DTilesRendererJS 0.5.4 (vetted 2026-11-21: Apache-2.0, imports only `three` and `three/addons`, which
  the import map already serves; `TilesFadePlugin` for LOD changes without popping, `UpdateOnChangePlugin` so idle
  views cost nothing), its parse queue limited per frame so tiles never cause long tasks, memory cache smaller on
  phones (as the point budget). As built: no `UpdateOnChangePlugin` (fading needs an update every frame) and the
  renderer's own queues; meshopt decoding runs in workers and KTX2 transcoding in the loader's; measured, the longest
  task while tiles load is 79 ms (the GLB's: 543 ms).
- **Failures** (the build runs unattended):
  - The binary missing, not executable or for another platform: no build, the GLB stays; the reason is logged.
  - Obj2Tiles exits non-zero or reports `{"stage":"error"}`: the build is marked failed with its message, the
    temporary folder removed; tried again after 24 h or when the task is reprocessed.
  - A build that hangs: no progress line for 10 minutes, or over its deadline (scaled to the face count): SIGTERM,
    then SIGKILL after 30 s; then as a failure.
  - The disk too full: free space checked before starting (twice the OBJ and its textures), a write error fails the
    build; the temporary folder is removed either way.
  - The worker restarts mid-build: the build's state carries a heartbeat written on each progress line; a stale one
    counts as failed and its temporary folder is removed on the next attempt.
  - Two requests for the same task: one owner, the build's state under the task's file lock; a second request finds
    it queued and does nothing.
  - A tool that keeps writing past its deadline: stopped as well (the deadline is checked on every line; a test
    found the first version checking it only during silence).
  - The task reprocessed or removed during a build: the result is checked against the task's mesh (size and time)
    before the rename and discarded if stale; `task_removing` removes the cache.
  - A tile or `tileset.json` failing in the browser: as point cloud nodes (retry once, then skip); a tileset that
    can't load at all falls back to the GLB.

### Plan: EPT point cloud streamer (decided 2026-11-21, built: see "Done")

- **Data checked** (the user's three clouds on the dev stack, 2026-11-21): entwine EPT 1.1.0, `dataType: laszip`,
  `hierarchyType: json`, LAS point format 3 (RGB) with 4 extra bytes (`OriginId`), 38 bytes a point; the largest
  has 124M points in 2,789 nodes (biggest node 932 KB) and a single hierarchy file. RGB values seen were in the
  8-bit range though LAS stores 16 bits, so the viewer scales by the cloud's range (as Potree does).
- **Decoder**: laz-perf 0.0.7 (approved 2026-11-21), vendored by `dev/vendor.sh` (`lib/worker/laz-perf.js`, a
  classic script defining `createLazPerf`, and its 214 KB wasm). Decoded the user's root node (25,154 points) in
  11 ms under Node.
- **Viewer**: a Point Cloud button on the link's 3D page beside Mesh and Splats. Reads `ept.json` and the
  hierarchy (following `-1` subtree pointers into `ept-hierarchy/<key>.json`), picks nodes by projected size
  within a point budget (to be set by measuring; lower on phones), nearest and largest first; fetches them through
  the token asset view (`entwine_pointcloud/`, already allowed), decodes in a worker pool, draws `THREE.Points`
  with RGB, offset to the cloud's centre for float precision; frees nodes that leave the selection.
- **Colouring**: RGB only in this phase (the user, 2026-11-21).
- **Failures** (what each dependency can do, and what happens):
  - `ept.json`, the root hierarchy or the root node fails (network, 5xx, timeout after 60 s): retried once after
    1 s, then the view fails with the page's error message, or "no longer valid" if the link page answers 404.
  - A node or subtree hierarchy file fails after the view opened: retried once (not on 404), then skipped for this
    view; the page checks the link and says "no longer valid" only if it is gone.
  - A fetch that hangs: aborted after 60 s, then as a failure.
  - laz-perf's script or wasm fails to load in every worker: the view fails with the error message.
  - A worker that errs or takes over 30 s on a node: terminated and replaced, the node counted as failed; once no
    worker can start, every queued node fails.
  - A corrupt node (decode throws): skipped; laz-perf's memory is freed either way.
  - Memory: loaded points beyond 1.5 times the budget are freed, least recently shown first (never the root).
  - Unsupported EPT (`dataType` other than `laszip`, other hierarchy types, bad bounds): the error message.
- Streaming lets a determined visitor fetch every node and rebuild the full-resolution cloud; the user chose to
  offer full downloads per link instead (previous plan).

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

### The request: Explorer UX, the project hub (2026-11-21)

Explorer becomes the project navigation and interactive browsing hub for WebODM users and admins: browsing,
viewing and showcasing results. Claude's UX review (2026-11-21, every page on the dev data at 1440 and 390 wide):

- Home: project cards show a name and a task count only; no search, sort, filter, dates, output types or share
  status. Admins see only projects shared with them (`pages.viewable_projects`, `accept_global_perms=False`).
- Project page: up to four equal blue buttons per task card, thumbnail not clickable, no task facts; active links
  visible only inside Share. Signed-in users leave for WebODM's pages and nothing leads back.
- Link and Preview pages: single-band layers (the thermal Roof Sample, DSMs) render grey with no colour ramp or
  legend (WebODM's map shows magma and a legend); the thermal task's thumbnail answers 404 from WebODM, so its cards
  show the placeholder; no basemap; 3D views lack fullscreen, reset, controls help and previous/next task; framing
  includes stray fragments (the house sits low on HomerunObliqueRGB); on a phone the view buttons take two rows and
  the Preview bar three lines.
- Showcase: a link opens on the same grid of buttons; no cover, featured view or landing page; WebODM's navbar
  shows a stray unit menu.

The user's answers (2026-11-21):

- **An additional UI in the plugin's own space, not a replacement for WebODM's**: Explorer's viewer may serve
  signed-in users too (revises D2); WebODM's pages stay as they are.
- **Admins see every project** in Explorer.
- **"Editing" means Open in WebODM**: where sensible, each view offers Open in WebODM 2D or 3D for its tools
  (measurement and the rest); no editing in Explorer.
- **Basemap on link maps** (the user, 2026-11-21, Claude's recommendation after the risks: visitors' IP and the
  site's location go to the provider, providers' terms, offline installs, misalignment): on by default with a
  Basemap switch and the providers' credits, from the basemaps the admin configured in WebODM (Administration,
  Basemaps; WebODM ships Google Maps Hybrid as default, ESRI Satellite, OpenStreetMap), and an admin setting in
  Explorer that turns basemaps off on links. **Approved WebODM internal:** `app.models.Basemap.get_cached_basemaps()`
  (no API exposes the list); a test imports it.

### Plan: UX step 1, defects and the basemap (decided 2026-11-21)

- **Thermal layer and legends.** An orthophoto with two bands (one value and alpha, as WebODM's Map.jsx tests it)
  gets a Thermal layer as WebODM draws it (`formula=Celsius`, `bands=L`, `color_map=magma`). DSM, DTM and Thermal
  get a legend: the colour ramp from the metadata's `color_maps` and the stretched range, with a unit switch
  (m/ft, °C/°F) remembered in the browser.
- **Thumbnail fallback.** WebODM's thumbnail API answers 404 for an orthophoto of fewer than three bands
  (`TaskThumbnail`). A card whose thumbnail fails draws one from the task's tiles instead (the Thermal or DSM
  colours, up to four 256 px tiles on a canvas, off the critical path), else keeps the placeholder icon. Same on the
  Explorer home's project cards.
- **3D framing.** The 2 % per-axis trim still frames the stray fragments of HomerunObliqueRGB. Frame on the median
  centre and the radius holding most of the sampled points instead; checked on the user's meshes, splats and clouds.
- **Basemap.** As decided above: the link and Preview map pages get the admin's basemaps (TMS and WMS) under the
  layer, a Basemap switch with None, credits, and the default basemap on; an admin-only Settings panel on the
  Explorer home holds "Basemaps on Links" (on), stored in the plugin's `GlobalDataStore`.
- What fails, and what happens: a basemap provider down or blocked shows the layer on grey (tile errors are not
  page errors); metadata for the legend failing hides the legend only; a tile failing in a thumbnail keeps the icon.

### Plan: UX step 2, the navigation hub (decided 2026-11-21)

Facts checked in WebODM v4.0.1: a superuser passes every `has_perm` (Django's ModelBackend), so admins can already
open any project's Explorer page; only the list leaves them out (`pages.viewable_projects`). Projects and tasks have
WebODM tags (`tags`; a leading "." marks WebODM's own, as `.dji-thermal-dataset`); tasks keep their footprints in
WGS84 (`orthophoto_extent`, `dsm_extent`, `dtm_extent`, GeoJSON polygons), `images_count`, `size` (MB) and
`processing_time` (ms).

- **Explorer home** (`/plugins/explorer/`):
  - a toolbar: Search (project names, descriptions and tags), a scope switch (All for admins and the default for
    them, Mine, Shared with Me), Sort (Recent Activity, the default; Name; Created), and Has 3D / Shared by Link
    filters. Server-side, in the page's address (bookmarkable, works without JS), 24 projects a page;
  - richer cards: the picture, name, two lines of description, user tags, an icon and count per output type (Map,
    Point Cloud, Textured Model, Splats), last activity ("Updated 3 days ago"), the owner when it isn't you, and a
    link badge (active links, "expires soon" within 7 days) for users who can share;
  - optional: a Grid / Map switch, the Map showing each project at its tasks' footprints (decision 2).
- **Project page** (`/plugins/explorer/project/<id>/`):
  - header: name, description, owner, tags, task count; Share (primary, with the active links count), View as
    Visitor (today's Preview), and a "..." menu with Open in Dashboard and View All on Map (WebODM's pages);
  - optional: an overview map of the tasks' footprints above the cards, a footprint opening its task (decision 3);
  - task cards: the thumbnail opens the task (decision 1), outputs as compact chips instead of four full buttons, a
    facts line (date, images, size, processing time), user tags, and a "..." menu: Open in WebODM (Map, 3D),
    Download (WebODM's own downloads, for users who can view the task).
- **Phone width:** the toolbar stacks (Search full width, the rest in one row), cards one per row, chips wrap.
- **Smoothness:** one query for a page of projects with their tasks, link counts read per project on the page
  only (at most 24), thumbnails lazy as now; the footprint maps draw GeoJSON outlines (no tiles of the tasks).
- What can fail: a project without tasks (no picture, "No outputs yet"), extents missing (left off the maps), the
  links store busy (the badge left out, never a page error), a bad page or sort in the address (the first
  page, or the last for a number past the end; the default sort).

The user's answers (2026-11-21): all three as recommended.

1. Fold step 3 in: the cards open Explorer's own viewer for signed-in users (today's Preview pages without the
   Preview bar, with Download for users who may and **Open in WebODM** on the map and 3D views for the measurement
   tools); View as Visitor keeps the visitor's version. Recommended: yes, the hub then keeps users in Explorer.
2. The Explorer home's Map view of all projects. Recommended: yes.
3. The project page's overview map of task footprints. Recommended: yes, folded away when a project has one task.

### Plan: UX step 3, viewer polish (decided 2026-11-22)

Explorer's map and 3D pages (the visitor's link pages, View as Visitor and the signed-in viewer share them). Checked
in the code: the 3D page has OrbitControls with damping and nothing else (no fullscreen, reset, help or way to the
next task); the map page has Leaflet's zoom buttons, the layer switch, the basemap picker and the legend; neither
page knows the project's other tasks. The stray unit menu on link pages in the dev stack comes from the DJI Thermal
plugin installed there (its scripts load on every page), not from WebODM or Explorer: left alone.

- **Both pages:**
  - **Fullscreen** (the browser's Fullscreen API on the viewer, shortcut F; the button left out where the browser
    has no element fullscreen, as iPhone Safari, from training knowledge, to check live);
  - **Reset View** (shortcut R): the 3D page re-frames the model, the map fits the layer again;
  - **Previous / Next task** in the bar: the project's other tasks in the cards' order (newest first), keeping the
    view type where the next task has it, else its first view; the page title and address follow, so Back works;
  - **phone width:** one row of controls (view buttons as icons with their names in titles), the View as Visitor bar
    on one line.
- **3D page:**
  - **Controls help** ("?"): mouse, touch and keys for orbit, pan, zoom and the shortcuts;
  - **double-click (double-tap) to focus**: the camera turns to orbit the point clicked (a raycast on the shown
    model; the point cloud's nearest point on screen);
  - point cloud **Point Size** and **Colour by Elevation** (with a legend of the elevation range, in the unit chosen
    on the map's legend).
- **Map page:** a **layer opacity** slider (to see the basemap under the layer), a **scale bar** in the legend's
  unit system (metric or imperial).
- **Thumbnails:** the faint seams between the tiles of a drawn thumbnail (step 1) removed.
- **Smoothness:** no new work per frame except what a control turns on; focus raycasts only on double-click, on
  the shown tiles or the points already on screen; fullscreen and resizes go through the existing ResizeObserver.
  The live check measures frame times while orbiting before and after, on the real GPU.
- What can fail: fullscreen refused (the button stays, nothing happens, no error shown); a double-click on empty
  space (nothing happens); the next task removed meanwhile (its page answers as a link page does for a task it
  doesn't open); a link whose project has one task (no Previous / Next).

The user's answers (2026-11-22), both as recommended:

1. Previous / Next on every page, visitors' link pages included (they browse a shared project the same way).
2. Point cloud options: both Point Size and Colour by Elevation (elevation colour helps read terrain and buildings
   when RGB is flat or missing).

### Plan: UX step 4, showcase (decided 2026-11-22)

Facts checked in WebODM v4.0.1: no `XFrameOptionsMiddleware` and no frame headers (`webodm/settings.py`; a live
response has no `X-Frame-Options`), so every page, Explorer's included, can be framed by any site; WebODM's own
public share offers iframe code for its `/public/.../iframe/map/` and `/iframe/3d/` pages (SharePopup.jsx). The
session cookie is sent in third-party frames (`SESSION_COOKIE_SAMESITE = None`). Explorer's link page today is the
project name, description and the task cards.

- **Security fix first (clickjacking):** a site framing Explorer's signed-in project page could trick a signed-in
  owner into clicking Create Link or Revoke. Explorer's signed-in pages (home, project page, own viewer, View as
  Visitor) get `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`; link pages stay
  frameable (they change nothing, and embedding is the point).
- **The link landing page** (`/s/<token>/`): a cover with the project's name, description and the featured task's
  picture with its **Open** buttons; a facts line (tasks, images, last update); the Overview Map of the tasks'
  footprints when Basemaps on Links is on (outlines alone say little); then the task cards as today.
- **Embeds:** in the Share panel, each link gets **Embed**: pick a task and a view (Map, Point Cloud, Textured
  Model, Gaussian Splats) or the whole link page, then copy iframe code. The embedded page is the map or 3D page in
  an embed layout (`?embed=1`): no WebODM header, no back link or Previous / Next, the view controls kept, and an
  **Open Full View** link to the link's page in a new tab. Revoking the link stops the embed; anyone who can read
  the host page can read the link in its code (said in the panel).
- **Smoothness:** the landing page loads the cover picture first, the map and cards lazily as now; an embedded 3D
  view loads like the link's own (no extra work), and the live check measures it inside a frame.
- What can fail: a project without tasks (a plain cover, "Nothing to show here yet"); a revoked link in an embed (its "no longer valid" message); a browser blocking
  third-party storage in the frame (preferences not kept, the page works).

The user's answers (2026-11-22):

1. The featured task is **the newest automatically** (not the recommendation of an owner's choice): nothing to set
   or store; "the featured task removed or failed" above cannot happen.
2. **Link previews: yes** (as recommended): Open Graph and Twitter card tags with the project's name, description
   and the newest task's picture, through the link; pages stay `noindex` for search engines.

### The request: 3D backgrounds (2026-11-22)

"Instead of just white, can empty space optionally be drawn as a dark 3d grid, or 3d sky background, or 3d
galaxy/space background? User selectable, default to grid view."

Builds on the 3D page (`explorer/templates/link_3d.html`, `explorer/public/viewer/scene.js`), shared by link pages,
View as Visitor and the signed-in viewer. Today the canvas is transparent (`alpha: true`), so the page's theme colour
(white in WebODM's default theme) shows behind the model. The 2D map page is not affected (its basemap fills it).

### Plan: 3D backgrounds (decided 2026-11-22)

- **Where:** a Background button (picture icon) in the 3D page's bar, in the View Controls group beside Reset View,
  Fullscreen and Controls; it opens a small menu: Grid, Sky, Space, Plain (today's look: the page's theme colour). Each visitor's choice is
  remembered in their browser, as Point Size is; the default is Grid. It applies to all three views (point cloud,
  mesh, splats) and survives switching between them.
- **Grid:** a dark background with a ground grid under the model, at the bottom of its framing box (slightly below,
  so flat ground doesn't flicker against it). Minor and major lines in metres, the spacing chosen from the model's
  size (1, 10, 100 m ...), fading out with distance so it reads as an endless floor. One plane drawn by a small
  shader: no per-frame work in script. The model hides it where it is in front.
- **Sky and Space are drawn in code**, no image files (the user, 2026-11-22: nothing to license or download).
- **Sky:** a gradient sky (pale at the horizon, deeper blue overhead, a soft haze below the horizon), Z-up as the
  outputs are.
- **Space:** a starfield with a faint galactic band, fixed in direction (it turns with the camera, never moves).
- **Smoothness:** Sky and Space are drawn once into a cube texture (smaller on phones) and set as the scene's
  background, a single draw per frame; switching background never reloads the model. The live check measures frame
  times with each background on the real GPU, against the step 3 baseline.
- Double-click focus ignores the grid (it picks only the model). Point cloud colours and the elevation legend stay
  as they are.

## Done

- **UX step 4: showcase** (2026-11-22, branch `ux-showcase`):
  - Code: `explorer/plugin.py` (`no_framing` and `signed_in_page`: `X-Frame-Options: SAMEORIGIN` and
    `frame-ancestors 'self'` on the home, project page, own viewer and View as Visitor; `embedded`, `preview_meta`;
    the landing page's cover, facts and Overview Map in `list_page`), `explorer/pages.py` (`link_footprints`,
    `cover_facts`, `embed_views`), templates `link.html` (the cover), `meta.html` (Open Graph and Twitter tags, the
    embed's header hidden), `link_map.html`, `link_3d.html` (embed layout: Open Full View, no Previous / Next),
    `project.html` (the views to embed), `explorer/public/explorer.js` (Embed in the Share panel, `embedCode` with
    attributes escaped), `explorer.css`.
  - Tests: `explorer/tests/test_showcase.py` (Django), `explorer/public/__tests__/embed.test.js` (Jest; a project name
    trying to break out of the iframe's attributes).
  - Live check (headless Chromium, the user's project 1, a "Live check" link revoked after): the cover's picture in
    0.3 s, the preview image answering 200 through the link, the Share panel's Embed, the embedded point cloud inside
    another page (header hidden, no Previous / Next, Fullscreen offered, steady 16.7 ms frames), desktop and phone.
    The signed-in project page answers with both frame headers. Framed from another page in Chrome over plain http, it
    showed the login page: Chrome doesn't send WebODM's `SameSite=None` session cookie without `Secure`. On an https
    WebODM the cookie is sent, and the headers are what stop the frame.

- **UX step 3: viewer polish** (2026-11-22, branch `ux-polish`):
  - Code: `explorer/pages.py` (`neighbours`: the tasks before and after in the cards' order, a URL per view each
    has), `explorer/plugin.py`, templates `neighbours.html`, `link_3d.html` (controls, help, point cloud panel),
    `link_map.html` (opacity, controls), `viewer_tools.html` (icons on phones), `preview_bar.html`;
    `explorer/public/viewer-controls.js` (Fullscreen, Reset View, keys R and F, help, Previous / Next following the
    view), `viewer-ui.js` (the point cloud panel and its legend, `?t=` kept in the address), `viewer/scene.js`
    (`reset`, `pick`, double-click and double-tap focus), `viewer/ept.js` (shared style uniforms: size scale,
    elevation colour between the root node's 2nd and 98th percentile heights), `map.js` (opacity, scale bar, reset),
    `layers.js` (viridis stops), `linkpage.js` (fullscreen height), `explorer.js` (thumbnail tiles drawn at whole
    pixels: the seams came from fractional offsets), `explorer.css`.
  - Tests: `explorer/tests/test_polish.py` (Django), `explorer/public/__tests__/viewer-polish.test.js` and the
    whole-pixel check in `thumbnails.test.js` (Jest); failures injected: fullscreen refused, unsupported, a
    remembered size out of range.
  - Live check (headless Chromium on the M4 Pro's GPU, the user's projects): Colour by Elevation 209-237 m, a point
    cloud pick in 4 ms, focus and Reset on the mesh tiles, Fullscreen on and off (F), help and Escape, Next keeping
    the mesh view, the address following the type switch, opacity and a 10 m scale bar; phone: the 3D bar in one
    row, the map's in two (three layers, basemap and opacity don't fit one). Smoothness (`link-perf.js`, the stack
    idle): steady 16.7 ms frames while interacting for cloud, mesh and splats; one long task while loading (cloud
    156 ms, mesh 80 ms; baseline 155 and 543 ms). Fullscreen on a real iPhone not checked.

- **UX step 2: the navigation hub** (2026-11-21, branch `ux-hub`):
  - Code: `explorer/pages.py` (`HomeQuery`, `home_query`, `home_projects`, `home_page`, `project_summaries`,
    `home_map`, cards as dicts with `open`, `webodm`, `facts`, `tags`, `footprint`; `task_footprints`, `user_tags`,
    `duration`, `disk_size`), `explorer/links.py` (`index:linked` with `linked_project_ids`, built once for links
    saved before it; `summary` for the badge), `explorer/plugin.py` (the home's query, the project page's header,
    `own_viewer` at `project/<id>/map|3d/<task>/`, `viewer_context` with downloads and Open in WebODM),
    `explorer/options.py` (`signed_in_basemaps`), templates `projects.html`, `project.html`, `cards.html`,
    `viewer_tools.html`, `link_map.html`, `link_3d.html`, `preview_bar.html` (View as Visitor),
    `explorer/public/footprints.js` (the home's Map view and the Overview Map), `layers.js` (`basemapLayer` and
    `chosenBasemap`, shared with `map.js`), `explorer.js` (the toolbar applies at once, leaves defaults out of the
    address), `explorer.css`.
  - Tests: `explorer/tests/test_hub.py` (Django), `explorer/public/__tests__/footprints.test.js` and the toolbar in
    `explorer.test.js` (Jest); failures injected: the links store raising (filter empty, page answers), footprint
    data that doesn't parse, an index missing for links saved before it.
  - Live check (headless Chromium on the M4 Pro's GPU, the user's two projects, desktop and phone): the home's cards,
    sort, Map view; the project pages' Overview Map, card menus, a card opening Explorer's map with Download and Open in
    WebODM; no long tasks on any of these pages, the server answering in 20-31 ms, loads in 60-125 ms (with two
    projects; Spotlight busy on the Mac, the stack idle).
  - Also found: a drawn thermal thumbnail shows faint seams between its tiles (from step 1, left for step 3).
  - The home's and project page's maps use `Basemap.get_cached_basemaps()` as the link map does: approved by the user
    2026-11-22 (CLAUDE.md's approved exceptions).

- **UX step 1: thermal layer and legends, drawn thumbnails, framing, basemaps** (2026-11-21, branch `ux-defects`):
  `explorer/public/layers.js` (each layer's parameters and stretch as WebODM's map, legends, the tiles a thumbnail
  needs), `map.js` (legend with a unit switch, the admin's basemaps under the layer with a picker),
  `explorer.js` (thumbnails drawn from tiles when near the screen; the admins' Settings panel), `frame.js` (median
  centre and the radius of 90 % of the points; the mesh tiles re-frame on their root tile, which a child tile can
  beat to it, unless the visitor moved), `options.py` and `api.Settings` (Basemaps on Links, superusers only),
  `pages.is_thermal`, `pages.thumbnail`. Tests: `tests/test_ux.py`, Jest `layers.test.js`, `thumbnails.test.js`,
  `map.test.js`. Live check (desktop and phone, the user's data): Thermal legend 10.6-50.3 °C as WebODM's map shows
  it; Roof Sample's card and project card drawn in magma; Google basemap by default, ESRI and none switch; the house
  framed on HomerunObliqueRGB's tiles, GLB and splats. One long task of about 185 ms while the mesh tiles load,
  with or without the re-frame (not compared with `main`; the machine was busy: another WebODM stack at 33 % CPU).

- **Preview without a link** (the user, 2026-11-21): **Preview** in the project page's header opens the link pages
  for a signed-in user who can view the project, with a bar saying so and Back to Explorer. They read WebODM's own
  API (the same paths as the token views, with WebODM's permission check) and Explorer's signed-in mesh tiles view;
  no Download menu, as on a link without Allow Downloads. Code: `explorer/plugin.py` (link and preview pages share
  `list_page`, `map_page`, `page_3d` over a `pages.Viewer`), `explorer/api.py` (`MeshTilesView`, `PreviewMeshTiles`),
  `explorer/templates/preview_bar.html`, `link*.html` (`tiles_api`), `project.html`. Also fixed: the map and 3D
  pages scrolled the window by 14 px (the page's bottom padding), now taken off the view (`linkpage.js`
  `fitHeight`). Tests: `explorer/tests/test_preview.py`. Checked live at desktop and phone widths: the list page, map,
  point cloud (0.3 s), splats (0.5 s), mesh tiles (0.5 s), no window scroll.

- **Fixes the user reported** (2026-11-21): the Share panel's Link for WebODM Users showed the origin twice
  (`explorer.js` prepended it to the field's value, which a browser restoring the field on reload or back already
  holds: now from a `data-path` attribute, with `autocomplete="off"`; the doubling itself was not reproduced in
  headless Chromium); a page address without its trailing slash answered 404 (WebODM's plugin routing has no
  APPEND_SLASH and falls through to the public files: every page now also has a slashless mount point that
  redirects, keeping the query string, `plugin.py` `with_and_without_slash`). Added at the user's request: **Open**
  on each link in the Share panel opens the link page in a new tab, as visitors see it. Tests:
  `explorer/tests/test_explorer.py`, `explorer/public/__tests__/{explorer,links}.test.js`; checked live (reload,
  back, slashless project and link pages, Open).

- **On-demand mesh tiling and 3D Tiles** (2026-11-21):
  - Code: `explorer/tiles_build.py` (the worker's build: Obj2Tiles, then gltfpack on every tile with the root
    simplified to a quarter; one build at a time, at the lowest CPU priority, with a deadline, a stall limit,
    SIGTERM then SIGKILL, heartbeats, a disk space check and a read-back before the build is published; the state
    file and the queue decision), `explorer/tiles.py` (queuing on link creation, task completion in a shared project
    and a 3D page without tiles; the async entry that loads the build by path), `explorer/api.py`
    (`TokenMeshTiles`, the tiles through the link's token, immutable caching), `explorer/plugin.py` (the mount, the
    `task_completed` and `task_removing` receivers, the 3D page's tileset), `explorer/public/viewer/scene.js`
    (3DTilesRendererJS with KTX2, meshopt in workers, fading, the fetch deadline and retry, the GLB fallback, the
    group turned back to Z-up), `explorer/public/viewer-ui.js` (tile memory per device, the "faster view" note),
    `explorer/templates/link_3d.html`, `dev/tools.sh`, `dev/vendor.sh` (3DTilesRendererJS 0.5.4, three's KTX2
    loader, Basis transcoder and meshopt decoder), `dev/package.sh`.
  - Tests: `explorer/tests/test_tiles.py` (Django; stand-ins for Obj2Tiles and gltfpack that exit with errors,
    report an error stage, stall, keep writing past the deadline, name a missing tile, change or remove the mesh
    mid-build; each failure seen failing before its fix where a fix was needed: the stall default bound too early,
    the deadline checked only in silence, Obj2Tiles' null `children`), `explorer/public/__tests__/viewer.test.js`
    (Jest: the fallback URL, the note, memory per device).
  - Checked live on WebODM 4.0.1 with the user's project 1 (`link-tiles.js` and `link-perf.js` in the `live-check`
    skill; headless Chromium on the M4 Pro's GPU): builds of 84 and 128 s (117 and 219 MB); the tiled mesh's first
    view in 0.5-0.6 s with 65 tiles (14 MB) against 1.0 s for the 25 MB GLB, one 76-79 ms long task while loading
    against 543 ms, 16.7 ms frames while orbiting; 285 tiles after zooming in; phone width (the root tile alone,
    2 MB); a failing `tileset.json` shows the GLB; failing tiles skipped with no message; a revoke says "no longer
    valid". During a build the point cloud and tiles opened as fast as without one (0.3 s, 0.6 s).
  - Found while building:
    - Obj2Tiles 1.10.3 `--local` keeps the OBJ's Z-up coordinates in its glTF tiles but writes bounding volumes that
      match them only after glTF's Y-up turn, so the viewer turns the tiles' group back instead of changing the
      tileset (which would break culling). It writes `"children": null` and `"transform": null` on leaves.
    - Obj2Tiles' root tile is 8-12 MB of uncompressed geometry whatever `--lods` is; gltfpack takes it to about
      1.2-2 MB. `--single-material-per-part` loses texture detail.
    - The tiles must be framed on the tileset's bounds before any loads: the renderer loads nothing outside the
      camera's view, the root included. A tile can arrive before it is attached to the turned group (phones).
    - On the dev machine a running build slows the GLB view (8.5 s instead of 1.0 s) because the browser and the
      Docker VM share the Mac's CPU; the GLB itself downloads in 0.36 s during a build. A visitor's browser runs
      elsewhere, and the tiles' view is unaffected.

- **EPT point cloud streamer** (2026-11-21):
  - Code: `explorer/public/ept-tree.js` (octree, hierarchy, node selection as Potree: biggest on screen first,
    150 px minimum node size, within the point budget), `explorer/public/ept-decode.js` (LAZ node to float32
    positions and 8-bit colours; 16-bit colours detected from the root node), `explorer/public/ept-worker.js`
    (laz-perf in a worker), `explorer/public/viewer/ept.js` (fetching with deadlines and retries, the worker pool,
    `THREE.Points` with a small point shader sized from the deepest shown level, the cache),
    `explorer/public/viewer/scene.js` (the cloud type; framing fits the narrower angle, so phones held upright see
    the whole model), `explorer/public/viewer-ui.js` (point budget per device as WebODM's ModelView.jsx: 10M, 2M
    mobile, 1M iOS; node failures), `explorer/pages.py` (Point Cloud first among 3D types, as on WebODM's own 3D
    page), `explorer/templates/link_3d.html`, `dev/vendor.sh` (laz-perf 0.0.7).
  - Tests: `explorer/public/__tests__/{ept-tree,ept-decode,viewer}.test.js` (Jest; decoding against a laz-perf
    stand-in that can grow its memory or fail mid-file, the memory-growth test seen failing without the fix),
    `explorer/tests/test_links.py` (the 3D page's cloud URL and laz-perf paths, node and hierarchy files through the
    token asset view).
  - Checked live on WebODM 4.0.1 (headless Chromium, SwiftShader) with the user's clouds (`link-cloud.js` in the
    `live-check` skill): the 124M-point cloud's first view in about 0.2 s with 22 nodes (509k points), 84 nodes after
    zooming in; switching type and back; phone width; nodes answering 500 skipped with no message; a missing wasm
    showing the error message; a revoke while open showing "no longer valid". Frame rates on real GPUs were not
    measured.
  - Found while building: the Python `.gitignore` pattern `lib/` hid laz-perf's `lib/worker/` (now un-ignored as
    `build/` and `dist/` are); the entwine clouds WebODM 4.0.1 builds hold 8-bit colour values in LAS's 16-bit fields.

- **Downloads through anyone-with-the-link shares** (2026-11-21):
  - Code: `explorer/links.py` (`downloads` on each link, `set_downloads`, `resolve`), `explorer/api.py` (`downloads`
    on create and PATCH, `TokenDownloads` with the `DOWNLOADABLE` allowlist, `?filename=` dropped),
    `explorer/pages.py` (`link_downloads`; cards are (task, outputs, downloads) triples), `explorer/plugin.py` (the
    download mount point), `explorer/templates/{cards,project}.html`, `explorer/public/explorer.{js,css}`.
  - Tests: `explorer/tests/test_downloads.py` (Django; the download-permission and `?filename=` tests seen failing
    with their checks disabled), `explorer/public/__tests__/links.test.js` (Jest).
  - Checked live on WebODM 4.0.1 with the user's project 2, desktop and phone widths (`link-downloads.js` in the
    `live-check` skill): Allow Downloads on create and toggled on an existing link, the Download menu, a 7.3 MB GLB
    downloaded as a visitor, 404 for a view-only link and right after turning downloads off.
  - Found while building: the cards' `overflow: hidden` clipped the Download menu (now the thumbnail rounds its
    own corners); a link row's checkbox came before its address field, so selecting a new link picked the checkbox
    (the address field now has its own class).

- **"Anyone with the link" shares, with 2D maps, splats and meshes** (2026-11-21):
  - Code: `explorer/links.py` (link storage, the advisory lock), `explorer/api.py` (links API, token views),
    `explorer/plugin.py` (link, map and 3D pages; API mount points), `explorer/pages.py` (link cards, map layers,
    3D types), `explorer/templates/` (`cards.html` shared, `link*.html`), `explorer/public/` (`explorer.js` Share
    panel links, `linkpage.js`, `map.js`, `viewer-ui.js`, `viewer/scene.js`), `explorer/public/vendor/` (from
    `dev/vendor.sh`: three.js 0.187.0, Spark 2.4.0, Leaflet 1.9.4).
  - Tests: `explorer/tests/test_links.py` (Django, including a two-thread revoke-during-create test, seen failing
    without the lock, and a held lock answering 503), `explorer/public/__tests__/{links,map,viewer}.test.js` (Jest).
  - Checked live on WebODM 4.0.1 with the user's projects, at desktop and phone widths: links created and revoked
    in the Share panel; link page, map (orthophoto, DSM, a greyscale orthophoto) and 3D page (GLB and splats) opened
    without signing in; a revoke while the map was open says "This link is no longer valid".
  - Found while building:
    - Spark 2.4.0 reads WebODM 4.0.1's `.rad` only in paged mode (whole-file loading gives 0 splats), which is how
      WebODM loads it too.
    - WebODM's GLB requires `KHR_draco_mesh_compression` and carries `CESIUM_RTC`, so three's glTF Draco decoder
      is vendored.
    - Task ids are UUIDs.
    - Stray fragments and long splats make bounding boxes useless for framing, so the viewer frames on the 2nd to
      98th percentile of sampled points.
    - The Playwright MCP's tools did not load in this session, so live checks used the Playwright script route.

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
  `TaskAssets`, `TaskThumbnail`, `TaskSafeTexturedModel` and (2026-11-21, for links that allow downloads)
  `TaskDownloads`, and override only `get_and_check_task`. The project stays private, and links can expire and be
  revoked; downloads are off unless a link allows them. This is an exception to "official extension points only",
  approved for this use; tests import those classes so a WebODM release that changes them fails loudly.
- **D2: WebODM's viewers first** (the user, 2026-11-21): the project page links to WebODM's map and 3D views;
  Explorer's own viewer serves links. Signed-in users keep WebODM's 3D page, also once meshes are tiled (the user,
  2026-11-21). Revised (the user, 2026-11-21): Explorer may offer its own viewer to signed-in users as an additional
  UI with Open in WebODM; WebODM's pages are not replaced.
- **D3: Obj2Tiles bundled in the zip** (the user, 2026-11-21): v1.10.3 (2026-11-17) release zips are 10-11 MB
  each for Linux x64/arm64 and macOS, 21-22 MB for Windows x64/arm64. Platforms: Linux x64 and arm64 only (Docker
  installs only, decided 2026-11-21). AGPL-3.0, like the plugin. Widened (the user, 2026-11-21) to gltfpack 1.3.0
  (MIT), its WebAssembly build run by WebODM's Node.js, to compress the tiles' geometry. Neither is committed:
  `dev/tools.sh` fetches them by sha256 and `dev/package.sh` adds them to the zip (27 MB).
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
- **Preview** (the user, 2026-11-21): the link pages for signed-in viewers of a project, without a link, through
  WebODM's own API; the Explorer page's buttons still open WebODM's own map and 3D pages.
- **Explorer's share control lives on the Explorer page, not in WebODM's Share popup** (the user, 2026-11-21):
  the popup makes its project or task public as soon as it opens.
- **Share links**: per project; per share, "anyone with the link" or "WebODM users only"; streamable formats
  built inside WebODM on demand and cached (the user, 2026-11-21).
- **Downloads through links** (the user, 2026-11-21): an Allow Downloads setting per link, set at creation and
  changeable, off for older links; output files only (point cloud, textured model, orthophoto, DSM, DTM); its own
  phase before the EPT streamer.
- **EPT streamer** (the user, 2026-11-21): laz-perf 0.0.7 vendored (Apache-2.0, Hobu, no dependencies, no
  advisories; npm release 2025-02-19, C++ release 3.4.0 2023-08-23, repo pushed 2026-10-18, so mature but rarely
  released; re-vet when upgrading); RGB colouring only.

# Upcoming changes

## Phases (current and upcoming)

Up next:

1. **Decide the open questions of the research** (below, "Open decisions"): how anonymous links grant access (D1),
   which viewer to start from (D2), how meshes without 3D Tiles get them (D3), how JS libraries are shipped (D4).

Then (proposed, order to confirm once the decisions are made):

2. **Project Explorer page for signed-in users**: a page per project listing every task and its outputs,
   opening each in a viewer. No new rendering yet: WebODM's own viewers, which already stream three of the four
   output types.
3. **Share links per project, chosen per share**: "WebODM users only" or "anyone with the link" (D1), from a
   control in the project's Share popup.
4. **Streamed textured meshes**: 3D Tiles in the Explorer viewer (D2, D4), for tasks that have them.
5. **On-demand mesh tiling**: build 3D Tiles for a task's mesh the first time it is shared or opened, cached (D3).

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
  to WebODM's public pages, so the task must still be public.
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
  created and revoked through an `api_mount_points` view and a control in the project Share popup
  (`addLinkControl`, `props.project`). Removed on project or task deletion (signals) where they apply.
- **On-demand mesh tiling** through `run_function_async`, written to the plugin's persistent path
  (`get_persistent_path`), never to the task's folder.

### Open decisions

- **D1: how an anonymous link grants access.**
  - (a) The plugin turns on WebODM's own project sharing and the link works only while it is on. Simple, and
    WebODM's endpoints serve everything. But anyone with a task's id gets all of it, the backup zip included,
    and revoking means turning the project's `public` off.
  - (b) The plugin serves everything itself behind its token: tiles, EPT nodes, `.rad` ranges and 3D Tiles. The
    project stays private, and links can expire or be revoked one by one. It means re-implementing tile
    rendering (rio-tiler through WebODM's internals, which are not a plugin API) and Range serving, with every
    byte through Python.
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
- **Share links**: per project; per share, "anyone with the link" or "WebODM users only"; streamable formats
  built inside WebODM on demand and cached (the user, 2026-11-21).

# Changelog

Explorer's releases. Versions follow [Semantic Versioning](https://semver.org/); each needs the WebODM version
named in its entry, or later.

## 0.3.0 (2026-11-27)

Experimental. Needs WebODM 4.0.1 or later (Docker installs, Linux x64 or arm64). 0.2.0 was tagged but not
published: its changes are part of this release.

- **Measure** on the map: **Length** and **Area** as exact geodesics on WGS84 (GeographicLib), **Volume** from
  WebODM's own Measure plugin (capped per link for visitors), and a **Point**'s DSM and DTM elevations with the
  height above ground; only what the task's data allows is offered.
- **Measure** on the 3D page: **Distance** (with its horizontal part, height difference and slope), **Area**
  (horizontal and sloped), a **Point**'s elevation and an **Angle**, on the textured model, the point cloud, and
  Gaussian splats through the point cloud; always at the model's full detail, whatever the view shows, and corrected
  from the task's grid to lengths on the ground.
- **The Sharing Center** (Explorer > Sharing Center): every link of the projects you can change, filtered, searched,
  created, edited, renewed, revoked and deleted in one place.
- **Links:** **Allow Source Photos** (the task's photos, without their EXIF data) and **Allow All Task Files** (the
  rest of WebODM's Download menu); a link's page is laid out as the project's page, with an **Overview Map** of the
  tasks.
- **Source Frames** on the map and 3D pages (S): the photos that show a spot you click, best first.
- **Presentation tools** on the map and 3D pages: a **Laser Pointer** (L) and **Area Highlight** (H), optionally as
  a **Spotlight**.
- **Explorer's home:** **List** view (the default on computers, Grid on phones, or each user's last choice), and
  **Search Projects & Tasks**, filtering as you type, with **Search Results** across projects in List view.
- **The task page:** a task's views, Download, Processing Report, Footprint map and Processing Details, with
  **Previous** and **Next**.
- Fixes: the Sharing Center's table fits the page at every width; a 3D Tiles build that an upgrade interrupts, or
  that failed under an earlier version, starts again the next time the model is opened, instead of a day later.
- Upgrading from 0.1.0: in Administration > Plugins, delete Explorer, load the new zip, then restart WebODM. Links,
  Explorer Settings and built 3D Tiles are kept.

## 0.1.0 (2026-11-23)

The first release, experimental. Needs WebODM 4.0.1 or later (Docker installs, Linux x64 or arm64).

- **Explorer** in the main menu: the projects you can view, with search, scopes, sorting and filters, as cards or on
  a **Map**.
- **A project's Explorer page:** an **Overview Map** of its tasks and a card per task with its outputs, opened in
  Explorer's own viewer or in WebODM; **View as Visitor**; **Share** with the page's link.
- **Anyone with the Link:** links that open a project without signing in, with a label, an expiry and optional
  **Allow Downloads** and **Require Sign-In** (any WebODM account), revoked at any time; a cover page with a preview
  for chat apps and social sites; **Embed** code for the whole page or one view.
- **Viewers:** maps (orthophoto, DSM, DTM, thermal) over WebODM's basemaps; a streamed point cloud (EPT); textured
  models streamed as 3D Tiles, which Explorer builds in WebODM's worker; Gaussian splats; **Previous** and **Next**
  through the tasks, **Reset View** and **Fullscreen**.
- **Explorer Settings** for superusers: **Public Address**, **Basemaps on Links** and **Links to Private
  Projects** (anyone with the link, signed-in users only, or not allowed, with **Allow Links** per project).
- After installing or upgrading, restart WebODM: see
  [Getting Started](https://winuxnomacs.github.io/webodm-explorer/getting-started).

# Changelog

Explorer's releases. Versions follow [Semantic Versioning](https://semver.org/); each needs the WebODM version
named in its entry, or later.

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

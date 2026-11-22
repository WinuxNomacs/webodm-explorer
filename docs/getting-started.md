# Getting Started

## Requirements

- **WebODM 4.0.0 or later**, installed with Docker (`webodm.sh`) on Linux, macOS or Windows (WSL). The native
  Windows app is not supported.
- An administrator account in WebODM, to install the plugin.
- For visitors: a browser with WebGL 2 for the 3D views (any current desktop or mobile browser). Maps work
  without it.

## Install

1. Download `explorer-X.Y.Z.zip` from the
   [releases](https://github.com/WinuxNomacs/webodm-explorer/releases) (the newest one, unless you need an older
   version).
2. In WebODM, open **Administration > Plugins** and choose **Load Plugin (.zip)**.
3. Pick the zip. WebODM installs and enables it; **Explorer** appears in the main menu.

The zip includes the tools Explorer uses to build 3D Tiles from textured models (for Linux x64 and arm64), so
nothing else needs installing.

::: tip Upgrading
WebODM refuses a zip for a plugin that is already installed. In **Administration > Plugins**, delete Explorer, then
load the newer zip. Links and settings are kept (they are in WebODM's database); the 3D Tiles built from textured
models are in the plugin's folder, so they are removed and built again the next time each model is opened. If WebODM
asks for a restart, restart it (`./webodm.sh restart`).
:::

## A first look

1. Open **Explorer** in WebODM's main menu. You see a card for each project you can view that has outputs (all
   projects, for WebODM's admins). See [Explorer's Home](/guide/projects).
2. Open a project. Its page lists the completed tasks, each with buttons for its **Map**, **Point Cloud**,
   **Textured Model** and **Gaussian Splats**, as far as the task has them. See [A Project's Page](/guide/project).
3. Open a view. The first time a task's textured model is opened, Explorer builds its 3D Tiles in WebODM's worker
   (a minute or two per mesh); until then the view shows WebODM's own model. See
   [Map and 3D Viewers](/guide/viewers).

## A first share link

1. On the project's page, choose **Share**.
2. Under **Anyone with the Link**, give the link a label (for example, who it is for), pick an expiry, and tick
   **Allow Downloads** if the visitor may download the outputs.
3. Choose **Create Link**, then **Copy**, and send the link.
4. To see what the visitor sees, choose **Open** beside the link, or **View as Visitor** on the project's page.

**Revoke** stops the link at once. See [Sharing](/guide/sharing) for what a link shows and what it doesn't.

::: warning Your server must be reachable
A link works for people outside your network only if your WebODM is reachable from the internet, ideally over
HTTPS. A WebODM on your own computer or office network is not. [Hosting on Linode](/hosting/linode) sets up a server
where only the links are public.
:::

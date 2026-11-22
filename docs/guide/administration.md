# Administration

## Who sees what

- Signed-in users see the projects they own or that are shared with them, as in WebODM. WebODM's admins see every
  project.
- Users who can change a project can create and revoke its links. Users who can only view it can copy the
  **Link for WebODM Users**.
- Explorer follows WebODM's permissions; it has none of its own. Share a project with users or groups in WebODM's
  Dashboard (the project's Edit dialog, Permissions).

## Settings

**Settings**, on Explorer's home, is shown to WebODM's admins.

![The Settings panel with Basemaps on Links ticked](/images/settings.png)

- **Basemaps on Links** (on by default): Explorer's task maps, opened from links, with **View as Visitor** or by
  signed-in users, show the basemaps set in WebODM's Administration, Basemaps. Each visitor's browser then loads the
  basemap's tiles from its provider (such as Google, Esri or OpenStreetMap), which sees the visitor's address and the
  area viewed. Turn it off where that matters: the task maps then show the layer alone, without **Layer Opacity**,
  and a link's page has no **Overview Map**.

Explorer's home and project pages always draw their maps over WebODM's basemaps, as WebODM's own map does.

## Storage and work on the server

- **3D Tiles**: the first time a task's textured model is shared or opened, Explorer builds 3D Tiles from it in
  WebODM's worker, one mesh at a time, at low priority. They are kept in the plugin's folder in WebODM's media
  (`plugins/explorer/tiles/<task id>/`) until the task is removed. Deleting or reinstalling the plugin removes them;
  they are built again on demand.
- **Links and settings** are kept in WebODM's database (the plugin's data stores), unencrypted.
- Nothing else is stored: maps, point clouds and splats are served from the task's own outputs.

## Removing Explorer

In **Administration > Plugins**, disable or delete Explorer. Deleting it removes its folder, with the built 3D
Tiles. Its links and settings stay in the database, unused; links stop working once the plugin is gone.

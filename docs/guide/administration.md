# Administration

## Who sees what

- Signed-in users see the projects they own or that are shared with them, as in WebODM. WebODM's admins see every
  project.
- Users who can change a project can create and revoke its links. Users who can only view it can copy the
  **Link for WebODM Users**.
- Explorer follows WebODM's permissions; it has none of its own. Share a project with users or groups in WebODM's
  Dashboard (the project's Edit dialog, Permissions).

## Settings

**Explorer Settings**, in the sidebar under **Explorer**, is shown to WebODM's superusers only (staff users who aren't
superusers see WebODM's Administration menu but not this). It is an item of its own because WebODM's Administration
menu doesn't take items from plugins.

![Explorer Settings: Basemaps on Links ticked, Public Address set to https://maps.example.com](/images/settings.png)

- **Basemaps on Links** (on by default): maps opened from links and with **View as Visitor** show the basemaps set
  in WebODM's Administration, Basemaps. Each visitor's browser then loads the basemap's tiles from its provider (such
  as Google, Esri or OpenStreetMap), which sees the visitor's address and the area viewed. Turn it off where that
  matters: link maps then show the layer alone, without **Layer Opacity**, and a link's page has no **Overview Map**.

- **Public Address** (empty by default): links and embed code copied from the Share panel start with this address
  instead of the browser's. Set it when you reach WebODM through an internal address or an SSH tunnel, while
  visitors reach the links at a public one (for example `https://maps.example.com`). It takes a scheme and a host,
  with a port if needed, and nothing after them. The **Link for WebODM Users** keeps the browser's address.

Signed-in users' maps (Explorer's home, project pages and task maps) always show WebODM's basemaps, as WebODM's own
map does.

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

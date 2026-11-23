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

![Explorer Settings: Basemaps on Links ticked, Links to Private Projects set to Anyone with the Link, Public Address set to https://maps.example.com](/images/settings.png)

- **Basemaps on Links** (on by default): maps opened from links and with **View as Visitor** show the basemaps set
  in WebODM's Administration, Basemaps. Each visitor's browser then loads the basemap's tiles from its provider (such
  as Google, Esri or OpenStreetMap), which sees the visitor's address and the area viewed. Turn it off where that
  matters: link maps then show the layer alone, without **Layer Opacity**, and a link's page has no **Overview Map**.

- **Links to Private Projects** (**Anyone with the Link** by default): what links of private projects do. Links of
  projects shared publicly in WebODM (the Dashboard: the project's **Share**, **Enabled**; a public task doesn't
  make its project public) always work as they were made.
  - **Anyone with the Link**: each link opens without a login, unless it has **Require Sign-In**.
  - **Signed-In Users Only**: every link of a private project asks for a WebODM login (any account), the links made
    before included, and new ones can only be made with **Require Sign-In**.
  - **Not Allowed**: links work only for public projects and for private ones a superuser allows with **Allow Links**
    in the project's Explorer Share panel (shown to superusers at this level, for private projects). Other projects'
    links stop working and none can be made; the people who can change the project can still revoke them.

  Changing it takes effect at once, and no link is deleted: changing it back restores them. (It replaces the
  earlier **Links for Public Projects Only** switch: an install that had it on is at **Not Allowed**.)

- **Public Address** (empty by default): links and embed code copied from the Share panel start with this address
  instead of the browser's. Set it when you reach WebODM through an internal address or an SSH tunnel, while
  visitors reach the links at a public one (for example `https://maps.example.com`). It takes a scheme and a host,
  with a port if needed, and nothing after them. The **Link for WebODM Users** keeps the browser's address.

Signed-in users' maps (Explorer's home, project pages and task maps) always show WebODM's basemaps, as WebODM's own
map does.

## Storage and work on the server

- **3D Tiles**: the first time a task's textured model is shared or opened, Explorer builds 3D Tiles from it in
  WebODM's worker, one mesh at a time, at low priority. They are kept in the task's own folder in WebODM's media
  (`project/<project id>/task/<task id>/explorer-tiles/`), so they survive upgrading Explorer, count towards the
  project owner's storage quota like the task's other files, are removed with the task and copied when it is
  duplicated.
- **Links and settings** are kept in WebODM's database (the plugin's data stores), unencrypted.
- Nothing else is stored: maps, point clouds and splats are served from the task's own outputs.

## Removing Explorer

In **Administration > Plugins**, disable or delete Explorer. Its links and settings stay in the database, unused;
links stop working once the plugin is gone. The built 3D Tiles stay in each task's folder, as `explorer-tiles/`; to
free that space, delete those folders on the server (WebODM's container is named `webapp`):

```bash
docker exec webapp sh -c 'rm -rf /webodm/app/media/project/*/task/*/explorer-tiles'
```

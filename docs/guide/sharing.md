# Sharing

A project is shared as a whole: a link opens the project's page, and stays current as tasks are added or removed.
**Share**, on a project's Explorer page, offers two kinds of link.

## Link for WebODM Users

The project page's own address, to copy and send. It opens only for signed-in WebODM users the project is shared
with. To share the project with someone, add them in WebODM's Dashboard: the project's Edit dialog, Permissions.

## Anyone with the Link

Links that open the project without signing in. Only users who can change the project see this part of the panel.
Where an admin turned on **Links for Public Projects Only** ([Administration](/guide/administration)), a private
project's links work only once it is shared publicly in WebODM or a superuser ticks **Allow Links** here; until then
the panel says so and offers no **Create Link**.

![The Share panel with two links: one expiring in 30 days with downloads, one that never expires](/images/share-panel.png)

To create one:

1. Give it a **Label** (optional; who it is for, say). Links without one show as **Untitled Link**.
2. Pick an **Expiry**: 7, 30 or 90 days, or **Never expires**.
3. Tick **Allow Downloads** if visitors may download the outputs (see below).
4. Choose **Create Link**.

Each link in the list has:

- **Copy**, to copy it again at any time. Links start with the browser's address, or with the **Public Address**
  an admin set ([Administration](/guide/administration)).
- **Open**, to open it as visitors see it.
- **Allow Downloads**, to turn downloads on or off later.
- **Embed**, for code that shows the link's views in another website (below).
- **Revoke**, which stops the link at once, for everyone using it.

The **Share** button shows how many active links the project has, and cards on [Explorer's home](/guide/projects)
mark a link that expires within 7 days.

### What a visitor sees

A link opens a page with the project's name, description and facts beside its newest task's picture and views, then
an **Overview Map** of the tasks (when the project has several and basemaps are on) and the other tasks, each with
its **Map**, **Point Cloud**, **Textured Model** and **Gaussian Splats** as far as the task has them. The views are
those of [Map and 3D Viewers](/guide/viewers), without **Open in WebODM**. A link reaches only this project's views:
no other projects, nothing of WebODM's own pages, no processing.

**View as Visitor**, on the project's page, shows the same without creating a link.

### What a link serves

Without **Allow Downloads**, a link serves only what its views stream: map tiles, point cloud nodes, 3D Tiles and
splats. A determined visitor could still save what their browser has loaded, as with any web viewer.

With **Allow Downloads**, task cards and views get a **Download** menu with the orthophoto, DSM, DTM, point cloud
(LAZ) and textured model (zip and glTF). A link never serves the report, camera positions, the images or **All
Assets**.

### Previews in chat apps

Pasted into a chat app or a social site, a link shows a preview with the project's name, description and its newest
task's picture. Search engines are asked not to index link pages. Anyone a link is forwarded to can open it: treat it
like a password to the project's results, and set an expiry.

## Embed

**Embed**, on a link, gives iframe code for **The Whole Page** or one task's view. The embedded page has no WebODM
header and offers **Open Full View**. Revoking the link stops the embed.

![Embed open on a link: Show, The Whole Page, and the iframe code to copy](/images/share-embed.png)

::: warning
Anyone who can read the host website's code can read the link in it.
:::

Explorer's signed-in pages can't be shown in other websites' frames (against clickjacking); link pages can, so that
embeds work.

## Good to know

- Links are kept in plain text in WebODM's database, so they can be copied again. Anyone with access to the database
  or its backups can read them.
- Revoking a link, or unticking **Allow Downloads**, takes effect on the visitor's next request, even on a page they
  already have open.
- Basemaps on link maps load from their provider in each visitor's browser. An admin can turn them off:
  [Administration](/guide/administration).
- For visitors outside your network, WebODM must be reachable from the internet, ideally over HTTPS.

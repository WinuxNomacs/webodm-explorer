# Sharing

A project is shared as a whole: a link opens the project's page, and stays current as tasks are added or removed.
**Share**, on a project's Explorer page, offers two kinds of link. The [Sharing Center](/guide/sharing-center)
manages the links of every project you can change in one place.

## Link for WebODM Users

The project page's own address, to copy and send. It opens only for signed-in WebODM users the project is shared
with. To share the project with someone, add them in WebODM's Dashboard: the project's Edit dialog, Permissions.

## Anyone with the Link

Links that open the project without a WebODM account or login, or, with **Require Sign-In**, for anyone who can
sign in to your WebODM. Only users who can change the project see this part of the panel.

An admin's **Links to Private Projects** ([Administration](/guide/administration)) can change what a private
project's links do: with **Signed-In Users Only**, every link of a private project requires sign-in (the box is
ticked and can't be unticked, and the panel says why); with **Not Allowed**, its links work only once it is shared
publicly in WebODM or a superuser ticks **Allow Links** here, and until then the panel says so and offers no
**Create Link**.

![The Share panel with two links: one expiring in 30 days with downloads, one that never expires](/images/share-panel.png)

To create one:

1. Give it a **Label** (optional; who it is for, say). Links without one show as **Untitled Link**.
2. Pick an **Expiry**: 7, 30 or 90 days, or **Never Expires**.
3. Tick **Allow Downloads** if visitors may download the outputs (see below).
4. Tick **Allow All Task Files** if visitors may also download every other file of WebODM's Download menu (see
   below). It needs **Allow Downloads**: the box can be ticked only while that one is.
5. Tick **Allow Source Photos** if visitors may see the task's photos that show a spot (see below).
6. Tick **Require Sign-In** if visitors must sign in to WebODM first (see below).
7. Choose **Create Link**.

Each link in the list has:

- **Copy**, to copy it again at any time. Links start with the browser's address, or with the **Public Address**
  an admin set ([Administration](/guide/administration)).
- **Open**, to open it as visitors see it.
- **Allow Downloads**, **Allow Source Photos**, **Allow All Task Files** and **Require Sign-In**, to turn them on or
  off later. While **Allow Downloads** is off, **Allow All Task Files** is greyed out and keeps its value, so ticking
  **Allow Downloads** again brings the files back.
- **Embed**, for code that shows the link's views in another website (below).
- **Edit**, to change its label or its expiry: **Keep the Current Expiry**, or 7, 30 or 90 days from today, or
  **Never Expires**. The link's address stays the same.
- **Revoke**, which stops the link at once, for everyone using it.

The **Share** button shows how many active links the project has, and cards on [Explorer's home](/guide/projects)
mark a link that expires within 7 days. **All Links in the Sharing Center**, beside the panel's heading, opens the
[Sharing Center](/guide/sharing-center) on this project's links, expired ones included.

### What a visitor sees

A link opens a page laid out as the project's own page: the project's name, facts and description, an **Overview
Map** of the tasks (when the project has several and basemaps are on: each task's outline, and a marker that shows
even when the tasks are far apart), then every task's card, newest first, each with its **Map**, **Point Cloud**, **Textured Model** and **Gaussian Splats** as far as the task has them. A task's picture
or name opens [its page](/guide/project#a-task-s-page): its views, footprint and processing details. The views are
those of [Map and 3D Viewers](/guide/viewers), without **Open in WebODM**. A link reaches only this project's views:
no other projects, nothing of WebODM's own pages, no processing.

**View as Visitor**, on the project's page, shows the same without creating a link.

### What a link serves

Without **Allow Downloads**, a link serves only what its views stream: map tiles, point cloud nodes, 3D Tiles and
splats. A determined visitor could still save what their browser has loaded, as with any web viewer.

With **Allow Downloads**, task cards and views get a **Download** menu with the orthophoto, DSM, DTM, point cloud
(LAZ) and textured model (zip and glTF).

With **Allow All Task Files** as well, the menu offers the rest of WebODM's own Download menu, where the task has
them: the orthophoto as MBTiles and tiles, the cutline, the elevation tiles, the point cloud as LAS, PLY, CSV and 3D
Tiles, the textured model as 3D Tiles, **Camera Parameters** (the lens calibration), **Camera Shots** (each photo's
position and orientation), the ground control points, the **Quality Report**, the splats and, last, **All Assets**;
the link's task pages get the **Processing Report** button. **All Assets** is the task's whole assets folder as one
zip (hundreds of megabytes to several gigabytes), made as it downloads. It holds no photos, but it does hold
`images.json`, with each photo's GPS position, capture time and camera, and the processing log. Tick it only for
people who may have the survey's raw data. Links made before Explorer had it don't serve these files.

With **Allow Source Photos**, the link's map and 3D pages have [Source Frames](/guide/viewers#source-frames): a
visitor clicks a spot and sees the task's photos that show it. They see each photo re-encoded as a JPEG at up to its
full size, without its EXIF data (its GPS position, camera serial number and the like), and its capture time, camera
and the camera's altitude in the window. Only the task's photos are served, nothing else in its folder. With
**Allow Downloads** too, the window also has **Download**, which gives the original photo, EXIF and all. The photos
are the raw inputs of the survey: tick it only for people who may see them. A link made without it, and links made
before Explorer had it, don't show the photos.

### Links that require sign-in

A visitor who opens a link with **Require Sign-In** and isn't signed in to WebODM gets WebODM's sign-in page, then
the link's page. Any account on your WebODM will do: the project doesn't need to be shared with that account in
WebODM, and the link still opens only what it shares. Use it for clients or partners you give an account to, so a
forwarded link is no use to anyone else. Such a link has no preview in chat apps. Where WebODM signs people in
through an identity provider that creates their accounts (OpenID Connect), anyone with an account there counts.

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

A link that requires sign-in shows in another website only to visitors signed in to your WebODM in the same browser,
and most browsers prevent even that (they block other sites' cookies in frames): share the link itself instead.

Explorer's signed-in pages can't be shown in other websites' frames (against clickjacking); link pages can, so that
embeds work.

## Good to know

- Links are kept in plain text in WebODM's database, so they can be copied again. Anyone with access to the database
  or its backups can read them.
- Revoking a link, or unticking **Allow Downloads**, **Allow All Task Files** or **Allow Source Photos**, takes effect on the visitor's next request, even on a page they
  already have open.
- Basemaps on link maps load from their provider in each visitor's browser. An admin can turn them off:
  [Administration](/guide/administration).
- For visitors outside your network, WebODM must be reachable from the internet. Don't expose it with WebODM's own
  protection alone: see [Security](/hosting/security) for the front end it needs (HTTPS, a WAF, only the link paths
  public).

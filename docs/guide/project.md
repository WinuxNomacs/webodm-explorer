# A Project's Page

A project's Explorer page shows its owner, tags and task count, then:

- an **Overview Map** of the tasks' footprints over a basemap; choose a footprint to open its task's page. With one task,
  the map is folded; unfold it to see it.
- a card for each completed task with outputs, newest first.

Tasks still processing, failed or cancelled are left out until they complete.

## Task cards

Each card shows the task's thumbnail, date, number of images, size and processing time, and its tags, with a button
per view the task has. The thumbnail and the task's name open [its page](#a-task-s-page).

| Button | Opens | Needs |
|---|---|---|
| **Map** | The orthophoto, DSM, DTM or thermal orthophoto | Any of them |
| **Point Cloud** | The point cloud, streamed | WebODM's point cloud (EPT) |
| **Textured Model** | The textured mesh, streamed as 3D Tiles | A textured model |
| **Gaussian Splats** | The splats, streamed | Splats uploaded to the task in WebODM |

The views open in Explorer's own viewer ([Map and 3D Viewers](/guide/viewers)), which also has **Download** and
**Open in WebODM**. The card's "..." menu has the same two: **Open in WebODM** lists WebODM's own map and 3D pages
for the task (for its measurement tools and editing), and **Download** its outputs.

Where WebODM can't make a thumbnail (a thermal orthophoto, or a task with elevation models only), the card draws one
from the task's map tiles, in the colours of its map.

## A task's page

Everything about one task in one place: its picture, date and tags; a button per view; **Download** and **Open in
WebODM**; **Processing Report** (WebODM's PDF report, when the task has one); a **Footprint** map over the basemap;
and **Processing Details**: the date, images, processing time, size on disk, the processing node, and the options
the task was processed with (or WebODM's defaults). **Previous** and **Next** step through the project's tasks, and
the project's name leads back to its page.

Through a link and with **View as Visitor**, the page is the same without the processing node (an internal name)
and **Open in WebODM**, with **Download** only on links that allow downloads, the report only on links that also
allow all task files, and the footprint only when **Basemaps on Links** is on. Your own Download menus list every
file of WebODM's Download menu the task has.

## The page's menus

- **Share** shows the project's links, with a count of its active ones: see [Sharing](/guide/sharing).
- **View as Visitor** shows the project exactly as anyone with a link sees it (the link's page, maps and 3D views),
  without creating a link.
- The page's "..." menu has **Open in Dashboard** (the project in WebODM) and **View All on Map** (the project's
  tasks on WebODM's map, when it has any).

Explorer doesn't change projects or tasks: to rename, process, edit or delete, use WebODM (**Open in Dashboard**,
**Open in WebODM**).

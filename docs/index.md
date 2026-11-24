---
layout: home

hero:
  name: Explorer
  text: Browse and share WebODM projects
  tagline: A WebODM plugin that opens a project's maps, point clouds, textured models and Gaussian splats in a light viewer that streams them, and shares them with a link that opens without a WebODM login.
  actions:
    - theme: brand
      text: Getting Started
      link: /getting-started
    - theme: alt
      text: Sharing
      link: /guide/sharing

features:
  - title: Streamed, not downloaded
    details: Point clouds load node by node, textured models as 3D Tiles (only what is on screen, finer close up), Gaussian splats with levels of detail, and maps as tiles. Large models start showing at once and sharpen as you look closer.
  - title: Share models and splats without a WebODM login
    details: Send clients, partners or the public a link to a project's maps, point clouds, textured models and Gaussian splats. It opens in any browser with no WebODM account or login, with an expiry and optional downloads, and can be embedded in a website. Revoking a link works at once.
  - title: Beside WebODM, not instead of it
    details: Explorer adds pages to WebODM. Processing, editing and measuring stay in WebODM, one click away with Open in WebODM.
---

![Explorer's viewer: a textured model of a row of houses, streamed as 3D Tiles](/images/viewer.jpg)

## What Is Explorer

Explorer is a plugin for [WebODM](https://github.com/WebODM/WebODM) 4.0.1 and later. It adds **Explorer** to WebODM's
main menu: a home page of the projects you can view, a page per project with its tasks, and viewers for each task's
outputs:

- **Map**: the orthophoto, DSM, DTM or thermal orthophoto, over a basemap.
- **Point Cloud**: streamed from WebODM's EPT point cloud.
- **Textured Model**: streamed as 3D Tiles that Explorer builds from the task's mesh.
- **Gaussian Splats**: streamed from the splats uploaded to the task.

A project's maps, point clouds, textured models and Gaussian splats can be shared with a link that opens without a
WebODM account or login, which suits clients, partners and the public: they see the project's results, not the rest
of your WebODM. See [Sharing](/guide/sharing).

Explorer is experimental. It is not part of WebODM and is not made by WebODM's authors.

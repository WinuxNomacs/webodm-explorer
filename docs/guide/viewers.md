# Map and 3D Viewers

Explorer's viewers are the same for signed-in users and for visitors with a link. Both stream what they show, so a
large model starts showing at once and sharpens as you look closer.

## Moving between tasks and views

- **Previous** and **Next** step through the project's tasks in the order of its page. The next task opens on the
  same view where it has it (its map from a map, its point cloud from a point cloud), and on its first view
  otherwise.
- On the 3D page, **Point Cloud**, **Textured Model** and **Gaussian Splats** switch between the task's 3D views,
  keeping the camera where you left it, so you compare the same spot.
- **Reset View** (R) frames the whole task again. **Fullscreen** (F) fills the screen, where the browser allows it.

## The map

The map shows one layer at a time: the **Orthophoto**, **DSM**, **DTM**, or a thermal orthophoto as **Thermal**
(degrees, in the magma colours), as WebODM's map draws them.

- **Layer Opacity** fades the layer to compare it with the basemap under it.
- **Basemap** picks one of the basemaps set in WebODM's Administration, Basemaps, or **No Basemap**. An admin can
  turn basemaps off for these maps ([Administration](/guide/administration)).
- Elevation and thermal layers have a legend, and the map a scale bar, in metric or imperial units: choose the
  unit button to switch.

## The 3D views

| Action | Mouse | Touch |
|---|---|---|
| Orbit | Left drag | One finger |
| Pan | Right drag, or Shift and drag | Two fingers |
| Zoom | Wheel | Pinch |
| Focus | Double-click a point to orbit around it | Double-tap a point |

Keys: **R** resets the view, **F** turns fullscreen on and off, **B** changes the background. The "?" button shows
these controls on the page.

- **Background** (B): a dark **Grid** floor under the model (the default), a **Sky**, **Space** with stars, or
  **Plain** (the page's own colour).
- **Point Cloud**: the panel at the bottom left sets the **Point Size** and the **Colour**: **Photo Colours** or
  **Elevation**, with a legend in metric or imperial units. The cloud streams node by node within a point budget:
  10 million points on a computer, 2 million on a phone, 1 million on iOS (the same as WebODM's own 3D page).
- **Textured Model**: streams as 3D Tiles, only what is on screen, finer close up. The first time a model is
  opened, Explorer builds its tiles in WebODM's worker (a minute or two per mesh, one at a time, at low priority);
  until they are ready the view shows WebODM's own model, with a message that a faster view is being prepared.
- **Gaussian Splats**: stream with levels of detail. WebODM doesn't make splats: they are trained elsewhere and
  uploaded to the task in WebODM.

Point size, colour, background, opacity, basemap and units are remembered in the browser.

## When something doesn't show

- "This browser can't show 3D views": the browser has no WebGL 2. Maps still work.
- "This view could not be loaded": the output is missing or damaged. Check the task in WebODM.
- "This link is no longer valid": the link was revoked or has expired. Ask whoever sent it for a new one.

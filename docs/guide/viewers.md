# Map and 3D Viewers

Explorer's viewers are the same for signed-in users and for visitors with a link. Both stream what they show, so a
large model starts showing at once and sharpens as you look closer.

## Moving between tasks and views

- **Previous** and **Next** step through the project's tasks in the order of its page. The next task opens on the
  same view where it has it (its map from a map, its point cloud from a point cloud), and on its first view
  otherwise.
- **Map**, **Point Cloud**, **Textured Model** and **Gaussian Splats**, on both pages, switch between the task's
  views (as far as it has them). The map is 2D: to tilt and rotate, open a 3D view. Between the 3D views the camera
  stays where you left it, so you compare the same spot.
- **Reset View** (R) frames the whole task again. **Fullscreen** (F) fills the screen, where the browser allows it.

## The map

The map shows one layer at a time: the **Orthophoto**, **DSM**, **DTM**, or a thermal orthophoto as **Thermal**
(degrees, in the magma colours), as WebODM's map draws them.

- **Layer Opacity** fades the layer to compare it with the basemap under it.
- **Basemap** picks one of the basemaps set in WebODM's Administration, Basemaps, or **No Basemap**. An admin can
  turn basemaps off for maps opened from links ([Administration](/guide/administration)).
- Elevation and thermal layers have a legend, and the map a scale bar, in metric or imperial units: choose the
  unit button to switch.

## The 3D views

| Action | Mouse | Touch |
|---|---|---|
| Orbit | Left drag | One finger |
| Pan | Right drag, or Shift and drag | Two fingers |
| Zoom | Wheel (out to about 20 times the first view's distance) | Pinch |
| Focus | Double-click a point to orbit around it | Double-tap a point |

Keys: **R** resets the view, **F** turns fullscreen on and off, **B** changes the background, **L** and **H** turn
the [presentation tools](#presentation-tools) on and off, **S** [Source Frames](#source-frames). The "?" button shows these controls on the page.

- **Background** (B): a dark **Grid** floor under the model (the default), a **Sky**, **Space** with stars, or
  **Plain** (the page's own colour).
- **Point Cloud**: the panel at the bottom left sets the **Point Size** and the **Colour**: **Photo Colours** or
  **Elevation**, with a legend in metric or imperial units. The cloud streams node by node within a point budget:
  10 million points on a computer, 2 million on a phone, 1 million on iOS (the same as WebODM's own 3D page). A part
  that fails to load (a phone's connection dropping) is tried again a few times, after a pause that grows.
- **Textured Model**: streams as 3D Tiles, only what is on screen, finer close up. The first time a model is
  opened, Explorer builds its tiles in WebODM's worker (a minute or two per mesh, one at a time, at low priority);
  until they are ready the view shows WebODM's own model, with a message that a faster view is being prepared.
- **Gaussian Splats**: stream with levels of detail. WebODM doesn't make splats: they are trained elsewhere and
  uploaded to the task in WebODM.

Point size, colour, background, opacity, basemap and units are remembered in the browser.

## Measuring

The map has a **Measure** tool (M, the ruler button) for lengths, areas, volumes and elevations. It is there for
everyone who sees the map, link visitors too, and offers only what the task's data allows.

- **Length**: click the map to add points along a path; double-click, **Finish** or Enter ends it. The panel shows the
  path's length as you draw.
- **Area**: click the corners; double-click, **Finish** or Enter closes the shape. The panel shows its area and
  perimeter, and its **Volume** when the task has a DSM.
- **Point**: click a spot to read the **Surface Elevation (DSM)**, the **Ground Elevation (DTM)** and, when the task has
  both, the **Height Above Ground** between them.
- **Undo** (Backspace) takes the last point back, **Clear** starts over, and the next click after a finished shape
  starts a new one. **Esc**, the panel's × or the button again turns the tool off. Turning on another tool (the
  presentation tools, Source Frames) turns it off, and the reverse.
- Values read in the units of the legend's switch: metres, square metres (hectares past 10,000), cubic metres; or feet,
  square feet (acres past one), cubic yards.

**How it measures**

- Lengths and areas are measured on the WGS84 ellipsoid with GeographicLib (Karney's method, the one PROJ uses), so
  they are exact for the points you clicked. WebODM's own map ruler measures on a sphere: the same shape can read up to
  about 0.6% differently there, depending on where it is and which way it runs.
- **Volume** is WebODM's own: its Measure plugin computes it from the DSM in WebODM's worker, as WebODM's map does, and
  gives the same number for the same shape. **Volume Base** picks how the ground under the shape is estimated from
  its edge: **Triangulate** (the default), **Plane**, **Average**, **Highest** or **Lowest**. A large shape over a fine
  DSM can take a while; after two minutes the panel says to try again later.
- The DSM is the surface, roofs and treetops included; the DTM is the bare ground, which ODM fills in under buildings
  and trees, so a height above ground there is an estimate.
- Every value is only as good as the task itself: its georeferencing (ground control points help) and its DEM's
  cell size.

Through a link, at most three volumes are measured at once per link; another visitor is told to try again in a
moment. When an admin disables WebODM's Measure plugin, Volume isn't offered.

### Measuring in 3D

The 3D page has the same **Measure** tool (M) on the textured model and the point cloud, with points picked on the
model itself: on the textured model the exact spot of its surface, on the point cloud the nearest real point within a
few pixels (a click on a gap says there is nothing there). Measuring isn't offered on Gaussian splats, whose surface
isn't exact enough.

- **Distance**: two points. The panel shows the length between them, its **Horizontal** part, the **Height
  Difference** (the second point less the first) and the **Slope** in degrees and percent, for example a roof's pitch.
- **Area**: the corners of a shape; double-click, **Finish** or Enter closes it. The **Horizontal Area** is the area
  seen from above, as on the map; the **Sloped Area** is the area on the plane through the points, for example a roof
  face; and its **Perimeter**.
- **Point**: the picked point's **Elevation**, from the model.
- **Angle**: three points; the angle at the second.
- The panel's **m** / **ft** button switches the units (the point cloud's legend follows it).

The 3D models are in the task's projected grid (UTM), whose lengths differ from those on the ground by up to about
0.1%. Horizontal lengths and areas are corrected by the grid's scale factor at the model, so they match the map's;
heights need no correction. The values are as good as the model: a textured model is smoothed where the photos saw
little, and the point cloud has gaps and stray points.

## Source Frames

On your own map and 3D pages of a task (signed in), and on a link's when it has
[Allow Source Photos](/guide/sharing#what-a-link-serves), **Source Frames** (S, the photos button in the bar) finds the
task's photos that show a spot. Turn it on and "Click to View Source Frames" shows over the view. Each click on the
map or the model (a drag still pans or orbits) moves the spot there. The first click opens a window, and each later
one updates it.

- The window lists up to 50 photos, best first: those where the spot is nearest the middle of the frame. The best one
  is selected and shown with the spot marked. Below it are its file name, capture time, camera, size and the camera's
  altitude, **Download** (the original photo; on a link, only when it has Allow Downloads too) and
  **Open Full Frame**.
- **Open Full Frame** shows the photo full screen. Zoom with the wheel, a pinch, the buttons or a double-click; drag
  to pan; step through the photos with the arrow keys; **Esc** closes it and returns to the window, on the photo you
  ended on.
- **Esc**, the window's × or the button again turns Source Frames off. Turning on the Laser Pointer, Area Highlight
  or Measure turns it off too, and the other way round.
- On a phone the window is a panel along the bottom of the view.

How it finds the photos: from each photo's position, direction and lens (the task's camera shots) and the spot's
height. On the map that is the ground's height from the task's DSM (without one, the point cloud's mean height); in
3D, the height of the point you clicked. A spot counts as shown when it falls inside a photo's frame, even if
something (a roof, a tree) hides it in that photo. On the point cloud, a click can land on a stray point floating in
front of the ground: the textured model gives the more exact spot.

Only tasks with camera shots have the button, and the 3D page only when WebODM knows the model's offset. View as Visitor
shows a link as made by default, without Allow Source Photos, so its button is unavailable.

## Presentation tools

Both pages have two tools for pointing at things while you talk about what's on screen, for example in a meeting or
on a shared screen. They are for everyone who sees the page, link visitors too. Nothing is saved or sent: the marks
show only on your screen.

- **Laser Pointer** (L, the target button): a red dot with a short fading trail follows the pointer. With a mouse,
  dragging still pans the map or orbits the model, so you can point while you move the view. On a touch screen one
  finger points; two fingers still pan and zoom (on the 3D page, one-finger orbit is off while the tool is on).
- **Area Highlight** (H, the highlighter button): drag to draw around an area. It fades after about 3 seconds; hold
  **Shift** while drawing to keep it until you clear it. While it is on, a drag draws instead of moving the view: the
  wheel, right drag and two fingers still move it. The menu beside it picks the shape (**Freehand**, **Rectangle** or
  **Ellipse**), turns **Spotlight** on (everything outside the shape is dimmed instead of outlining it), and has
  **Clear Highlights**.
- **Esc** turns the tool off and clears the highlights. Marks stay where you drew them on the screen, not on the map
  or model, so they clear when the window changes size.

The colours come from WebODM's theme (Button Danger for the laser, Dialog Warning for highlights). The shape and
Spotlight are remembered in the browser.

## When something doesn't show

- "This browser can't show 3D views": the browser has no WebGL 2. Maps still work.
- "This view could not be loaded": the output is missing or damaged. Check the task in WebODM.
- "This link is no longer valid": the link was revoked or has expired. Ask whoever sent it for a new one.
- "The 3D view stopped": the device ran short of graphics memory (most often a phone with several views opened).
  If the browser recovers, the view comes back by itself; otherwise reload the page.

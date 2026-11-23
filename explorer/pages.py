"""
The Explorer pages: which projects a user sees (the home's search, scope, sort and filters), which tasks get a card
and which buttons each card gets. The cards open Explorer's own map and 3D pages: under the link on a link page, under
the project for signed-in users, whose cards also offer WebODM's own pages ("Open in WebODM", decision D2 revised in
upcoming-changes.md).
"""
import hashlib
import logging
import math
import os
from typing import NamedTuple
from urllib.parse import urlencode

from app import pending_actions
from app.models import Project, Task
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db.models import Max, Q
from django.db.models.functions import Greatest, Lower
from django.utils.translation import gettext as _
from guardian.shortcuts import get_objects_for_user
from nodeodm import status_codes

from . import links

logger = logging.getLogger("app.logger")

# The layers WebODM's map page shows. Its URL cannot pick one (MapView's selectedMapType is never set from the
# request), so they share one button that names them.
MAP_LAYERS = (("orthophoto.tif", "Orthophoto"), ("dsm.tif", "DSM"), ("dtm.tif", "DTM"))
# A link's Download menu: the files api.DOWNLOADABLE allows, with the labels and icons of WebODM's own Download menu
# (AssetDownloads.js), in its order.
LINK_DOWNLOADS = (
    ("orthophoto.tif", "Orthophoto", "far fa-image"),
    ("dtm.tif", "Terrain Model", "fa fa-chart-area"),
    ("dsm.tif", "Surface Model", "fa fa-chart-area"),
    ("georeferenced_model.laz", "Point Cloud", "fa fa-pointcloud"),
    ("textured_model.zip", "Textured Model", "fab fa-connectdevelop"),
    ("textured_model.glb", "Textured Model (glTF)", "fab fa-connectdevelop"),
)


# The assets of the 3D types Explorer's 3D page shows (viewer_types), for the home's Has 3D filter
ASSETS_3D = ("georeferenced_model.laz", "georeferenced_model.las", "textured_model.glb", "splats.rad")
# The output types a project card counts, in the order of a task card's buttons
OUTPUT_TYPES = (("map", "Map", "fa fa-globe"), ("cloud", "Point Cloud", "fa fa-pointcloud"),
                ("mesh", "Textured Model", "fab fa-connectdevelop"), ("splats", "Gaussian Splats", "fa fa-splat"))
SCOPES = ("all", "mine", "shared")
SORTS = ("activity", "name", "created")
VIEWS = ("grid", "map")
PAGE_SIZE = 24
SEARCH_MAX = 100
# The home's Map view: at most this many projects drawn, the most recently active first
MAP_PROJECTS = 500


class Viewer(NamedTuple):
    """
    What a set of Explorer's map and 3D pages opens and through which API: a link (Explorer's token views), a
    signed-in user's preview of the link pages (WebODM's own API, the same paths), or the signed-in user's own view
    (the same, without the preview bar, with downloads and Open in WebODM). path is the page the cards are on (the
    link page, or the project page), ending in a slash; api and tiles_api end in "tasks/".
    """
    project: Project
    path: str
    api: str
    tiles_api: str
    downloads: bool
    preview: bool
    signed_in: bool = False


class HomeQuery(NamedTuple):
    """The Explorer home's search, scope, sort, filters, view and page, from its address."""
    q: str = ""
    scope: str = "all"
    sort: str = "activity"
    has_3d: bool = False
    linked: bool = False
    view: str = "grid"
    page: str = "1"

    def params(self, **changes):
        """The query string of this query with changes, without the defaults (for links between pages and views)."""
        values = self._replace(**changes)
        pairs = [("q", values.q), ("scope", values.scope if values.scope != "all" else ""),
                 ("sort", values.sort if values.sort != "activity" else ""), ("3d", "1" if values.has_3d else ""),
                 ("linked", "1" if values.linked else ""), ("view", values.view if values.view != "grid" else ""),
                 ("page", values.page if values.page != "1" else "")]
        return urlencode([(k, v) for k, v in pairs if v])

    @property
    def filtered(self):
        return bool(self.q or self.scope != "all" or self.has_3d or self.linked)


def home_query(params):
    """The home's query from the request's GET parameters; anything unknown falls back to the default."""
    def pick(name, choices, default):
        value = params.get(name)
        return value if value in choices else default
    return HomeQuery(q=params.get("q", "").strip()[:SEARCH_MAX], scope=pick("scope", SCOPES, "all"),
                     sort=pick("sort", SORTS, "activity"), has_3d=params.get("3d") == "1",
                     linked=params.get("linked") == "1", view=pick("view", VIEWS, "grid"),
                     page=params.get("page", "1"))


def explorable_task_set():
    return Task.objects.filter(status=status_codes.COMPLETED).exclude(pending_action=pending_actions.REMOVE)


def home_projects(user, query):
    """
    The projects the home lists for the query, as a queryset annotated with `activity` (the newest of the project's
    and its tasks' creation times), sorted. "All" is every project the user may view: every project for WebODM's admins.
    """
    projects = viewable_projects(user).select_related("owner")
    if query.scope == "mine":
        projects = projects.filter(owner=user)
    elif query.scope == "shared":
        projects = projects.exclude(owner=user)
    if query.q:
        projects = projects.filter(Q(name__icontains=query.q) | Q(description__icontains=query.q)
                                   | Q(tags__icontains=query.q))
    if query.has_3d:
        projects = projects.filter(id__in=explorable_task_set().filter(available_assets__overlap=list(ASSETS_3D))
                                   .values("project_id"))
    if query.linked:
        try:
            linked = links.linked_project_ids()
        except Exception as e:  # noqa: BLE001 - the links store failing leaves the filter empty, never a page error
            logger.warning(f"Explorer: could not read which projects have links: {e}")
            linked = set()
        projects = projects.filter(id__in=linked)
    # Postgres' GREATEST skips NULLs: a project without tasks has its own creation time
    projects = projects.annotate(activity=Greatest("created_at", Max("task__created_at")))
    order = {"activity": ("-activity", "-id"), "name": (Lower("name"), "id"), "created": ("-created_at", "-id")}
    return projects.order_by(*order[query.sort])


def home_page(user, query):
    """The page of projects the query asks for (an unknown page number gives the first, one past the end the last)."""
    paginator = Paginator(home_projects(user, query), PAGE_SIZE)
    try:
        number = int(query.page)
    except ValueError:
        number = 1
    return paginator.get_page(number)


def user_tags(text):
    """WebODM's tags (space separated) without its own, which start with a "." (Tags.js userTags)."""
    return [tag for tag in (text or "").split(" ") if tag and not tag.startswith(".")]


def output_types(task):
    """The output types of a task Explorer opens: map, cloud, mesh, splats."""
    types = ["map"] if map_layers(task) else []
    return types + [kind for kind, _label, _icon in viewer_types(task)]


def link_summaries(user, project_ids):
    """{project id: links.summary} for the projects the user can share (the badge), leaving out the rest."""
    shareable = get_objects_for_user(user, "app.change_project", Project.objects.filter(id__in=project_ids),
                                     accept_global_perms=False).values_list("id", flat=True)
    result = {}
    # Links that don't work (Links for Public Projects Only) get no badge: the project page says why
    for project_id in links.links_work(shareable):
        try:
            result[project_id] = links.summary(project_id)
        except Exception as e:  # noqa: BLE001 - a store that can't be read leaves the badge out, never a page error
            logger.warning(f"Explorer: could not read the links of project {project_id}: {e}")
    return result


def project_summaries(user, projects):
    """
    The home's cards for a page of projects: each project's picture (the newest task with one), its counts per
    output type, its user tags, its owner when it isn't the user, and its links in brief for users who can share it.
    """
    summary = {project.id: {"project": project, "count": 0, "thumbnail": None, "picture": None,
                            "types": {kind: 0 for kind, _label, _icon in OUTPUT_TYPES},
                            "tags": user_tags(project.tags), "owner": project.owner if project.owner_id != user.id else None,
                            "links": None}
               for project in projects}
    for card in explorable_tasks(projects):
        task, picture = card["task"], card["picture"]
        entry = summary[task.project_id]
        entry["count"] += 1
        for kind in output_types(task):
            entry["types"][kind] += 1
        if entry["thumbnail"] is None and (picture["webodm"] or picture["draw"]):
            entry["thumbnail"], entry["picture"] = task, picture
    for project_id, brief in link_summaries(user, list(summary)).items():
        summary[project_id]["links"] = brief
    for entry in summary.values():
        entry["outputs"] = [{"type": kind, "label": _(label), "icon": icon, "count": entry["types"][kind]}
                            for kind, label, icon in OUTPUT_TYPES if entry["types"][kind]]
    return [summary[project.id] for project in projects]


def footprint(task):
    """A task's footprint as a GeoJSON polygon in WGS84 (its orthophoto's, else its DSM's or DTM's), or None."""
    for extent in (task.orthophoto_extent, task.dsm_extent, task.dtm_extent):
        if isinstance(extent, dict) and extent.get("type") == "Polygon" and extent.get("coordinates"):
            return extent
    return None


def bounds(polygons):
    """[west, south, east, north] around GeoJSON polygons, or None."""
    points = [point for polygon in polygons for ring in polygon["coordinates"] for point in ring
              if isinstance(point, (list, tuple)) and len(point) >= 2]
    if not points:
        return None
    xs, ys = [float(p[0]) for p in points], [float(p[1]) for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def home_map(user, query, public):
    """The home's Map view: each matching project (MAP_PROJECTS at most) around its tasks' footprints."""
    projects = list(home_projects(user, query)[:MAP_PROJECTS])
    tasks = (explorable_task_set().filter(project__in=projects)
             .only("id", "project_id", "orthophoto_extent", "dsm_extent", "dtm_extent"))
    polygons = {}
    for task in tasks:
        shape = footprint(task)
        if shape:
            polygons.setdefault(task.project_id, []).append(shape)
    places = []
    for project in projects:
        box = bounds(polygons.get(project.id, []))
        if box:
            places.append({"name": project.name, "url": f"{public}project/{project.id}/", "bounds": box,
                           "count": len(polygons[project.id])})
    return {"places": places, "missing": len(projects) - len(places), "capped": len(projects) == MAP_PROJECTS,
            "limit": MAP_PROJECTS}


def viewable_projects(user):
    """
    The projects the user may view, newest first, as the Dashboard lists them (ObjectPermissionsFilter); every project
    for WebODM's admins (guardian's with_superuser, as their has_perm passes for any project).
    """
    projects = Project.objects.filter(deleting=False).order_by("-created_at")
    return get_objects_for_user(user, "app.view_project", projects, accept_global_perms=False)


def task_outputs(task):
    """The buttons a task's card gets: label, a detail line (or ""), icon classes and the WebODM page to open."""
    assets = task.available_assets or []
    base_3d = f"/3d/project/{task.project_id}/task/{task.id}/"
    outputs = []

    layers = [_(label) for asset, label in MAP_LAYERS if asset in assets]
    if layers:
        outputs.append({"label": _("Map"), "detail": ", ".join(layers), "icon": "fa fa-globe",
                        "url": f"/map/project/{task.project_id}/task/{task.id}/"})
    # The same assets WebODM's own pages check before offering each 3D type (TaskListItem.jsx, ModelView.jsx).
    if "georeferenced_model.laz" in assets or "georeferenced_model.las" in assets:
        outputs.append({"label": _("Point Cloud"), "detail": "", "icon": "fa fa-pointcloud", "url": base_3d + "?t=cloud"})
    if "textured_model.zip" in assets:
        outputs.append({"label": _("Textured Model"), "detail": "", "icon": "fab fa-connectdevelop",
                        "url": base_3d + "?t=mesh"})
    if "splats.rad" in assets:
        outputs.append({"label": _("Gaussian Splats"), "detail": "", "icon": "fa fa-splat",
                        "url": base_3d + "?t=splats"})
    return outputs


def is_thermal(task):
    """
    An orthophoto of one band and alpha, as WebODM's map tells a thermal one (Map.jsx): drawn in degrees Celsius,
    and WebODM's thumbnail API can't make its thumbnail (it needs three colour bands).
    """
    return "orthophoto.tif" in (task.available_assets or []) and len(task.orthophoto_bands or []) == 2


def map_layers(task):
    """
    The map layers a task has, as (layer type, label) pairs. A thermal orthophoto's Thermal layer comes first: the
    orthophoto itself is then a grey picture of the same values.
    """
    assets = task.available_assets or []
    layers = [(asset.removesuffix(".tif"), _(label)) for asset, label in MAP_LAYERS if asset in assets]
    if is_thermal(task):
        layers.insert(0, ("thermal", _("Thermal")))
    return layers


def thumbnail(task):
    """
    A card's picture: WebODM's thumbnail of the orthophoto ("webodm"), and the layer the card draws from tiles
    instead ("draw": thermal, dsm, dtm or None) when WebODM can't make one or there is no orthophoto.
    """
    assets = task.available_assets or []
    elevation = next((kind for kind in ("dsm", "dtm") if f"{kind}.tif" in assets), None)
    if is_thermal(task):
        return {"webodm": False, "draw": "thermal"}
    return {"webodm": "orthophoto.tif" in assets, "draw": elevation}


def viewer_types(task):
    """The types Explorer's 3D page can show for a task, as (type, label, icon) triples, in its switch's order."""
    assets = task.available_assets or []
    types = []
    # As WebODM's own 3D page offers the point cloud; its EPT (entwine_pointcloud/) is built on import (Task.check_ept)
    if "georeferenced_model.laz" in assets or "georeferenced_model.las" in assets:
        types.append(("cloud", _("Point Cloud"), "fa fa-pointcloud"))
    # WebODM's safe textured model view needs the GLB (Task.get_safe_textured_model)
    if "textured_model.glb" in assets:
        types.append(("mesh", _("Textured Model"), "fab fa-connectdevelop"))
    if "splats.rad" in assets:
        types.append(("splats", _("Gaussian Splats"), "fa fa-splat"))
    return types


PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


def asset_version(folder=PUBLIC):
    """
    A token that changes whenever one of Explorer's own browser files does, added to their URLs (?v=) so a browser
    never runs a cached copy beside a newer one (the files are served without cache headers, and a module imported by
    another isn't revalidated on reload). The vendored libraries carry their versions in their paths.
    """
    digest = hashlib.sha1()
    for sub in ("", "viewer"):
        try:
            entries = sorted(os.scandir(os.path.join(folder, sub)), key=lambda entry: entry.name)
        except OSError:
            continue
        for entry in entries:
            if entry.is_file():
                stat = entry.stat()
                digest.update(f"{sub}/{entry.name}:{stat.st_mtime_ns}:{stat.st_size}".encode())
    return digest.hexdigest()[:12]


def model_offset(task):
    """WebODM's offset for a task, "x y" (coords.txt's second line: the mesh's and the splats' origin in the model's
    coordinates), or None. The 3D page lines its views up with it, so switching keeps the camera."""
    try:
        with open(task.assets_path("odm_georeferencing", "coords.txt")) as f:
            f.readline()
            x, y = (float(value) for value in f.readline().split()[:2])
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return f"{x:.3f} {y:.3f}" if math.isfinite(x) and math.isfinite(y) else None


def link_outputs(task, link_path, embed=False):
    """
    The buttons a link page's card gets; link_path is the link page's path, ending in a slash. In an embed, they keep
    ?embed=1, so a click inside the host site's frame stays without WebODM's header.
    """
    outputs = []
    layers = map_layers(task)
    if layers:
        outputs.append({"label": _("Map"), "detail": ", ".join(label for _type, label in layers),
                        "icon": "fa fa-globe", "url": f"{link_path}map/{task.id}/" + ("?embed=1" if embed else "")})
    for kind, label, icon in viewer_types(task):
        outputs.append({"label": label, "detail": "", "icon": icon,
                        "url": f"{link_path}3d/{task.id}/?t={kind}" + ("&embed=1" if embed else "")})
    return outputs


def link_downloads(task, api_path):
    """A link page card's Download menu: label, icon and URL of each file the task has; api_path ends in a slash."""
    assets = task.available_assets or []
    return [{"label": _(label), "icon": icon, "url": f"{api_path}{task.id}/download/{asset}"}
            for asset, label, icon in LINK_DOWNLOADS if asset in assets]


def explorable_task(project, task_pk):
    """The project's task if it is completed and not being removed, else None."""
    try:
        return (Task.objects.filter(project=project, pk=task_pk, status=status_codes.COMPLETED)
                .exclude(pending_action=pending_actions.REMOVE).first())
    except ValidationError:
        return None


def duration(ms):
    """A processing time in milliseconds as it reads ("1h 05m", "4m 10s", "12s"); "" when unknown (-1)."""
    if ms is None or ms < 0:
        return ""
    seconds = int(ms // 1000)
    hours, minutes, secs = seconds // 3600, seconds // 60 % 60, seconds % 60
    if hours:
        return f"{hours}h {minutes:02d}m"
    return f"{minutes}m {secs:02d}s" if minutes else f"{secs}s"


def disk_size(mb):
    """A size in megabytes as it reads ("850 MB", "5.9 GB"); "" for none."""
    if not mb or mb <= 0:
        return ""
    return f"{mb / 1024:.1f} GB" if mb >= 1024 else f"{max(1, round(mb))} MB"


def task_facts(task):
    """A signed-in card's facts line after the date: images, size on disk and processing time, where known."""
    facts = []
    if task.images_count:
        facts.append(_("%(count)s images") % {"count": task.images_count} if task.images_count != 1 else _("1 image"))
    facts += [value for value in (disk_size(task.size), duration(task.processing_time)) if value]
    return facts


def explorable_tasks(projects, outputs_for=task_outputs, downloads_for=None, details=False):
    """
    Completed tasks (not being removed) with at least one output, newest first, as cards: {task, outputs, downloads
    ([] without downloads_for), picture (thumbnail()), open (the first output's URL)}; with details (the signed-in
    project page) also webodm (WebODM's own pages, task_outputs), facts, tags and footprint.
    """
    tasks = (explorable_task_set().filter(project__in=projects)
             .only("id", "project_id", "name", "created_at", "available_assets", "orthophoto_bands", "crop", "tags",
                   "images_count", "size", "processing_time", "orthophoto_extent", "dsm_extent", "dtm_extent")
             .order_by("-created_at"))
    cards = []
    for task in tasks:
        outputs = outputs_for(task)
        if not outputs:
            continue
        card = {"task": task, "outputs": outputs, "downloads": downloads_for(task) if downloads_for else [],
                "picture": thumbnail(task), "open": outputs[0]["url"]}
        if details:
            card.update(webodm=task_outputs(task), facts=task_facts(task), tags=user_tags(task.tags),
                        footprint=footprint(task))
        cards.append(card)
    return cards


def neighbours(project, task, path, view):
    """
    Previous / Next on a map or 3D page: the tasks before and after this one in the cards' order (newest first),
    each opening in the same view where it has it (view: "map", or a 3D type), else its first view. Returns
    {"previous": card or None, "next": card or None, "position": 1-based, "total"}, a card being {"name", "url",
    "open", "views"}.
    path: the page the cards are on, ending in a slash.
    """
    cards = explorable_tasks([project], lambda t: link_outputs(t, path))
    ids = [card["task"].id for card in cards]
    if task.id not in ids:
        return None
    index = ids.index(task.id)

    def target(card):
        if card is None:
            return None
        other = card["task"]
        views = {kind: f"{path}3d/{other.id}/?t={kind}" for kind, _label, _icon in viewer_types(other)}
        if map_layers(other):
            views["map"] = f"{path}map/{other.id}/"
        # views: the URL of each view it has, so the 3D page's link follows its type switch
        return {"name": other.name or _("Unnamed Task"), "url": views.get(view, card["open"]), "open": card["open"],
                "views": views}

    return {"previous": target(cards[index - 1] if index > 0 else None),
            "next": target(cards[index + 1] if index + 1 < len(cards) else None),
            "position": index + 1, "total": len(cards)}


def link_footprints(cards):
    """A link page's Overview Map: each card's task at its footprint, opening as its card does."""
    return [{"name": card["task"].name or _("Unnamed Task"), "url": card["open"], "geometry": shape}
            for card in cards if (shape := footprint(card["task"]))]


def cover_facts(cards):
    """A link page's facts line: how many tasks, images in all, and the newest task's date (None without tasks)."""
    if not cards:
        return None
    return {"tasks": len(cards), "images": sum(card["task"].images_count or 0 for card in cards),
            "updated": cards[0]["task"].created_at}


def embed_views(cards):
    """
    What the Share panel's Embed can show: each task's views as paths below a link's page ("map/<id>/",
    "3d/<id>/?t=cloud"), with labels; the panel adds the link page's own path and ?embed=1.
    """
    return [{"task": card["task"].name or _("Unnamed Task"),
             "views": [{"label": output["label"], "path": output["url"]} for output in link_outputs(card["task"], "")]}
            for card in cards]


def task_footprints(cards):
    """The project page's overview map: each card's task at its footprint, opening as its thumbnail does."""
    return [{"name": card["task"].name or _("Unnamed Task"), "url": card["open"], "geometry": card["footprint"]}
            for card in cards if card.get("footprint")]

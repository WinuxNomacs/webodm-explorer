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
from app.plugins.data_store import UserDataStore
from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db.models import Max, Q
from django.db.models.functions import Greatest, Lower
from django.utils.translation import gettext as _
from guardian.shortcuts import get_objects_for_user
from nodeodm import status_codes

from . import links, measure

logger = logging.getLogger("app.logger")

# The layers WebODM's map page shows. Its URL cannot pick one (MapView's selectedMapType is never set from the
# request), so they share one button that names them.
MAP_LAYERS = (("orthophoto.tif", "Orthophoto"), ("dsm.tif", "DSM"), ("dtm.tif", "DTM"))
# A link's Download menu: the files api.DOWNLOADABLE allows, then (extra: True) those api.ALL_FILES adds for a link
# with Allow All Task Files, with the labels and icons of WebODM's own Download menu (AssetDownloads.js), in its order.
LINK_DOWNLOADS = (
    ("orthophoto.tif", "Orthophoto", "far fa-image", False),
    ("orthophoto.mbtiles", "Orthophoto (MBTiles)", "far fa-image", True),
    ("orthophoto_tiles.zip", "Orthophoto (Tiles)", "fa fa-table", True),
    ("cutline.gpkg", "Orthophoto Cutline", "fa fa-image", True),
    ("dtm.tif", "Terrain Model", "fa fa-chart-area", False),
    ("dtm_tiles.zip", "Terrain Model (Tiles)", "fa fa-table", True),
    ("dsm.tif", "Surface Model", "fa fa-chart-area", False),
    ("dsm_tiles.zip", "Surface Model (Tiles)", "fa fa-table", True),
    ("georeferenced_model.laz", "Point Cloud", "fa fa-pointcloud", False),
    ("georeferenced_model.las", "Point Cloud (LAS)", "fa fa-pointcloud", True),
    ("georeferenced_model.ply", "Point Cloud (PLY)", "fa fa-pointcloud", True),
    ("georeferenced_model.csv", "Point Cloud (CSV)", "fa fa-pointcloud", True),
    ("3d_tiles_pointcloud.zip", "Point Cloud (3D Tiles)", "fa fa-cube", True),
    ("textured_model.zip", "Textured Model", "fab fa-connectdevelop", False),
    ("3d_tiles_model.zip", "Textured Model (3D Tiles)", "fab fa-connectdevelop", True),
    ("textured_model.glb", "Textured Model (glTF)", "fab fa-connectdevelop", False),
    ("cameras.json", "Camera Parameters", "fa fa-camera", True),
    ("shots.geojson", "Camera Shots", "fa fa-camera", True),
    ("ground_control_points.geojson", "Ground Control Points", "far fa-dot-circle", True),
    ("report.pdf", "Quality Report", "far fa-file-pdf", True),
    ("splats.rad", "Splats", "fa fa-splat", True),
    ("all.zip", "All Assets", "far fa-file-archive", True),  # after a separator, as in WebODM's menu
)


# The assets of the 3D types Explorer's 3D page shows (viewer_types), for the home's Has 3D filter
ASSETS_3D = ("georeferenced_model.laz", "georeferenced_model.las", "textured_model.glb", "splats.rad")
# The output types a project card counts, in the order of a task card's buttons
OUTPUT_TYPES = (("map", "Map", "fa fa-globe"), ("cloud", "Point Cloud", "fa fa-pointcloud"),
                ("mesh", "Textured Model", "fab fa-connectdevelop"), ("splats", "Gaussian Splats", "fa fa-splat"))
SCOPES = ("all", "mine", "shared")
SORTS = ("activity", "name", "created")
VIEWS = ("grid", "list", "map")
PAGE_SIZE = 24
SEARCH_MAX = 100
# The home's Map view: at most this many projects drawn, the most recently active first
MAP_PROJECTS = 500
# The home's List view: at most this many projects in its folder pane, by name
LIST_PROJECTS = 500
VIEW_KEY = "home_view"  # the user's last chosen view of the home, in the plugin's UserDataStore


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
    sign_in_link: bool = False  # a link that asks for a WebODM login: no preview in chat apps
    photos: bool = False  # a link's Allow Source Photos
    all_files: bool = False  # every file of WebODM's Download menu: a link's Allow All Task Files, or signed-in users


class HomeQuery(NamedTuple):
    """
    The Explorer home's search, scope, sort, filters, view, page and (List view) selected project, from its address.
    default_view is the view the home opens in without one in its address: the user's last choice (saved_view).
    """
    q: str = ""
    scope: str = "all"
    sort: str = "activity"
    has_3d: bool = False
    linked: bool = False
    view: str = "grid"
    page: str = "1"
    project: str = ""
    default_view: str = "grid"

    def params(self, **changes):
        """The query string of this query with changes, without the defaults (for links between pages and views)."""
        values = self._replace(**changes)
        pairs = [("q", values.q), ("scope", values.scope if values.scope != "all" else ""),
                 ("sort", values.sort if values.sort != "activity" else ""), ("3d", "1" if values.has_3d else ""),
                 ("linked", "1" if values.linked else ""),
                 ("view", values.view if values.view != values.default_view else ""),
                 ("page", values.page if values.page != "1" and values.view == "grid" else ""),
                 ("project", values.project if values.view == "list" else "")]
        return urlencode([(k, v) for k, v in pairs if v])

    @property
    def filtered(self):
        return bool(self.q or self.scope != "all" or self.has_3d or self.linked)


def home_query(params, default_view="grid"):
    """
    The home's query from the request's GET parameters; anything unknown falls back to the default. Without a view in
    the address, default_view (the user's last choice).
    """
    def pick(name, choices, default):
        value = params.get(name)
        return value if value in choices else default
    default_view = default_view if default_view in VIEWS else "grid"
    project = params.get("project", "")
    return HomeQuery(q=params.get("q", "").strip()[:SEARCH_MAX], scope=pick("scope", SCOPES, "all"),
                     sort=pick("sort", SORTS, "activity"), has_3d=params.get("3d") == "1",
                     linked=params.get("linked") == "1", view=pick("view", VIEWS, default_view),
                     page=params.get("page", "1"), project=project if project.isdigit() else "",
                     default_view=default_view)


# The home's view on a computer until the user picks another; a phone opens in Grid (the user, 2026-11-26)
COMPUTER_VIEW = "list"
PHONE_VIEW = "grid"


def is_phone(request):
    """
    Whether the request comes from a phone: the client hint Chromium browsers send with every request
    (Sec-CH-UA-Mobile: ?1), else "Mobi" in the user agent, the token MDN recommends for detecting a mobile browser
    (tablets such as iPads leave it out and get the computer's view).
    """
    if request.headers.get("Sec-CH-UA-Mobile") == "?1":
        return True
    return "Mobi" in request.headers.get("User-Agent", "")


def saved_view(user):
    """
    The view the user last chose on the home (grid, list or map) on a computer; COMPUTER_VIEW when none, or one that
    doesn't read.
    """
    try:
        value = UserDataStore(links.NAMESPACE, user).get_string(VIEW_KEY, COMPUTER_VIEW)
    except Exception as e:  # noqa: BLE001 - a store that can't be read means the default, never a page error
        logger.warning(f"Explorer: could not read the home view of user {user.id}: {e}")
        return COMPUTER_VIEW
    return value if value in VIEWS else COMPUTER_VIEW


def save_view(user, view):
    """Keeps the view the user chose (one of VIEWS), written only when it changes."""
    if view not in VIEWS or view == saved_view(user):
        return
    try:
        UserDataStore(links.NAMESPACE, user).set_string(VIEW_KEY, view)
    except Exception as e:  # noqa: BLE001 - not remembered, the page still shows
        logger.warning(f"Explorer: could not save the home view of user {user.id}: {e}")


def list_projects(user, query):
    """The projects List view's folder pane lists for the query: by name, LIST_PROJECTS at most."""
    return list(home_projects(user, query._replace(sort="name"))[:LIST_PROJECTS])


def home_list(user, query, public):
    """
    The home's List view: the folder pane's projects (list_projects) as project_summaries entries, and the selected
    one: the query's project when listed, else the first. With a search, `results` (search_results), each entry's
    `task_matches` (the tasks the search matched in it: name and task page, listed under it), and no project selected
    unless the address names one: the right pane shows the results.
    """
    projects = list_projects(user, query)
    entries = project_summaries(user, projects, query.q)
    selected = next((entry for entry in entries if str(entry["project"].id) == query.project), None)
    results = search_results(user, query, public, projects) if query.q else None
    if results:
        found = {group["project"].id: group["cards"] for group in results["groups"]}
        for entry in entries:
            entry["task_matches"] = [{"name": card["task"].name or _("Unnamed Task"), "page": card["page"]}
                                     for card in found.get(entry["project"].id, [])]
    elif not selected and entries:
        selected = entries[0]
    return {"entries": entries, "selected": selected, "results": results,
            "capped": len(projects) == LIST_PROJECTS, "limit": LIST_PROJECTS}


# List view's Search Results show at most this many tasks (the newest)
RESULTS_TASKS = 100


def search_results(user, query, public, projects=None):
    """
    List view's Search Results for a search: each listed project (list_projects, by name) with the tasks the search
    matched in it, as the project pane's task rows (newest first, RESULTS_TASKS at most in all); a project the search
    matched only by its name, description or tags has none. `tasks` counts the rows, `capped` says some were left out.
    """
    if projects is None:
        projects = list_projects(user, query)
    matching = matching_tasks(projects, query.q)
    wanted = {task_id for ids in matching.values() for task_id in ids}
    with_tasks = [project for project in projects if project.id in matching]

    def path(task):
        return f"{public}project/{task.project_id}/"
    cards = [card for card in explorable_tasks(with_tasks, lambda task: link_outputs(task, path(task)), details=True,
                                               page_for=lambda task: task_page_path(path(task), task))
             if card["task"].id in wanted] if with_tasks else []
    by_project = {}
    for card in cards[:RESULTS_TASKS]:
        by_project.setdefault(card["task"].project_id, []).append(card)
    return {"q": query.q, "tasks": min(len(cards), RESULTS_TASKS), "capped": len(cards) > RESULTS_TASKS,
            "limit": RESULTS_TASKS,
            "groups": [{"project": project, "path": f"{public}project/{project.id}/",
                        "cards": by_project.get(project.id, [])} for project in projects]}


def project_pane(user, project, public, q="", narrow=True):
    """
    List view's right pane for a project the user can view: its details, its options (the project page, Share for
    users who can change it, View as Visitor, the Dashboard, WebODM's map) and its tasks as rows opening their pages.
    With a search q that some of its tasks' names match, only those tasks (all of them when not narrow: Show All
    Tasks), and `matched` says how many of how many; Back to Search Results either way.
    """
    path = f"{public}project/{project.id}/"
    cards = explorable_tasks([project], lambda task: link_outputs(task, path), details=True,
                             page_for=lambda task: task_page_path(path, task))
    can_share = user.has_perm("app.change_project", project)
    counts = {kind: 0 for kind, _label, _icon in OUTPUT_TYPES}
    for card in cards:
        for kind in output_types(card["task"]):
            counts[kind] += 1
    total = len(cards)
    matched = None
    matching = set(matching_tasks([project], q).get(project.id, [])) if q else set()
    if matching and narrow:
        cards = [card for card in cards if card["task"].id in matching]
        matched = {"shown": len(cards), "total": total, "q": q}
    return {"project": project, "path": path, "cards": cards, "total": total, "matched": matched,
            # Back to Search Results, while a search is on
            "results_href": "?" + urlencode([("view", "list"), ("q", q)]) if q else None,
            "tags": user_tags(project.tags),
            "owner": project.owner if project.owner_id != user.id else None, "can_share": can_share,
            "links": link_summaries(user, [project.id]).get(project.id) if can_share else None,
            "outputs": [{"type": kind, "label": _(label), "icon": icon, "count": counts[kind]}
                        for kind, label, icon in OUTPUT_TYPES if counts[kind]]}


def explorable_task_set():
    return Task.objects.filter(status=status_codes.COMPLETED).exclude(pending_action=pending_actions.REMOVE)


def matching_tasks(projects, q):
    """
    {project id: [task id, ...]} of the projects' completed tasks whose names contain q (any case), newest first; {}
    without q. The home's search matches them as well as the project's own name, description and tags.
    """
    if not q:
        return {}
    result = {}
    tasks = (explorable_task_set().filter(project__in=projects, name__icontains=q).order_by("-created_at")
             .values_list("project_id", "id"))
    for project_id, task_id in tasks:
        result.setdefault(project_id, []).append(task_id)
    return result


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
                                   | Q(tags__icontains=query.q)
                                   | Q(id__in=explorable_task_set().filter(name__icontains=query.q)
                                       .values("project_id")))
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


# A Grid card names at most this many of the tasks a search matched
MATCHES_SHOWN = 3


def project_summaries(user, projects, q=""):
    """
    The home's cards for a page of projects: each project's picture (the newest task with one), its counts per
    output type, its user tags, its owner when it isn't the user, its links in brief for users who can share it, and
    with a search q, the names of the tasks it matched (`matches`, MATCHES_SHOWN at most, and how many more).
    """
    summary = {project.id: {"project": project, "count": 0, "thumbnail": None, "picture": None,
                            "matches": [], "more_matches": 0,
                            "types": {kind: 0 for kind, _label, _icon in OUTPUT_TYPES},
                            "tags": user_tags(project.tags), "owner": project.owner if project.owner_id != user.id else None,
                            "links": None}
               for project in projects}
    matching = matching_tasks(projects, q)
    for card in explorable_tasks(projects):
        task, picture = card["task"], card["picture"]
        entry = summary[task.project_id]
        if task.id in matching.get(task.project_id, ()):
            if len(entry["matches"]) < MATCHES_SHOWN:
                entry["matches"].append(task.name or _("Unnamed Task"))
            else:
                entry["more_matches"] += 1
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
    """
    The home's Map view: each matching project (MAP_PROJECTS at most) around its tasks' footprints; with a search that
    some of a project's task names match, around those tasks only.
    """
    projects = list(home_projects(user, query)[:MAP_PROJECTS])
    tasks = (explorable_task_set().filter(project__in=projects)
             .only("id", "project_id", "orthophoto_extent", "dsm_extent", "dtm_extent"))
    matching = matching_tasks(projects, query.q)
    polygons = {}
    for task in tasks:
        if task.project_id in matching and task.id not in matching[task.project_id]:
            continue
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


def manageable_projects(user, ids=None):
    """
    The projects whose links the user may manage (view and change, the Share panel's rule; every project for WebODM's
    admins), by name; only those among ids when given.
    """
    projects = Project.objects.filter(deleting=False)
    if ids is not None:
        projects = projects.filter(id__in=list(ids))
    return get_objects_for_user(user, ["app.view_project", "app.change_project"], projects,
                                accept_global_perms=False).order_by(Lower("name"), "id")


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


def source_frames(viewer, task, offset=True):
    """
    Source Frames on a task's map or 3D page (frames.py), or None: a task with camera shots, on the 3D page only with
    WebODM's offset (a pick in the scene plus the offset is the point in the task's coordinates). {api, images,
    download, link}: the signed-in user's own pages ask Explorer's API and show the photos through WebODM's, with
    Download; a link that allows source photos asks its token views, with Download if it also allows downloads. View
    as Visitor shows the button unavailable ({"api": None}): it shows a link as made by default, without photos.
    """
    if task is None or "shots.geojson" not in (task.available_assets or []) or not offset:
        return None
    if viewer.signed_in:
        return {"api": f"/api/plugins/{links.NAMESPACE}/projects/{viewer.project.id}/tasks/{task.id}/frames/",
                "images": f"/api/projects/{viewer.project.id}/tasks/{task.id}/images/", "download": True, "link": False}
    if viewer.preview:
        return {"api": None}
    if viewer.photos:
        return {"api": f"{viewer.api}{task.id}/frames/", "images": f"{viewer.api}{task.id}/images/",
                "download": viewer.downloads, "link": True}
    return None


def measure_tools(viewer, task):
    """
    The map page's Measure tool (public/measure.js): {elevation, dsm, dtm, volume: {start, result} or None, link}.
    Signed-in users and View as Visitor read elevations through Explorer's view for signed-in users and measure volume
    through WebODM's Measure plugin's own API; a link's visitors through the link's token views (measure.py caps their
    volume jobs). Volume needs a DSM and WebODM's Measure plugin enabled.
    """
    kinds = measure.elevation_assets(task)
    if viewer.signed_in or viewer.preview:
        elevation = f"/api/plugins/{links.NAMESPACE}/projects/{viewer.project.id}/tasks/{task.id}/elevation/"
        volume = {"start": f"/api/plugins/{measure.MEASURE_PLUGIN}/task/{task.id}/volume",
                  "result": f"/api/plugins/{measure.MEASURE_PLUGIN}/task/{task.id}/volume/get/"}
    else:
        elevation = f"{viewer.api}{task.id}/elevation/"
        volume = {"start": f"{viewer.api}{task.id}/volume", "result": f"{viewer.api}{task.id}/volume/get/"}
    return {"elevation": elevation if kinds else None, "dsm": "dsm" in kinds, "dtm": "dtm" in kinds,
            "volume": volume if "dsm" in kinds and measure.measure_active() else None,
            "link": not (viewer.signed_in or viewer.preview)}


def measure_scene(task, types, offset):
    """
    The 3D page's Measure tool (public/viewer/measure3d.js), or None: on the textured model and the point cloud, with
    WebODM's offset known (the scene's coordinates are then the task's). {scene, scale: the grid's scale factor}.
    """
    if not offset or not any(kind in ("mesh", "cloud") for kind, _label, _icon in types):
        return None
    return {"scene": True, "scale": f"{measure.grid_scale(task, offset):.9f}"}


def measure_texts():
    """What the Measure tool says (public/measure.js), translated."""
    return {
        "measure": _("Measure"), "length": _("Length"), "area": _("Area"), "point": _("Point"),
        "hintLength": _("Click the map to add points; double-click or Finish to end."),
        "hintArea": _("Click the map to add the area's corners; double-click or Finish to end."),
        "hintPoint": _("Click the map to read the elevation there."),
        "hintDone": _("Click the map to start a new measurement."),
        "lengthLabel": _("Length"), "areaLabel": _("Area"), "perimeter": _("Perimeter"), "volume": _("Volume"),
        "computing": _("Computing..."), "base": _("Volume Base"),
        "methods": {"triangulate": _("Triangulate"), "plane": _("Plane"), "average": _("Average"),
                    "highest": _("Highest"), "lowest": _("Lowest")},
        "volumeFailed": _("The volume could not be measured."),
        "volumeTimeout": _("The volume is taking too long: try again later."),
        "elevation": _("Elevation"), "reading": _("Reading..."), "surface": _("Surface Elevation (DSM)"),
        "ground": _("Ground Elevation (DTM)"), "heightAboveGround": _("Height Above Ground"),
        "noValue": _("No value here"), "elevationFailed": _("The elevation could not be read."),
        "undo": _("Undo"), "finish": _("Finish"), "clear": _("Clear"), "close": _("Close"),
        # The 3D page's
        "distance": _("Distance"), "angle": _("Angle"),
        "hintDistance": _("Click two points on the model."),
        "hintArea3d": _("Click the area's corners on the model; double-click, Finish or Enter to end."),
        "hintPoint3d": _("Click the model to read its elevation there."),
        "hintAngle": _("Click three points on the model: the angle is at the second."),
        "hintDone3d": _("Click the model to start a new measurement."),
        "horizontal": _("Horizontal"), "heightDifference": _("Height Difference"), "slope": _("Slope"),
        "horizontalArea": _("Horizontal Area"), "slopedArea": _("Sloped Area"),
        "nothing": _("Nothing there: click on the model."),
        "noSplats": _("Measuring works on the textured model and the point cloud, not on Gaussian splats."),
        "units": _("Switch units"),
    }


def frames_texts():
    """What the Source Frames window says (public/frames.js), translated."""
    return {
        "label": _("Click to View Source Frames"), "title": _("Source Frames"), "finding": _("Finding the photos..."),
        "none": _("No photo shows this spot."), "failed": _("The photos could not be found."),
        "nothing": _("Nothing there: click on the model."), "open": _("Open Full Frame"), "download": _("Download"),
        "close": _("Close"), "previous": _("Previous Photo"), "next": _("Next Photo"), "zoomIn": _("Zoom In"),
        "zoomOut": _("Zoom Out"), "list": _("Photos, best first"), "full": _("Full Frame"), "file": _("File"),
        "captured": _("Captured"), "camera": _("Camera"), "size": _("Size"), "altitude": _("Camera Altitude"),
        "missing": _("This photo could not be loaded."),
    }


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


def task_page_path(path, task, embed=False):
    """A task's page below a project's set of pages (path: the link page, the preview or the project page)."""
    return f"{path}task/{task.id}/" + ("?embed=1" if embed else "")


def option_value(value):
    """A processing option's value as it reads: true/false, numbers and text as given, lists joined."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return ", ".join(option_value(item) for item in value)
    if isinstance(value, dict):
        return ", ".join(f"{key}: {option_value(item)}" for key, item in value.items())
    return str(value)


def task_details(task, viewer):
    """
    A task page's processing details: images, size on disk, processing time (each "" when unknown), the options it
    was processed with ([(name, value)]; [] for WebODM's defaults), for signed-in users only the processing node's
    name (an internal name, so not through links), and WebODM's processing report for viewers with every file
    (signed-in users, links with Allow All Task Files), through the viewer's API.
    """
    options = []
    for option in task.options if isinstance(task.options, list) else []:
        if isinstance(option, dict) and option.get("name"):
            options.append((str(option["name"]), option_value(option.get("value", ""))))
    details = {"images": task.images_count or 0, "size": disk_size(task.size),
               "processing_time": duration(task.processing_time), "options": options, "node": None, "report": None}
    if viewer.signed_in:
        node = task.processing_node
        details["node"] = str(node) if node else None
    if viewer.all_files and "report.pdf" in (task.available_assets or []):
        details["report"] = f"{viewer.api}{task.id}/download/report.pdf"
    return details


def link_downloads(task, api_path, all_files=False):
    """
    A Download menu: label, icon and URL of each file the task has, the outputs, and with all_files the rest of
    WebODM's menu (All Assets marked to follow a separator); api_path ends in a slash.
    """
    assets = task.available_assets or []
    return [{"label": _(label), "icon": icon, "url": f"{api_path}{task.id}/download/{asset}",
             "separator": asset == "all.zip"}
            for asset, label, icon, extra in LINK_DOWNLOADS if asset in assets and (all_files or not extra)]


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


def explorable_tasks(projects, outputs_for=task_outputs, downloads_for=None, details=False, page_for=None):
    """
    Completed tasks (not being removed) with at least one output, newest first, as cards: {task, outputs, downloads
    ([] without downloads_for), picture (thumbnail()), open (the first output's URL), page (the task page, page_for's
    URL; the first output's without it)}; with details (the signed-in project page) also webodm (WebODM's own pages,
    task_outputs), facts, tags and footprint.
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
                "picture": thumbnail(task), "open": outputs[0]["url"],
                "page": page_for(task) if page_for else outputs[0]["url"]}
        if details:
            card.update(webodm=task_outputs(task), facts=task_facts(task), tags=user_tags(task.tags),
                        footprint=footprint(task))
        cards.append(card)
    return cards


def neighbours(project, task, path, view):
    """
    Previous / Next on a map, 3D or task page: the tasks before and after this one in the cards' order (newest first),
    each opening in the same view where it has it (view: "map", or a 3D type), else its first view; on a task page
    (view: "task"), its task page. Returns
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
        url = task_page_path(path, other) if view == "task" else views.get(view, card["open"])
        return {"name": other.name or _("Unnamed Task"), "url": url, "open": card["open"],
                "views": views}

    return {"previous": target(cards[index - 1] if index > 0 else None),
            "next": target(cards[index + 1] if index + 1 < len(cards) else None),
            "position": index + 1, "total": len(cards)}


def link_footprints(cards):
    """A link page's Overview Map: each card's task at its footprint, opening as its card does."""
    return [{"name": card["task"].name or _("Unnamed Task"), "url": card["page"], "geometry": shape}
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
    return [{"name": card["task"].name or _("Unnamed Task"), "url": card["page"], "geometry": card["footprint"]}
            for card in cards if card.get("footprint")]

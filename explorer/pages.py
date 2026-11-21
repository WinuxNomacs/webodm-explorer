"""
The Explorer pages: which projects a user sees, which tasks get a card and which buttons each card gets. Every
button opens one of WebODM's own pages (decision D2 in upcoming-changes.md).
"""
from app import pending_actions
from app.models import Project, Task
from django.utils.translation import gettext as _
from guardian.shortcuts import get_objects_for_user
from nodeodm import status_codes

# The layers WebODM's map page shows. Its URL cannot pick one (MapView's selectedMapType is never set from the
# request), so they share one button that names them.
MAP_LAYERS = (("orthophoto.tif", "Orthophoto"), ("dsm.tif", "DSM"), ("dtm.tif", "DTM"))


def viewable_projects(user):
    """The projects the user may view, newest first, as the Dashboard lists them (ObjectPermissionsFilter)."""
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


def explorable_tasks(projects):
    """Completed tasks (not being removed) with at least one output, newest first, as (task, outputs) pairs."""
    tasks = (Task.objects.filter(project__in=projects, status=status_codes.COMPLETED)
             .exclude(pending_action=pending_actions.REMOVE)
             .only("id", "project_id", "name", "created_at", "available_assets")
             .order_by("-created_at"))
    cards = []
    for task in tasks:
        outputs = task_outputs(task)
        if outputs:
            cards.append((task, outputs))
    return cards


def project_cards(user):
    """The project list: each viewable project with how many tasks have outputs and a thumbnail task if any."""
    projects = list(viewable_projects(user))
    summary = {project.id: {"project": project, "count": 0, "thumbnail": None} for project in projects}
    for task, _outputs in explorable_tasks(projects):
        entry = summary[task.project_id]
        entry["count"] += 1
        if entry["thumbnail"] is None and "orthophoto.tif" in task.available_assets:
            entry["thumbnail"] = task
    return [summary[project.id] for project in projects]

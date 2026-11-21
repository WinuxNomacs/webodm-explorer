"""
The plugin's API (api_mount_points, under /api/plugins/explorer/):
- the Share panel's links: list, create and revoke, for users with change_project;
- the token views a link page streams from: WebODM's tile, thumbnail, asset and textured model views with the link's
  token check in place of WebODM's permission check (decision D1 in upcoming-changes.md), its download view for
  links that allow downloads, and the mesh tiles Explorer builds (tiles.py).
"""
import logging
import os
import posixpath
import re

from app import pending_actions
from app.api.tasks import TaskAssets, TaskDownloads, TaskSafeTexturedModel, TaskThumbnail
from app.api.tiler import Bounds, Metadata, TileJson, Tiles
from app.models import Project, Task
from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.http import FileResponse
from django.utils.translation import gettext as _
from nodeodm import status_codes
from rest_framework import exceptions, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import links, pages, tiles

logger = logging.getLogger("app.logger")
LINK_PATH = "/plugins/{}/s/{}/"


def link_json(link):
    return {
        "token": link["token"],
        "label": link["label"],
        "created": link["created"],
        "expires": link["expires"],
        "path": LINK_PATH.format(links.NAMESPACE, link["token"]),
        "downloads": links.allows_downloads(link),
    }


def downloads_value(data):
    """The request's `downloads` (a JSON boolean), False when absent; a 400 for anything else."""
    value = data.get("downloads", False)
    if not isinstance(value, bool):
        raise exceptions.ValidationError({"downloads": _("Not a valid choice.")})
    return value


class ProjectLinksBase(APIView):
    permission_classes = (IsAuthenticated,)

    def get_project(self, request, project_pk):
        """The project, if the user may change it: 404 if they can't see it, 403 if they can only see it."""
        project = Project.objects.filter(pk=project_pk, deleting=False).first()
        if project is None or not request.user.has_perm("app.view_project", project):
            raise exceptions.NotFound()
        if not request.user.has_perm("app.change_project", project):
            raise exceptions.PermissionDenied(_("Only users who can change this project can manage its links."))
        return project

    def handle_exception(self, exc):
        if isinstance(exc, links.LinkStoreBusy):
            return Response({"detail": _("Links are being changed elsewhere. Try again in a moment.")},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return super().handle_exception(exc)


class ProjectLinks(ProjectLinksBase):
    def get(self, request, project_pk=None):
        project = self.get_project(request, project_pk)
        return Response([link_json(link) for link in links.list_links(project.id)])

    def post(self, request, project_pk=None):
        project = self.get_project(request, project_pk)
        label = request.data.get("label", "")
        expires = request.data.get("expires_days", links.DEFAULT_EXPIRY)
        if not isinstance(label, str):
            raise exceptions.ValidationError({"label": _("Not a valid label.")})
        if expires in ("", "never"):
            expires = None
        try:
            expires = None if expires is None else int(expires)
        except (TypeError, ValueError):
            expires = -1
        if expires not in links.EXPIRY_CHOICES:
            raise exceptions.ValidationError({"expires_days": _("Not a valid expiry.")})
        downloads = downloads_value(request.data)
        link = links.create_link(project.id, label, expires, request.user, downloads)
        prepare_tiles(project)
        return Response(link_json(link), status=status.HTTP_201_CREATED)


def prepare_tiles(project):
    """A mesh is tiled the first time it is shared: queues the project's builds; the link is made either way."""
    try:
        store = tiles.Tiles.current()
        if store:
            store.prepare(task for task, _outputs, _downloads in pages.explorable_tasks([project]))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Explorer: could not queue the mesh tiles of project {project.id}: {e}")


class ProjectLink(ProjectLinksBase):
    def patch(self, request, project_pk=None, token=None):
        project = self.get_project(request, project_pk)
        if "downloads" not in request.data:
            raise exceptions.ValidationError({"downloads": _("This field is required.")})
        link = links.set_downloads(project.id, token, downloads_value(request.data))
        if link is None:
            raise exceptions.NotFound()
        return Response(link_json(link))

    def delete(self, request, project_pk=None, token=None):
        project = self.get_project(request, project_pk)
        if not links.revoke_link(project.id, token):
            raise exceptions.NotFound()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TokenTaskMixin:
    """
    Replaces WebODM's permission check with the link's: the token must be live, the task in its project, completed
    and not being removed. Every refusal is the same 404, so a visitor learns nothing about other tasks or links.
    """
    allowed = True
    needs_downloads = False

    def dispatch(self, request, *args, **kwargs):
        # WebODM's get() methods don't take the token
        self.share_token = kwargs.pop("token", None)
        return super().dispatch(request, *args, **kwargs)

    def get_and_check_task(self, request, pk, annotate=None):
        project, link = links.resolve(self.share_token)
        if project is None or not self.allowed or (self.needs_downloads and not links.allows_downloads(link)):
            raise exceptions.NotFound()
        try:
            task = self.queryset.annotate(**(annotate or {})).get(pk=pk, project=project)
        except (ObjectDoesNotExist, ValidationError):
            raise exceptions.NotFound()
        if task.status != status_codes.COMPLETED or task.pending_action == pending_actions.REMOVE:
            raise exceptions.NotFound()
        return task

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        # The token is in this request's URL: don't pass it on in Referer headers
        response["Referrer-Policy"] = "strict-origin"
        return response


class TokenTileJson(TokenTaskMixin, TileJson):
    pass


class TokenBounds(TokenTaskMixin, Bounds):
    pass


class TokenMetadata(TokenTaskMixin, Metadata):
    pass


class TokenTiles(TokenTaskMixin, Tiles):
    pass


class TokenThumbnail(TokenTaskMixin, TaskThumbnail):
    pass


class TokenTexturedModel(TokenTaskMixin, TaskSafeTexturedModel):
    pass


# The asset paths a link page may stream: the splats and the EPT point cloud (mesh tiles: TokenMeshTiles).
# WebODM's own TaskAssets serves anything under assets/ (the full point cloud, the report, camera positions).
ALLOWED_ASSET = re.compile(r"^(splats/model\.rad|entwine_pointcloud/[A-Za-z0-9_.\-/]+)$")


def asset_allowed(path):
    return (isinstance(path, str) and ALLOWED_ASSET.match(path) is not None
            and posixpath.normpath(path) == path and ".." not in path.split("/"))


class TokenAssets(TokenTaskMixin, TaskAssets):
    def dispatch(self, request, *args, **kwargs):
        # Checked here, before WebODM's code runs; get_and_check_task refuses the request when it fails
        self.allowed = asset_allowed(kwargs.get("unsafe_asset_path"))
        return super().dispatch(request, *args, **kwargs)


# What a link that allows downloads offers (the user, 2026-11-21: output files only), as WebODM's download names
# (app/models/task.py ASSETS_MAP). Not all.zip, the report, camera positions or tiles zips.
DOWNLOADABLE = ("orthophoto.tif", "dtm.tif", "dsm.tif", "georeferenced_model.laz", "textured_model.zip",
                "textured_model.glb")


class TokenDownloads(TokenTaskMixin, TaskDownloads):
    needs_downloads = True

    def dispatch(self, request, *args, **kwargs):
        self.allowed = kwargs.get("asset") in DOWNLOADABLE
        # WebODM names the saved file after ?filename= when given; a link someone passes on must not rename it
        # (a .tif saved as invoice.exe). The file keeps WebODM's own name.
        if "filename" in request.GET:
            request.GET = request.GET.copy()
            del request.GET["filename"]
        return super().dispatch(request, *args, **kwargs)


TILE_TYPES = {".json": "application/json", ".glb": "model/gltf-binary"}


class TokenMeshTiles(TokenTaskMixin, APIView):
    """A file of a task's mesh tiles (tiles_build.py), from the plugin's persistent path."""
    queryset = Task.objects.all()
    permission_classes = (AllowAny,)

    def get(self, request, pk=None, build=None, path=None):
        task = self.get_and_check_task(request, pk)
        store = tiles.Tiles.current()
        file = store.file(task.id, build, path) if store else None
        if file is None:
            raise exceptions.NotFound()
        # FileResponse closes the file once sent
        response = FileResponse(open(file, "rb"), content_type=TILE_TYPES[os.path.splitext(file)[1]])  # noqa: SIM115
        # A build's files never change (its id comes from the mesh's), so the browser keeps them; private, since the
        # URL holds the token
        response["Cache-Control"] = "private, max-age=31536000, immutable"
        return response

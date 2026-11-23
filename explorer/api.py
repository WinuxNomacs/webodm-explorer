"""
The plugin's API (api_mount_points, under /api/plugins/explorer/):
- the Share panel's links: list, create and revoke, for users with change_project;
- the token views a link page streams from: WebODM's tile, thumbnail, asset and textured model views with the link's
  token check in place of WebODM's permission check (decision D1 in upcoming-changes.md), its download view for
  links that allow downloads, and the mesh tiles Explorer builds (tiles.py);
- Explorer's settings (options.py), for WebODM's admins.
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
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import links, options, pages, tiles

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
        "sign_in": links.requires_sign_in(link),
    }


def flag_value(data, name):
    """The request's `downloads` or `sign_in` (a JSON boolean), False when absent; a 400 for anything else."""
    value = data.get(name, False)
    if not isinstance(value, bool):
        raise exceptions.ValidationError({name: _("Not a valid choice.")})
    return value


def downloads_value(data):
    return flag_value(data, "downloads")


SIGN_IN_ONLY = _("Links to this private project must require sign-in: Explorer Settings allow only those.")


class NotCrossSite(BasePermission):
    """
    Refuses what the browser marks as another site's request (Sec-Fetch-Site): WebODM allows any origin with
    credentials (CORS_ALLOW_ALL_ORIGINS, SameSite=None cookies), and these APIs return or change links and settings.
    """
    message = "Cross-site requests are refused."

    def has_permission(self, request, view):
        return request.META.get("HTTP_SEC_FETCH_SITE") != "cross-site"


class IsSuperuser(BasePermission):
    """WebODM's admins: the users its Administration menu is for."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_superuser)


class Settings(APIView):
    """
    Explorer's settings: GET them, PATCH any of {"basemaps_on_links": true|false, "public_address": "https://...",
    "private_links": "anyone"|"signed_in"|"none"}, or "public_projects_only": true|false (a page from before
    private_links: true is "none").
    """
    permission_classes = (NotCrossSite, IsSuperuser)
    SWITCHES = (("basemaps_on_links", options.set_basemaps_on_links),
                ("public_projects_only", links.set_public_projects_only))

    def get(self, request):
        return Response(options.all_settings())

    def patch(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        if not any(name in data for name in (*(name for name, _save in self.SWITCHES), "public_address",
                                             "private_links")):
            raise exceptions.ValidationError({"detail": _("Nothing to change.")})
        address = data.get("public_address")
        for name, _save in self.SWITCHES:
            if name in data and not isinstance(data[name], bool):
                raise exceptions.ValidationError({name: _("Expected true or false.")})
        if "private_links" in data and data["private_links"] not in links.PRIVATE_LINKS:
            raise exceptions.ValidationError({"private_links": _("Not a valid choice.")})
        if "public_address" in data:
            try:
                if not isinstance(address, str):
                    raise TypeError("not text")
                address = options.clean_public_address(address)
            except (TypeError, ValueError):
                raise exceptions.ValidationError(
                    {"public_address": _("Expected an address such as https://maps.example.com, or nothing.")}) from None
        # All checked before any is saved
        for name, save in self.SWITCHES:
            if name in data:
                save(data[name])
        if "private_links" in data:
            links.set_private_links(data["private_links"])
        if "public_address" in data:
            options.set_public_address(address)
        return Response(options.all_settings())


class ProjectLinksBase(APIView):
    permission_classes = (NotCrossSite, IsAuthenticated)

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


def object_body(request):
    """The request's fields; a JSON body that is not an object (a list, a string) is refused, not a server error."""
    if not isinstance(request.data, dict):
        raise exceptions.ValidationError({"detail": _("Expected an object.")})
    return request.data


class ProjectLinks(ProjectLinksBase):
    def get(self, request, project_pk=None):
        project = self.get_project(request, project_pk)
        return Response([link_json(link) for link in links.list_links(project.id)])

    def post(self, request, project_pk=None):
        project = self.get_project(request, project_pk)
        data = object_body(request)
        label = data.get("label", "")
        expires = data.get("expires_days", links.DEFAULT_EXPIRY)
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
        if not links.links_allowed(project):
            raise exceptions.PermissionDenied(_("Links are allowed only for public projects here. An administrator "
                                                "can allow them for this project."))
        downloads = downloads_value(data)
        sign_in = flag_value(data, "sign_in")
        if links.sign_in_forced(project) and not sign_in:
            raise exceptions.PermissionDenied(SIGN_IN_ONLY)
        link = links.create_link(project.id, label, expires, request.user, downloads, sign_in)
        prepare_tiles(project)
        return Response(link_json(link), status=status.HTTP_201_CREATED)


def prepare_tiles(project):
    """A mesh is tiled the first time it is shared: queues the project's builds; the link is made either way."""
    try:
        store = tiles.Tiles.current()
        if store:
            store.prepare(card["task"] for card in pages.explorable_tasks([project]))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Explorer: could not queue the mesh tiles of project {project.id}: {e}")


class ProjectLinksAllowed(APIView):
    """A superuser allows links for a private project, or stops them: PATCH {"allowed": true|false}."""
    permission_classes = (NotCrossSite, IsSuperuser)

    def patch(self, request, project_pk=None):
        project = Project.objects.filter(pk=project_pk, deleting=False).first()
        if project is None:
            raise exceptions.NotFound()
        allowed = object_body(request).get("allowed")
        if not isinstance(allowed, bool):
            raise exceptions.ValidationError({"allowed": _("Expected true or false.")})
        links.set_project_allowed(project.id, allowed)
        return Response({"allowed": links.project_allowed(project.id), "links_work": links.links_allowed(project)})


class ProjectLink(ProjectLinksBase):
    def patch(self, request, project_pk=None, token=None):
        project = self.get_project(request, project_pk)
        data = object_body(request)
        changes = {name: flag_value(data, name) for name in ("downloads", "sign_in") if name in data}
        if not changes:
            raise exceptions.ValidationError({"detail": _("Nothing to change.")})
        if changes.get("sign_in") is False and links.sign_in_forced(project):
            raise exceptions.PermissionDenied(SIGN_IN_ONLY)
        link = links.set_options(project.id, token, **changes)
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
    Replaces WebODM's permission check with the link's: the token must be live, the visitor signed in to WebODM when
    the link asks for it, the task in its project, completed and not being removed. Every refusal is the same 404, so
    a visitor learns nothing about other tasks or links.
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
        # Active as well: DRF's authentication already refuses inactive users; the same rule as the link pages
        user = request.user
        if links.needs_sign_in(project, link) and not (user and user.is_authenticated and user.is_active):
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
        # The token is in this request's URL: don't pass it on in Referer headers, nor keep the answer in a shared cache
        # (a CDN in front of WebODM would serve it after the link is revoked); the visitor's own browser may keep it
        response["Referrer-Policy"] = "strict-origin"
        if not response.has_header("Cache-Control"):
            response["Cache-Control"] = "private"
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
# Only what the viewer streams: the splats, and the point cloud's ept.json, hierarchy and nodes. Not ept-sources/ (the
# processing node's file paths) nor ept-build.json
ALLOWED_ASSET = re.compile(r"^(splats/model\.rad|entwine_pointcloud/(ept\.json|ept-hierarchy/[0-9-]+\.json"
                           r"|ept-data/[0-9-]+\.laz))$")


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


class MeshTilesView(APIView):
    """A file of a task's mesh tiles (tiles_build.py), from the task's own folder."""
    queryset = Task.objects.all()

    def serve(self, task, build, path):
        store = tiles.Tiles.current()
        file = store.file(task, build, path) if store else None
        if file is None:
            raise exceptions.NotFound()
        try:
            handle = open(file, "rb")  # noqa: SIM115 - FileResponse closes the file once sent
        except OSError:
            raise exceptions.NotFound() from None  # removed meanwhile: a rebuild, or the task removed
        response = FileResponse(handle, content_type=TILE_TYPES[os.path.splitext(file)[1]])
        # A build's files never change (its id comes from the mesh's), so the browser keeps them; private, since the
        # URL holds the token
        response["Cache-Control"] = "private, max-age=31536000, immutable"
        return response


class TokenMeshTiles(TokenTaskMixin, MeshTilesView):
    permission_classes = (AllowAny,)

    def get(self, request, pk=None, build=None, path=None):
        return self.serve(self.get_and_check_task(request, pk), build, path)


class PreviewMeshTiles(MeshTilesView):
    """The same files for a signed-in user's preview: the project viewable, the task in it, completed."""
    permission_classes = (IsAuthenticated,)

    def get(self, request, project_pk=None, pk=None, build=None, path=None):
        project = Project.objects.filter(pk=project_pk, deleting=False).first()
        if project is None or not request.user.has_perm("app.view_project", project):
            raise exceptions.NotFound()
        task = pages.explorable_task(project, pk)
        if task is None:
            raise exceptions.NotFound()
        return self.serve(task, build, path)

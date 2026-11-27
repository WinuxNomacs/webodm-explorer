"""
The plugin's API (api_mount_points, under /api/plugins/explorer/):
- the Share panel's links: list, create, change and revoke, for users with change_project; the Sharing Center's
  list of every link they can manage, across projects;
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
from app.api.imageuploads import ImageDownload, Thumbnail
from app.api.tasks import TaskAssets, TaskDownloads, TaskSafeTexturedModel, TaskThumbnail
from app.api.tiler import Bounds, Metadata, TileJson, Tiles
from app.models import Project, Task
from coreplugins.measure.api import TaskVolume, TaskVolumeResult
from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.http import FileResponse
from django.utils.translation import gettext as _
from nodeodm import status_codes
from rest_framework import exceptions, status
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import frames, links, measure, options, pages, tiles

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
        "photos": links.allows_photos(link),
        # As stored: the Share panel keeps the box ticked (and disabled) while Allow Downloads is off
        "all_files": link.get("all_files") is True,
        "expired": links.is_expired(link),
    }


def flag_value(data, name):
    """The request's `downloads`, `sign_in`, `photos` or `all_files` (a JSON boolean), False when absent; a 400 for anything else."""
    value = data.get(name, False)
    if not isinstance(value, bool):
        raise exceptions.ValidationError({name: _("Not a valid choice.")})
    return value


def downloads_value(data):
    return flag_value(data, "downloads")


def expiry_value(data):
    """The request's `expires_days` (7, 30 or 90, as a number or text; "never", "" or null for never); a 400 else."""
    expires = data.get("expires_days", links.DEFAULT_EXPIRY)
    if expires in ("", "never"):
        expires = None
    if isinstance(expires, bool):
        expires = -1
    try:
        expires = None if expires is None else int(expires)
    except (TypeError, ValueError):
        expires = -1
    if expires not in links.EXPIRY_CHOICES:
        raise exceptions.ValidationError({"expires_days": _("Not a valid expiry.")})
    return expires


def label_value(data):
    label = data.get("label", "")
    if not isinstance(label, str):
        raise exceptions.ValidationError({"label": _("Not a valid label.")})
    return label


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
        label = label_value(data)
        expires = expiry_value(data)
        if not links.links_allowed(project):
            raise exceptions.PermissionDenied(_("Links are allowed only for public projects here. An administrator "
                                                "can allow them for this project."))
        downloads = downloads_value(data)
        sign_in = flag_value(data, "sign_in")
        if links.sign_in_forced(project) and not sign_in:
            raise exceptions.PermissionDenied(SIGN_IN_ONLY)
        link = links.create_link(project.id, label, expires, request.user, downloads, sign_in,
                                 flag_value(data, "photos"), flag_value(data, "all_files"))
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
        changes = {name: flag_value(data, name) for name in links.FLAGS if name in data}
        if "label" in data:
            changes["label"] = label_value(data)
        if "expires_days" in data:
            changes["expires_days"] = expiry_value(data)
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


def project_json(project):
    """A project as the Sharing Center shows it: its name, page and links API, and what Explorer Settings say of it."""
    return {"id": project.id, "name": project.name,
            "page": f"/plugins/{links.NAMESPACE}/project/{project.id}/",
            "links_api": f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/links/",
            "links_work": links.links_allowed(project), "sign_in_forced": links.sign_in_forced(project)}


def manageable_links(user):
    """
    Every kept link (live and recently expired) of the projects the user may manage, newest first, each with its
    project and the username of who made it (None once that account is gone).
    """
    from django.contrib.auth.models import User
    rows = []
    for project in pages.manageable_projects(user, links.indexed_project_ids()):
        info = project_json(project)
        for link in links.kept_links(project.id):
            rows.append(dict(link_json(link), project=info, created_by=link.get("created_by")))
    creators = dict(User.objects.filter(id__in={row["created_by"] for row in rows if row["created_by"]})
                    .values_list("id", "username"))
    for row in rows:
        row["created_by"] = creators.get(row["created_by"])
    rows.sort(key=lambda row: row["created"], reverse=True)
    return rows


class AllLinks(ProjectLinksBase):
    """The Sharing Center's list: GET every link the user may manage, across projects (manageable_links)."""

    def get(self, request):
        return Response(manageable_links(request.user))


class TokenTaskMixin:
    """
    Replaces WebODM's permission check with the link's: the token must be live, the visitor signed in to WebODM when
    the link asks for it, the task in its project, completed and not being removed. Every refusal is the same 404, so
    a visitor learns nothing about other tasks or links.
    """
    allowed = True
    needs_downloads = False
    needs_photos = False
    needs_all_files = False

    def dispatch(self, request, *args, **kwargs):
        # WebODM's get() methods don't take the token
        self.share_token = kwargs.pop("token", None)
        return super().dispatch(request, *args, **kwargs)

    def get_and_check_task(self, request, pk, annotate=None):
        project, link = links.resolve(self.share_token)
        if (project is None or not self.allowed or (self.needs_downloads and not links.allows_downloads(link))
                or (self.needs_photos and not links.allows_photos(link))
                or (self.needs_all_files and not links.allows_all_files(link))):
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
# What a link with Allow All Task Files adds: the rest of WebODM's Download menu (AssetDownloads.js) and the point
# cloud's other formats ODX may write, all names of WebODM's Task.ASSETS_MAP
ALL_FILES = ("orthophoto.mbtiles", "orthophoto_tiles.zip", "cutline.gpkg", "dtm_tiles.zip", "dsm_tiles.zip",
             "georeferenced_model.las", "georeferenced_model.ply", "georeferenced_model.csv", "3d_tiles_pointcloud.zip",
             "3d_tiles_model.zip", "cameras.json", "shots.geojson", "ground_control_points.geojson", "report.pdf",
             "splats.rad", "all.zip")


class TokenDownloads(TokenTaskMixin, TaskDownloads):
    needs_downloads = True

    def dispatch(self, request, *args, **kwargs):
        asset = kwargs.get("asset")
        self.allowed = asset in DOWNLOADABLE or asset in ALL_FILES
        self.needs_all_files = asset in ALL_FILES
        # WebODM names the saved file after ?filename= when given; a link someone passes on must not rename it
        # (a .tif saved as invoice.exe). The file keeps WebODM's own name.
        if "filename" in request.GET:
            request.GET = request.GET.copy()
            del request.GET["filename"]
        return super().dispatch(request, *args, **kwargs)


TILE_TYPES = {".json": "application/json", ".glb": "model/gltf-binary"}


def frames_response(task, data):
    """The photos of a task that show the spot `data` gives (frames.py), best first; 400 with what was wrong."""
    try:
        return Response({"frames": frames.find(task, data)})
    except frames.FramesError as e:
        return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("Explorer: Source Frames failed for task %s", task.id)
        return Response({"detail": _("The photos could not be found.")}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class TokenPhotoMixin(TokenTaskMixin):
    """
    A link's photo views (decision D1, widened for Source Frames step B): WebODM's photo thumbnail and download with
    the link's check, for links that allow source photos, and only for the task's photos (frames.photo_names).
    """
    needs_photos = True

    def dispatch(self, request, *args, **kwargs):
        self.photo_name = kwargs.get("image_filename")
        return super().dispatch(request, *args, **kwargs)

    def get_and_check_task(self, request, pk, annotate=None):
        task = super().get_and_check_task(request, pk, annotate)
        if self.photo_name not in frames.photo_names(task):
            raise exceptions.NotFound()
        return task


class TokenPhotoThumbnail(TokenPhotoMixin, Thumbnail):
    """The photo re-encoded as a JPEG, at the size asked for: Pillow saves it without the photo's EXIF."""


class TokenPhotoDownload(TokenPhotoMixin, ImageDownload):
    """The original photo, EXIF and all: only for links that allow downloads too."""
    needs_downloads = True


class TokenFrames(TokenTaskMixin, APIView):
    """POST: Source Frames through a link that allows source photos."""
    permission_classes = (AllowAny,)
    queryset = Task.objects.all().select_related("project")
    needs_photos = True

    def post(self, request, pk=None):
        return frames_response(self.get_and_check_task(request, pk), request.data)


class Frames(APIView):
    """POST: Source Frames for a signed-in user who can view the project (the task in it, completed)."""
    permission_classes = (NotCrossSite, IsAuthenticated)

    def post(self, request, project_pk=None, pk=None):
        project = Project.objects.filter(pk=project_pk, deleting=False).first()
        if project is None or not request.user.has_perm("app.view_project", project):
            raise exceptions.NotFound()
        task = pages.explorable_task(project, pk)
        if task is None:
            raise exceptions.NotFound()
        return frames_response(task, request.data)


def elevation_response(task, query):
    point = measure.parse_point(query)
    if point is None:
        return Response({"error": "Expected lng and lat"}, status=status.HTTP_400_BAD_REQUEST)
    return Response(measure.elevations(task, *point))


class TokenElevation(TokenTaskMixin, APIView):
    """GET ?lng=&lat=: the DSM's and the DTM's elevation under a point, through a link."""
    permission_classes = (AllowAny,)
    queryset = Task.objects.all().select_related("project")

    def get(self, request, pk=None):
        return elevation_response(self.get_and_check_task(request, pk), request.query_params)


class Elevation(APIView):
    """The same for a signed-in user who can view the project (the task in it, completed)."""
    permission_classes = (NotCrossSite, IsAuthenticated)

    def get(self, request, project_pk=None, pk=None):
        project = Project.objects.filter(pk=project_pk, deleting=False).first()
        if project is None or not request.user.has_perm("app.view_project", project):
            raise exceptions.NotFound()
        task = pages.explorable_task(project, pk)
        if task is None:
            raise exceptions.NotFound()
        return elevation_response(task, request.query_params)


class TokenVolume(TokenTaskMixin, TaskVolume):
    """
    POST: WebODM's own volume (its Measure plugin's view and calc_volume, in WebODM's worker) through a link, with the
    link's token check in place of WebODM's permission check, and at most measure.VOLUME_JOBS_PER_LINK jobs of the
    link's visitors at once. Not there when WebODM's Measure plugin is disabled.
    """
    permission_classes = (AllowAny,)

    def post(self, request, pk=None):
        if not measure.measure_active():
            raise exceptions.NotFound()
        self.get_and_check_task(request, pk)
        try:
            slot = measure.claim_slot(self.share_token)
        except measure.CapUnavailable:
            return Response({"error": _("Volume can't be measured right now: try again later.")},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if slot is None:
            return Response({"error": _("Too many volumes are being measured through this link: try again in a moment.")},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)
        try:
            response = super().post(request, pk)
        except Exception:
            measure.release_slot(self.share_token, key=slot)
            raise
        job = response.data.get("celery_task_id") if isinstance(response.data, dict) else None
        if job:
            measure.hold_slot(slot, job)
        else:
            measure.release_slot(self.share_token, key=slot)
        return response


class TokenVolumeResult(TokenTaskMixin, TaskVolumeResult):
    """GET: a volume job's result, through the link that started it; a finished job frees its place."""
    permission_classes = (AllowAny,)
    queryset = Task.objects.all().select_related("project")

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        # WebODM's result view checks nothing (anyone with the job's id): the link must still be valid
        if not measure.measure_active():
            raise exceptions.NotFound()
        self.get_and_check_task(request, kwargs.get("pk"))

    def get(self, request, pk=None, celery_task_id=None):
        response = super().get(request, pk=pk, celery_task_id=celery_task_id)
        data = response.data if isinstance(response.data, dict) else {}
        if data.get("error") != "Task not ready":
            measure.release_slot(self.share_token, job_id=celery_task_id)
        return response


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

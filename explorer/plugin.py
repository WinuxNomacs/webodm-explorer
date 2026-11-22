import logging

from app.models import Project, Task
from app.plugins import Menu, MountPoint, PluginBase, signals
from django.contrib.auth.decorators import login_required
from django.dispatch import receiver
from django.http import Http404, HttpResponseRedirect
from django.shortcuts import get_object_or_404, render
from django.utils.translation import gettext as _

from . import api, links, options, pages, tiles

logger = logging.getLogger("app.logger")

TOKEN = rf"(?P<token>{links.TOKEN_PATTERN})"
TASK = r"(?P<pk>[0-9a-fA-F-]{36})"
TILE_TYPE = r"(?P<tile_type>orthophoto|dsm|dtm)"


def with_and_without_slash(pages):
    """
    The pages' mount points, each also reached without its trailing slash (a redirect, as Django's APPEND_SLASH does:
    WebODM's plugin routing doesn't, and serves the plugin's public files for any path no mount point matches).
    pages: (pattern ending in "/", view) pairs.
    """
    def add_slash(request, **kwargs):
        query = request.META.get("QUERY_STRING", "")
        return HttpResponseRedirect(request.path + "/" + ("?" + query if query else ""))

    mounts = []
    for pattern, view in pages:
        mounts.append(MountPoint(pattern + "$", view))
        if pattern:
            mounts.append(MountPoint(pattern[:-1] + "$", add_slash))
    return mounts


def link_headers(response):
    """Link pages: the token is in the URL, so no Referer carries it and no shared cache keeps the page."""
    response["Referrer-Policy"] = "strict-origin"
    response["Cache-Control"] = "private, no-store"
    response["X-Robots-Tag"] = "noindex, nofollow"
    return response


def no_framing(response):
    """
    Signed-in pages: only WebODM's own pages may frame them. WebODM sets no frame headers and sends its session cookie
    in third-party frames, so another site could frame the project page and trick an owner into Create Link or Revoke
    (clickjacking). Link pages stay frameable: they change nothing, and embedding them is a feature.
    """
    response["X-Frame-Options"] = "SAMEORIGIN"
    response["Content-Security-Policy"] = "frame-ancestors 'self'"
    return response


def signed_in_page(view):
    """A page for signed-in users only: login required, and not framed by other sites."""
    @login_required
    def page(request, *args, **kwargs):
        return no_framing(view(request, *args, **kwargs))
    page.__name__ = view.__name__
    return page


class Plugin(PluginBase):
    """The Explorer plugin: a page per project listing its tasks' outputs, and "anyone with the link" shares."""

    def main_menu(self):
        return [Menu(_("Explorer"), self.public_url(""), "fa fa-binoculars fa-fw")]

    def app_mount_points(self):
        public = self.public_url("")

        @signed_in_page
        def project_list(request):
            query = pages.home_query(request.GET)
            context = {
                "title": _("Explorer"),
                "public": public,
                "query": query,
                "scopes": [("all", _("All")), ("mine", _("Mine")), ("shared", _("Shared with Me"))],
                "sorts": [("activity", _("Recent Activity")), ("name", _("Name")), ("created", _("Created"))],
                "grid_params": query.params(view="grid", page="1"),
                "map_params": query.params(view="map", page="1"),
                "settings": options.all_settings() if request.user.is_superuser else None,
                "settings_api": f"/api/plugins/{links.NAMESPACE}/settings/",
                "any_projects": pages.viewable_projects(request.user).exists(),
            }
            if query.view == "map":
                context.update(places=pages.home_map(request.user, query, public),
                               basemaps=options.signed_in_basemaps())
            else:
                page = pages.home_page(request.user, query)
                context.update(page=page, projects=pages.project_summaries(request.user, list(page.object_list)),
                               previous_params=query.params(page=str(page.number - 1)) if page.has_previous() else None,
                               next_params=query.params(page=str(page.number + 1)) if page.has_next() else None)
            return render(request, self.template_path("projects.html"), context)

        def viewable_project(request, project_pk):
            project = get_object_or_404(Project, pk=project_pk, deleting=False)
            # A 404 rather than a 403, as WebODM's own map page (app/views/app.py) does.
            if not request.user.has_perm("app.view_project", project):
                raise Http404()
            return project

        @signed_in_page
        def project_page(request, project_pk):
            viewer = own_viewer(request, project_pk)
            project = viewer.project
            cards = pages.explorable_tasks([project], lambda task: pages.link_outputs(task, viewer.path),
                                           lambda task: pages.link_downloads(task, viewer.api), details=True)
            can_share = request.user.has_perm("app.change_project", project)
            return render(request, self.template_path("project.html"), {
                "title": project.name,
                "public": public,
                "project": project,
                "tags": pages.user_tags(project.tags),
                "owner": project.owner if project.owner_id != request.user.id else None,
                "cards": cards,
                "signed_in": True,
                "footprints": pages.task_footprints(cards),
                "basemaps": options.signed_in_basemaps(),
                "cards_template": self.template_path("cards.html"),
                "thumbnails": viewer.api,
                "can_share": can_share,
                "links": pages.link_summaries(request.user, [project.id]).get(project.id) if can_share else None,
                "links_api": f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/links/",
                "preview_path": f"{public}project/{project.id}/preview/",
                "embed_views": pages.embed_views(cards),
            })

        def invalid_link(request):
            # One page for an unknown, revoked or expired link, and for a task the link doesn't open
            return link_headers(render(request, self.template_path("link_invalid.html"),
                                       {"title": _("Link Not Valid"), "public": public}, status=404))

        def link_viewer(token):
            """The link's pages: Explorer's token views. None for a link that doesn't open anything."""
            project, link = links.resolve(token)
            if project is None:
                return None
            api_path = f"/api/plugins/{links.NAMESPACE}/s/{token}/tasks/"
            return pages.Viewer(project=project, path=f"{public}s/{token}/", api=api_path, tiles_api=api_path,
                                downloads=links.allows_downloads(link), preview=False)

        def preview_viewer(request, project_pk):
            """
            The same pages for a signed-in user who can view the project, without a link: WebODM's own API (the same
            paths as the token views, with WebODM's permission check) and Explorer's signed-in mesh tiles view. No
            Download menu, as on a link that doesn't allow downloads.
            """
            project = viewable_project(request, project_pk)
            return pages.Viewer(project=project, path=f"{public}project/{project.id}/preview/",
                                api=f"/api/projects/{project.id}/tasks/",
                                tiles_api=f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/tasks/",
                                downloads=False, preview=True)

        def own_viewer(request, project_pk):
            """
            The signed-in user's own view, which the project page's cards open: the preview's API without its bar,
            with WebODM's downloads (viewing a project is enough for them) and Open in WebODM.
            """
            project = viewable_project(request, project_pk)
            return pages.Viewer(project=project, path=f"{public}project/{project.id}/",
                                api=f"/api/projects/{project.id}/tasks/",
                                tiles_api=f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/tasks/",
                                downloads=True, preview=False, signed_in=True)

        def viewer_context(viewer, task=None, **extra):
            context = {"public": public, "project": viewer.project, "link_path": viewer.path, "api": viewer.api,
                       "tiles_api": viewer.tiles_api, "thumbnails": viewer.api, "preview": viewer.preview,
                       "signed_in": viewer.signed_in, "task": task,
                       "back": f"{public}project/{viewer.project.id}/",
                       "cards_template": self.template_path("cards.html"),
                       "preview_template": self.template_path("preview_bar.html"),
                       "viewer_tools_template": self.template_path("viewer_tools.html"),
                       "neighbours_template": self.template_path("neighbours.html"),
                       "meta_template": self.template_path("meta.html"), **extra}
            if task is not None:
                context["downloads"] = pages.link_downloads(task, viewer.api) if viewer.downloads else []
                if viewer.signed_in:
                    context["webodm"] = pages.task_outputs(task)
            return context

        def embedded(request, viewer):
            """A link page asked for as an embed (?embed=1): no WebODM header, back link or Previous / Next."""
            return request.GET.get("embed") == "1" and not viewer.preview and not viewer.signed_in

        def preview_meta(request, viewer, title, picture_task=None, picture=None):
            """
            A link page's preview in chat apps and social sites (Open Graph and Twitter card tags): its title, the
            project's description and the task's picture through the link (WebODM's thumbnail; none for a picture
            drawn from tiles). None on View as Visitor and the signed-in pages, which no one unfurls.
            """
            if viewer.preview or viewer.signed_in:
                return None
            image = None
            if picture_task is not None and picture and picture["webodm"]:
                image = request.build_absolute_uri(f"{viewer.api}{picture_task.id}/thumbnail?size=1024")
            return {"title": title, "description": (viewer.project.description or "")[:300], "image": image}

        def list_page(request, viewer):
            if viewer is None:
                return invalid_link(request)
            cards = pages.explorable_tasks([viewer.project], lambda task: pages.link_outputs(task, viewer.path),
                                           (lambda task: pages.link_downloads(task, viewer.api)) if viewer.downloads
                                           else None)
            # The landing page's cover: the newest task with outputs, its picture and buttons; the Overview Map only
            # over a basemap (outlines alone say little)
            cover = cards[0] if cards else None
            basemaps = options.link_basemaps()
            footprints = pages.link_footprints(cards) if basemaps and len(cards) > 1 else []
            return link_headers(render(request, self.template_path("link.html"), viewer_context(
                viewer, title=viewer.project.name, cards=cards[1:] if cover else [], cover=cover,
                facts=pages.cover_facts(cards), footprints=footprints, basemaps=basemaps,
                embed=embedded(request, viewer),
                meta=preview_meta(request, viewer, viewer.project.name, cover and cover["task"],
                                  cover and cover["picture"]))))

        def map_page(request, viewer, pk):
            task = pages.explorable_task(viewer.project, pk) if viewer else None
            layers = pages.map_layers(task) if task else []
            if not layers:
                return invalid_link(request)
            title = task.name or viewer.project.name
            return link_headers(render(request, self.template_path("link_map.html"), viewer_context(
                viewer, title=title, task=task, embed=embedded(request, viewer),
                meta=preview_meta(request, viewer, f"{title} - {viewer.project.name}", task, pages.thumbnail(task)),
                neighbours=pages.neighbours(viewer.project, task, viewer.path, "map"),
                layers=[{"type": kind, "label": label} for kind, label in layers],
                bands=task.orthophoto_bands or [], crop=task.crop is not None,
                basemaps=options.link_basemaps())))

        def page_3d(request, viewer, pk):
            task = pages.explorable_task(viewer.project, pk) if viewer else None
            types = pages.viewer_types(task) if task else []
            if not types:
                return invalid_link(request)
            kinds = [kind for kind, _label, _icon in types]
            initial = request.GET.get("t") if request.GET.get("t") in kinds else kinds[0]
            # The mesh streams as tiles once they are built; until then (and if they fail) WebODM's GLB
            mesh_build, preparing = None, False
            if "mesh" in kinds:
                store = tiles.Tiles.current()
                mesh_build, preparing = store.tileset(task) if store else (None, False)
            title = task.name or viewer.project.name
            return link_headers(render(request, self.template_path("link_3d.html"), viewer_context(
                viewer, title=title, task=task, embed=embedded(request, viewer),
                meta=preview_meta(request, viewer, f"{title} - {viewer.project.name}", task, pages.thumbnail(task)),
                neighbours=pages.neighbours(viewer.project, task, viewer.path, initial),
                types=[{"type": kind, "label": label, "icon": icon} for kind, label, icon in types],
                initial=initial, mesh_build=mesh_build, preparing=preparing)))

        def link_page(request, token):
            return list_page(request, link_viewer(token))

        def link_map(request, token, pk):
            return map_page(request, link_viewer(token), pk)

        def link_3d(request, token, pk):
            return page_3d(request, link_viewer(token), pk)

        @signed_in_page
        def preview_page(request, project_pk):
            return list_page(request, preview_viewer(request, project_pk))

        @signed_in_page
        def preview_map(request, project_pk, pk):
            return map_page(request, preview_viewer(request, project_pk), pk)

        @signed_in_page
        def preview_3d(request, project_pk, pk):
            return page_3d(request, preview_viewer(request, project_pk), pk)

        @signed_in_page
        def own_map(request, project_pk, pk):
            return map_page(request, own_viewer(request, project_pk), pk)

        @signed_in_page
        def own_3d(request, project_pk, pk):
            return page_3d(request, own_viewer(request, project_pk), pk)

        return with_and_without_slash([
            ("", project_list),
            (r"project/(?P<project_pk>[0-9]+)/", project_page),
            (rf"project/(?P<project_pk>[0-9]+)/map/{TASK}/", own_map),
            (rf"project/(?P<project_pk>[0-9]+)/3d/{TASK}/", own_3d),
            (r"project/(?P<project_pk>[0-9]+)/preview/", preview_page),
            (rf"project/(?P<project_pk>[0-9]+)/preview/map/{TASK}/", preview_map),
            (rf"project/(?P<project_pk>[0-9]+)/preview/3d/{TASK}/", preview_3d),
            (rf"s/{TOKEN}/", link_page),
            (rf"s/{TOKEN}/map/{TASK}/", link_map),
            (rf"s/{TOKEN}/3d/{TASK}/", link_3d),
        ])

    def api_mount_points(self):
        base = rf"s/{TOKEN}/tasks/{TASK}/"
        tile = rf"{base}{TILE_TYPE}/tiles/(?P<z>[\d]+)/(?P<x>[\d]+)/(?P<y>[\d]+)"
        return [
            MountPoint(r"settings/$", api.Settings.as_view()),
            MountPoint(r"projects/(?P<project_pk>[0-9]+)/links/$", api.ProjectLinks.as_view()),
            MountPoint(rf"projects/(?P<project_pk>[0-9]+)/links/{TOKEN}/$", api.ProjectLink.as_view()),
            # Preview: the mesh tiles for signed-in users who can view the project (everything else is WebODM's API)
            MountPoint(rf"projects/(?P<project_pk>[0-9]+)/tasks/{TASK}/tiles/(?P<build>[0-9a-f]{{16}})/"
                       r"(?P<path>[A-Za-z0-9_\-/.]+)$", api.PreviewMeshTiles.as_view()),
            # The same paths as WebODM's own views (app/api/urls.py), below the link's token
            MountPoint(rf"{base}{TILE_TYPE}/tiles\.json$", api.TokenTileJson.as_view()),
            MountPoint(rf"{base}{TILE_TYPE}/bounds$", api.TokenBounds.as_view()),
            MountPoint(rf"{base}{TILE_TYPE}/metadata$", api.TokenMetadata.as_view()),
            MountPoint(rf"{tile}\.?(?P<ext>png|jpg|webp)?$", api.TokenTiles.as_view()),
            MountPoint(rf"{tile}@(?P<scale>[\d]+)x\.?(?P<ext>png|jpg|webp)?$", api.TokenTiles.as_view()),
            MountPoint(rf"{base}thumbnail$", api.TokenThumbnail.as_view()),
            MountPoint(rf"{base}textured_model/$", api.TokenTexturedModel.as_view()),
            MountPoint(rf"{base}assets/(?P<unsafe_asset_path>.+)$", api.TokenAssets.as_view()),
            MountPoint(rf"{base}download/(?P<asset>[A-Za-z0-9_.]+)$", api.TokenDownloads.as_view()),
            MountPoint(rf"{base}tiles/(?P<build>[0-9a-f]{{16}})/(?P<path>[A-Za-z0-9_\-/.]+)$",
                       api.TokenMeshTiles.as_view()),
        ]


@receiver(signals.task_removing, dispatch_uid="explorer_task_removing")
def remove_tiles(sender, task_id, **kwargs):
    store = tiles.Tiles.current()
    if store:
        store.remove(task_id)


@receiver(signals.task_completed, dispatch_uid="explorer_task_completed")
def prepare_tiles(sender, task_id, **kwargs):
    """A task completed (or reprocessed) in a shared project: its mesh is tiled before anyone opens it."""
    try:
        store = tiles.Tiles.current()
        task = Task.objects.filter(pk=task_id).first()
        if store and task and tiles.project_is_shared(task.project_id):
            store.prepare([task])
    except Exception as e:  # noqa: BLE001 - a signal handler must not fail the task
        logger.warning(f"Explorer: could not queue the mesh tiles of task {task_id}: {e}")

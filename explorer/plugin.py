from app.models import Project
from app.plugins import Menu, MountPoint, PluginBase
from django.contrib.auth.decorators import login_required
from django.http import Http404
from django.shortcuts import get_object_or_404, render
from django.utils.translation import gettext as _

from . import api, links, pages

TOKEN = rf"(?P<token>{links.TOKEN_PATTERN})"
TASK = r"(?P<pk>[0-9a-fA-F-]{36})"
TILE_TYPE = r"(?P<tile_type>orthophoto|dsm|dtm)"


def link_headers(response):
    """Link pages: the token is in the URL, so no Referer carries it and no shared cache keeps the page."""
    response["Referrer-Policy"] = "strict-origin"
    response["Cache-Control"] = "private, no-store"
    response["X-Robots-Tag"] = "noindex, nofollow"
    return response


class Plugin(PluginBase):
    """The Explorer plugin: a page per project listing its tasks' outputs, and "anyone with the link" shares."""

    def main_menu(self):
        return [Menu(_("Explorer"), self.public_url(""), "fa fa-binoculars fa-fw")]

    def app_mount_points(self):
        public = self.public_url("")

        @login_required
        def project_list(request):
            return render(request, self.template_path("projects.html"), {
                "title": _("Explorer"),
                "public": public,
                "projects": pages.project_cards(request.user),
            })

        @login_required
        def project_page(request, project_pk):
            project = get_object_or_404(Project, pk=project_pk, deleting=False)
            # A 404 rather than a 403, as WebODM's own map page (app/views/app.py) does.
            if not request.user.has_perm("app.view_project", project):
                raise Http404()
            return render(request, self.template_path("project.html"), {
                "title": project.name,
                "public": public,
                "project": project,
                "cards": pages.explorable_tasks([project]),
                "cards_template": self.template_path("cards.html"),
                "thumbnails": f"/api/projects/{project.id}/tasks/",
                "can_share": request.user.has_perm("app.change_project", project),
                "links_api": f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/links/",
            })

        def invalid_link(request):
            # One page for an unknown, revoked or expired link, and for a task the link doesn't open
            return link_headers(render(request, self.template_path("link_invalid.html"),
                                       {"title": _("Link Not Valid"), "public": public}, status=404))

        def link_context(token, project, **extra):
            api_path = f"/api/plugins/{links.NAMESPACE}/s/{token}/tasks/"
            return {"public": public, "project": project, "link_path": f"{public}s/{token}/", "api": api_path,
                    "cards_template": self.template_path("cards.html"), "thumbnails": api_path, **extra}

        def link_page(request, token):
            project, link = links.resolve(token)
            if project is None:
                return invalid_link(request)
            link_path = f"{public}s/{token}/"
            api_path = f"/api/plugins/{links.NAMESPACE}/s/{token}/tasks/"
            downloads = links.allows_downloads(link)
            cards = pages.explorable_tasks([project], lambda task: pages.link_outputs(task, link_path),
                                           (lambda task: pages.link_downloads(task, api_path)) if downloads else None)
            return link_headers(render(request, self.template_path("link.html"),
                                       link_context(token, project, title=project.name, cards=cards)))

        def link_task(token, pk):
            project = links.project_for_token(token)
            task = pages.explorable_task(project, pk) if project else None
            return project, task

        def link_map(request, token, pk):
            project, task = link_task(token, pk)
            layers = pages.map_layers(task) if task else []
            if not layers:
                return invalid_link(request)
            return link_headers(render(request, self.template_path("link_map.html"), link_context(
                token, project, title=task.name or project.name, task=task,
                layers=[{"type": kind, "label": label} for kind, label in layers],
                bands=task.orthophoto_bands or [], crop=task.crop is not None)))

        def link_3d(request, token, pk):
            project, task = link_task(token, pk)
            types = pages.viewer_types(task) if task else []
            if not types:
                return invalid_link(request)
            kinds = [kind for kind, _label, _icon in types]
            initial = request.GET.get("t") if request.GET.get("t") in kinds else kinds[0]
            return link_headers(render(request, self.template_path("link_3d.html"), link_context(
                token, project, title=task.name or project.name, task=task,
                types=[{"type": kind, "label": label, "icon": icon} for kind, label, icon in types],
                initial=initial)))

        return [
            MountPoint("$", project_list),
            MountPoint(r"project/(?P<project_pk>[0-9]+)/$", project_page),
            MountPoint(rf"s/{TOKEN}/$", link_page),
            MountPoint(rf"s/{TOKEN}/map/{TASK}/$", link_map),
            MountPoint(rf"s/{TOKEN}/3d/{TASK}/$", link_3d),
        ]

    def api_mount_points(self):
        base = rf"s/{TOKEN}/tasks/{TASK}/"
        tile = rf"{base}{TILE_TYPE}/tiles/(?P<z>[\d]+)/(?P<x>[\d]+)/(?P<y>[\d]+)"
        return [
            MountPoint(r"projects/(?P<project_pk>[0-9]+)/links/$", api.ProjectLinks.as_view()),
            MountPoint(rf"projects/(?P<project_pk>[0-9]+)/links/{TOKEN}/$", api.ProjectLink.as_view()),
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
        ]

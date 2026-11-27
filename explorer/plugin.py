import logging

from app.models import Project, Task
from app.plugins import Menu, MountPoint, PluginBase, signals
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import redirect_to_login
from django.dispatch import receiver
from django.http import Http404, HttpResponseRedirect
from django.shortcuts import get_object_or_404, render
from django.utils.cache import patch_vary_headers
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
        # A drop-down: Projects (the home) and the Sharing Center. WebODM's Administration menu takes no plugin items,
        # and it checks admin_only only on top-level items: the settings get their own, for superusers only
        return [Menu(_("Explorer"), "#", "fa fa-binoculars fa-fw", submenu=[
                    Menu(_("Projects"), self.public_url(""), "fa fa-folder-open fa-fw"),
                    Menu(_("Sharing Center"), self.public_url("sharing/"), "fa fa-share-alt fa-fw")]),
                Menu(_("Explorer Settings"), self.public_url("settings/"), "fa fa-cog fa-fw", admin_only=True)]

    def app_mount_points(self):
        public = self.public_url("")

        @signed_in_page
        def project_list(request):
            # A phone always opens in Grid; a computer in the user's last choice (List at first)
            phone = pages.is_phone(request)
            query = pages.home_query(request.GET, pages.PHONE_VIEW if phone else pages.saved_view(request.user))
            # A view named in the address is the user's choice: on a computer the home opens in it next time (a
            # phone's choice isn't kept, so it never changes the computer's)
            if request.GET.get("view") in pages.VIEWS:
                if not phone:
                    pages.save_view(request.user, query.view)
                query = query._replace(default_view=query.view)
            context = {
                "title": _("Explorer"),
                "public": public, "v": pages.asset_version(),
                "query": query,
                "scopes": [("all", _("All")), ("mine", _("Mine")), ("shared", _("Shared with Me"))],
                "sorts": [("activity", _("Recent Activity")), ("name", _("Name")), ("created", _("Created"))],
                "grid_params": query.params(view="grid", page="1"),
                "list_params": query.params(view="list", page="1", project=""),
                "map_params": query.params(view="map", page="1"),
                # Clear Filters: everything again, in the same view
                "clear_params": pages.HomeQuery(view=query.view, default_view=query.default_view).params(),
                "any_projects": pages.viewable_projects(request.user).exists(),
            }
            if query.view == "map":
                context.update(places=pages.home_map(request.user, query, public),
                               basemaps=options.signed_in_basemaps())
            elif query.view == "list":
                folder = pages.home_list(request.user, query, public)
                selected = folder["selected"]
                for entry in folder["entries"]:
                    entry["params"] = query.params(project=str(entry["project"].id))
                context.update(folder=folder, pane_template=self.template_path("project_pane.html"),
                               results_template=self.template_path("search_results.html"),
                               task_rows_template=self.template_path("task_rows.html"),
                               results_params=query.params(project=""),
                               cards_template=self.template_path("cards.html"),
                               downloads_template=self.template_path("download_items.html"),
                               pane=(pages.project_pane(request.user, selected["project"], public, query.q)
                                     if selected else None),
                               # Back to Projects on a phone: the folder pane, without a selection
                               back_params=query.params(project=""))
            else:
                page = pages.home_page(request.user, query)
                context.update(page=page, projects=pages.project_summaries(request.user, list(page.object_list),
                                                                           query.q),
                               previous_params=query.params(page=str(page.number - 1)) if page.has_previous() else None,
                               next_params=query.params(page=str(page.number + 1)) if page.has_next() else None)
            response = render(request, self.template_path("projects.html"), context)
            # The view depends on the device: no cache may give a phone's page to a computer
            patch_vary_headers(response, ("Sec-CH-UA-Mobile", "User-Agent"))
            return response

        @signed_in_page
        def list_pane(request, project_pk):
            """
            List view's right pane alone, for the page's script to swap in when another project is chosen; ?q= is the
            home's search, which narrows its tasks to those it matches.
            """
            project = viewable_project(request, project_pk)
            q = pages.home_query(request.GET).q
            # Show All Tasks: every task, still under the search (Back to Search Results)
            narrow = request.GET.get("all") != "1"
            return render(request, self.template_path("project_pane.html"), {
                "public": public, "pane": pages.project_pane(request.user, project, public, q, narrow),
                "task_rows_template": self.template_path("task_rows.html"),
                "cards_template": self.template_path("cards.html"),
                "downloads_template": self.template_path("download_items.html")})

        @signed_in_page
        def list_results(request):
            """List view's Search Results alone, for the page's script, with the home's search and filters."""
            query = pages.home_query(request.GET)._replace(view="list")
            if not query.q:
                raise Http404()
            return render(request, self.template_path("search_results.html"), {
                "public": public, "results": pages.search_results(request.user, query, public),
                "task_rows_template": self.template_path("task_rows.html")})

        @signed_in_page
        def settings_page(request):
            # A 404 for everyone but superusers, as the menu item shows to them only
            if not request.user.is_superuser:
                raise Http404()
            return render(request, self.template_path("settings.html"), {
                "title": _("Explorer Settings"),
                "public": public, "v": pages.asset_version(),
                "settings": options.all_settings(),
                "settings_api": f"/api/plugins/{links.NAMESPACE}/settings/",
            })

        @signed_in_page
        def sharing_center(request):
            """
            Every link of the projects the user may manage, in one place: listed by the page's script from api.AllLinks,
            created for any of those projects, changed, renewed, revoked and deleted through the per-project API.
            """
            projects = list(pages.manageable_projects(request.user))
            linked = set(links.indexed_project_ids())
            # Embed's views for the projects that have links, as the Share panel offers them
            cards = pages.explorable_tasks([project for project in projects if project.id in linked])
            embed = {}
            for project in projects:
                if project.id in linked:
                    embed[str(project.id)] = pages.embed_views(
                        [card for card in cards if card["task"].project_id == project.id])
            return render(request, self.template_path("sharing.html"), {
                "title": _("Sharing Center"),
                "public": public, "v": pages.asset_version(),
                "projects": [api.project_json(project) for project in projects],
                "link_texts_template": self.template_path("link_texts.html"),
                "embed_views": embed,
                "all_links_api": f"/api/plugins/{links.NAMESPACE}/links/",
                "public_address": options.public_address(),
            })

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
                                           lambda task: pages.link_downloads(task, viewer.api, True), details=True,
                                           page_for=lambda task: pages.task_page_path(viewer.path, task))
            can_share = request.user.has_perm("app.change_project", project)
            return render(request, self.template_path("project.html"), {
                "title": project.name,
                "public": public, "v": pages.asset_version(),
                "project": project,
                "tags": pages.user_tags(project.tags),
                "owner": project.owner if project.owner_id != request.user.id else None,
                "cards": cards,
                "signed_in": True,
                "footprints": pages.task_footprints(cards),
                "basemaps": options.signed_in_basemaps(),
                "cards_template": self.template_path("cards.html"),
                "downloads_template": self.template_path("download_items.html"),
                "link_texts_template": self.template_path("link_texts.html"),
                "thumbnails": viewer.api,
                "can_share": can_share,
                "links": pages.link_summaries(request.user, [project.id]).get(project.id) if can_share else None,
                "links_api": f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/links/",
                # Links to Private Projects: whether this project's links work, the superuser's switch where they
                # aren't allowed, and whether they must all ask for a login
                "links_work": links.links_allowed(project),
                "allow_switch": (request.user.is_superuser and links.public_projects_only()
                                 and not project.public),
                "sign_in_forced": links.sign_in_forced(project),
                "allowed": links.project_allowed(project.id),
                "allowed_api": f"/api/plugins/{links.NAMESPACE}/projects/{project.id}/links-allowed/",
                "public_address": options.public_address() if can_share else "",
                "preview_path": f"{public}project/{project.id}/preview/",
                "embed_views": pages.embed_views(cards),
            })

        def invalid_link(request):
            # One page for an unknown, revoked or expired link, and for a task the link doesn't open
            return link_headers(render(request, self.template_path("link_invalid.html"),
                                       {"title": _("Link Not Valid"), "public": public, "v": pages.asset_version()}, status=404))

        def link_viewer(token, project, link):
            """The link's pages: Explorer's token views. None for a link that doesn't open anything."""
            if project is None:
                return None
            api_path = f"/api/plugins/{links.NAMESPACE}/s/{token}/tasks/"
            return pages.Viewer(project=project, path=f"{public}s/{token}/", api=api_path, tiles_api=api_path,
                                downloads=links.allows_downloads(link), preview=False,
                                sign_in_link=links.needs_sign_in(project, link), photos=links.allows_photos(link),
                                all_files=links.allows_all_files(link))

        def through_link(request, token, show):
            """
            A link page: shown through the link, or WebODM's login first (then back here) for a link that asks for one
            and a visitor who isn't signed in. Any active account will do: the link decides what it opens. (Active: a
            session of a user deactivated since doesn't count, as in WebODM's API; its external sign-in backend loads
            such users.)
            """
            project, link = links.resolve(token)
            signed_in = request.user.is_authenticated and request.user.is_active
            if project is not None and links.needs_sign_in(project, link) and not signed_in:
                return link_headers(redirect_to_login(request.get_full_path()))
            return show(link_viewer(token, project, link))

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
                                downloads=True, preview=False, signed_in=True, all_files=True)

        def viewer_context(viewer, task=None, **extra):
            context = {"public": public, "v": pages.asset_version(), "project": viewer.project, "link_path": viewer.path, "api": viewer.api,
                       "tiles_api": viewer.tiles_api, "thumbnails": viewer.api, "preview": viewer.preview,
                       "signed_in": viewer.signed_in, "task": task,
                       "back": f"{public}project/{viewer.project.id}/",
                       "cards_template": self.template_path("cards.html"),
                       "downloads_template": self.template_path("download_items.html"),
                       "preview_template": self.template_path("preview_bar.html"),
                       "viewer_tools_template": self.template_path("viewer_tools.html"),
                       "present_template": self.template_path("present_tools.html"),
                       "neighbours_template": self.template_path("neighbours.html"),
                       "meta_template": self.template_path("meta.html"), **extra}
            if task is not None:
                # The view switch on the map and 3D pages: the task's map, then its 3D views (its own pages; the 3D
                # page switches between its 3D views in place)
                context["map_view"] = f"{viewer.path}map/{task.id}/" if pages.map_layers(task) else None
                context["views_3d"] = [{"type": kind, "label": label, "icon": icon,
                                        "url": f"{viewer.path}3d/{task.id}/?t={kind}"}
                                       for kind, label, icon in pages.viewer_types(task)]
                context["downloads"] = (pages.link_downloads(task, viewer.api, viewer.all_files) if viewer.downloads
                                        else [])
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
            if viewer.preview or viewer.signed_in or viewer.sign_in_link:
                return None
            image = None
            if picture_task is not None and picture and picture["webodm"]:
                image = request.build_absolute_uri(f"{viewer.api}{picture_task.id}/thumbnail?size=1024")
            return {"title": title, "description": (viewer.project.description or "")[:300], "image": image}

        def list_page(request, viewer):
            if viewer is None:
                return invalid_link(request)
            embed = embedded(request, viewer)
            cards = pages.explorable_tasks([viewer.project],
                                           lambda task: pages.link_outputs(task, viewer.path, embed),
                                           (lambda task: pages.link_downloads(task, viewer.api, viewer.all_files))
                                           if viewer.downloads
                                           else None,
                                           page_for=lambda task: pages.task_page_path(viewer.path, task, embed))
            # As the signed-in project page: the Overview Map above every task's card, only over a basemap (outlines
            # alone say little); link previews show the newest task's picture
            newest = cards[0] if cards else None
            basemaps = options.link_basemaps()
            footprints = pages.link_footprints(cards) if basemaps and len(cards) > 1 else []
            return link_headers(render(request, self.template_path("link.html"), viewer_context(
                viewer, title=viewer.project.name, cards=cards,
                facts=pages.cover_facts(cards), footprints=footprints, basemaps=basemaps, embed=embed,
                meta=preview_meta(request, viewer, viewer.project.name, newest and newest["task"],
                                  newest and newest["picture"]))))

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
                # A signed-in user's own map has WebODM's basemaps, as WebODM's map does; Basemaps on Links rules
                # the link's maps and View as Visitor, which shows them as a link does
                basemaps=options.signed_in_basemaps() if viewer.signed_in else options.link_basemaps(),
                frames=pages.source_frames(viewer, task), frames_texts=pages.frames_texts(),
                measure=pages.measure_tools(viewer, task), measure_texts=pages.measure_texts(),
                measure_template=self.template_path("measure_tools.html"))))

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
            offset = pages.model_offset(task)
            return link_headers(render(request, self.template_path("link_3d.html"), viewer_context(
                viewer, title=title, task=task, embed=embedded(request, viewer),
                meta=preview_meta(request, viewer, f"{title} - {viewer.project.name}", task, pages.thumbnail(task)),
                neighbours=pages.neighbours(viewer.project, task, viewer.path, initial),
                types=[{"type": kind, "label": label, "icon": icon} for kind, label, icon in types],
                initial=initial, mesh_build=mesh_build, preparing=preparing, offset=offset,
                frames=pages.source_frames(viewer, task, offset is not None), frames_texts=pages.frames_texts(),
                measure=pages.measure_scene(task, types, offset), measure_texts=pages.measure_texts(),
                measure_template=self.template_path("measure_tools.html"))))

        def task_view(request, viewer, pk):
            """
            A task's page: everything about one task (its views, downloads, footprint, processing details), for the
            signed-in user in WebODM's layout, and through a link or View as Visitor in the link pages' layout.
            """
            task = pages.explorable_task(viewer.project, pk) if viewer else None
            outputs = pages.link_outputs(task, viewer.path, embedded(request, viewer)) if task else []
            if not outputs:
                return invalid_link(request)
            embed = embedded(request, viewer)
            title = task.name or viewer.project.name
            shape = pages.footprint(task)
            basemaps = options.signed_in_basemaps() if viewer.signed_in else options.link_basemaps()
            # The footprint over a basemap only, as the link page's Overview Map (an outline alone says little)
            footprints = ([{"name": task.name or _("Unnamed Task"), "url": outputs[0]["url"], "geometry": shape}]
                          if shape and basemaps else [])
            response = render(request, self.template_path("task.html"), viewer_context(
                viewer, title=title, task=task, embed=embed,
                base_template="app/plugins/templates/base.html" if viewer.signed_in else "app/public/base.html",
                outputs=outputs, picture=pages.thumbnail(task), tags=pages.user_tags(task.tags),
                details=pages.task_details(task, viewer), footprints=footprints, basemaps=basemaps,
                project_path=viewer.path + ("?embed=1" if embed else ""),
                meta=preview_meta(request, viewer, f"{title} - {viewer.project.name}", task, pages.thumbnail(task)),
                neighbours=pages.neighbours(viewer.project, task, viewer.path, "task")))
            return response if viewer.signed_in else link_headers(response)

        def link_page(request, token):
            return through_link(request, token, lambda viewer: list_page(request, viewer))

        def link_map(request, token, pk):
            return through_link(request, token, lambda viewer: map_page(request, viewer, pk))

        def link_3d(request, token, pk):
            return through_link(request, token, lambda viewer: page_3d(request, viewer, pk))

        def link_task(request, token, pk):
            return through_link(request, token, lambda viewer: task_view(request, viewer, pk))

        @signed_in_page
        def preview_task(request, project_pk, pk):
            return task_view(request, preview_viewer(request, project_pk), pk)

        @signed_in_page
        def own_task(request, project_pk, pk):
            return task_view(request, own_viewer(request, project_pk), pk)

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
            (r"settings/", settings_page),
            (r"sharing/", sharing_center),
            (r"list/(?P<project_pk>[0-9]+)/", list_pane),
            (r"list/results/", list_results),
            (r"project/(?P<project_pk>[0-9]+)/", project_page),
            (rf"project/(?P<project_pk>[0-9]+)/map/{TASK}/", own_map),
            (rf"project/(?P<project_pk>[0-9]+)/3d/{TASK}/", own_3d),
            (rf"project/(?P<project_pk>[0-9]+)/task/{TASK}/", own_task),
            (r"project/(?P<project_pk>[0-9]+)/preview/", preview_page),
            (rf"project/(?P<project_pk>[0-9]+)/preview/map/{TASK}/", preview_map),
            (rf"project/(?P<project_pk>[0-9]+)/preview/3d/{TASK}/", preview_3d),
            (rf"project/(?P<project_pk>[0-9]+)/preview/task/{TASK}/", preview_task),
            (rf"s/{TOKEN}/", link_page),
            (rf"s/{TOKEN}/map/{TASK}/", link_map),
            (rf"s/{TOKEN}/3d/{TASK}/", link_3d),
            (rf"s/{TOKEN}/task/{TASK}/", link_task),
        ])

    def api_mount_points(self):
        base = rf"s/{TOKEN}/tasks/{TASK}/"
        tile = rf"{base}{TILE_TYPE}/tiles/(?P<z>[\d]+)/(?P<x>[\d]+)/(?P<y>[\d]+)"
        return [
            MountPoint(r"settings/$", api.Settings.as_view()),
            MountPoint(r"links/$", api.AllLinks.as_view()),
            MountPoint(r"projects/(?P<project_pk>[0-9]+)/links/$", api.ProjectLinks.as_view()),
            MountPoint(r"projects/(?P<project_pk>[0-9]+)/links-allowed/$", api.ProjectLinksAllowed.as_view()),
            MountPoint(rf"projects/(?P<project_pk>[0-9]+)/links/{TOKEN}/$", api.ProjectLink.as_view()),
            MountPoint(rf"projects/(?P<project_pk>[0-9]+)/tasks/{TASK}/frames/$", api.Frames.as_view()),
            MountPoint(rf"projects/(?P<project_pk>[0-9]+)/tasks/{TASK}/elevation/$", api.Elevation.as_view()),
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
            MountPoint(rf"{base}frames/$", api.TokenFrames.as_view()),
            MountPoint(rf"{base}elevation/$", api.TokenElevation.as_view()),
            # WebODM's Measure plugin's volume views (coreplugins/measure/plugin.py's paths), below the link's token
            MountPoint(rf"{base}volume$", api.TokenVolume.as_view()),
            MountPoint(rf"{base}volume/get/(?P<celery_task_id>[A-Za-z0-9-]+)$", api.TokenVolumeResult.as_view()),
            MountPoint(rf"{base}images/thumbnail/(?P<image_filename>.+)$", api.TokenPhotoThumbnail.as_view()),
            MountPoint(rf"{base}images/download/(?P<image_filename>.+)$", api.TokenPhotoDownload.as_view()),
            MountPoint(rf"{base}textured_model/$", api.TokenTexturedModel.as_view()),
            MountPoint(rf"{base}assets/(?P<unsafe_asset_path>.+)$", api.TokenAssets.as_view()),
            MountPoint(rf"{base}download/(?P<asset>[A-Za-z0-9_.]+)$", api.TokenDownloads.as_view()),
            MountPoint(rf"{base}tiles/(?P<build>[0-9a-f]{{16}})/(?P<path>[A-Za-z0-9_\-/.]+)$",
                       api.TokenMeshTiles.as_view()),
        ]


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

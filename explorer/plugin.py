from app.models import Project
from app.plugins import Menu, MountPoint, PluginBase
from django.contrib.auth.decorators import login_required
from django.http import Http404
from django.shortcuts import get_object_or_404, render
from django.utils.translation import gettext as _

from . import pages


class Plugin(PluginBase):
    """The Explorer plugin: a page per project listing its tasks' outputs (upcoming-changes.md, phase 1)."""

    def main_menu(self):
        return [Menu(_("Explorer"), self.public_url(""), "fa fa-binoculars fa-fw")]

    def app_mount_points(self):
        @login_required
        def project_list(request):
            return render(request, self.template_path("projects.html"), {
                "title": _("Explorer"),
                "public": self.public_url(""),
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
                "public": self.public_url(""),
                "project": project,
                "cards": pages.explorable_tasks([project]),
            })

        return [
            MountPoint("$", project_list),
            MountPoint(r"project/(?P<project_pk>[0-9]+)/$", project_page),
        ]

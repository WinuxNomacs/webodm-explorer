"""
Tests of the home's List view and the remembered view (upcoming-changes.md, "Plan: List view and the task page", step
B), run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import re
from unittest import mock

from app.models import Project
from app.tests.classes import BootTestCase
from coreplugins.explorer import pages
from coreplugins.explorer.tests.test_hub import HubTestMixin
from django.contrib.auth.models import User
from django.test import Client
from guardian.shortcuts import assign_perm

HOME = "/plugins/explorer/"


class ListViewTests(HubTestMixin, BootTestCase):
    def folder(self, response):
        """The folder pane's project names, in order, and the selected one's."""
        html = response.content.decode()
        names = re.findall(r'<span class="explorer-folder-name">([^<]*)</span>', html)
        selected = re.search(r'class="explorer-folder-item active[^"]*"[^>]*data-project="(\d+)"', html, re.DOTALL)
        return names, selected and int(selected.group(1))

    def test_list_view_lists_the_projects_by_name_and_selects_the_first(self):
        alpha = Project.objects.create(owner=self.owner, name="alpha field")
        Project.objects.create(owner=self.owner, name="Zulu")
        response = self.home("view=list&sort=created")
        names, selected = self.folder(response)
        self.assertEqual(names, ["alpha field", "User Test Project", "Zulu"])  # by name, whatever the sort
        self.assertEqual(selected, alpha.id)
        self.assertNotIn("User 2 Test Project", names)
        html = response.content.decode()
        self.assertNotIn('name="sort" data-default', html)  # no Sort in List view
        self.assertIn(f'data-pane-project="{alpha.id}"', html)

    def test_the_pane_shows_the_chosen_projects_details_options_and_tasks(self):
        task = self.task("Roof")
        response = self.home(f"view=list&project={self.project.id}")
        html = response.content.decode()
        own = f"/plugins/explorer/project/{self.project.id}/"
        self.assertIn('class="explorer-list explorer-list-chosen"', html)
        self.assertIn(f'href="{own}task/{task.id}/"', html)  # a row opens the task page
        self.assertIn(f'href="{own}map/{task.id}/"', html)  # and its views open directly
        self.assertIn(f'href="{own}#share"', html)
        self.assertIn(f'href="{own}preview/"', html)
        self.assertIn(f'href="/dashboard/?project_task_open={self.project.id}"', html)
        self.assertIn("Back to Projects", html)

    def test_a_viewer_gets_no_share_and_a_project_without_tasks_no_view_as_visitor(self):
        assign_perm("view_project", self.stranger, self.project)
        html = self.home(f"view=list&project={self.project.id}", "testuser2").content.decode()
        self.assertNotIn(f'href="/plugins/explorer/project/{self.project.id}/#share"', html)
        self.assertNotIn("View as Visitor", html)
        self.assertIn("No completed tasks with outputs yet", html)

    def test_a_project_the_user_cannot_view_is_never_selected(self):
        _names, selected = self.folder(self.home(f"view=list&project={self.other_project.id}"))
        self.assertEqual(selected, self.project.id)
        self.assertNotIn(f'data-pane-project="{self.other_project.id}"',
                         self.home(f"view=list&project={self.other_project.id}").content.decode())

    def test_the_search_and_filters_narrow_the_folder_pane(self):
        Project.objects.create(owner=self.owner, name="Bridge")
        self.assertEqual(self.folder(self.home("view=list&q=bridge"))[0], ["Bridge"])
        response = self.home("view=list&q=nothing-like-it")
        self.assertContains(response, "No projects match.")
        # List view is now this user's default: Clear Filters keeps it without naming it
        self.assertContains(response, 'href="?">Clear Filters')

    def test_the_folder_pane_has_a_limit_and_says_so(self):
        Project.objects.create(owner=self.owner, name="Another")
        with mock.patch.object(pages, "LIST_PROJECTS", 1):
            response = self.home("view=list")
        self.assertEqual(self.folder(response)[0], ["Another"])
        self.assertContains(response, "The first 1 projects by name are listed")

    def test_the_pane_alone_answers_users_who_can_view_the_project_only(self):
        task = self.task("Roof")
        path = f"{HOME}list/{self.project.id}/"
        response = self.client_for("testuser").get(path)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Frame-Options"], "SAMEORIGIN")
        html = response.content.decode()
        self.assertIn(f'data-pane-project="{self.project.id}"', html)
        self.assertIn(f"task/{task.id}/", html)
        self.assertNotIn("<html", html)
        self.assertEqual(self.client_for("testuser2").get(path).status_code, 404)
        self.assertEqual(Client().get(path).status_code, 302)

    def test_the_home_opens_in_the_view_the_user_last_chose(self):
        self.assertIn('class="explorer-grid"', self.home().content.decode())
        self.home("view=list")
        html = self.home().content.decode()
        self.assertIn("data-explorer-list", html)
        # List is the default now: its own links leave the view out, Grid's names it
        self.assertIn('href="?view=grid"', html)
        self.assertIn('<input type="hidden" name="view" value="list" data-default="list">', html)
        self.home("view=map")
        self.assertIn('aria-current="page"><i class="fa fa-map"></i>', self.home().content.decode())
        self.home("view=grid")
        self.assertIn('class="explorer-grid"', self.home().content.decode())
        # Each user's own
        self.home("view=list")
        self.assertNotIn("data-explorer-list", self.home(username="testuser2").content.decode())

    def test_a_view_store_that_fails_opens_the_grid(self):
        with mock.patch.object(pages.UserDataStore, "get_string", side_effect=RuntimeError("store")), \
                self.assertLogs("app.logger", "WARNING"):
            self.assertIn('class="explorer-grid"', self.home().content.decode())
        with mock.patch.object(pages.UserDataStore, "set_string", side_effect=RuntimeError("store")), \
                self.assertLogs("app.logger", "WARNING"):
            self.assertEqual(self.home("view=list").status_code, 200)

    def test_the_address_keeps_the_project_only_in_list_view_and_the_page_only_in_grid(self):
        query = pages.HomeQuery(view="list", project="7", page="3")
        self.assertEqual(query.params(), "view=list&project=7")
        self.assertEqual(query.params(view="grid"), "page=3")
        self.assertEqual(pages.HomeQuery(view="list", default_view="list", project="7").params(), "project=7")
        self.assertEqual(pages.home_query({"project": "x1"}).project, "")
        self.assertEqual(pages.home_query({}, "list").view, "list")
        self.assertEqual(pages.home_query({}, "nonsense").view, "grid")

    def test_a_superuser_lists_every_project(self):
        names, _selected = self.folder(self.home("view=list", "testsuperuser"))
        self.assertEqual(set(names), {"Super User Test Project", "User Test Project", "User 2 Test Project"})

    def user(self, username):
        return User.objects.get(username=username)

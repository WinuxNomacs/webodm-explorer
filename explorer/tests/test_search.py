"""
Tests of the home's Search Projects & Tasks (upcoming-changes.md, "Plan: search projects and tasks"), run inside the
dev stack's web container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import re

from app.models import Project
from app.tests.classes import BootTestCase
from coreplugins.explorer.tests.test_hub import HubTestMixin, square
from guardian.shortcuts import assign_perm
from nodeodm import status_codes


class SearchTests(HubTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        assign_perm("view_project", self.owner, self.other_project)
        self.roof = self.task("Barn Roof", orthophoto_extent=square(-88.0, 42.0))
        self.field = self.task("North Field", orthophoto_extent=square(-80.0, 40.0))
        self.other = self.task("Quarry Face", project=self.other_project, orthophoto_extent=square(10.0, 50.0))

    def folder(self, response):
        return re.findall(r'<span class="explorer-folder-name">([^<]*)</span>', response.content.decode())

    def test_the_box_says_it_searches_projects_and_tasks(self):
        response = self.home()
        self.assertContains(response, 'placeholder="Search Projects & Tasks"')
        self.assertContains(response, "data-explorer-results")

    def test_a_task_name_finds_its_project_in_any_case_and_the_card_names_the_task(self):
        response = self.home("q=barn+ROOF")
        self.assertEqual(self.names(response), ["User Test Project"])
        self.assertContains(response, "Matching task: Barn Roof")
        self.assertNotContains(response, "North Field")

    def test_project_names_descriptions_and_tags_still_match_without_naming_tasks(self):
        Project.objects.filter(pk=self.other_project.pk).update(description="the gravel pit")
        response = self.home("q=gravel")
        self.assertEqual(self.names(response), ["User 2 Test Project"])
        self.assertNotContains(response, "Matching task")
        self.assertEqual(self.names(self.home("q=User+2")), ["User 2 Test Project"])

    def test_a_card_names_three_matching_tasks_and_counts_the_rest(self):
        for name in ("Roof A", "Roof B", "Roof C"):
            self.task(name)
        response = self.home("q=roof")
        self.assertContains(response, "Matching tasks:")
        self.assertContains(response, "and 1 more")

    def test_unfinished_tasks_and_other_users_projects_are_not_found(self):
        self.task("Hidden Roof", status=status_codes.RUNNING, project=self.other_project)
        self.task("Secret Roof", project=self.superuser_project)
        self.assertEqual(self.names(self.home("q=hidden")), [])
        self.assertEqual(self.names(self.home("q=secret")), [])

    def test_list_view_shows_only_the_matching_tasks_with_show_all_tasks(self):
        response = self.home("view=list&q=roof")
        self.assertEqual(self.folder(response), ["User Test Project"])
        html = response.content.decode()
        self.assertIn("Barn Roof", html)
        self.assertNotIn("North Field", html)
        self.assertIn('1 of 2 tasks match "roof".', html)
        self.assertIn(f'data-pane-all="{self.project.id}"', html)
        self.assertIn("2 tasks with outputs", html)

    def test_list_view_shows_every_task_when_only_the_project_matches(self):
        html = self.home("view=list&q=User+Test").content.decode()
        self.assertIn("Barn Roof", html)
        self.assertIn("North Field", html)
        self.assertNotIn("data-pane-all", html)

    def test_the_pane_alone_narrows_to_the_search_or_shows_all_without_it(self):
        client = self.client_for("testuser")
        url = f"/plugins/explorer/list/{self.project.id}/"
        narrowed = client.get(url + "?q=roof").content.decode()
        self.assertIn("Barn Roof", narrowed)
        self.assertNotIn("North Field", narrowed)
        everything = client.get(url).content.decode()
        self.assertIn("North Field", everything)
        self.assertNotIn("data-pane-all", everything)

    def test_the_map_view_places_a_project_around_its_matching_tasks_only(self):
        places = self.json_script(self.home("view=map&q=roof"), "explorer-footprints")
        self.assertEqual([place["name"] for place in places], ["User Test Project"])
        self.assertEqual(places[0]["count"], 1)
        self.assertLess(places[0]["bounds"][0], -87.9)
        self.assertLess(places[0]["bounds"][2], -87.9)  # the North Field, at -80, is left out
        places = self.json_script(self.home("view=map&q=User+Test"), "explorer-footprints")
        self.assertEqual(places[0]["count"], 2)

    def test_a_search_with_markup_is_escaped(self):
        self.task("<b>bold</b> roof")
        response = self.home("q=bold")
        self.assertNotIn("<b>bold</b>", response.content.decode())
        self.assertContains(response, "&lt;b&gt;bold&lt;/b&gt; roof")
        html = self.home("view=list&q=%3Cb%3E").content.decode()
        self.assertNotIn('match "<b>"', html)

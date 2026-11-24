"""
Tests of the task page (upcoming-changes.md, "Plan: List view and the task page", step A), run inside the dev stack's
web container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
from unittest import mock

from app.tests.classes import BootTestCase
from coreplugins.explorer import links
from coreplugins.explorer.tests.test_hub import square
from coreplugins.explorer.tests.test_links import ALL_OUTPUTS, LinkTestMixin
from django.contrib.auth.models import User
from django.test import Client
from guardian.shortcuts import assign_perm
from nodeodm import status_codes
from nodeodm.models import ProcessingNode

BASEMAPS = [{"label": "Streets", "url": "https://tiles.example.com/{z}/{x}/{y}.png", "attribution": "", "maxzoom": 19,
             "minzoom": 0, "default": True}]
OPTIONS = [{"name": "dsm", "value": True}, {"name": "pc-quality", "value": "high"}]


class TaskPageTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.node = ProcessingNode.objects.create(hostname="node-internal.lan", port=3000)
        self.task_ = self.task("Roof", assets=ALL_OUTPUTS + ["report.pdf"], options=OPTIONS, images_count=42,
                               processing_node=self.node, orthophoto_extent=square(-88.0, 42.0))
        patcher = mock.patch("coreplugins.explorer.options.Basemap.get_cached_basemaps", return_value=BASEMAPS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def own(self, task=None):
        return f"/plugins/explorer/project/{self.project.id}/task/{(task or self.task_).id}/"

    def linked(self, token, task=None):
        return f"/plugins/explorer/s/{token}/task/{(task or self.task_).id}/"

    def test_the_signed_in_page_has_the_views_downloads_webodm_footprint_details_and_report(self):
        response = self.client_for("testuser").get(self.own())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Frame-Options"], "SAMEORIGIN")
        html = response.content.decode()
        base = f"/plugins/explorer/project/{self.project.id}/"
        self.assertIn(f'href="{base}map/{self.task_.id}/"', html)
        self.assertIn(f'href="{base}3d/{self.task_.id}/?t=cloud"', html)
        self.assertIn(f'href="/api/projects/{self.project.id}/tasks/{self.task_.id}/download/orthophoto.tif"', html)
        self.assertIn("Open in WebODM", html)
        self.assertIn(f'href="/map/project/{self.project.id}/task/{self.task_.id}/"', html)
        self.assertIn(f'href="/api/projects/{self.project.id}/tasks/{self.task_.id}/download/report.pdf"', html)
        self.assertIn("node-internal.lan:3000", html)
        self.assertIn("<th scope=\"row\">pc-quality</th><td>high</td>", html)
        self.assertIn("<th scope=\"row\">dsm</th><td>true</td>", html)
        self.assertIn('data-explorer-footprints="tasks"', html)
        self.assertIn('id="side-menu"', html)  # WebODM's own layout, with its menu

    def test_a_task_processed_with_the_defaults_says_so(self):
        task = self.task("Plain", options=[])
        self.assertContains(self.client_for("testuser").get(self.own(task)), "WebODM's defaults.")

    def test_through_a_link_the_page_has_no_node_report_or_webodm_pages_and_downloads_only_when_allowed(self):
        token = self.link()["token"]
        response = Client().get(self.linked(token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(response["Referrer-Policy"], "strict-origin")
        html = response.content.decode()
        self.assertIn(f'href="/plugins/explorer/s/{token}/map/{self.task_.id}/"', html)
        self.assertIn("pc-quality", html)
        self.assertNotIn("node-internal", html)
        self.assertNotIn("report.pdf", html)
        self.assertNotIn("Open in WebODM", html)
        self.assertNotIn("/download/", html)
        self.assertIn('property="og:title" content="Roof - User Test Project"', html)
        self.assertNotIn('id="side-menu"', html)
        links.set_downloads(self.project.id, token, True)
        self.assertIn(f'href="/api/plugins/explorer/s/{token}/tasks/{self.task_.id}/download/orthophoto.tif"',
                      Client().get(self.linked(token)).content.decode())

    def test_a_links_footprint_needs_basemaps_on_links(self):
        token = self.link()["token"]
        self.assertContains(Client().get(self.linked(token)), 'data-explorer-footprints="tasks"')
        from coreplugins.explorer import options
        options.set_basemaps_on_links(False)
        self.assertNotContains(Client().get(self.linked(token)), 'data-explorer-footprints')
        # The signed-in page keeps WebODM's basemaps, as its other maps do
        self.assertContains(self.client_for("testuser").get(self.own()), 'data-explorer-footprints="tasks"')

    def test_a_sign_in_link_asks_for_a_login_first(self):
        token = links.create_link(self.project.id, "Client", 30, self.owner, sign_in=True)["token"]
        response = Client().get(self.linked(token))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("/login/?next="))
        self.assertEqual(self.client_for("testuser2").get(self.linked(token)).status_code, 200)

    def test_a_task_the_link_does_not_open_is_not_found(self):
        token = self.link()["token"]
        other = self.task("Theirs", project=self.other_project)
        unfinished = self.task("Running", status=status_codes.RUNNING)
        no_outputs = self.task("Empty", assets=[])
        for task in (other, unfinished, no_outputs):
            self.assertEqual(Client().get(self.linked(token, task)).status_code, 404, task.name)
        self.assertEqual(Client().get("/plugins/explorer/s/" + "x" * 43 + f"/task/{self.task_.id}/").status_code, 404)
        links.revoke_link(self.project.id, token)
        self.assertEqual(Client().get(self.linked(token)).status_code, 404)

    def test_view_as_visitor_shows_the_links_version_to_users_who_can_view_the_project(self):
        path = f"/plugins/explorer/project/{self.project.id}/preview/task/{self.task_.id}/"
        stranger = self.client_for("testuser2")
        self.assertEqual(stranger.get(path).status_code, 404)
        self.assertEqual(stranger.get(self.own()).status_code, 404)
        assign_perm("view_project", User.objects.get(username="testuser2"), self.project)
        html = stranger.get(path).content.decode()
        self.assertIn("explorer-preview-bar", html)
        self.assertNotIn("node-internal", html)
        self.assertNotIn("Open in WebODM", html)
        self.assertEqual(Client().get(path).status_code, 302)

    def test_cards_open_the_task_page_and_their_buttons_still_open_each_view(self):
        token = self.link()["token"]
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/").content.decode()
        self.assertIn(f'class="explorer-thumbnail-link" href="{self.own()}"', html)
        self.assertIn(f'class="explorer-card-title explorer-title-link" href="{self.own()}"', html)
        self.assertIn(f'href="/plugins/explorer/project/{self.project.id}/map/{self.task_.id}/"', html)
        second = self.task("Older")
        second.created_at = self.task_.created_at.replace(year=2020)
        second.save()
        page = Client().get(f"/plugins/explorer/s/{token}/").content.decode()
        self.assertIn(f'class="explorer-cover-picture" href="{self.linked(token)}"', page)  # the newest task
        self.assertIn(f'href="{self.linked(token, second)}"', page)
        embedded = Client().get(f"/plugins/explorer/s/{token}/?embed=1").content.decode()
        self.assertIn(f'href="{self.linked(token, second)}?embed=1"', embedded)

    def test_previous_and_next_step_through_the_task_pages(self):
        older = self.task("Older")
        older.created_at = self.task_.created_at.replace(year=2020)
        older.save()
        html = self.client_for("testuser").get(self.own()).content.decode()
        self.assertIn(f'href="{self.own(older)}" rel="next"', html)
        self.assertIn('1 / 2', html)

    def test_an_embedded_task_page_has_no_previous_and_next_and_keeps_the_embed(self):
        token = self.link()["token"]
        html = Client().get(self.linked(token) + "?embed=1").content.decode()
        self.assertNotIn("explorer-neighbours", html)
        self.assertIn(f'href="/plugins/explorer/s/{token}/map/{self.task_.id}/?embed=1"', html)
        self.assertIn(f'href="/plugins/explorer/s/{token}/?embed=1"', html)

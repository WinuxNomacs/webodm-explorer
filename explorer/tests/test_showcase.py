"""
Tests of UX step 4, showcase (upcoming-changes.md): signed-in pages refuse other sites' frames (clickjacking), the
link landing page, link previews for chat apps and social sites, and embeds. Run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import json
import re
from datetime import timedelta

from app.tests.classes import BootTestCase
from coreplugins.explorer import options
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.test import Client
from django.utils import timezone


def square(west, south, size=0.001):
    return {"type": "Polygon", "coordinates": [[[west, south], [west + size, south], [west + size, south + size],
                                                [west, south + size], [west, south]]]}


class FramingTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        self.own = f"/plugins/explorer/project/{self.project.id}/"

    def test_signed_in_pages_may_only_be_framed_by_webodm_itself(self):
        client = self.client_for("testuser")
        for path in ("/plugins/explorer/", self.own, f"{self.own}map/{self.full.id}/", f"{self.own}3d/{self.full.id}/",
                     f"{self.own}preview/", f"{self.own}preview/map/{self.full.id}/"):
            response = client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertEqual(response["X-Frame-Options"], "SAMEORIGIN", path)
            self.assertEqual(response["Content-Security-Policy"], "frame-ancestors 'self'", path)

    def test_link_pages_stay_frameable(self):
        token = self.link()["token"]
        for path in ("", f"map/{self.full.id}/", f"3d/{self.full.id}/"):
            response = Client().get(f"/plugins/explorer/s/{token}/{path}")
            self.assertEqual(response.status_code, 200, path)
            self.assertFalse(response.has_header("X-Frame-Options"), path)
            self.assertFalse(response.has_header("Content-Security-Policy"), path)


class LandingPageTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        now = timezone.now()
        self.older = self.task("Older", images_count=100, created_at=now - timedelta(days=2),
                               orthophoto_extent=square(-88.0, 42.0))
        self.newest = self.task("Newest", images_count=27, created_at=now - timedelta(days=1),
                                orthophoto_extent=square(-88.01, 42.0))
        self.token = self.link()["token"]
        self.path = f"/plugins/explorer/s/{self.token}/"

    def page(self, query=""):
        return Client().get(self.path + query).content.decode()

    def test_the_page_has_the_projects_facts_then_the_overview_map_then_every_tasks_card(self):
        html = self.page()
        header = html[html.index('class="explorer-link-title"'):html.index("explorer-overview")]
        self.assertIn("User Test Project", header)
        self.assertIn("2 tasks", header)
        self.assertIn("127 images", header)
        # Every task below the map, newest first, each once, as on the signed-in project page
        cards = html[html.index("explorer-overview"):]
        self.assertLess(cards.index(f"{self.newest.id}/thumbnail?size=512"), cards.index(f"{self.older.id}/thumbnail?size=512"))
        self.assertEqual(html.count(f"{self.newest.id}/thumbnail?size=512"), 1)
        self.assertIn(f'href="{self.path}map/{self.newest.id}/"', cards)
        self.assertNotIn("explorer-cover", html)
        self.assertNotIn("More Tasks", html)
        self.assertNotIn("{#", html)  # no template comment shown as text

    def test_the_overview_map_shows_over_a_basemap_only(self):
        html = self.page()
        footprints = json.loads(re.search(r'id="explorer-footprints" type="application/json">(.*?)</script>', html).group(1))
        self.assertEqual({f["name"] for f in footprints}, {"Older", "Newest"})
        self.assertIn("footprints.js", html)
        options.set_basemaps_on_links(False)
        self.assertNotIn("explorer-footprints", self.page())

    def test_a_project_with_one_task_has_its_card_and_no_map(self):
        self.older.delete()
        html = self.page()
        self.assertIn(f"{self.newest.id}/thumbnail?size=512", html)
        self.assertNotIn("explorer-footprints", html)

    def test_a_project_without_tasks_says_so(self):
        self.older.delete()
        self.newest.delete()
        html = self.page()
        self.assertNotIn("explorer-card", html)
        self.assertIn("Nothing to show here yet.", html)

    def test_link_previews_name_the_project_and_show_the_newest_picture_through_the_link(self):
        type(self.project).objects.filter(pk=self.project.pk).update(description='Barn "roof" <survey>')
        html = self.page()
        self.assertIn('<meta property="og:title" content="User Test Project">', html)
        self.assertIn('<meta property="og:description" content="Barn &quot;roof&quot; &lt;survey&gt;">', html)
        self.assertIn(f'<meta property="og:image" content="http://testserver/api/plugins/explorer/s/{self.token}/tasks/'
                      f'{self.newest.id}/thumbnail?size=1024">', html)
        self.assertIn('<meta name="twitter:card" content="summary_large_image">', html)
        self.assertIn('content="noindex, nofollow"', html)
        map_html = Client().get(f"{self.path}map/{self.older.id}/").content.decode()
        self.assertIn('<meta property="og:title" content="Older - User Test Project">', map_html)

    def test_a_picture_drawn_from_tiles_gives_no_preview_image(self):
        self.older.delete()
        self.newest.orthophoto_bands = [{"description": "lwir"}, {"description": None}]
        self.newest.save()
        html = self.page()
        self.assertIn("og:title", html)
        self.assertNotIn("og:image", html)
        self.assertIn('<meta name="twitter:card" content="summary">', html)

    def test_view_as_visitor_shows_the_landing_page_without_previews(self):
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/preview/").content.decode()
        self.assertIn("explorer-overview", html)
        self.assertIn(f"{self.older.id}/thumbnail?size=512", html)
        self.assertNotIn("og:title", html)


class EmbedTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        self.second = self.task("Second", ["georeferenced_model.laz"])
        self.token = self.link()["token"]
        self.path = f"/plugins/explorer/s/{self.token}/"

    def test_an_embedded_view_leaves_out_webodms_header_and_the_way_back_and_opens_the_link_in_a_new_tab(self):
        for view in (f"map/{self.full.id}/", f"3d/{self.full.id}/"):
            html = Client().get(f"{self.path}{view}?embed=1").content.decode()
            self.assertIn("#navbar-top { display: none; }", html, view)
            self.assertIn("explorer-embedded", html, view)
            self.assertIn(f'href="{self.path}" target="_blank" rel="noopener"', html, view)
            self.assertNotIn("explorer-neighbours", html, view)
            self.assertNotIn("fa-arrow-left", html, view)
            self.assertIn("data-fullscreen", html, view)
        html = Client().get(f"{self.path}map/{self.full.id}/").content.decode()
        self.assertNotIn("#navbar-top { display: none; }", html)
        self.assertIn("explorer-neighbours", html)

    def test_the_whole_link_page_embeds_too(self):
        html = Client().get(f"{self.path}?embed=1").content.decode()
        self.assertIn("#navbar-top { display: none; }", html)
        self.assertIn(f"{self.full.id}/thumbnail", html)

    def test_the_views_an_embedded_link_page_opens_stay_embedded(self):
        def views(html):
            return re.findall(rf'href="({re.escape(self.path)}(?:map|3d|task)/[^"]*)"', html)
        embedded = views(Client().get(f"{self.path}?embed=1").content.decode())
        # The cover's picture and buttons, and the other task's card: its picture, title and buttons
        self.assertGreaterEqual(len(embedded), 6)
        for url in embedded:
            self.assertTrue(url.endswith(("?embed=1", "&amp;embed=1")), url)
        for url in views(Client().get(self.path).content.decode()):
            self.assertNotIn("embed", url)

    def test_signed_in_pages_ignore_embed(self):
        own = f"/plugins/explorer/project/{self.project.id}/"
        client = self.client_for("testuser")
        for path in (f"{own}map/{self.full.id}/?embed=1", f"{own}preview/map/{self.full.id}/?embed=1"):
            self.assertNotIn("#navbar-top { display: none; }", client.get(path).content.decode(), path)

    def test_the_share_panel_lists_each_tasks_views_to_embed(self):
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/").content.decode()
        views = json.loads(re.search(r'id="explorer-embed-views" type="application/json">(.*?)</script>', html).group(1))
        self.assertEqual(views[0]["task"], "Second")
        self.assertEqual(views[0]["views"], [{"label": "Point Cloud", "path": f"3d/{self.second.id}/?t=cloud"}])
        self.assertIn({"label": "Map", "path": f"map/{self.full.id}/"}, views[1]["views"])
        self.assertIn('data-embed="Embed"', html)

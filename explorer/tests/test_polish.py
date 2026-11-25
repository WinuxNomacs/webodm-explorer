"""
Tests of UX step 3, viewer polish (upcoming-changes.md): Previous / Next task on the map and 3D pages, and the
controls those pages carry. Run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import os
import re
import shutil
import tempfile
from datetime import timedelta

from app.tests.classes import BootTestCase
from coreplugins.explorer import options, pages
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.test import Client
from django.utils import timezone
from nodeodm import status_codes


class NeighbourTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        now = timezone.now()
        # The cards' order is newest first: newest, middle, oldest
        self.oldest = self.task("Oldest", ["orthophoto.tif", "textured_model.glb"], created_at=now - timedelta(days=3))
        self.middle = self.task("Middle", ["orthophoto.tif", "georeferenced_model.laz", "textured_model.glb"],
                                created_at=now - timedelta(days=2))
        self.newest = self.task("Newest", ["georeferenced_model.laz"], created_at=now - timedelta(days=1))
        self.own = f"/plugins/explorer/project/{self.project.id}/"

    def html(self, path, client=None):
        response = (client or self.client_for("testuser")).get(path)
        self.assertEqual(response.status_code, 200, path)
        return response.content.decode()

    def test_the_map_page_steps_to_the_tasks_before_and_after_in_the_cards_order(self):
        html = self.html(f"{self.own}map/{self.middle.id}/")
        self.assertIn(">2 / 3<", html)
        # The newer task has no map: its first view; the older one opens on its map
        self.assertIn(f'href="{self.own}3d/{self.newest.id}/?t=cloud" rel="prev"', html)
        self.assertIn(f'href="{self.own}map/{self.oldest.id}/" rel="next"', html)
        self.assertIn("Previous: Newest", html)
        self.assertIn("Next: Oldest", html)

    def test_the_3d_page_keeps_its_type_where_the_other_task_has_it_and_says_each_ones_views(self):
        html = self.html(f"{self.own}3d/{self.middle.id}/?t=mesh")
        self.assertIn(f'href="{self.own}3d/{self.oldest.id}/?t=mesh" rel="next"', html)
        self.assertIn(f'href="{self.own}3d/{self.newest.id}/?t=cloud" rel="prev"', html)  # it has no mesh
        self.assertIn(f'data-view-mesh="{self.own}3d/{self.oldest.id}/?t=mesh"', html)
        self.assertIn(f'data-view-map="{self.own}map/{self.oldest.id}/"', html)
        self.assertIn(f'data-open="{self.own}map/{self.oldest.id}/"', html)

    def test_the_first_and_last_tasks_have_one_way_to_go(self):
        first = self.html(f"{self.own}3d/{self.newest.id}/")
        self.assertIn(">1 / 3<", first)
        self.assertNotIn('rel="prev"', first)
        self.assertIn('rel="next"', first)
        last = self.html(f"{self.own}map/{self.oldest.id}/")
        self.assertNotIn('rel="next"', last)

    def test_a_project_with_one_task_has_no_previous_or_next(self):
        self.middle.delete()
        self.newest.delete()
        self.assertNotIn("explorer-neighbours", self.html(f"{self.own}map/{self.oldest.id}/"))

    def test_link_pages_step_through_the_link_and_view_as_visitor_through_the_preview(self):
        token = self.link()["token"]
        html = self.html(f"/plugins/explorer/s/{token}/map/{self.middle.id}/", Client())
        self.assertIn(f'href="/plugins/explorer/s/{token}/map/{self.oldest.id}/" rel="next"', html)
        html = self.html(f"{self.own}preview/map/{self.middle.id}/")
        self.assertIn(f'href="{self.own}preview/map/{self.oldest.id}/" rel="next"', html)

    def test_a_task_being_removed_or_unfinished_is_skipped(self):
        self.oldest.status = status_codes.FAILED
        self.oldest.save()
        html = self.html(f"{self.own}map/{self.middle.id}/")
        self.assertIn(">2 / 2<", html)
        self.assertNotIn('rel="next"', html)

    def test_neighbours_of_a_task_outside_the_list_is_none(self):
        other = self.task("Elsewhere", project=self.other_project)
        self.assertIsNone(pages.neighbours(self.project, other, self.own, "map"))


class ViewerControlTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        self.own = f"/plugins/explorer/project/{self.project.id}/"

    def test_the_3d_page_has_reset_fullscreen_help_and_the_point_cloud_panel(self):
        html = self.client_for("testuser").get(f"{self.own}3d/{self.full.id}/").content.decode()
        for marker in ("data-reset", "data-fullscreen hidden", "data-help-toggle", 'id="explorer-help"',
                       "data-point-size", 'value="elevation"', "viewer-controls.js", "layers.js",
                       'class="explorer-label"'):
            self.assertIn(marker, html)
        self.assertLess(html.index('id="explorer-help"'), html.index('class="explorer-scene"'))

    def test_the_map_page_has_reset_fullscreen_and_opacity_over_a_basemap(self):
        html = self.client_for("testuser").get(f"{self.own}map/{self.full.id}/").content.decode()
        for marker in ("data-reset", "data-fullscreen", "data-opacity", "viewer-controls.js"):
            self.assertIn(marker, html)
        options.set_basemaps_on_links(False)
        token = self.link()["token"]
        html = Client().get(f"/plugins/explorer/s/{token}/map/{self.full.id}/").content.decode()
        self.assertNotIn("data-opacity", html)  # nothing under the layer to see
        self.assertIn("data-reset", html)

    def test_the_map_and_3d_pages_have_the_presentation_tools_for_everyone_who_sees_them(self):
        token = self.link()["token"]
        client = self.client_for("testuser")
        for kind in ("map", "3d"):
            for who, path in (("signed in", f"{self.own}{kind}/{self.full.id}/"),
                              ("preview", f"{self.own}preview/{kind}/{self.full.id}/"),
                              ("link", f"/plugins/explorer/s/{token}/{kind}/{self.full.id}/"),
                              ("embed", f"/plugins/explorer/s/{token}/{kind}/{self.full.id}/?embed=1")):
                html = (Client() if who in ("link", "embed") else client).get(path).content.decode()
                for marker in ("data-present", 'data-tool="laser"', 'data-tool="highlight"', 'data-shape="ellipse"',
                               "data-spotlight", "data-clear", "present.js?v="):
                    self.assertIn(marker, html, f"{kind} {who}")
        # The 3D page's Controls help names the keys
        self.assertIn("L turns the Laser Pointer on and off", client.get(f"{self.own}3d/{self.full.id}/").content.decode())

    def test_basemaps_on_links_off_leaves_the_signed_in_users_own_map_its_basemaps(self):
        options.set_basemaps_on_links(False)
        client = self.client_for("testuser")
        own = client.get(f"{self.own}map/{self.full.id}/").content.decode()
        self.assertIn("data-opacity", own)
        preview = client.get(f"{self.own}preview/map/{self.full.id}/").content.decode()
        self.assertNotIn("data-opacity", preview)  # as a link shows it

    def test_the_map_and_3d_pages_switch_between_the_tasks_map_and_its_3d_views(self):
        client = self.client_for("testuser")
        html = client.get(f"{self.own}map/{self.full.id}/").content.decode()
        self.assertIn(f'href="{self.own}map/{self.full.id}/" aria-current="page"', html)
        for kind in ("cloud", "mesh", "splats"):
            self.assertIn(f'href="{self.own}3d/{self.full.id}/?t={kind}"', html)
        html = client.get(f"{self.own}3d/{self.full.id}/").content.decode()
        self.assertIn(f'href="{self.own}map/{self.full.id}/" title="Map"', html)
        token = self.link()["token"]
        link = f"/plugins/explorer/s/{token}/"
        html = Client().get(f"{link}map/{self.full.id}/?embed=1").content.decode()
        self.assertIn(f'href="{link}3d/{self.full.id}/?t=mesh&amp;embed=1"', html)  # an embed stays an embed
        html = Client().get(f"{link}3d/{self.full.id}/?embed=1").content.decode()
        self.assertIn(f'href="{link}map/{self.full.id}/?embed=1"', html)

    def test_a_task_without_a_map_or_3d_views_has_no_switch_to_them(self):
        no_map = self.task("3D only", ["georeferenced_model.laz"])
        self.assertNotIn('title="Map"', self.client_for("testuser").get(f"{self.own}3d/{no_map.id}/").content.decode())
        flat = self.task("Map only", ["orthophoto.tif"])
        self.assertNotIn("explorer-types", self.client_for("testuser").get(f"{self.own}map/{flat.id}/").content.decode())

    def test_the_visitor_bar_keeps_its_long_half_for_wide_screens(self):
        html = self.client_for("testuser").get(f"{self.own}preview/").content.decode()
        self.assertIn('Viewing as a visitor<span class="explorer-wide">', html)


class BackgroundMenuTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")

    def test_every_3d_page_offers_grid_sky_space_and_plain_and_the_b_key(self):
        own = f"/plugins/explorer/project/{self.project.id}/"
        token = self.link()["token"]
        client = self.client_for("testuser")
        for path, viewer in ((f"{own}3d/{self.full.id}/", client), (f"{own}preview/3d/{self.full.id}/", client),
                             (f"/plugins/explorer/s/{token}/3d/{self.full.id}/", Client()),
                             (f"/plugins/explorer/s/{token}/3d/{self.full.id}/?embed=1", Client())):
            html = viewer.get(path).content.decode()
            found = re.findall(r'data-background="(\w+)"', html)
            self.assertEqual(found, ["grid", "sky", "space", "plain"], path)
            self.assertIn('title="Background (B)"', html, path)
            self.assertIn("B changes the background", html, path)

    def test_the_map_page_has_no_background_menu(self):
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/map/{self.full.id}/").content.decode()
        self.assertNotIn("data-background", html)


class KeepCameraTests(LinkTestMixin, BootTestCase):
    """The 3D page carries WebODM's offset, so the views line up and a switch keeps the camera (viewer/scene.js)."""
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        self.addCleanup(shutil.rmtree, self.full.task_path(), True)
        self.path = f"/plugins/explorer/project/{self.project.id}/3d/{self.full.id}/"

    def coords(self, text):
        os.makedirs(self.full.assets_path("odm_georeferencing"), exist_ok=True)
        with open(self.full.assets_path("odm_georeferencing", "coords.txt"), "w") as f:
            f.write(text)

    def page(self):
        return self.client_for("testuser").get(self.path).content.decode()

    def test_the_3d_page_carries_the_tasks_offset(self):
        self.coords("WGS84 UTM 16N\n410976 4661818\n-5.19 -1.68 226.7\n")
        self.assertIn('data-offset="410976.000 4661818.000"', self.page())
        token = self.link()["token"]
        html = Client().get(f"/plugins/explorer/s/{token}/3d/{self.full.id}/").content.decode()
        self.assertIn('data-offset="410976.000 4661818.000"', html)

    def test_without_a_readable_offset_the_page_has_none_and_switching_frames_each_view(self):
        self.assertNotIn("data-offset", self.page())
        for text in ("WGS84 UTM 16N\n", "WGS84 UTM 16N\nnorth east\n", "WGS84 UTM 16N\nnan 4661818\n"):
            self.coords(text)
            self.assertIsNone(pages.model_offset(self.full), text)
            self.assertNotIn("data-offset", self.page(), text)


class AssetVersionTests(LinkTestMixin, BootTestCase):
    """Explorer's own scripts carry ?v=, so a browser never runs a cached module beside a newer one."""
    def test_every_page_asks_for_explorers_own_files_with_the_current_version(self):
        full = self.task("Full")
        own = f"/plugins/explorer/project/{self.project.id}/"
        token = self.link()["token"]
        version = pages.asset_version()
        client = self.client_for("testuser")
        for path, viewer in (("/plugins/explorer/", client), (own, client), (f"{own}3d/{full.id}/", client),
                             (f"{own}map/{full.id}/", client), (f"/plugins/explorer/s/{token}/", Client()),
                             (f"/plugins/explorer/s/{'A' * 43}/", Client())):
            html = viewer.get(path).content.decode()
            # Script and stylesheet URLs (not the import map's keys, which name the bare URLs)
            files = re.findall(r'"/plugins/explorer/((?:viewer/)?[a-z-]+\.(?:js|css))(\?v=\w+)?"(?!:)', html)
            self.assertTrue(files, path)
            self.assertEqual({suffix for _name, suffix in files}, {f"?v={version}"}, path)
        html = client.get(f"{own}3d/{full.id}/").content.decode()
        # The viewer's own module imports, through the import map
        self.assertIn(f'"/plugins/explorer/viewer/ept.js": "/plugins/explorer/viewer/ept.js?v={version}"', html)
        self.assertIn(f'"/plugins/explorer/viewer/backdrop.js": "/plugins/explorer/viewer/backdrop.js?v={version}"', html)

    def test_the_version_changes_when_a_file_does(self):
        with tempfile.TemporaryDirectory() as folder:
            os.makedirs(os.path.join(folder, "viewer"))
            module = os.path.join(folder, "viewer", "ept.js")
            with open(module, "w") as f:
                f.write("old")
            before = pages.asset_version(folder)
            self.assertEqual(pages.asset_version(folder), before)
            with open(module, "w") as f:
                f.write("newer")
            self.assertNotEqual(pages.asset_version(folder), before)
        self.assertTrue(pages.asset_version("/no/such/folder"))

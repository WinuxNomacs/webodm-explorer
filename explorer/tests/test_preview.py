"""
Tests of Preview: the link pages for a signed-in user who can view the project, without a link. Run inside the dev
stack's web container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import os
import shutil
import tempfile
import time
from unittest import mock

from app.tests.classes import BootTestCase
from coreplugins.explorer import tiles
from coreplugins.explorer import tiles_build as build
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.contrib.auth.models import User
from django.test import Client
from guardian.shortcuts import assign_perm


class PreviewTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.store = tiles.Tiles(os.path.join(self.dir, "tiles"), os.path.join(self.dir, "bin"))
        for patcher in (mock.patch.object(tiles.Tiles, "current", return_value=self.store),
                        mock.patch.object(tiles, "run_function_async")):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.full = self.task("Full")
        self.base = f"/plugins/explorer/project/{self.project.id}/preview/"

    def ready_tiles(self, task):
        """A finished mesh build for the task, as the worker leaves it."""
        obj = task.assets_path(*tiles.MESH)
        os.makedirs(os.path.dirname(obj), exist_ok=True)
        with open(obj, "w") as f:
            f.write("f 1 2 3\n")
        self.addCleanup(shutil.rmtree, task.task_path(), True)
        fp = build.fingerprint(obj)
        build_id = build.build_id(fp)
        folder = os.path.join(self.store.root, str(task.id), build_id)
        os.makedirs(folder)
        with open(os.path.join(folder, "tileset.json"), "w") as f:
            f.write('{"root": {}}')
        build.write_state(self.store.root, task.id, {"state": "ready", "fingerprint": fp, "build": build_id,
                                                     "updated": time.time()})
        return build_id

    def test_the_project_page_offers_a_preview(self):
        response = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/")
        self.assertContains(response, f'href="{self.base}"')

    def test_a_preview_shows_the_link_page_through_webodms_api_with_its_bar(self):
        response = self.client_for("testuser").get(self.base)
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertIn("explorer-preview-bar", html)
        self.assertIn(f'href="/plugins/explorer/project/{self.project.id}/"', html)  # back to Explorer
        self.assertIn(f"{self.base}map/{self.full.id}/", html)
        self.assertIn(f"{self.base}3d/{self.full.id}/?t=cloud", html)
        self.assertIn(f"/api/projects/{self.project.id}/tasks/{self.full.id}/thumbnail", html)
        self.assertNotIn("/download/", html)  # as a link without Allow Downloads
        self.assertEqual(response["Cache-Control"], "private, no-store")

    def test_a_link_page_has_no_preview_bar(self):
        token = self.link()["token"]
        self.assertNotIn("explorer-preview-bar", Client().get(f"/plugins/explorer/s/{token}/").content.decode())

    def test_the_preview_3d_and_map_pages_read_webodms_api_and_explorers_tiles(self):
        build_id = self.ready_tiles(self.full)
        client = self.client_for("testuser")
        html = client.get(f"{self.base}3d/{self.full.id}/?t=mesh").content.decode()
        api = f"/api/projects/{self.project.id}/tasks/{self.full.id}/"
        self.assertIn(f'data-url="{api}assets/entwine_pointcloud/"', html)
        self.assertIn(f'data-url="{api}assets/splats/model.rad"', html)
        self.assertIn(f'data-url="/api/plugins/explorer/projects/{self.project.id}/tasks/{self.full.id}/tiles/{build_id}/tileset.json"', html)
        self.assertIn(f'data-fallback="{api}textured_model/"', html)
        self.assertIn(f'data-link="{self.base}"', html)
        self.assertIn("explorer-preview-bar", html)
        html = client.get(f"{self.base}map/{self.full.id}/").content.decode()
        self.assertIn(f'data-api="{api}"', html)

    def test_a_preview_needs_a_signed_in_user_who_can_view_the_project(self):
        response = Client().get(self.base)
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login/", response["Location"])
        stranger = self.client_for("testuser2")
        for path in ("", f"map/{self.full.id}/", f"3d/{self.full.id}/"):
            self.assertEqual(stranger.get(self.base + path).status_code, 404, path)
        assign_perm("view_project", User.objects.get(username="testuser2"), self.project)
        self.assertEqual(stranger.get(self.base).status_code, 200)  # viewing is enough: nothing is shared

    def test_a_task_of_another_project_does_not_open_in_a_preview(self):
        other = self.task("Elsewhere", project=self.other_project)
        assign_perm("view_project", self.owner, self.other_project)
        self.assertEqual(self.client_for("testuser").get(f"{self.base}3d/{other.id}/").status_code, 404)

    def test_the_preview_tiles_view_serves_viewers_of_the_project_only(self):
        build_id = self.ready_tiles(self.full)
        path = f"/api/plugins/explorer/projects/{self.project.id}/tasks/{self.full.id}/tiles/{build_id}/tileset.json"
        response = self.client_for("testuser").get(path)
        self.assertEqual(response.status_code, 200)
        self.assertIn("immutable", response["Cache-Control"])
        self.assertIn(Client().get(path).status_code, (401, 403))
        self.assertEqual(self.client_for("testuser2").get(path).status_code, 404)
        assign_perm("view_project", self.owner, self.other_project)
        wrong_project = path.replace(f"projects/{self.project.id}/", f"projects/{self.other_project.id}/")
        self.assertEqual(self.client_for("testuser").get(wrong_project).status_code, 404)
        self.assertEqual(self.client_for("testuser").get(path.replace("tileset.json", "../state.json")).status_code, 404)

    def test_a_preview_address_without_its_slash_redirects(self):
        response = self.client_for("testuser").get(f"{self.base}3d/{self.full.id}?t=mesh")
        self.assertEqual(response["Location"], f"{self.base}3d/{self.full.id}/?t=mesh")

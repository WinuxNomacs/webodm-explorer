"""
Tests of downloads through "anyone with the link" shares, run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import os
import shutil

from app.api.tasks import TaskDownloads
from app.tests.classes import BootTestCase
from coreplugins.explorer import api, links
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.contrib.auth.models import User
from django.test import Client
from guardian.shortcuts import assign_perm


class DownloadSettingTests(LinkTestMixin, BootTestCase):
    def test_a_link_allows_downloads_only_when_created_so(self):
        client = self.client_for("testuser")
        response = client.post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
        self.assertEqual(response.status_code, 201)
        self.assertIs(response.json()["downloads"], False)
        response = client.post(self.links_api(), {"expires_days": "30", "downloads": True},
                               content_type="application/json")
        self.assertIs(response.json()["downloads"], True)
        self.assertEqual([link["downloads"] for link in client.get(self.links_api()).json()], [True, False])

    def test_only_a_boolean_sets_downloads(self):
        client = self.client_for("testuser")
        for bad in ("true", 1, "yes", None, [True]):
            response = client.post(self.links_api(), {"downloads": bad}, content_type="application/json")
            self.assertEqual(response.status_code, 400, bad)
        token = self.link()["token"]
        for bad in ("true", 1, None):
            response = client.patch(f"{self.links_api()}{token}/", {"downloads": bad}, content_type="application/json")
            self.assertEqual(response.status_code, 400, bad)
        response = client.patch(f"{self.links_api()}{token}/", {}, content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(client.get(self.links_api()).json()[0]["downloads"], False)

    def test_the_owner_turns_downloads_on_and_off_for_an_existing_link(self):
        client = self.client_for("testuser")
        token = self.link()["token"]
        response = client.patch(f"{self.links_api()}{token}/", {"downloads": True}, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["downloads"], True)
        self.assertEqual(response.json()["token"], token)
        response = client.patch(f"{self.links_api()}{token}/", {"downloads": False}, content_type="application/json")
        self.assertIs(response.json()["downloads"], False)
        self.assertIs(client.get(self.links_api()).json()[0]["downloads"], False)

    def test_downloads_cannot_be_changed_by_a_viewer_through_another_project_or_without_csrf(self):
        token = self.link()["token"]
        assign_perm("view_project", User.objects.get(username="testuser2"), self.project)
        viewer = self.client_for("testuser2")
        response = viewer.patch(f"{self.links_api()}{token}/", {"downloads": True}, content_type="application/json")
        self.assertEqual(response.status_code, 403)
        assign_perm("change_project", self.owner, self.other_project)
        assign_perm("view_project", self.owner, self.other_project)
        response = self.client_for("testuser").patch(f"{self.links_api(self.other_project)}{token}/",
                                                     {"downloads": True}, content_type="application/json")
        self.assertEqual(response.status_code, 404)
        strict = self.client_for("testuser", enforce_csrf_checks=True)
        response = strict.patch(f"{self.links_api()}{token}/", {"downloads": True}, content_type="application/json")
        self.assertEqual(response.status_code, 403)
        self.assertIs(links.allows_downloads(links.list_links(self.project.id)[0]), False)

    def test_an_unknown_link_cannot_be_changed(self):
        client = self.client_for("testuser")
        response = client.patch(f"{self.links_api()}{'A' * 43}/", {"downloads": True}, content_type="application/json")
        self.assertEqual(response.status_code, 404)

    def test_links_saved_before_downloads_existed_do_not_allow_them(self):
        link = self.link()
        saved = links.store().get_json(links.links_key(self.project.id))
        for entry in saved:
            del entry["downloads"]
        links.store().set_json(links.links_key(self.project.id), saved)
        self.assertEqual(len(links.list_links(self.project.id)), 1)
        self.assertIs(links.allows_downloads(links.resolve(link["token"])[1]), False)
        self.assertIs(self.client_for("testuser").get(self.links_api()).json()[0]["downloads"], False)

    def test_a_saved_downloads_value_that_is_not_a_boolean_does_not_parse(self):
        self.link()
        saved = links.store().get_json(links.links_key(self.project.id))
        saved[0]["downloads"] = "yes"
        links.store().set_json(links.links_key(self.project.id), saved)
        self.assertEqual(links.list_links(self.project.id), [])


class DownloadPageTests(LinkTestMixin, BootTestCase):
    def test_the_link_page_offers_a_download_menu_only_when_the_link_allows_downloads(self):
        task = self.task("Shared Task", assets=["orthophoto.tif", "dsm.tif", "georeferenced_model.laz",
                                                 "textured_model.zip", "textured_model.glb", "report.pdf",
                                                 "all.zip", "cameras.json", "splats.rad"])
        token = self.link()["token"]
        downloads = f"/api/plugins/explorer/s/{token}/tasks/{task.id}/download/"
        response = Client().get(f"/plugins/explorer/s/{token}/")
        self.assertNotContains(response, "/download/")
        links.set_downloads(self.project.id, token, True)
        response = Client().get(f"/plugins/explorer/s/{token}/")
        for asset in ("orthophoto.tif", "dsm.tif", "georeferenced_model.laz", "textured_model.zip",
                      "textured_model.glb"):
            self.assertContains(response, f'href="{downloads}{asset}" download')
        for asset in ("dtm.tif", "report.pdf", "all.zip", "cameras.json", "splats.rad"):
            self.assertNotContains(response, f"{downloads}{asset}")

    def test_the_signed_in_project_page_offers_webodms_own_downloads(self):
        task = self.task()
        response = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, f'href="/api/projects/{self.project.id}/tasks/{task.id}/download/orthophoto.tif" download')
        self.assertNotContains(response, "/api/plugins/explorer/s/")


class TokenDownloadTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.token = links.create_link(self.project.id, "Test", 30, self.owner, downloads=True)["token"]
        self.task_ok = self.task()
        for folder, name, content in (("odm_orthophoto", "odm_orthophoto.tif", "ortho"),
                                      ("odm_report", "report.pdf", "private"),
                                      ("odm_texturing", "odm_textured_model_geo.obj", "mesh"),
                                      ("odm_texturing", "odm_textured_model_geo.glb", "glb")):
            os.makedirs(self.task_ok.assets_path(folder), exist_ok=True)
            with open(self.task_ok.assets_path(folder, name), "w") as f:
                f.write(content)
        self.addCleanup(shutil.rmtree, self.task_ok.task_path(), True)

    def url(self, asset, token=None, task=None):
        return f"/api/plugins/explorer/s/{token or self.token}/tasks/{(task or self.task_ok).id}/download/{asset}"

    def body(self, response):
        return b"".join(response.streaming_content) if response.streaming else response.content

    def test_the_view_subclasses_webodms_and_replaces_only_its_permission_check(self):
        self.assertTrue(issubclass(api.TokenDownloads, TaskDownloads))
        self.assertIs(api.TokenDownloads.get, TaskDownloads.get)
        self.assertIs(api.TokenDownloads.get_and_check_task, api.TokenTaskMixin.get_and_check_task)

    def test_a_link_that_allows_downloads_downloads_the_output_files(self):
        response = Client().get(self.url("orthophoto.tif"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.body(response), b"ortho")
        self.assertIn("attachment", response["Content-Disposition"])
        self.assertEqual(response["Referrer-Policy"], "strict-origin")
        response = Client().get(self.url("textured_model.zip"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.body(response)[:2], b"PK")

    def test_a_link_cannot_rename_the_downloaded_file(self):
        response = Client().get(self.url("orthophoto.tif") + "?filename=invoice.exe")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("invoice", response["Content-Disposition"])
        self.assertIn(".tif", response["Content-Disposition"])

    def test_only_the_output_files_can_be_downloaded(self):
        for asset in ("report.pdf", "all.zip", "cameras.json", "shots.geojson", "splats.rad", "orthophoto_tiles.zip",
                      "../odm_report/report.pdf", "orthophoto.tif/"):
            response = Client().get(self.url(asset))
            self.assertEqual(response.status_code, 404, asset)
            self.assertNotIn(b"private", self.body(response))

    def test_a_missing_file_is_not_found(self):
        self.assertEqual(Client().get(self.url("dtm.tif")).status_code, 404)

    def test_downloads_stop_when_turned_off_revoked_or_for_a_link_without_them(self):
        view_only = self.link()["token"]
        self.assertEqual(Client().get(self.url("orthophoto.tif", view_only)).status_code, 404)
        links.set_downloads(self.project.id, self.token, False)
        self.assertEqual(Client().get(self.url("orthophoto.tif")).status_code, 404)
        links.set_downloads(self.project.id, self.token, True)
        self.assertEqual(Client().get(self.url("orthophoto.tif")).status_code, 200)
        links.revoke_link(self.project.id, self.token)
        self.assertEqual(Client().get(self.url("orthophoto.tif")).status_code, 404)

    def test_a_task_outside_the_links_project_cannot_be_downloaded(self):
        elsewhere = self.task(project=self.other_project, public=True)
        self.assertEqual(Client().get(self.url("orthophoto.tif", task=elsewhere)).status_code, 404)

    def test_allowing_downloads_leaves_the_streamed_assets_as_they_were(self):
        response = Client().get(f"/api/plugins/explorer/s/{self.token}/tasks/{self.task_ok.id}/assets/odm_report/"
                                "report.pdf")
        self.assertEqual(response.status_code, 404)

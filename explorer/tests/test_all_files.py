"""
Tests of Allow All Task Files (upcoming-changes.md, "Plan: more task files through links"), run inside the dev stack's
web container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import io
import os
import shutil
import zipfile

from app.models import Task
from app.tests.classes import BootTestCase
from coreplugins.explorer import api, links, pages
from coreplugins.explorer.tests.test_links import ALL_OUTPUTS, LinkTestMixin
from django.test import Client

EXTRA = ["report.pdf", "cameras.json", "shots.geojson", "all.zip", "orthophoto_tiles.zip", "splats.rad"]


class AllFilesSettingTests(LinkTestMixin, BootTestCase):
    def test_a_link_allows_all_task_files_only_when_created_so(self):
        client = self.client_for("testuser")
        response = client.post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
        self.assertIs(response.json()["all_files"], False)
        response = client.post(self.links_api(), {"expires_days": "30", "downloads": True, "all_files": True},
                               content_type="application/json")
        self.assertEqual(response.status_code, 201)
        self.assertIs(response.json()["all_files"], True)
        self.assertIs(links.allows_all_files(links.resolve(response.json()["token"])[1]), True)

    def test_only_a_boolean_sets_all_task_files(self):
        client = self.client_for("testuser")
        for bad in ("true", 1, None, [True]):
            response = client.post(self.links_api(), {"all_files": bad}, content_type="application/json")
            self.assertEqual(response.status_code, 400, bad)
        token = self.link()["token"]
        for bad in ("true", 1, None):
            response = client.patch(f"{self.links_api()}{token}/", {"all_files": bad}, content_type="application/json")
            self.assertEqual(response.status_code, 400, bad)
        self.assertIs(client.get(self.links_api()).json()[0]["all_files"], False)

    def test_the_owner_turns_all_task_files_on_and_off(self):
        client = self.client_for("testuser")
        token = self.link()["token"]
        response = client.patch(f"{self.links_api()}{token}/", {"all_files": True}, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["all_files"], True)
        response = client.patch(f"{self.links_api()}{token}/", {"all_files": False}, content_type="application/json")
        self.assertIs(response.json()["all_files"], False)

    def test_the_option_works_only_with_allow_downloads_and_is_kept_while_downloads_are_off(self):
        link = links.create_link(self.project.id, "Test", 30, self.owner, all_files=True)
        self.assertIs(links.allows_all_files(link), False)
        token = link["token"]
        self.assertIs(self.client_for("testuser").get(self.links_api()).json()[0]["all_files"], True)
        links.set_downloads(self.project.id, token, True)
        self.assertIs(links.allows_all_files(links.resolve(token)[1]), True)
        links.set_downloads(self.project.id, token, False)
        self.assertIs(links.allows_all_files(links.resolve(token)[1]), False)
        links.set_downloads(self.project.id, token, True)
        self.assertIs(links.allows_all_files(links.resolve(token)[1]), True)

    def test_links_saved_before_the_option_existed_do_not_have_it(self):
        token = links.create_link(self.project.id, "Test", 30, self.owner, downloads=True)["token"]
        saved = links.store().get_json(links.links_key(self.project.id))
        del saved[0]["all_files"]
        links.store().set_json(links.links_key(self.project.id), saved)
        self.assertIs(links.allows_all_files(links.resolve(token)[1]), False)
        self.assertIs(self.client_for("testuser").get(self.links_api()).json()[0]["all_files"], False)

    def test_a_saved_value_that_is_not_a_boolean_does_not_parse(self):
        self.link()
        saved = links.store().get_json(links.links_key(self.project.id))
        saved[0]["all_files"] = "yes"
        links.store().set_json(links.links_key(self.project.id), saved)
        self.assertEqual(links.list_links(self.project.id), [])


class AllFilesListTests(BootTestCase):
    def test_the_menu_and_the_allowlists_name_the_same_files_all_in_webodms_assets(self):
        self.assertEqual([a for a, _, _, extra in pages.LINK_DOWNLOADS if not extra], sorted(
            api.DOWNLOADABLE, key=[a for a, *_ in pages.LINK_DOWNLOADS].index))
        self.assertEqual({a for a, _, _, extra in pages.LINK_DOWNLOADS if extra}, set(api.ALL_FILES))
        self.assertFalse(set(api.DOWNLOADABLE) & set(api.ALL_FILES))
        for asset in api.DOWNLOADABLE + api.ALL_FILES:
            self.assertIn(asset, Task.ASSETS_MAP, asset)
        self.assertEqual(pages.LINK_DOWNLOADS[-1][0], "all.zip")


class TokenAllFilesTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.token = links.create_link(self.project.id, "Test", 30, self.owner, downloads=True,
                                       all_files=True)["token"]
        self.task_ok = self.task(assets=ALL_OUTPUTS + EXTRA)
        for folder, name, content in (("odm_orthophoto", "odm_orthophoto.tif", "ortho"),
                                      ("odm_report", "report.pdf", "report"),
                                      ("odm_report", "shots.geojson", "shots"),
                                      (".", "cameras.json", "cameras"),
                                      (".", "images.json", "images-marker"),
                                      (".", "task_output.txt", "processing-log-marker")):
            os.makedirs(self.task_ok.assets_path(folder), exist_ok=True)
            with open(self.task_ok.assets_path(folder, name), "w") as f:
                f.write(content)
        self.addCleanup(shutil.rmtree, self.task_ok.task_path(), True)

    def url(self, asset, token=None):
        return f"/api/plugins/explorer/s/{token or self.token}/tasks/{self.task_ok.id}/download/{asset}"

    def body(self, response):
        return b"".join(response.streaming_content) if response.streaming else response.content

    def test_a_link_with_both_options_downloads_the_extra_files(self):
        for asset, content in (("report.pdf", b"report"), ("shots.geojson", b"shots"), ("cameras.json", b"cameras"),
                               ("orthophoto.tif", b"ortho")):
            response = Client().get(self.url(asset))
            self.assertEqual(response.status_code, 200, asset)
            self.assertEqual(self.body(response), content)
            self.assertIn("attachment", response["Content-Disposition"])
        response = Client().get(self.url("all.zip"))
        self.assertEqual(response.status_code, 200)
        names = zipfile.ZipFile(io.BytesIO(self.body(response))).namelist()
        self.assertIn("odm_report/report.pdf", names)
        self.assertIn("images.json", names)

    def test_the_extra_files_need_both_options(self):
        downloads_only = links.create_link(self.project.id, "Test", 30, self.owner, downloads=True)["token"]
        all_files_only = links.create_link(self.project.id, "Test", 30, self.owner, all_files=True)["token"]
        for token in (downloads_only, all_files_only):
            for asset in ("report.pdf", "all.zip", "cameras.json", "shots.geojson"):
                response = Client().get(self.url(asset, token))
                self.assertEqual(response.status_code, 404, (asset, token == downloads_only))
                self.assertNotIn(b"report", self.body(response))
        self.assertEqual(Client().get(self.url("orthophoto.tif", downloads_only)).status_code, 200)
        self.assertEqual(Client().get(self.url("orthophoto.tif", all_files_only)).status_code, 404)

    def test_files_outside_webodms_download_menu_stay_out_of_reach(self):
        for asset in ("images.json", "task_output.txt", "orthophoto.png", "../odm_report/report.pdf", "report.pdf/",
                      "odm_report/report.pdf", "%2e%2e/report.pdf"):
            response = Client().get(self.url(asset))
            self.assertEqual(response.status_code, 404, asset)
            self.assertNotIn(b"processing-log-marker", self.body(response))
            self.assertNotIn(b"images-marker", self.body(response))

    def test_turning_either_option_off_stops_the_extra_files_at_once(self):
        links.set_options(self.project.id, self.token, all_files=False)
        self.assertEqual(Client().get(self.url("report.pdf")).status_code, 404)
        self.assertEqual(Client().get(self.url("orthophoto.tif")).status_code, 200)
        links.set_options(self.project.id, self.token, all_files=True)
        self.assertEqual(Client().get(self.url("report.pdf")).status_code, 200)
        links.set_downloads(self.project.id, self.token, False)
        self.assertEqual(Client().get(self.url("report.pdf")).status_code, 404)
        links.set_downloads(self.project.id, self.token, True)
        links.revoke_link(self.project.id, self.token)
        self.assertEqual(Client().get(self.url("report.pdf")).status_code, 404)


class AllFilesPageTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.task_ = self.task("Roof", assets=ALL_OUTPUTS + EXTRA)

    def downloads(self, token):
        return f"/api/plugins/explorer/s/{token}/tasks/{self.task_.id}/download/"

    def test_the_link_pages_list_the_extra_files_only_with_both_options(self):
        token = links.create_link(self.project.id, "Test", 30, self.owner, downloads=True)["token"]
        pages_ = (f"/plugins/explorer/s/{token}/", f"/plugins/explorer/s/{token}/task/{self.task_.id}/",
                  f"/plugins/explorer/s/{token}/map/{self.task_.id}/")
        for page in pages_:
            html = Client().get(page).content.decode()
            self.assertIn(f'href="{self.downloads(token)}orthophoto.tif" download', html, page)
            for asset in EXTRA:
                self.assertNotIn(f"{self.downloads(token)}{asset}", html, page)
        links.set_options(self.project.id, token, all_files=True)
        for page in pages_:
            html = Client().get(page).content.decode()
            for asset in EXTRA:
                self.assertIn(f'href="{self.downloads(token)}{asset}" download', html, (page, asset))
            # All Assets last, after a separator, as in WebODM's menu
            self.assertRegex(html, r'class="divider"></li>\s*<li><a href="[^"]*/all\.zip" download>')

    def test_the_link_task_page_has_the_processing_report_only_with_both_options(self):
        token = links.create_link(self.project.id, "Test", 30, self.owner, downloads=True)["token"]
        page = f"/plugins/explorer/s/{token}/task/{self.task_.id}/"
        self.assertNotContains(Client().get(page), "Processing Report")
        links.set_options(self.project.id, token, all_files=True)
        self.assertContains(Client().get(page), f'href="{self.downloads(token)}report.pdf" download><i class="far '
                                                 'fa-file-pdf"></i> Processing Report')

    def test_view_as_visitor_shows_no_extra_files(self):
        client = self.client_for("testuser")
        html = client.get(f"/plugins/explorer/project/{self.project.id}/preview/task/{self.task_.id}/").content.decode()
        self.assertNotIn("all.zip", html)
        self.assertNotIn("Processing Report", html)

    def test_signed_in_users_get_every_file_through_webodms_api(self):
        client = self.client_for("testuser")
        own = f"/api/projects/{self.project.id}/tasks/{self.task_.id}/download/"
        for page in (f"/plugins/explorer/project/{self.project.id}/",
                     f"/plugins/explorer/project/{self.project.id}/task/{self.task_.id}/",
                     f"/plugins/explorer/project/{self.project.id}/map/{self.task_.id}/"):
            html = client.get(page).content.decode()
            self.assertIn(f'href="{own}all.zip" download', html, page)
            self.assertIn(f'href="{own}cameras.json" download', html, page)

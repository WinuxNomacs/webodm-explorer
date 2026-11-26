"""
Tests of "anyone with the link" shares, run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import os
import shutil
import threading
import time
from datetime import timedelta
from unittest import mock

from app import pending_actions
from app.api.tasks import TaskAssets, TaskNestedView, TaskSafeTexturedModel, TaskThumbnail
from app.api.tiler import Bounds, Metadata, TileJson, Tiles
from app.models import Project, Task
from app.plugins import disable_plugin, enable_plugin
from app.tests.classes import BootTestCase, BootTransactionTestCase
from coreplugins.explorer import api, links
from django.contrib.auth.models import User
from django.db import connection, transaction
from django.test import Client
from django.utils import timezone
from guardian.shortcuts import assign_perm
from nodeodm import status_codes

PASSWORD = "test1234"
ALL_OUTPUTS = ["orthophoto.tif", "dsm.tif", "dtm.tif", "georeferenced_model.laz", "textured_model.zip",
               "textured_model.glb", "splats.rad"]


class LinkTestMixin:
    def setUp(self):
        super().setUp()
        disable_plugin("explorer")
        enable_plugin("explorer")
        self.project = Project.objects.get(name="User Test Project")  # owned by testuser
        self.other_project = Project.objects.get(name="User 2 Test Project")
        self.owner = User.objects.get(username="testuser")

    def tearDown(self):
        disable_plugin("explorer")
        super().tearDown()

    def client_for(self, username, **kwargs):
        client = Client(**kwargs)
        self.assertTrue(client.login(username=username, password=PASSWORD))
        return client

    def task(self, name="Task", assets=ALL_OUTPUTS, status=status_codes.COMPLETED, project=None, **fields):
        return Task.objects.create(project=project or self.project, name=name, status=status,
                                   available_assets=list(assets), **fields)

    def link(self, project=None, days=30):
        return links.create_link((project or self.project).id, "Test", days, self.owner)

    def links_api(self, project=None):
        return f"/api/plugins/explorer/projects/{(project or self.project).id}/links/"


class LinksApiTests(LinkTestMixin, BootTestCase):
    def test_the_owner_creates_and_lists_links(self):
        client = self.client_for("testuser")
        self.assertEqual(client.get(self.links_api()).json(), [])
        response = client.post(self.links_api(), {"label": "  For the client  ", "expires_days": "30"},
                               content_type="application/json")
        self.assertEqual(response.status_code, 201)
        link = response.json()
        self.assertEqual(link["label"], "For the client")
        self.assertRegex(link["token"], r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(link["path"], f"/plugins/explorer/s/{link['token']}/")
        expires = timezone.datetime.fromisoformat(link["expires"]) - timezone.datetime.fromisoformat(link["created"])
        self.assertEqual(expires, timedelta(days=30))
        self.assertEqual(client.get(self.links_api()).json(), [link])

    def test_a_link_can_never_expire_and_other_expiries_are_refused(self):
        client = self.client_for("testuser")
        response = client.post(self.links_api(), {"expires_days": "never"}, content_type="application/json")
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.json()["expires"])
        for bad in (5, "abc", 0, -1, [30]):
            response = client.post(self.links_api(), {"expires_days": bad}, content_type="application/json")
            self.assertEqual(response.status_code, 400, bad)
        response = client.post(self.links_api(), {"label": ["x"]}, content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_the_links_api_refuses_what_the_browser_marks_as_another_sites_request(self):
        client = self.client_for("testuser")
        self.assertEqual(client.get(self.links_api(), HTTP_SEC_FETCH_SITE="cross-site").status_code, 403)
        self.assertEqual(client.get(self.links_api(), HTTP_SEC_FETCH_SITE="same-origin").status_code, 200)
        self.assertEqual(client.get(self.links_api()).status_code, 200)  # no header: an older browser or a script
        admin = self.client_for("testsuperuser")
        self.assertEqual(admin.get("/api/plugins/explorer/settings/", HTTP_SEC_FETCH_SITE="cross-site").status_code, 403)
        self.assertEqual(admin.patch(f"/api/plugins/explorer/projects/{self.project.id}/links-allowed/", {"allowed": True},
                                     content_type="application/json", HTTP_SEC_FETCH_SITE="cross-site").status_code, 403)

    def test_a_json_body_that_is_not_an_object_is_refused_not_a_server_error(self):
        client = self.client_for("testuser")
        token = self.link()["token"]
        for body in ("[]", '"x"', "3", "null"):
            self.assertEqual(client.post(self.links_api(), body, content_type="application/json").status_code, 400, body)
            self.assertEqual(client.patch(f"{self.links_api()}{token}/", body, content_type="application/json")
                             .status_code, 400, body)

    def test_a_long_label_is_cut_to_100_characters(self):
        response = self.client_for("testuser").post(self.links_api(), {"label": "x" * 300},
                                                    content_type="application/json")
        self.assertEqual(len(response.json()["label"]), 100)

    def test_a_user_who_can_only_view_the_project_cannot_manage_its_links(self):
        assign_perm("view_project", User.objects.get(username="testuser2"), self.project)
        client = self.client_for("testuser2")
        self.assertEqual(client.get(self.links_api()).status_code, 403)
        self.assertEqual(client.post(self.links_api(), {}, content_type="application/json").status_code, 403)
        token = self.link()["token"]
        self.assertEqual(client.delete(f"{self.links_api()}{token}/").status_code, 403)
        self.assertIsNotNone(links.project_for_token(token))

    def test_a_user_who_cannot_see_the_project_gets_not_found_and_anonymous_visitors_are_refused(self):
        self.assertEqual(self.client_for("testuser2").get(self.links_api()).status_code, 404)
        self.assertIn(Client().get(self.links_api()).status_code, (401, 403))
        self.assertIn(Client().post(self.links_api(), {}, content_type="application/json").status_code, (401, 403))

    def test_creating_or_revoking_needs_the_csrf_token(self):
        client = self.client_for("testuser", enforce_csrf_checks=True)
        self.assertEqual(client.post(self.links_api(), {}, content_type="application/json").status_code, 403)
        page = client.get(f"/plugins/explorer/project/{self.project.id}/")
        csrf = page.context["csrf_token"]
        response = client.post(self.links_api(), {}, content_type="application/json", HTTP_X_CSRFTOKEN=str(csrf))
        self.assertEqual(response.status_code, 201)
        token = response.json()["token"]
        self.assertEqual(client.delete(f"{self.links_api()}{token}/").status_code, 403)
        self.assertEqual(client.delete(f"{self.links_api()}{token}/", HTTP_X_CSRFTOKEN=str(csrf)).status_code, 204)

    def test_revoking_a_link_stops_it_at_once(self):
        token = self.link()["token"]
        self.assertEqual(Client().get(f"/plugins/explorer/s/{token}/").status_code, 200)
        client = self.client_for("testuser")
        self.assertEqual(client.delete(f"{self.links_api()}{token}/").status_code, 204)
        self.assertEqual(Client().get(f"/plugins/explorer/s/{token}/").status_code, 404)
        self.assertEqual(client.get(self.links_api()).json(), [])
        self.assertEqual(client.delete(f"{self.links_api()}{token}/").status_code, 404)

    def test_a_link_cannot_be_revoked_through_another_project(self):
        assign_perm("change_project", self.owner, self.other_project)
        assign_perm("view_project", self.owner, self.other_project)
        token = self.link()["token"]
        response = self.client_for("testuser").delete(f"{self.links_api(self.other_project)}{token}/")
        self.assertEqual(response.status_code, 404)
        self.assertIsNotNone(links.project_for_token(token))

    def test_the_share_panel_offers_links_only_to_users_who_can_change_the_project(self):
        page = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/")
        self.assertContains(page, f'data-links-api="{self.links_api()}"')
        self.assertContains(page, "csrfmiddlewaretoken")
        assign_perm("view_project", User.objects.get(username="testuser2"), self.project)
        page = self.client_for("testuser2").get(f"/plugins/explorer/project/{self.project.id}/")
        self.assertEqual(page.status_code, 200)
        self.assertNotContains(page, "data-links-api")


class LinkStoreTests(LinkTestMixin, BootTestCase):
    def test_an_expired_link_is_refused_kept_for_90_days_then_dropped_at_the_next_change(self):
        token = self.link(days=7)["token"]
        later = timezone.now() + timedelta(days=8)
        with mock.patch("coreplugins.explorer.links.timezone.now", return_value=later):
            self.assertIsNone(links.project_for_token(token))
            self.assertEqual(links.list_links(self.project.id), [])
            self.assertEqual(Client().get(f"/plugins/explorer/s/{token}/").status_code, 404)
            self.link()  # a write: the expired link is kept, with its token key, but still opens nothing
            self.assertTrue(links.store().has_key(links.token_key(token)))
            self.assertEqual(len(links.store().get_json(links.links_key(self.project.id))), 2)
            self.assertIsNone(links.project_for_token(token))
        much_later = timezone.now() + timedelta(days=7 + links.RETAIN_EXPIRED_DAYS + 1)
        with mock.patch("coreplugins.explorer.links.timezone.now", return_value=much_later):
            self.assertNotIn(token, [link["token"] for link in links.kept_links(self.project.id)])
            self.link()
            self.assertFalse(links.store().has_key(links.token_key(token)))
            self.assertEqual(len(links.store().get_json(links.links_key(self.project.id))), 2)

    def test_a_saved_entry_that_does_not_parse_means_no_links_until_the_next_change(self):
        for broken in ("text", {"token": "x"}, [{"token": 1}], [{"token": "a", "label": "", "created": "nope",
                                                                 "expires": None}]):
            links.store().set_json(links.links_key(self.project.id), broken)
            with self.assertLogs("app.logger", "WARNING"):
                self.assertEqual(links.list_links(self.project.id), [])
        response = self.client_for("testuser").get(self.links_api())
        self.assertEqual(response.status_code, 200)
        with self.assertLogs("app.logger", "WARNING"):
            token = self.link()["token"]
        self.assertEqual([link["token"] for link in links.list_links(self.project.id)], [token])

    def test_a_token_key_without_its_link_leads_nowhere(self):
        links.store().set_int(links.token_key("A" * 43), self.project.id)
        self.assertIsNone(links.project_for_token("A" * 43))

    def test_the_links_of_a_removed_project_are_refused_and_dropped(self):
        project = Project.objects.create(owner=self.owner, name="Short Lived")
        token = self.link(project)["token"]
        project_id = project.id
        Project.objects.filter(pk=project_id).delete()
        self.assertIsNone(links.project_for_token(token))
        self.assertFalse(links.store().has_key(links.token_key(token)))
        self.assertFalse(links.store().has_key(links.links_key(project_id)))

    def test_odd_tokens_are_refused(self):
        for token in (None, "", "short", "x" * 44, 42):
            self.assertIsNone(links.project_for_token(token))


class LinkPagesTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.token = self.link()["token"]
        self.base = f"/plugins/explorer/s/{self.token}/"

    def test_the_link_page_opens_without_signing_in_and_offers_explorers_own_views(self):
        task = self.task("Shared Task")
        response = Client().get(self.base)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "User Test Project")
        self.assertContains(response, "Shared Task")
        self.assertContains(response, f'href="{self.base}map/{task.id}/"')
        self.assertContains(response, f'href="{self.base}3d/{task.id}/?t=cloud"')
        self.assertContains(response, f'href="{self.base}3d/{task.id}/?t=mesh"')
        self.assertContains(response, f'href="{self.base}3d/{task.id}/?t=splats"')
        self.assertContains(response, f'src="/api/plugins/explorer/s/{self.token}/tasks/{task.id}/thumbnail?size=512"')  # its card
        # Nothing of WebODM's own pages or API
        self.assertNotContains(response, "/api/projects/")
        self.assertNotContains(response, 'href="/map/')
        self.assertNotContains(response, 'href="/3d/')

    def test_link_pages_keep_the_token_out_of_referers_and_shared_caches(self):
        task = self.task()
        for url in (self.base, f"{self.base}map/{task.id}/", f"{self.base}3d/{task.id}/", "/plugins/explorer/s/"
                    + "A" * 43 + "/"):
            response = Client().get(url)
            self.assertEqual(response["Referrer-Policy"], "strict-origin", url)
            self.assertIn("no-store", response["Cache-Control"], url)
            self.assertIn("noindex", response["X-Robots-Tag"], url)

    def test_an_unknown_or_revoked_link_gets_one_plain_not_found_page(self):
        unknown = Client().get("/plugins/explorer/s/" + "A" * 43 + "/")
        self.assertEqual(unknown.status_code, 404)
        self.assertContains(unknown, "Link Not Valid", status_code=404)
        links.revoke_link(self.project.id, self.token)
        revoked = Client().get(self.base)
        self.assertEqual(revoked.status_code, 404)
        self.assertEqual(revoked.content, unknown.content)

    def test_the_map_page_needs_a_task_of_the_links_project_with_a_layer(self):
        task = self.task(assets=["orthophoto.tif", "dsm.tif"])
        response = Client().get(f"{self.base}map/{task.id}/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, f'data-api="/api/plugins/explorer/s/{self.token}/tasks/{task.id}/"')
        self.assertContains(response, 'data-layer="orthophoto"')
        self.assertContains(response, 'data-layer="dsm"')
        self.assertNotContains(response, 'data-layer="dtm"')
        for other in (self.task(assets=["textured_model.glb"]),
                      self.task(status=status_codes.RUNNING),
                      self.task(pending_action=pending_actions.REMOVE),
                      self.task(project=self.other_project)):
            self.assertEqual(Client().get(f"{self.base}map/{other.id}/").status_code, 404)

    def test_the_3d_page_offers_the_tasks_types_and_opens_the_one_asked_for(self):
        task = self.task()
        response = Client().get(f"{self.base}3d/{task.id}/?t=splats")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-initial="splats"')
        self.assertContains(response, f'data-url="/api/plugins/explorer/s/{self.token}/tasks/{task.id}/textured_model/"')
        self.assertContains(response, f'data-url="/api/plugins/explorer/s/{self.token}/tasks/{task.id}/assets/splats/model.rad"')
        self.assertContains(response, f'data-url="/api/plugins/explorer/s/{self.token}/tasks/{task.id}/assets/entwine_pointcloud/"')
        self.assertContains(response, '<script type="importmap">')
        self.assertContains(response, "vendor/laz-perf-0.0.7/lib/worker/laz-perf.wasm")
        # The point cloud first, as on WebODM's own 3D page
        self.assertContains(Client().get(f"{self.base}3d/{task.id}/?t=nope"), 'data-initial="cloud"')
        mesh_first = self.task(assets=["textured_model.glb", "splats.rad"])
        self.assertContains(Client().get(f"{self.base}3d/{mesh_first.id}/"), 'data-initial="mesh"')
        cloud_only = self.task(assets=["georeferenced_model.las"])
        self.assertContains(Client().get(f"{self.base}3d/{cloud_only.id}/"), 'data-initial="cloud"')
        splats_only = self.task(assets=["splats.rad", "textured_model.zip"])
        self.assertContains(Client().get(f"{self.base}3d/{splats_only.id}/"), 'data-initial="splats"')
        nothing = self.task(assets=["orthophoto.tif", "textured_model.zip"])
        self.assertEqual(Client().get(f"{self.base}3d/{nothing.id}/").status_code, 404)

    def test_names_on_link_pages_are_escaped(self):
        task = self.task("<b>Task</b>")
        self.project.name = "<script>x</script>"
        self.project.save()
        for url in (self.base, f"{self.base}map/{task.id}/", f"{self.base}3d/{task.id}/"):
            response = Client().get(url)
            self.assertNotContains(response, "<script>x</script>")
            self.assertNotContains(response, "<b>Task</b>")


class TokenViewTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.token = self.link()["token"]
        self.task_ok = self.task()
        os.makedirs(self.task_ok.assets_path("splats"), exist_ok=True)
        os.makedirs(self.task_ok.assets_path("entwine_pointcloud"), exist_ok=True)
        os.makedirs(self.task_ok.assets_path("odm_report"), exist_ok=True)
        with open(self.task_ok.assets_path("splats", "model.rad"), "wb") as f:
            f.write(bytes(range(256)) * 4)
        with open(self.task_ok.assets_path("entwine_pointcloud", "ept.json"), "w") as f:
            f.write("{}")
        with open(self.task_ok.assets_path("odm_report", "report.pdf"), "w") as f:
            f.write("private")
        self.addCleanup(shutil.rmtree, self.task_ok.task_path(), True)

    def url(self, task, rest, token=None):
        return f"/api/plugins/explorer/s/{token or self.token}/tasks/{task.id}/{rest}"

    PATHS = ("orthophoto/tiles.json", "dsm/bounds", "dtm/metadata", "orthophoto/tiles/1/2/3.png",
             "orthophoto/tiles/1/2/3@2x.png", "thumbnail", "textured_model/", "assets/splats/model.rad")

    def test_the_views_subclass_webodms_and_replace_only_its_permission_check(self):
        for view, base in ((api.TokenTileJson, TileJson), (api.TokenBounds, Bounds), (api.TokenMetadata, Metadata),
                           (api.TokenTiles, Tiles), (api.TokenThumbnail, TaskThumbnail),
                           (api.TokenAssets, TaskAssets), (api.TokenTexturedModel, TaskSafeTexturedModel)):
            self.assertTrue(issubclass(view, base))
            self.assertIs(view.get, base.get)
            self.assertIs(view.get_and_check_task, api.TokenTaskMixin.get_and_check_task)
            self.assertTrue(hasattr(TaskNestedView, "get_and_check_task"))

    def test_a_live_link_streams_the_splats_with_ranges(self):
        response = Client().get(self.url(self.task_ok, "assets/splats/model.rad"), HTTP_RANGE="bytes=0-9")
        self.assertEqual(response.status_code, 206)
        self.assertEqual(b"".join(response.streaming_content), bytes(range(10)))
        self.assertEqual(response["Referrer-Policy"], "strict-origin")
        self.assertEqual(response["Cache-Control"], "private")  # never kept by a shared cache after a revoke
        response = Client().get(self.url(self.task_ok, "assets/entwine_pointcloud/ept.json"))
        self.assertEqual(response.status_code, 200)

    def test_a_live_link_streams_the_point_cloud_nodes_and_hierarchy(self):
        for folder, name in (("ept-data", "0-0-0-0.laz"), ("ept-hierarchy", "1-0-1-0.json")):
            os.makedirs(self.task_ok.assets_path("entwine_pointcloud", folder), exist_ok=True)
            with open(self.task_ok.assets_path("entwine_pointcloud", folder, name), "w") as f:
                f.write(name)
            response = Client().get(self.url(self.task_ok, f"assets/entwine_pointcloud/{folder}/{name}"))
            self.assertEqual(response.status_code, 200, name)
            body = b"".join(response.streaming_content) if response.streaming else response.content
            self.assertEqual(body, name.encode())

    def test_every_view_refuses_an_unknown_revoked_or_expired_link(self):
        unknown = "A" * 43
        for path in self.PATHS:
            self.assertEqual(Client().get(self.url(self.task_ok, path, unknown)).status_code, 404, path)
        expiring = self.link(days=7)["token"]
        with mock.patch("coreplugins.explorer.links.timezone.now", return_value=timezone.now() + timedelta(days=8)):
            for path in self.PATHS:
                self.assertEqual(Client().get(self.url(self.task_ok, path, expiring)).status_code, 404, path)
        links.revoke_link(self.project.id, self.token)
        for path in self.PATHS:
            self.assertEqual(Client().get(self.url(self.task_ok, path)).status_code, 404, path)

    def test_every_view_refuses_a_task_the_link_does_not_open(self):
        public_elsewhere = self.task(project=self.other_project, public=True)
        for task in (public_elsewhere, self.task(status=status_codes.RUNNING),
                     self.task(pending_action=pending_actions.REMOVE)):
            for path in self.PATHS:
                self.assertEqual(Client().get(self.url(task, path)).status_code, 404, path)

    def test_only_the_streamed_assets_are_served(self):
        for path in ("odm_report/report.pdf", "splats/../odm_report/report.pdf", "../../../etc/passwd",
                     "entwine_pointcloud/../odm_report/report.pdf", "entwine_pointcloud/%2e%2e/odm_report/report.pdf",
                     "%2e%2e/odm_report/report.pdf", "splats/model.rad/", "splats//model.rad",
                     "entwine_pointcloud//ept.json", "entwine_pointcloud/./ept.json", "georeferenced_model.laz",
                     "splats/splatme-model.ply"):
            response = Client().get(self.url(self.task_ok, "assets/" + path))
            self.assertEqual(response.status_code, 404, path)
            self.assertNotIn(b"private", b"".join(getattr(response, "streaming_content", [response.content])))

    def test_the_asset_check(self):
        self.assertTrue(api.asset_allowed("splats/model.rad"))
        self.assertTrue(api.asset_allowed("entwine_pointcloud/ept-data/0-0-0-0.laz"))
        self.assertTrue(api.asset_allowed("entwine_pointcloud/ept-hierarchy/1-0-1-0.json"))
        # Not what the viewer doesn't stream: ept-sources/ holds the processing node's file paths
        for path in ("entwine_pointcloud/ept-sources/manifest.json", "entwine_pointcloud/ept-sources/0.json",
                     "entwine_pointcloud/ept-build.json", "entwine_pointcloud/ept-data/0-0-0-0.bin"):
            self.assertFalse(api.asset_allowed(path), path)
        for path in ("entwine_pointcloud/", "entwine_pointcloud/a/../b", "/splats/model.rad", "splats\\model.rad",
                     "entwine_pointcloud/a b", None):
            self.assertFalse(api.asset_allowed(path), path)


class ConcurrentLinkTests(LinkTestMixin, BootTransactionTestCase):
    """Real transactions: two threads, each with its own database connection."""

    def run_thread(self, target, name=None):
        errors = []

        def run():
            try:
                target()
            except Exception as e:  # noqa: BLE001 - any failure is reported by the test
                errors.append(e)
            finally:
                connection.close()

        thread = threading.Thread(target=run, name=name)
        thread.start()
        return thread, errors

    def test_a_revoke_during_a_create_is_not_undone(self):
        revoked = self.link()["token"]
        read_done, go = threading.Event(), threading.Event()
        real_read = links._read

        def slow_read(project_id):
            value = real_read(project_id)
            if threading.current_thread().name == "creator":
                read_done.set()
                go.wait(5)
            return value

        with mock.patch("coreplugins.explorer.links._read", side_effect=slow_read):
            created = {}
            creator, creator_errors = self.run_thread(
                lambda: created.update(links.create_link(self.project.id, "New", 30, None)), "creator")
            self.assertTrue(read_done.wait(5))
            revoker, revoker_errors = self.run_thread(lambda: links.revoke_link(self.project.id, revoked))
            time.sleep(0.5)  # the revoke waits on the lock meanwhile
            go.set()
            creator.join(10)
            revoker.join(10)
        self.assertEqual(creator_errors + revoker_errors, [])
        tokens = [link["token"] for link in links.list_links(self.project.id)]
        self.assertEqual(tokens, [created["token"]])
        self.assertIsNone(links.project_for_token(revoked))

    def test_a_lock_held_too_long_answers_503(self):
        held, release = threading.Event(), threading.Event()

        def hold():
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_xact_lock(%s)", [links.LOCK_ID])
                held.set()
                release.wait(10)

        holder, errors = self.run_thread(hold)
        self.assertTrue(held.wait(5))
        try:
            with mock.patch.object(links, "LOCK_TIMEOUT", "200ms"):
                with self.assertRaises(links.LinkStoreBusy):
                    links.create_link(self.project.id, "", 30, None)
                response = self.client_for("testuser").post(self.links_api(), {}, content_type="application/json")
            self.assertEqual(response.status_code, 503)
        finally:
            release.set()
            holder.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(links.list_links(self.project.id), [])

"""
Tests of sign-in links and Links to Private Projects (upcoming-changes.md, "Plan: sign-in links"), run inside the dev
stack's web container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import os
import shutil
from unittest import mock

from app.tests.classes import BootTestCase
from coreplugins.explorer import links, options
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.test import Client

SETTINGS_API = "/api/plugins/explorer/settings/"


class SignInLinkTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        # A file a link streams, to tell an answer from the link's refusal (404)
        os.makedirs(self.full.assets_path("entwine_pointcloud"), exist_ok=True)
        with open(self.full.assets_path("entwine_pointcloud", "ept.json"), "w") as f:
            f.write("{}")
        self.addCleanup(shutil.rmtree, self.full.task_path(), True)

    def sign_in_link(self, sign_in=True):
        return links.create_link(self.project.id, "Client", 30, self.owner, sign_in=sign_in)

    def paths(self, token):
        page = f"/plugins/explorer/s/{token}/"
        return page, f"{page}map/{self.full.id}/", f"{page}3d/{self.full.id}/"

    def thumbnail(self, token):
        """A file the link streams (the point cloud's ept.json)."""
        return f"/api/plugins/explorer/s/{token}/tasks/{self.full.id}/assets/entwine_pointcloud/ept.json"

    def make_public(self, public=True):
        self.project.public = public
        self.project.save()

    def test_a_sign_in_link_sends_a_visitor_who_is_not_signed_in_to_webodms_login_and_back(self):
        token = self.sign_in_link()["token"]
        for path in self.paths(token):
            response = Client().get(path + "?embed=1")
            self.assertEqual(response.status_code, 302, path)
            self.assertTrue(response["Location"].startswith("/login/?next="), response["Location"])
            self.assertIn(token, response["Location"])  # back to the same page after the login
            self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(Client().get(self.thumbnail(token)).status_code, 404)

    def test_any_webodm_account_opens_a_sign_in_link_even_one_the_project_is_not_shared_with(self):
        token = self.sign_in_link()["token"]
        stranger = self.client_for("testuser2")
        self.assertFalse(self.user("testuser2").has_perm("app.view_project", self.project))
        for path in self.paths(token):
            self.assertEqual(stranger.get(path).status_code, 200, path)
        self.assertEqual(stranger.get(self.thumbnail(token)).status_code, 200)

    def test_a_link_without_sign_in_still_opens_for_anyone(self):
        token = self.sign_in_link(sign_in=False)["token"]
        self.assertEqual(Client().get(self.paths(token)[0]).status_code, 200)
        self.assertEqual(Client().get(self.thumbnail(token)).status_code, 200)

    def test_a_sign_in_link_has_no_preview_for_chat_apps(self):
        token = self.sign_in_link()["token"]
        html = self.client_for("testuser2").get(self.paths(token)[0]).content.decode()
        self.assertNotIn('property="og:title"', html)
        open_html = Client().get(self.paths(self.sign_in_link(sign_in=False)["token"])[0]).content.decode()
        self.assertIn('property="og:title"', open_html)

    def test_the_owner_creates_a_sign_in_link_and_turns_sign_in_on_and_off(self):
        owner = self.client_for("testuser")
        created = owner.post(self.links_api(), {"expires_days": "30", "sign_in": True},
                             content_type="application/json")
        self.assertEqual(created.status_code, 201)
        self.assertTrue(created.json()["sign_in"])
        token = created.json()["token"]
        self.assertEqual(Client().get(self.paths(token)[0]).status_code, 302)
        changed = owner.patch(f"{self.links_api()}{token}/", {"sign_in": False}, content_type="application/json")
        self.assertFalse(changed.json()["sign_in"])
        self.assertEqual(Client().get(self.paths(token)[0]).status_code, 200)
        self.assertEqual(owner.patch(f"{self.links_api()}{token}/", {"sign_in": "yes"},
                                     content_type="application/json").status_code, 400)
        self.assertEqual(owner.post(self.links_api(), {"sign_in": 1}, content_type="application/json").status_code,
                         400)
        self.assertEqual(owner.patch(f"{self.links_api()}{token}/", {}, content_type="application/json")
                         .status_code, 400)

    def test_links_made_before_sign_in_existed_open_without_one(self):
        link = self.link()
        stored = links._read(self.project.id)
        for entry in stored:
            entry.pop("sign_in", None)
        links.store().set_json(links.links_key(self.project.id), stored)
        self.assertFalse(links.requires_sign_in(links.list_links(self.project.id)[0]))
        self.assertEqual(Client().get(self.paths(link["token"])[0]).status_code, 200)

    def test_signed_in_users_only_makes_every_link_of_a_private_project_ask_for_a_login_until_it_is_public(self):
        token = self.sign_in_link(sign_in=False)["token"]
        links.set_private_links(links.SIGNED_IN)
        self.assertEqual(Client().get(self.paths(token)[0]).status_code, 302)
        self.assertEqual(Client().get(self.thumbnail(token)).status_code, 404)
        self.assertEqual(self.client_for("testuser2").get(self.paths(token)[0]).status_code, 200)
        self.make_public()  # public projects' links work as made
        self.assertEqual(Client().get(self.paths(token)[0]).status_code, 200)
        self.make_public(False)
        links.set_private_links(links.ANYONE)  # back: open again, the link unchanged
        self.assertEqual(Client().get(self.paths(token)[0]).status_code, 200)
        self.assertFalse(links.list_links(self.project.id)[0]["sign_in"])

    def test_under_signed_in_users_only_a_private_project_gets_only_sign_in_links(self):
        links.set_private_links(links.SIGNED_IN)
        owner = self.client_for("testuser")
        refused = owner.post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
        self.assertEqual(refused.status_code, 403)
        self.assertIn("require sign-in", refused.json()["detail"])
        created = owner.post(self.links_api(), {"expires_days": "30", "sign_in": True},
                             content_type="application/json")
        self.assertEqual(created.status_code, 201)
        token = created.json()["token"]
        self.assertEqual(owner.patch(f"{self.links_api()}{token}/", {"sign_in": False},
                                     content_type="application/json").status_code, 403)
        self.assertEqual(owner.patch(f"{self.links_api()}{token}/", {"downloads": True},
                                     content_type="application/json").status_code, 200)
        self.make_public()
        self.assertEqual(owner.post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
                         .status_code, 201)

    def test_links_to_private_projects_is_a_superusers_choice_on_explorer_settings(self):
        self.assertEqual(links.private_links(), links.ANYONE)
        admin = self.client_for("testsuperuser")
        html = admin.get("/plugins/explorer/settings/").content.decode()
        self.assertIn('name="private_links"', html)
        self.assertIn('<option value="anyone" selected>', html)
        response = admin.patch(SETTINGS_API, {"private_links": "signed_in"}, content_type="application/json")
        self.assertEqual(response.json()["private_links"], "signed_in")
        self.assertFalse(response.json()["public_projects_only"])
        self.assertIn('<option value="signed_in" selected>', admin.get("/plugins/explorer/settings/").content.decode())
        self.assertEqual(admin.patch(SETTINGS_API, {"private_links": "everyone"}, content_type="application/json")
                         .status_code, 400)
        self.assertEqual(self.client_for("testuser").patch(SETTINGS_API, {"private_links": "anyone"},
                                                           content_type="application/json").status_code, 403)
        self.assertEqual(links.private_links(), links.SIGNED_IN)

    def test_the_older_switch_reads_as_not_allowed_and_is_kept_only_for_not_allowed(self):
        links.store().set_bool(links.PUBLIC_ONLY_KEY, True)  # saved by the version before
        self.assertEqual(links.private_links(), links.NONE)
        self.assertTrue(options.all_settings()["public_projects_only"])
        links.set_private_links(links.SIGNED_IN)
        self.assertFalse(links.store().has_key(links.PUBLIC_ONLY_KEY))
        # A Settings page from before: off undoes Not Allowed only, on is Not Allowed
        links.set_public_projects_only(False)
        self.assertEqual(links.private_links(), links.SIGNED_IN)
        links.set_public_projects_only(True)
        self.assertEqual(links.private_links(), links.NONE)
        # Kept on for Not Allowed: a build from before, installed over this one, still stops private projects' links
        self.assertTrue(links.store().get_bool(links.PUBLIC_ONLY_KEY, False))
        links.set_public_projects_only(False)
        self.assertEqual(links.private_links(), links.ANYONE)
        self.assertFalse(links.store().has_key(links.PUBLIC_ONLY_KEY))

    def test_the_share_panel_offers_require_sign_in_and_fixes_it_where_every_link_must_have_it(self):
        own = f"/plugins/explorer/project/{self.project.id}/"
        html = self.client_for("testuser").get(own).content.decode()
        self.assertIn('name="sign_in">', html)
        self.assertNotIn("data-sign-in-forced", html)
        links.set_private_links(links.SIGNED_IN)
        html = self.client_for("testuser").get(own).content.decode()
        self.assertIn('name="sign_in" checked disabled', html)
        self.assertIn("data-sign-in-forced", html)
        self.assertIn("explorer-links-sign-in", html)
        self.make_public()
        self.assertNotIn("data-sign-in-forced", self.client_for("testuser").get(own).content.decode())

    def test_every_view_a_link_serves_from_refuses_a_visitor_who_is_not_signed_in(self):
        from coreplugins.explorer import api, plugin
        from django.contrib.auth.models import AnonymousUser
        from rest_framework import exceptions
        token = self.sign_in_link()["token"]
        mounted = [m.view.view_class for m in plugin.Plugin.api_mount_points(None)
                   if m.url.startswith("s/")]
        self.assertEqual(len(mounted), 10)  # every token route, both tile routes included
        for view_class in set(mounted):
            self.assertTrue(issubclass(view_class, api.TokenTaskMixin), view_class)
            self.assertIs(view_class.get_and_check_task, api.TokenTaskMixin.get_and_check_task, view_class)
            view = view_class()
            view.share_token = token
            visitor = mock.Mock(user=AnonymousUser())
            with self.assertRaises(exceptions.NotFound):
                view.get_and_check_task(visitor, self.full.id)
            inactive = self.user("testuser2")
            inactive.is_active = False
            with self.assertRaises(exceptions.NotFound):
                view.get_and_check_task(mock.Mock(user=inactive), self.full.id)
            if view_class.needs_downloads:
                continue  # a link without Allow Downloads refuses everyone
            self.assertEqual(view.get_and_check_task(mock.Mock(user=self.user("testuser2")), self.full.id), self.full)

    def test_a_session_of_a_user_deactivated_since_does_not_count_as_signed_in(self):
        token = self.sign_in_link()["token"]
        client = self.client_for("testuser2")
        self.assertEqual(client.get(self.paths(token)[0]).status_code, 200)
        User = type(self.user("testuser2"))
        User.objects.filter(username="testuser2").update(is_active=False)
        self.assertEqual(client.get(self.paths(token)[0]).status_code, 302)
        self.assertEqual(client.get(self.thumbnail(token)).status_code, 404)

    def user(self, username):
        from django.contrib.auth.models import User
        return User.objects.get(username=username)

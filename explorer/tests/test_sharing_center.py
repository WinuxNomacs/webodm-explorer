"""
Tests of the Sharing Center (upcoming-changes.md, "Plan: the Sharing Center"), run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
from datetime import timedelta
from unittest import mock

from app.tests.classes import BootTestCase
from coreplugins.explorer import links
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.contrib.auth.models import User
from django.test import Client
from django.utils import timezone
from guardian.shortcuts import assign_perm

ALL_LINKS = "/api/plugins/explorer/links/"
PAGE = "/plugins/explorer/sharing/"


class SharingCenterTests(LinkTestMixin, BootTestCase):
    def tokens(self, client):
        response = client.get(ALL_LINKS)
        self.assertEqual(response.status_code, 200)
        return [row["token"] for row in response.json()]

    def later(self, days):
        return mock.patch("coreplugins.explorer.links.timezone.now", return_value=timezone.now() + timedelta(days=days))

    def test_the_list_has_every_link_of_the_projects_the_user_can_change_and_no_others(self):
        own = self.link()["token"]
        others = links.create_link(self.other_project.id, "Theirs", 30, User.objects.get(username="testuser2"))["token"]
        self.assertEqual(self.tokens(self.client_for("testuser")), [own])
        self.assertEqual(self.tokens(self.client_for("testuser2")), [others])
        # Viewing a project isn't enough to manage its links; changing it is
        stranger = User.objects.get(username="testuser2")
        assign_perm("view_project", stranger, self.project)
        self.assertEqual(self.tokens(self.client_for("testuser2")), [others])
        assign_perm("change_project", stranger, self.project)
        self.assertEqual(set(self.tokens(self.client_for("testuser2"))), {own, others})

    def test_superusers_see_every_projects_links_newest_first(self):
        first = self.link()["token"]
        second = links.create_link(self.other_project.id, "Theirs", 30, User.objects.get(username="testuser2"))["token"]
        self.assertEqual(self.tokens(self.client_for("testsuperuser")), [second, first])

    def test_each_row_says_its_project_who_made_it_and_whether_it_expired(self):
        self.link(days=7)
        row = self.client_for("testuser").get(ALL_LINKS).json()[0]
        self.assertEqual(row["created_by"], "testuser")
        self.assertFalse(row["expired"])
        self.assertEqual(row["project"], {
            "id": self.project.id, "name": self.project.name,
            "page": f"/plugins/explorer/project/{self.project.id}/", "links_api": self.links_api(),
            "links_work": True, "sign_in_forced": False})
        User.objects.filter(username="testuser").update(username="renamed")
        self.assertEqual(self.client_for("renamed").get(ALL_LINKS).json()[0]["created_by"], "renamed")

    def test_a_link_whose_maker_was_removed_says_so_with_no_name(self):
        gone = User.objects.create_user(username="gone", password="test1234")
        links.create_link(self.project.id, "Old", 30, gone)
        gone.delete()
        self.assertIsNone(self.client_for("testuser").get(ALL_LINKS).json()[0]["created_by"])

    def test_expired_links_are_listed_for_90_days_then_not(self):
        token = self.link(days=7)["token"]
        client = self.client_for("testuser")
        with self.later(8):
            rows = client.get(ALL_LINKS).json()
            self.assertEqual([(row["token"], row["expired"]) for row in rows], [(token, True)])
            self.assertEqual(client.get(self.links_api()).json(), [])  # the Share panel lists live links only
        with self.later(7 + links.RETAIN_EXPIRED_DAYS + 1):
            # Signed in again: the patched clock moves past the session's own expiry
            self.assertEqual(self.client_for("testuser").get(ALL_LINKS).json(), [])

    def test_renewing_an_expired_link_brings_the_same_url_back(self):
        token = self.link(days=7)["token"]
        owner = self.client_for("testuser")
        with self.later(8):
            self.assertEqual(Client().get(f"/plugins/explorer/s/{token}/").status_code, 404)
            renewed = owner.patch(f"{self.links_api()}{token}/", {"expires_days": 30}, content_type="application/json")
            self.assertEqual(renewed.status_code, 200)
            self.assertFalse(renewed.json()["expired"])
            self.assertEqual(Client().get(f"/plugins/explorer/s/{token}/").status_code, 200)

    def test_renewing_restores_a_token_key_dropped_before_expired_links_were_kept(self):
        token = self.link(days=7)["token"]
        links.store().del_key(links.token_key(token))
        with self.later(8):
            self.assertEqual(self.client_for("testuser").patch(f"{self.links_api()}{token}/", {"expires_days": "never"},
                                                               content_type="application/json").status_code, 200)
            self.assertEqual(Client().get(f"/plugins/explorer/s/{token}/").status_code, 200)
            self.assertIsNone(links.list_links(self.project.id)[0]["expires"])

    def test_an_expired_link_takes_only_a_label_or_a_new_expiry(self):
        token = self.link(days=7)["token"]
        owner = self.client_for("testuser")
        with self.later(8):
            url = f"{self.links_api()}{token}/"
            self.assertEqual(owner.patch(url, {"downloads": True}, content_type="application/json").status_code, 404)
            labelled = owner.patch(url, {"label": "Old client"}, content_type="application/json")
            self.assertEqual(labelled.json()["label"], "Old client")
            self.assertIsNone(links.project_for_token(token))  # still expired

    def test_the_label_and_expiry_of_a_live_link_change_and_bad_values_are_refused(self):
        token = self.link(days=7)["token"]
        owner = self.client_for("testuser")
        url = f"{self.links_api()}{token}/"
        changed = owner.patch(url, {"label": "  " + "x" * 120, "expires_days": "90"}, content_type="application/json")
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["label"], "x" * links.LABEL_MAX)
        days = (timezone.datetime.fromisoformat(changed.json()["expires"]) - timezone.now()).days
        self.assertIn(days, (89, 90))  # from today, not from when it was made
        self.assertEqual(changed.json()["token"], token)
        for bad in ({"label": 5}, {"expires_days": 5}, {"expires_days": True}, {"expires_days": [30]}):
            self.assertEqual(owner.patch(url, bad, content_type="application/json").status_code, 400, bad)
        self.assertEqual(links.list_links(self.project.id)[0]["label"], "x" * links.LABEL_MAX)

    def test_only_users_who_can_change_the_project_edit_its_links(self):
        token = self.link()["token"]
        stranger = User.objects.get(username="testuser2")
        url = f"{self.links_api()}{token}/"
        self.assertEqual(self.client_for("testuser2").patch(url, {"label": "Mine"}, content_type="application/json")
                         .status_code, 404)
        assign_perm("view_project", stranger, self.project)
        self.assertEqual(self.client_for("testuser2").patch(url, {"label": "Mine"}, content_type="application/json")
                         .status_code, 403)
        self.assertEqual(links.list_links(self.project.id)[0]["label"], "Test")

    def test_deleting_an_expired_link_removes_it_for_good(self):
        token = self.link(days=7)["token"]
        owner = self.client_for("testuser")
        with self.later(8):
            self.assertEqual(owner.delete(f"{self.links_api()}{token}/").status_code, 204)
            self.assertEqual(owner.get(ALL_LINKS).json(), [])
            self.assertFalse(links.store().has_key(links.token_key(token)))
            self.assertEqual(owner.patch(f"{self.links_api()}{token}/", {"expires_days": 30},
                                         content_type="application/json").status_code, 404)

    def test_rows_say_where_explorer_settings_stop_or_force_a_projects_links(self):
        self.link()
        owner = self.client_for("testuser")
        links.set_private_links(links.SIGNED_IN)
        self.assertTrue(owner.get(ALL_LINKS).json()[0]["project"]["sign_in_forced"])
        links.set_private_links(links.NONE)
        project = owner.get(ALL_LINKS).json()[0]["project"]
        self.assertFalse(project["links_work"])
        self.assertFalse(project["sign_in_forced"])

    def test_the_list_refuses_visitors_and_cross_site_requests(self):
        self.link()
        self.assertIn(Client().get(ALL_LINKS).status_code, (401, 403))
        self.assertEqual(self.client_for("testuser").get(ALL_LINKS, HTTP_SEC_FETCH_SITE="cross-site").status_code, 403)

    def test_the_page_offers_create_link_for_the_projects_the_user_can_change(self):
        response = self.client_for("testuser").get(PAGE)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Frame-Options"], "SAMEORIGIN")
        html = response.content.decode()
        self.assertIn('data-all-links-api="/api/plugins/explorer/links/"', html)
        self.assertIn(f'<option value="{self.project.id}">User Test Project', html)
        self.assertNotIn("User 2 Test Project", html)
        self.assertIn('id="explorer-sharing-projects"', html)
        self.assertIn('<script src="/plugins/explorer/sharing.js', html)

    def test_a_project_whose_links_are_not_allowed_cannot_be_picked(self):
        links.set_private_links(links.NONE)
        html = self.client_for("testuser").get(PAGE).content.decode()
        self.assertIn(f'<option value="{self.project.id}" disabled>User Test Project (Links Not Allowed)', html)

    def test_a_user_who_can_change_no_project_gets_a_note_instead(self):
        lone = User.objects.create_user(username="lone", password="test1234")
        html = self.client_for("lone").get(PAGE).content.decode()
        self.assertNotIn("explorer-sharing-rows", html)
        self.assertTrue("change any project here, so you have no links to manage" in html)
        self.assertEqual(self.client_for("lone").get(ALL_LINKS).json(), [])
        lone.delete()

    def test_the_page_asks_visitors_to_sign_in(self):
        response = Client().get(PAGE)
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login/", response["Location"])

    def test_the_share_panel_links_to_its_projects_links_in_the_sharing_center_and_offers_edit(self):
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/").content.decode()
        self.assertIn(f'href="/plugins/explorer/sharing/?project={self.project.id}&amp;status=all"', html)
        self.assertIn('data-edit="Edit"', html)
        self.assertIn('<script src="/plugins/explorer/sharing.js', html)

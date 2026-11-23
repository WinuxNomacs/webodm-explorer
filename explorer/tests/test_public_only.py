"""
Tests of Links for Public Projects Only (upcoming-changes.md, "Plan: links for public projects only"), run inside the
dev stack's web container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
from app.tests.classes import BootTestCase
from coreplugins.explorer import links, options
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.test import Client

SETTINGS_API = "/api/plugins/explorer/settings/"


class PublicProjectsOnlyTests(LinkTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        self.token = self.link()["token"]
        self.page = f"/plugins/explorer/s/{self.token}/"
        self.allowed_api = f"/api/plugins/explorer/projects/{self.project.id}/links-allowed/"

    def make_public(self, public=True):
        self.project.public = public
        self.project.save()

    def opens(self):
        return Client().get(self.page).status_code == 200

    def test_off_by_default_so_every_projects_links_work_as_before(self):
        self.assertFalse(links.public_projects_only())
        self.assertFalse(options.all_settings()["public_projects_only"])
        self.assertTrue(self.opens())

    def test_turned_on_a_private_projects_links_stop_at_once_and_work_again_when_it_is_made_public(self):
        links.set_public_projects_only(True)
        self.assertFalse(self.opens())
        self.assertEqual(Client().get(f"{self.page}map/{self.full.id}/").status_code, 404)
        self.assertEqual(Client().get(f"/api/plugins/explorer/s/{self.token}/tasks/{self.full.id}/thumbnail")
                         .status_code, 404)
        self.make_public()
        self.assertTrue(self.opens())
        self.make_public(False)  # private again: stopped again
        self.assertFalse(self.opens())
        self.assertEqual(len(links.list_links(self.project.id)), 1)  # kept, not deleted

    def test_an_administrator_allows_a_private_projects_links_and_stops_them_again(self):
        links.set_public_projects_only(True)
        admin = self.client_for("testsuperuser")
        self.assertEqual(admin.patch(self.allowed_api, {"allowed": True}, content_type="application/json").json(),
                         {"allowed": True, "links_work": True})
        self.assertTrue(self.opens())
        self.assertEqual(admin.patch(self.allowed_api, {"allowed": False}, content_type="application/json").json(),
                         {"allowed": False, "links_work": False})
        self.assertFalse(self.opens())
        self.assertEqual(admin.patch(self.allowed_api, {"allowed": "yes"}, content_type="application/json")
                         .status_code, 400)
        self.assertEqual(admin.patch("/api/plugins/explorer/projects/999999/links-allowed/", {"allowed": True},
                                     content_type="application/json").status_code, 404)

    def test_only_superusers_allow_a_project_even_its_owner_cannot(self):
        owner = self.client_for("testuser")
        self.assertEqual(owner.patch(self.allowed_api, {"allowed": True}, content_type="application/json")
                         .status_code, 403)
        self.assertIn(Client().patch(self.allowed_api, {"allowed": True}, content_type="application/json")
                      .status_code, (401, 403))
        self.assertFalse(links.project_allowed(self.project.id))

    def test_a_link_cannot_be_made_for_a_private_project_that_is_not_allowed(self):
        links.set_public_projects_only(True)
        owner = self.client_for("testuser")
        response = owner.post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
        self.assertEqual(response.status_code, 403)
        self.assertIn("public projects", response.json()["detail"])
        self.assertEqual(owner.get(self.links_api()).status_code, 200)  # still listed, so they can be revoked
        self.assertEqual(owner.delete(f"{self.links_api()}{self.token}/").status_code, 204)
        self.make_public()
        self.assertEqual(owner.post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
                         .status_code, 201)

    def test_the_setting_is_a_superusers_switch_on_explorer_settings(self):
        admin = self.client_for("testsuperuser")
        self.assertIn('name="public_projects_only"', admin.get("/plugins/explorer/settings/").content.decode())
        response = admin.patch(SETTINGS_API, {"public_projects_only": True}, content_type="application/json")
        self.assertTrue(response.json()["public_projects_only"])
        self.assertTrue(links.public_projects_only())
        self.assertEqual(admin.patch(SETTINGS_API, {"public_projects_only": 1}, content_type="application/json")
                         .status_code, 400)
        self.assertEqual(self.client_for("testuser").patch(SETTINGS_API, {"public_projects_only": False},
                                                           content_type="application/json").status_code, 403)

    def test_blocked_links_count_nowhere_as_shared_and_get_no_tile_builds(self):
        from coreplugins.explorer import pages, tiles
        self.assertIn(self.project.id, links.linked_project_ids())
        self.assertIn(self.project.id, pages.link_summaries(self.owner, [self.project.id]))
        self.assertTrue(tiles.project_is_shared(self.project.id))
        links.set_public_projects_only(True)
        self.assertNotIn(self.project.id, links.linked_project_ids())  # the home's Shared by Link filter
        self.assertNotIn(self.project.id, pages.link_summaries(self.owner, [self.project.id]))  # its badge
        self.assertFalse(tiles.project_is_shared(self.project.id))
        links.set_project_allowed(self.project.id, True)
        self.assertIn(self.project.id, links.linked_project_ids())
        self.assertTrue(tiles.project_is_shared(self.project.id))

    def test_the_share_panel_explains_and_offers_the_switch_to_superusers_only(self):
        own = f"/plugins/explorer/project/{self.project.id}/"
        owner_html = self.client_for("testuser").get(own).content.decode()
        self.assertNotIn("explorer-links-blocked", owner_html)
        self.assertNotIn("data-allowed-api", owner_html)
        links.set_public_projects_only(True)
        owner_html = self.client_for("testuser").get(own).content.decode()
        self.assertIn("explorer-links-blocked", owner_html)
        self.assertIn('class="explorer-link-form" hidden', owner_html)
        self.assertNotIn("data-allowed-api", owner_html)
        admin_html = self.client_for("testsuperuser").get(own).content.decode()
        self.assertIn(f'data-allowed-api="{self.allowed_api}"', admin_html)
        links.set_project_allowed(self.project.id, True)
        admin_html = self.client_for("testsuperuser").get(own).content.decode()
        self.assertIn('name="allowed" checked', admin_html)
        self.assertNotIn("explorer-links-blocked", admin_html)
        self.make_public()  # public: no switch needed
        self.assertNotIn("data-allowed-api", self.client_for("testsuperuser").get(own).content.decode())

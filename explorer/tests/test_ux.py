"""
Tests of UX step 1 (upcoming-changes.md): the thermal layer, card pictures, basemaps on link maps and Explorer's
settings. Run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import json

from app.models import Basemap
from app.tests.classes import BootTestCase
from coreplugins.explorer import options, pages
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.test import Client

THERMAL_BANDS = [{"name": "gray", "description": "lwir"}, {"name": "alpha", "description": None}]
RGB_BANDS = [{"name": n, "description": n} for n in ("red", "green", "blue")] + [{"name": "alpha", "description": None}]
SETTINGS_API = "/api/plugins/explorer/settings/"


class ThermalAndPicturesTests(LinkTestMixin, BootTestCase):
    def test_a_thermal_orthophoto_gets_a_thermal_layer_first_and_a_card_drawn_from_it(self):
        thermal = self.task("Thermal", ["orthophoto.tif", "dsm.tif"], orthophoto_bands=THERMAL_BANDS)
        self.assertEqual([kind for kind, _label in pages.map_layers(thermal)], ["thermal", "orthophoto", "dsm"])
        self.assertEqual(pages.thumbnail(thermal), {"webodm": False, "draw": "thermal"})

    def test_a_colour_orthophoto_keeps_webodms_thumbnail_with_its_elevation_as_the_fallback(self):
        colour = self.task("Colour", ["orthophoto.tif", "dsm.tif"], orthophoto_bands=RGB_BANDS)
        self.assertEqual([kind for kind, _label in pages.map_layers(colour)], ["orthophoto", "dsm"])
        self.assertEqual(pages.thumbnail(colour), {"webodm": True, "draw": "dsm"})
        no_ortho = self.task("Elevation only", ["dtm.tif", "georeferenced_model.laz"])
        self.assertEqual(pages.thumbnail(no_ortho), {"webodm": False, "draw": "dtm"})
        nothing = self.task("Cloud only", ["georeferenced_model.laz"])
        self.assertEqual(pages.thumbnail(nothing), {"webodm": False, "draw": None})

    def test_the_project_page_and_a_link_page_draw_a_thermal_cards_picture_from_their_own_api(self):
        thermal = self.task("Thermal", ["orthophoto.tif"], orthophoto_bands=THERMAL_BANDS)
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/").content.decode()
        self.assertIn(f'data-draw="thermal" data-api="/api/projects/{self.project.id}/tasks/{thermal.id}/"', html)
        self.assertNotIn(f"/tasks/{thermal.id}/thumbnail", html)
        token = self.link()["token"]
        html = Client().get(f"/plugins/explorer/s/{token}/").content.decode()
        self.assertIn(f'data-draw="thermal" data-api="/api/plugins/explorer/s/{token}/tasks/{thermal.id}/"', html)
        self.assertIn(f"/plugins/explorer/s/{token}/map/{thermal.id}/", html)

    def test_the_project_list_draws_a_thermal_projects_picture(self):
        thermal = self.task("Thermal", ["orthophoto.tif"], orthophoto_bands=THERMAL_BANDS)
        html = self.client_for("testuser").get("/plugins/explorer/").content.decode()
        self.assertIn(f'data-draw="thermal"\n                 data-api="/api/projects/{self.project.id}/tasks/{thermal.id}/"', html)

    def test_a_thermal_link_map_offers_thermal_first(self):
        thermal = self.task("Thermal", ["orthophoto.tif"], orthophoto_bands=THERMAL_BANDS)
        token = self.link()["token"]
        html = Client().get(f"/plugins/explorer/s/{token}/map/{thermal.id}/").content.decode()
        self.assertLess(html.index('data-layer="thermal"'), html.index('data-layer="orthophoto"'))
        self.assertIn("layers.js", html)

    def test_the_thermal_layer_draws_through_a_links_token_views(self):
        # The Thermal layer is the orthophoto's tile type with WebODM's own parameters: the token views must pass them
        thermal = self.task("Thermal", ["orthophoto.tif"], orthophoto_bands=THERMAL_BANDS)
        token = self.link()["token"]
        response = Client().get(f"/api/plugins/explorer/s/{token}/tasks/{thermal.id}/orthophoto/metadata"
                                "?formula=Celsius&bands=L&color_map=magma")
        # No raster in the test task: WebODM's view gets past the token check and finds no file
        self.assertIn(response.status_code, (404,))
        self.assertNotIn(Client().get(f"/api/plugins/explorer/s/{'x' * 43}/tasks/{thermal.id}/orthophoto/metadata")
                         .status_code, (200,))


class BasemapAndSettingsTests(LinkTestMixin, BootTestCase):
    def map_html(self):
        task = self.task("Map", ["orthophoto.tif"], orthophoto_bands=RGB_BANDS)
        token = self.link()["token"]
        return Client().get(f"/plugins/explorer/s/{token}/map/{task.id}/").content.decode()

    def basemaps_in(self, html):
        start = html.index('<script id="explorer-basemaps" type="application/json">') + len(
            '<script id="explorer-basemaps" type="application/json">')
        return json.loads(html[start:html.index("</script>", start)])

    def test_a_link_map_offers_the_basemaps_the_admin_configured_in_webodm(self):
        html = self.map_html()
        offered = self.basemaps_in(html)
        self.assertEqual([b["label"] for b in offered], [b["label"] for b in Basemap.get_cached_basemaps()])
        self.assertTrue(offered)
        self.assertIn("data-basemap", html)

    def test_turned_off_in_explorers_settings_a_link_map_has_no_basemaps(self):
        options.set_basemaps_on_links(False)
        html = self.map_html()
        self.assertEqual(self.basemaps_in(html), [])
        self.assertNotIn("data-basemap", html)

    def test_only_webodms_admins_read_and_change_explorers_settings(self):
        self.assertIn(Client().get(SETTINGS_API).status_code, (401, 403))
        self.assertEqual(self.client_for("testuser").get(SETTINGS_API).status_code, 403)
        admin = self.client_for("testsuperuser", enforce_csrf_checks=True)
        self.assertEqual(admin.get(SETTINGS_API).json(), {"basemaps_on_links": True, "public_address": "",
                                                       "private_links": "anyone", "public_projects_only": False})
        # WebODM's CSRF check applies to the plugin's API
        self.assertEqual(admin.patch(SETTINGS_API, {"basemaps_on_links": False},
                                     content_type="application/json").status_code, 403)
        admin.get("/plugins/explorer/settings/")
        csrf = admin.cookies["csrftoken"].value
        response = admin.patch(SETTINGS_API, {"basemaps_on_links": False}, content_type="application/json",
                               HTTP_X_CSRFTOKEN=csrf)
        self.assertEqual(response.json(), {"basemaps_on_links": False, "public_address": "", "private_links": "anyone",
                                           "public_projects_only": False})
        self.assertFalse(options.basemaps_on_links())
        self.assertEqual(admin.patch(SETTINGS_API, {"basemaps_on_links": "no"}, content_type="application/json",
                                     HTTP_X_CSRFTOKEN=csrf).status_code, 400)
        user = self.client_for("testuser")
        self.assertEqual(user.patch(SETTINGS_API, {"basemaps_on_links": True},
                                    content_type="application/json").status_code, 403)

    def test_the_public_address_is_kept_as_scheme_and_host_and_anything_else_is_refused(self):
        admin = self.client_for("testsuperuser")
        def patch(value):
            return admin.patch(SETTINGS_API, {"public_address": value}, content_type="application/json")
        for typed, kept in (("https://Maps.Example.com/", "https://maps.example.com"),
                            ("  http://10.0.0.5:8000 ", "http://10.0.0.5:8000"),
                            ("https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"), ("", "")):
            response = patch(typed)
            self.assertEqual(response.status_code, 200, typed)
            self.assertEqual(response.json()["public_address"], kept, typed)
            self.assertEqual(options.public_address(), kept)
        options.set_public_address("https://maps.example.com")
        for bad in ("maps.example.com", "ftp://maps.example.com", "https://user:pw@maps.example.com",
                    "https://maps.example.com/webodm", "https://maps.example.com/?a=1", "https://maps.example.com/#x",
                    "https://", "https://maps.example.com:port", "javascript:alert(1)", 42, None):
            self.assertEqual(patch(bad).status_code, 400, bad)
        self.assertEqual(options.public_address(), "https://maps.example.com")  # unchanged by a refusal
        # A refused value saves nothing else from the same request
        self.assertEqual(admin.patch(SETTINGS_API, {"basemaps_on_links": False, "public_address": "nope"},
                                     content_type="application/json").status_code, 400)
        self.assertTrue(options.basemaps_on_links())
        self.assertEqual(admin.patch(SETTINGS_API, {}, content_type="application/json").status_code, 400)

    def test_the_share_panel_copies_links_with_the_public_address_for_users_who_can_share(self):
        own = f"/plugins/explorer/project/{self.project.id}/"
        self.assertNotIn("data-origin", self.client_for("testuser").get(own).content.decode())
        options.set_public_address("https://maps.example.com")
        self.assertIn('data-origin="https://maps.example.com"', self.client_for("testuser").get(own).content.decode())
        html = self.client_for("testsuperuser").get("/plugins/explorer/settings/").content.decode()
        self.assertIn('name="public_address"', html)
        self.assertIn('value="https://maps.example.com"', html)

    def test_explorer_settings_is_a_page_and_a_menu_item_of_its_own_for_superusers_only(self):
        admin = self.client_for("testsuperuser")
        page = admin.get("/plugins/explorer/settings/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("data-settings-api", page.content.decode())
        self.assertEqual(page["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn('href="/plugins/explorer/settings/"', admin.get("/dashboard/").content.decode())
        # Not on Explorer's home any more
        self.assertNotIn("data-settings-api", admin.get("/plugins/explorer/").content.decode())
        user = self.client_for("testuser")
        self.assertEqual(user.get("/plugins/explorer/settings/").status_code, 404)
        self.assertNotIn('href="/plugins/explorer/settings/"', user.get("/dashboard/").content.decode())
        self.assertEqual(Client().get("/plugins/explorer/settings/").status_code, 302)

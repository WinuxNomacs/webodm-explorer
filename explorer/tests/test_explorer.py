"""
Tests of the Explorer plugin, run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests.test_explorer
"""
from app.plugins import disable_plugin, enable_plugin, get_plugin_by_name
from app.tests.classes import BootTestCase
from django.test import Client


class ExplorerTestCase(BootTestCase):
    def setUp(self):
        super().setUp()
        disable_plugin("explorer")
        enable_plugin("explorer")

    def tearDown(self):
        disable_plugin("explorer")
        super().tearDown()

    def test_the_plugin_registers_with_its_manifest(self):
        plugin = get_plugin_by_name("explorer")
        self.assertIsNotNone(plugin)
        manifest = plugin.get_manifest()
        self.assertEqual(manifest["name"], "Explorer")
        self.assertTrue(manifest["experimental"])
        self.assertEqual(manifest["webodmMinVersion"], "4.0.0")

    def test_the_dashboard_loads_with_the_plugin_enabled(self):
        client = Client()
        self.assertTrue(client.login(username="testuser", password="test1234"))  # app/tests/classes.py's users
        self.assertEqual(client.get("/dashboard/").status_code, 200)

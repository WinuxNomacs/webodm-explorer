"""
Tests of the Explorer plugin, run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests.test_explorer
"""
from app import pending_actions
from app.models import Project, Task
from app.plugins import disable_plugin, enable_plugin, get_plugin_by_name
from app.tests.classes import BootTestCase
from django.contrib.auth.models import User
from django.test import Client
from guardian.shortcuts import assign_perm
from nodeodm import status_codes

# app/tests/classes.py's users and projects: testuser owns "User Test Project", testuser2 "User 2 Test Project".
PASSWORD = "test1234"
ALL_OUTPUTS = ["orthophoto.tif", "dsm.tif", "dtm.tif", "georeferenced_model.laz", "textured_model.zip",
               "textured_model.glb", "splats.rad"]


class ExplorerTestCase(BootTestCase):
    def setUp(self):
        super().setUp()
        disable_plugin("explorer")
        enable_plugin("explorer")
        self.project = Project.objects.get(name="User Test Project")
        self.other_project = Project.objects.get(name="User 2 Test Project")

    def tearDown(self):
        disable_plugin("explorer")
        super().tearDown()

    def client_for(self, username):
        client = Client()
        self.assertTrue(client.login(username=username, password=PASSWORD))
        return client

    def task(self, name, assets, status=status_codes.COMPLETED, project=None, **fields):
        return Task.objects.create(project=project or self.project, name=name, status=status,
                                   available_assets=assets, **fields)

    def page(self, project=None, username="testuser"):
        return self.client_for(username).get(f"/plugins/explorer/project/{(project or self.project).id}/")

    def test_the_plugin_registers_with_its_manifest(self):
        plugin = get_plugin_by_name("explorer")
        self.assertIsNotNone(plugin)
        manifest = plugin.get_manifest()
        self.assertEqual(manifest["name"], "Explorer")
        self.assertTrue(manifest["experimental"])
        self.assertEqual(manifest["webodmMinVersion"], "4.0.0")

    def test_the_main_menu_has_an_explorer_item_for_every_signed_in_user(self):
        response = self.client_for("testuser").get("/dashboard/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'href="/plugins/explorer/"')

    def test_the_pages_ask_anonymous_visitors_to_sign_in(self):
        for url in ("/plugins/explorer/", f"/plugins/explorer/project/{self.project.id}/"):
            response = Client().get(url)
            self.assertEqual(response.status_code, 302, url)
            self.assertIn("/login/", response["Location"])

    def test_the_project_list_shows_only_the_projects_the_user_can_view(self):
        response = self.client_for("testuser").get("/plugins/explorer/")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, f'href="/plugins/explorer/project/{self.project.id}/"')
        self.assertNotContains(response, f'href="/plugins/explorer/project/{self.other_project.id}/"')
        self.assertNotContains(response, "Super User Test Project")

    def test_a_project_shared_with_the_user_is_listed_and_opens(self):
        assign_perm("view_project", User.objects.get(username="testuser"), self.other_project)
        response = self.client_for("testuser").get("/plugins/explorer/")
        self.assertContains(response, f'href="/plugins/explorer/project/{self.other_project.id}/"')
        self.assertEqual(self.page(self.other_project).status_code, 200)

    def test_the_project_list_counts_tasks_with_outputs_and_uses_an_orthophoto_for_its_thumbnail(self):
        task = self.task("With Ortho", ["orthophoto.tif"])
        self.task("Point Cloud Only", ["georeferenced_model.laz"])
        self.task("Running", ["orthophoto.tif"], status=status_codes.RUNNING)
        response = self.client_for("testuser").get("/plugins/explorer/")
        self.assertContains(response, "2 tasks with outputs")
        self.assertContains(response, f"/api/projects/{self.project.id}/tasks/{task.id}/thumbnail?size=512")

    def test_a_project_page_without_view_permission_is_not_found(self):
        self.assertEqual(self.page(self.other_project).status_code, 404)

    def test_a_missing_or_deleting_project_is_not_found(self):
        self.assertEqual(self.client_for("testuser").get("/plugins/explorer/project/999999/").status_code, 404)
        Project.objects.filter(pk=self.project.pk).update(deleting=True)
        self.assertEqual(self.page().status_code, 404)

    def test_only_completed_tasks_with_outputs_get_cards(self):
        self.task("Completed Task", ["orthophoto.tif"])
        self.task("Only A Report", ["report.pdf", "all.zip"])
        self.task("Running Task", ["orthophoto.tif"], status=status_codes.RUNNING)
        self.task("Failed Task", ["orthophoto.tif"], status=status_codes.FAILED)
        self.task("Canceled Task", ["orthophoto.tif"], status=status_codes.CANCELED)
        self.task("Queued Task", [], status=status_codes.QUEUED)
        self.task("Being Removed", ["orthophoto.tif"], pending_action=pending_actions.REMOVE)
        response = self.page()
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Completed Task")
        for name in ("Only A Report", "Running Task", "Failed Task", "Canceled Task", "Queued Task",
                     "Being Removed"):
            self.assertNotContains(response, name)

    def test_a_task_with_every_output_gets_one_map_button_and_a_button_per_3d_type(self):
        task = self.task("Everything", ALL_OUTPUTS)
        response = self.page()
        self.assertContains(response, f'href="/map/project/{self.project.id}/task/{task.id}/"', count=1)
        self.assertContains(response, "(Orthophoto, DSM, DTM)")
        for model_type in ("cloud", "mesh", "splats"):
            self.assertContains(response, f'href="/3d/project/{self.project.id}/task/{task.id}/?t={model_type}"')
        self.assertContains(response, f"/api/projects/{self.project.id}/tasks/{task.id}/thumbnail?size=512")
        self.assertContains(response, f'href="/map/project/{self.project.id}/"')

    def test_a_task_gets_buttons_only_for_the_outputs_it_has(self):
        task = self.task("DSM And LAS", ["dsm.tif", "georeferenced_model.las", "textured_model.glb"])
        response = self.page()
        self.assertContains(response, "(DSM)")
        self.assertContains(response, f"/3d/project/{self.project.id}/task/{task.id}/?t=cloud")
        # The 3D page needs textured_model.zip for its mesh view and splats.rad for splats (ModelView.jsx).
        self.assertNotContains(response, "?t=mesh")
        self.assertNotContains(response, "?t=splats")
        self.assertNotContains(response, f"/tasks/{task.id}/thumbnail")

    def test_a_project_without_tasks_says_so_and_offers_no_map(self):
        response = self.page()
        self.assertContains(response, "No completed tasks with outputs yet.")
        self.assertNotContains(response, f'href="/map/project/{self.project.id}/"')

    def test_task_and_project_names_are_escaped(self):
        self.task("<script>alert(1)</script>", ["orthophoto.tif"])
        Project.objects.filter(pk=self.project.pk).update(name="<b>bold</b>")
        response = self.page()
        self.assertNotContains(response, "<script>alert(1)</script>")
        self.assertContains(response, "&lt;script&gt;alert(1)&lt;/script&gt;")
        self.assertNotContains(response, "<b>bold</b>")

    def test_the_share_panel_holds_the_page_link_and_says_who_can_open_it(self):
        response = self.page()
        self.assertContains(response, f'value="/plugins/explorer/project/{self.project.id}/"')
        self.assertContains(response, "Only signed-in users this project is shared with can open it.")
        self.assertContains(response, "/plugins/explorer/explorer.js")

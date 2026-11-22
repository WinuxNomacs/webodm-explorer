"""
Tests of UX step 2, the navigation hub (upcoming-changes.md): the Explorer home's search, scope, sort, filters, pages,
cards and Map view; the project page's header, overview map and cards; and Explorer's own viewer for signed-in users.
Run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import json
import re
from datetime import timedelta
from unittest import mock

from app.models import Project
from app.tests.classes import BootTestCase
from coreplugins.explorer import links, pages
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.contrib.auth.models import User
from django.test import Client
from django.utils import timezone
from guardian.shortcuts import assign_perm
from nodeodm import status_codes

HOME = "/plugins/explorer/"


def square(west, south, size=0.001):
    return {"type": "Polygon", "coordinates": [[[west, south], [west + size, south], [west + size, south + size],
                                                [west, south + size], [west, south]]]}


class HubTestMixin(LinkTestMixin):
    def setUp(self):
        super().setUp()
        self.superuser_project = Project.objects.get(name="Super User Test Project")
        self.stranger = User.objects.get(username="testuser2")

    def home(self, query="", username="testuser"):
        return self.client_for(username).get(HOME + ("?" + query if query else ""))

    def names(self, response):
        """The project names on the home's cards, in order."""
        return re.findall(r'<span class="explorer-card-title">([^<]*)</span>', response.content.decode())

    def json_script(self, response, element_id):
        match = re.search(rf'<script id="{element_id}" type="application/json">(.*?)</script>',
                          response.content.decode(), re.DOTALL)
        return json.loads(match.group(1)) if match else None


class HomeTests(HubTestMixin, BootTestCase):
    def test_admins_see_every_project_and_can_narrow_to_their_own(self):
        response = self.home(username="testsuperuser")
        self.assertEqual(set(self.names(response)),
                         {"Super User Test Project", "User Test Project", "User 2 Test Project"})
        self.assertEqual(self.names(self.home("scope=mine", "testsuperuser")), ["Super User Test Project"])

    def test_a_user_sees_their_own_and_shared_projects_and_can_pick_either(self):
        assign_perm("view_project", self.owner, self.other_project)
        self.assertEqual(set(self.names(self.home())), {"User Test Project", "User 2 Test Project"})
        self.assertEqual(self.names(self.home("scope=mine")), ["User Test Project"])
        self.assertEqual(self.names(self.home("scope=shared")), ["User 2 Test Project"])

    def test_the_search_matches_names_descriptions_and_tags_in_any_case(self):
        assign_perm("view_project", self.owner, self.other_project)
        Project.objects.filter(pk=self.project.pk).update(description="Roof survey of the barn")
        Project.objects.filter(pk=self.other_project.pk).update(tags="quarry .dji-thermal-dataset")
        self.assertEqual(self.names(self.home("q=BARN")), ["User Test Project"])
        self.assertEqual(self.names(self.home("q=Quarry")), ["User 2 Test Project"])
        self.assertEqual(self.names(self.home("q=User+2")), ["User 2 Test Project"])
        response = self.home("q=nothing-like-this")
        self.assertEqual(self.names(response), [])
        self.assertContains(response, "No projects match.")
        self.assertContains(response, 'value="nothing-like-this"')

    def test_projects_sort_by_recent_activity_by_default_or_by_name_or_creation(self):
        assign_perm("view_project", self.owner, self.other_project)
        # The older project gets the newest task, so activity and creation disagree
        Project.objects.filter(pk=self.project.pk).update(created_at=timezone.now() - timedelta(days=10))
        Project.objects.filter(pk=self.other_project.pk).update(created_at=timezone.now() - timedelta(days=5),
                                                               name="a quarry")
        self.task("New", created_at=timezone.now())
        self.assertEqual(self.names(self.home()), ["User Test Project", "a quarry"])
        self.assertEqual(self.names(self.home("sort=created")), ["a quarry", "User Test Project"])
        self.assertEqual(self.names(self.home("sort=name")), ["a quarry", "User Test Project"])
        self.assertEqual(self.names(self.home("sort=bogus")), ["User Test Project", "a quarry"])

    def test_has_3d_keeps_projects_with_a_3d_output(self):
        assign_perm("view_project", self.owner, self.other_project)
        self.task("Flat", ["orthophoto.tif"])
        self.task("Cloud", ["georeferenced_model.laz"], project=self.other_project)
        self.task("Failed Cloud", ["georeferenced_model.laz"], status=status_codes.FAILED)
        self.assertEqual(self.names(self.home("3d=1")), ["User 2 Test Project"])

    def test_shared_by_link_keeps_projects_with_a_live_link(self):
        assign_perm("view_project", self.owner, self.other_project)
        self.link()
        self.assertEqual(self.names(self.home("linked=1")), ["User Test Project"])
        links.revoke_link(self.project.id, links.list_links(self.project.id)[0]["token"])
        self.assertEqual(self.names(self.home("linked=1")), [])

    def test_an_expired_link_does_not_count_as_shared(self):
        self.link()
        with mock.patch("django.utils.timezone.now", return_value=timezone.now() + timedelta(days=31)):
            self.assertEqual(links.linked_project_ids(), set())

    def test_links_saved_before_the_index_are_found_once_and_the_index_kept_after(self):
        self.link()
        links.store().del_key(links.INDEX_KEY)
        self.assertEqual(links.linked_project_ids(), {self.project.id})
        self.assertEqual(links.store().get_json(links.INDEX_KEY), [self.project.id])
        self.link(self.other_project)
        self.assertEqual(links.linked_project_ids(), {self.project.id, self.other_project.id})

    def test_a_links_store_that_fails_leaves_the_filter_empty_not_the_page_broken(self):
        self.link()
        with mock.patch.object(links, "linked_project_ids", side_effect=RuntimeError("store")):
            response = self.home("linked=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.names(response), [])

    def test_projects_come_24_to_a_page_keeping_the_query_in_the_page_links(self):
        for i in range(25):
            Project.objects.create(owner=self.owner, name=f"Many {i:02d}")
        first = self.home("q=many&sort=name")
        self.assertEqual(len(self.names(first)), 24)
        self.assertContains(first, "Page 1 of 2")
        self.assertContains(first, 'href="?q=many&amp;sort=name&amp;page=2"')
        second = self.home("q=many&sort=name&page=2")
        self.assertEqual(self.names(second), ["Many 24"])
        self.assertContains(second, 'href="?q=many&amp;sort=name"')  # back to the first page, without page=1
        self.assertEqual(self.names(self.home("q=many&sort=name&page=nope"))[0], "Many 00")

    def test_a_card_shows_user_tags_counts_and_the_owner_when_it_is_not_you(self):
        assign_perm("view_project", self.owner, self.other_project)
        Project.objects.filter(pk=self.other_project.pk).update(tags="quarry .dji-thermal-dataset", description="Pit")
        self.task("Everything", project=self.other_project)
        html = self.home().content.decode()
        self.assertIn('<span class="explorer-tag theme-border-secondary-07">quarry</span>', html)
        self.assertNotIn("dji-thermal-dataset", html)
        self.assertIn("&middot; testuser2", html)
        for icon, label in (("fa fa-globe", "Map"), ("fa fa-pointcloud", "Point Cloud"),
                            ("fab fa-connectdevelop", "Textured Model"), ("fa fa-splat", "Gaussian Splats")):
            self.assertIn(f'<i class="{icon}"></i> 1<span class="sr-only"> {label}</span>', html)
        self.assertIn("No outputs yet", html)  # the user's own project, without tasks
        self.assertIn("Updated", html)

    def test_the_link_badge_shows_for_users_who_can_share_and_warns_before_expiry(self):
        self.link(days=7)
        response = self.home()
        self.assertContains(response, "1 Link")
        self.assertContains(response, "Expires Soon")
        assign_perm("view_project", self.stranger, self.project)
        self.assertNotContains(self.home(username="testuser2"), "explorer-link-badge")

    def test_a_link_good_for_30_days_is_not_flagged(self):
        self.link(days=30)
        response = self.home()
        self.assertContains(response, "1 Link")
        self.assertNotContains(response, "Expires Soon")

    def test_the_map_view_places_each_project_around_its_tasks_footprints(self):
        assign_perm("view_project", self.owner, self.other_project)
        self.task("West", orthophoto_extent=square(-88.0, 42.0))
        self.task("East", ["dsm.tif"], dsm_extent=square(-87.0, 42.5))
        self.task("No Extent", ["georeferenced_model.laz"], project=self.other_project)
        response = self.home("view=map")
        places = self.json_script(response, "explorer-footprints")
        self.assertEqual(len(places), 1)
        self.assertEqual(places[0]["name"], "User Test Project")
        self.assertEqual(places[0]["url"], f"/plugins/explorer/project/{self.project.id}/")
        self.assertEqual(places[0]["count"], 2)
        self.assertAlmostEqual(places[0]["bounds"][0], -88.0)
        self.assertAlmostEqual(places[0]["bounds"][3], 42.501)
        self.assertContains(response, "1 project without outputs with a location is not on the map.")
        self.assertContains(response, "footprints.js")
        self.assertIsNotNone(self.json_script(response, "explorer-basemaps"))
        self.assertNotContains(response, "explorer-card-title")

    def test_the_map_view_keeps_the_filters_and_says_when_nothing_has_a_location(self):
        response = self.home("view=map&q=zzz")
        self.assertEqual(self.json_script(response, "explorer-footprints"), [])
        self.assertContains(response, "No projects match, or none of them has outputs with a location.")
        self.assertContains(response, 'name="view" value="map"')
        self.assertNotContains(response, "footprints.js")
        self.assertContains(response, 'href="?q=zzz"')  # the Grid switch keeps the search

    def test_project_names_are_escaped_on_the_cards_and_in_the_map_data(self):
        Project.objects.filter(pk=self.project.pk).update(name="</script><b>x</b>")
        self.task("Placed", orthophoto_extent=square(-88.0, 42.0))
        self.assertNotIn("<b>x</b>", self.home().content.decode())
        self.assertNotIn("</script><b>", self.home("view=map").content.decode())

    def test_a_user_without_projects_gets_the_first_steps_text_and_no_toolbar(self):
        Project.objects.filter(owner=self.owner).delete()
        response = self.home()
        self.assertContains(response, "No projects yet.")
        self.assertNotContains(response, "data-explorer-toolbar")


class ProjectPageTests(HubTestMixin, BootTestCase):
    def page(self, username="testuser"):
        return self.client_for(username).get(f"/plugins/explorer/project/{self.project.id}/")

    def test_the_header_offers_view_as_visitor_share_with_its_link_count_and_webodms_pages(self):
        self.task()
        self.link()
        self.link()
        Project.objects.filter(pk=self.project.pk).update(tags="barn .system")
        response = self.page()
        self.assertContains(response, "View as Visitor")
        self.assertNotContains(response, "> Preview<")
        self.assertContains(response, '<span class="badge"')
        self.assertContains(response, f'href="/dashboard/?project_task_open={self.project.id}"')
        self.assertContains(response, f'href="/map/project/{self.project.id}/"')
        self.assertContains(response, ">barn</span>")
        self.assertNotContains(response, ".system")
        self.assertContains(response, "1 task with outputs")

    def test_a_viewer_sees_the_owner_and_no_link_count(self):
        self.task()
        self.link()
        assign_perm("view_project", self.stranger, self.project)
        response = self.page("testuser2")
        self.assertContains(response, '<i class="fa fa-user"></i> testuser')
        self.assertNotContains(response, '<span class="badge"')

    def test_the_cards_open_explorers_viewer_and_offer_webodms_pages_and_downloads(self):
        task = self.task("Everything", images_count=327, size=1061.4, processing_time=1628205, tags="roof .x")
        html = self.page().content.decode()
        own = f"/plugins/explorer/project/{self.project.id}/"
        self.assertIn(f'class="explorer-thumbnail-link" href="{own}map/{task.id}/"', html)
        self.assertIn(f'href="{own}3d/{task.id}/?t=cloud"', html)
        self.assertIn(f'href="/map/project/{self.project.id}/task/{task.id}/"', html)  # Open in WebODM
        self.assertIn(f'href="/3d/project/{self.project.id}/task/{task.id}/?t=mesh"', html)
        self.assertIn(f'href="/api/projects/{self.project.id}/tasks/{task.id}/download/textured_model.glb" download',
                      html)
        self.assertIn("327 images", html)
        self.assertIn("1.0 GB", html)
        self.assertIn("27m 08s", html)
        self.assertIn(">roof</span>", html)

    def test_the_overview_map_holds_each_tasks_footprint_and_is_folded_for_one_task(self):
        first = self.task("First", orthophoto_extent=square(-88.0, 42.0))
        response = self.page()
        footprints = self.json_script(response, "explorer-footprints")
        self.assertEqual(footprints, [{"name": "First", "url": f"/plugins/explorer/project/{self.project.id}/map/{first.id}/",
                                       "geometry": square(-88.0, 42.0)}])
        self.assertContains(response, '<details class="explorer-overview">')
        self.task("Second", ["georeferenced_model.laz"], dsm_extent=square(-88.0, 42.0))
        self.task("No Footprint", ["georeferenced_model.laz"])
        response = self.page()
        self.assertEqual(len(self.json_script(response, "explorer-footprints")), 2)
        self.assertContains(response, '<details class="explorer-overview" open>')

    def test_a_project_without_footprints_has_no_overview_map(self):
        self.task("No Footprint", ["georeferenced_model.laz"])
        response = self.page()
        self.assertNotContains(response, "explorer-overview")
        self.assertNotContains(response, "leaflet.js")


class OwnViewerTests(HubTestMixin, BootTestCase):
    def setUp(self):
        super().setUp()
        self.full = self.task("Full")
        self.own = f"/plugins/explorer/project/{self.project.id}/"

    def test_the_map_and_3d_pages_have_downloads_and_open_in_webodm_without_the_preview_bar(self):
        client = self.client_for("testuser")
        api = f"/api/projects/{self.project.id}/tasks/{self.full.id}/"
        for path in (f"map/{self.full.id}/", f"3d/{self.full.id}/?t=cloud"):
            response = client.get(self.own + path)
            self.assertEqual(response.status_code, 200, path)
            html = response.content.decode()
            self.assertNotIn("explorer-preview-bar", html)
            self.assertIn("Open in WebODM", html)
            self.assertIn(f'href="/map/project/{self.project.id}/task/{self.full.id}/"', html)
            self.assertIn(f'href="{api}download/orthophoto.tif" download', html)
            self.assertIn(f'href="{self.own}"', html)  # back to the project page
        self.assertIn(f'data-api="{api}"', client.get(self.own + f"map/{self.full.id}/").content.decode())

    def test_the_own_viewer_needs_a_signed_in_user_who_can_view_the_project(self):
        path = self.own + f"map/{self.full.id}/"
        response = Client().get(path)
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login/", response["Location"])
        self.assertEqual(self.client_for("testuser2").get(path).status_code, 404)
        assign_perm("view_project", self.stranger, self.project)
        self.assertEqual(self.client_for("testuser2").get(path).status_code, 200)

    def test_a_task_of_another_project_does_not_open(self):
        other = self.task("Elsewhere", project=self.other_project)
        assign_perm("view_project", self.owner, self.other_project)
        self.assertEqual(self.client_for("testuser").get(f"{self.own}3d/{other.id}/").status_code, 404)

    def test_view_as_visitor_keeps_the_visitors_pages(self):
        html = self.client_for("testuser").get(f"{self.own}preview/map/{self.full.id}/").content.decode()
        self.assertIn("explorer-preview-bar", html)
        self.assertIn("Viewing as a visitor", html)
        self.assertNotIn("Open in WebODM", html)
        self.assertNotIn("/download/", html)

    def test_a_link_map_has_a_download_menu_only_when_the_link_allows_downloads(self):
        plain = self.link()["token"]
        downloads = links.create_link(self.project.id, "D", 30, self.owner, downloads=True)["token"]
        html = Client().get(f"/plugins/explorer/s/{plain}/map/{self.full.id}/").content.decode()
        self.assertNotIn("/download/", html)
        self.assertNotIn("Open in WebODM", html)
        html = Client().get(f"/plugins/explorer/s/{downloads}/3d/{self.full.id}/").content.decode()
        self.assertIn(f'href="/api/plugins/explorer/s/{downloads}/tasks/{self.full.id}/download/orthophoto.tif" download',
                      html)
        self.assertNotIn("Open in WebODM", html)

    def test_the_slashless_address_redirects(self):
        response = self.client_for("testuser").get(f"{self.own}3d/{self.full.id}?t=mesh")
        self.assertEqual(response["Location"], f"{self.own}3d/{self.full.id}/?t=mesh")


class HelperTests(BootTestCase):
    def test_durations_and_sizes_read_as_people_write_them(self):
        self.assertEqual(pages.duration(-1), "")
        self.assertEqual(pages.duration(12_400), "12s")
        self.assertEqual(pages.duration(250_000), "4m 10s")
        self.assertEqual(pages.duration(3_900_000), "1h 05m")
        self.assertEqual(pages.disk_size(0), "")
        self.assertEqual(pages.disk_size(0.2), "1 MB")
        self.assertEqual(pages.disk_size(850.4), "850 MB")
        self.assertEqual(pages.disk_size(5908.5), "5.8 GB")

    def test_an_unknown_query_falls_back_to_the_defaults(self):
        query = pages.home_query({"scope": "everyone", "sort": "size", "view": "list", "3d": "yes", "q": " x " * 80})
        self.assertEqual((query.scope, query.sort, query.view, query.has_3d), ("all", "activity", "grid", False))
        self.assertEqual(len(query.q), pages.SEARCH_MAX)
        self.assertEqual(pages.HomeQuery().params(), "")

    def test_bounds_and_footprints_skip_what_does_not_parse(self):
        self.assertIsNone(pages.bounds([]))
        self.assertEqual(pages.bounds([square(1, 2, 1), square(-1, 0, 1)]), [-1, 0, 2, 3])
        task = mock.Mock(orthophoto_extent={"type": "Point"}, dsm_extent=None, dtm_extent=square(0, 0))
        self.assertEqual(pages.footprint(task), square(0, 0))

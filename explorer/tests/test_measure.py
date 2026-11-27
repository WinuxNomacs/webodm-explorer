"""
Tests of the map page's Measure tool (upcoming-changes.md, "Plan: measurement tools"), run inside the dev stack's web
container: docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
Volume is WebODM's own (its Measure plugin's TaskVolume, TaskVolumeResult and calc_volume: an exception the user
allowed, CLAUDE.md); these tests import them, so a WebODM release that changes them fails here.
"""
import json
import os
import shutil
from unittest import mock

from app.tests.classes import BootTestCase
from coreplugins.explorer import api, links, measure
from coreplugins.explorer.tests.test_links import ALL_OUTPUTS, LinkTestMixin
from coreplugins.measure import api as measure_api
from coreplugins.measure.api import TaskVolume, TaskVolumeResult
from coreplugins.measure.volume import calc_volume
from django.test import Client, override_settings
from worker.celery import MockAsyncResult

LOCAL_CACHE = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "explorer-measure"}}


class MeasureTestMixin(LinkTestMixin):
    """A task with a 60 m x 60 m DSM (1 m cells) at 100 m with a 10 m x 10 m block 10 m higher in its middle, and a
    DTM at 95 m whose north-west quarter is nodata"""
    X, Y, EPSG = 500000.0, 4600000.0, 32616

    def setUp(self):
        super().setUp()
        # WebODM's volume view needs the DSM's extent (any; it only checks there is one)
        self.dem = self.task("Stockpile", ALL_OUTPUTS, epsg=self.EPSG,
                             dsm_extent={"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]})
        os.makedirs(self.dem.assets_path("odm_dem"), exist_ok=True)
        import numpy
        dsm = numpy.full((60, 60), 100.0, dtype="float32")
        dsm[25:35, 25:35] = 110.0
        dtm = numpy.full((60, 60), 95.0, dtype="float32")
        dtm[:30, :30] = -9999.0
        self.write("dsm.tif", dsm)
        self.write("dtm.tif", dtm)
        self.link = links.create_link(self.project.id, "Measure", 30, self.owner)
        self.token_api = f"/api/plugins/explorer/s/{self.link['token']}/tasks/{self.dem.id}/"
        self.own_api = f"/api/plugins/explorer/projects/{self.project.id}/tasks/{self.dem.id}/"

    def tearDown(self):
        path = self.dem.task_path()
        if os.path.isdir(path) and str(self.dem.id) in path:
            shutil.rmtree(path)
        super().tearDown()

    def write(self, name, values):
        import rasterio
        from rasterio.transform import from_origin
        with rasterio.open(self.dem.assets_path("odm_dem", name), "w", driver="GTiff", width=60, height=60, count=1,
                           dtype="float32", crs=f"EPSG:{self.EPSG}", nodata=-9999.0,
                           transform=from_origin(self.X, self.Y + 60, 1, 1)) as dem:
            dem.write(values, 1)

    def lnglat(self, x, y):
        from pyproj import Transformer
        return list(Transformer.from_crs(f"EPSG:{self.EPSG}", "EPSG:4326", always_xy=True).transform(x, y))

    def at(self, x, y):
        lng, lat = self.lnglat(x, y)
        return f"?lng={lng}&lat={lat}"

    def area(self, x0, y0, x1, y1):
        """WebODM's volume request: a Feature whose ring is the box's corners in WGS84"""
        ring = [self.lnglat(x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0))]
        return {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [ring]}}

    def post_volume(self, client=None, method="triangulate", url=None):
        return (client or Client()).post(url or self.token_api + "volume",
                                         json.dumps({"area": self.area(self.X + 20.5, self.Y + 20.5, self.X + 39.5, self.Y + 39.5),
                                                     "method": method}), content_type="application/json")


class ElevationTests(MeasureTestMixin, BootTestCase):
    def test_a_points_elevations_are_the_dsm_and_dtm_cells_under_it(self):
        response = Client().get(self.token_api + "elevation/" + self.at(self.X + 30.5, self.Y + 30.5))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"dsm": 110.0, "dtm": 95.0})
        self.assertEqual(Client().get(self.token_api + "elevation/" + self.at(self.X + 50.5, self.Y + 10.5)).json(),
                         {"dsm": 100.0, "dtm": 95.0})

    def test_nodata_and_points_outside_the_raster_have_no_value(self):
        self.assertEqual(Client().get(self.token_api + "elevation/" + self.at(self.X + 10.5, self.Y + 50.5)).json(),
                         {"dsm": 100.0, "dtm": None})
        self.assertEqual(Client().get(self.token_api + "elevation/" + self.at(self.X + 500, self.Y + 500)).json(),
                         {"dsm": None, "dtm": None})

    def test_only_the_rasters_the_task_has_are_read_and_a_broken_one_has_no_value(self):
        self.dem.available_assets = ["dsm.tif"]
        self.dem.save()
        self.assertEqual(Client().get(self.token_api + "elevation/" + self.at(self.X + 30.5, self.Y + 30.5)).json(),
                         {"dsm": 110.0})
        with open(self.dem.assets_path("odm_dem", "dsm.tif"), "wb") as f:
            f.write(b"not a tiff")
        self.assertEqual(Client().get(self.token_api + "elevation/" + self.at(self.X + 30.5, self.Y + 30.5)).json(),
                         {"dsm": None})

    def test_a_point_that_doesnt_parse_is_refused(self):
        for query in ("", "?lng=x&lat=1", "?lng=1", "?lng=200&lat=1", "?lng=nan&lat=1"):
            self.assertEqual(Client().get(self.token_api + "elevation/" + query).status_code, 400, query)

    def test_a_revoked_link_and_another_projects_task_read_nothing(self):
        other = self.task("Other", ALL_OUTPUTS, project=self.other_project)
        response = Client().get(f"/api/plugins/explorer/s/{self.link['token']}/tasks/{other.id}/elevation/?lng=1&lat=1")
        self.assertEqual(response.status_code, 404)
        links.revoke_link(self.project.id, self.link["token"])
        self.assertEqual(Client().get(self.token_api + "elevation/" + self.at(self.X + 30.5, self.Y + 30.5)).status_code, 404)

    def test_signed_in_users_who_can_view_the_project_read_elevations_and_others_dont(self):
        url = self.own_api + "elevation/" + self.at(self.X + 30.5, self.Y + 30.5)
        self.assertEqual(self.client_for("testuser").get(url).json(), {"dsm": 110.0, "dtm": 95.0})
        self.assertEqual(self.client_for("testuser2").get(url).status_code, 404)
        self.assertIn(Client().get(url).status_code, (401, 403))
        self.assertEqual(self.client_for("testuser").get(url, HTTP_SEC_FETCH_SITE="cross-site").status_code, 403)


class VolumeTests(MeasureTestMixin, BootTestCase):
    def capture_jobs(self):
        """WebODM's tests run the worker inline without keeping its results where its result view reads them: keep
        each job's real result there, as the worker would"""
        real = measure_api.run_function_async

        def run(*args, **kwargs):
            job = real(*args, **kwargs)
            MockAsyncResult.set(job.task_id, job.get())
            return job
        return mock.patch.object(measure_api, "run_function_async", side_effect=run)

    def test_webodms_own_volume_measures_the_block_on_the_synthetic_dsm(self):
        # Checks WebODM's calc_volume on this DSM: the 10 x 10 x 10 m block over a flat 100 m base. The corners are
        # inside cells: one exactly on a cell's corner reads the empty cell beyond WebODM's mask, and the volume is 0
        points = self.area(self.X + 20.5, self.Y + 20.5, self.X + 39.5, self.Y + 39.5)["geometry"]["coordinates"][0]
        for method in ("triangulate", "plane", "lowest"):
            result = calc_volume(input_dem=self.dem.assets_path("odm_dem", "dsm.tif"), pts=points, pts_epsg=4326,
                                 base_method=method)
            self.assertAlmostEqual(result["output"], 1000.0, delta=1.0, msg=method)

    @override_settings(CACHES=LOCAL_CACHE)
    def test_a_links_visitor_gets_webodms_volume_through_the_links_views(self):
        with self.capture_jobs():
            response = self.post_volume()
        self.assertEqual(response.status_code, 200)
        job = response.json()["celery_task_id"]
        result = Client().get(self.token_api + f"volume/get/{job}")
        self.assertEqual(result.status_code, 200)
        self.assertAlmostEqual(float(result.json()["output"]), 1000.0, delta=1.0)
        self.assertEqual(result["Referrer-Policy"], "strict-origin")

    @override_settings(CACHES=LOCAL_CACHE)
    def test_a_link_runs_three_volume_jobs_at_once_and_a_finished_one_frees_its_place(self):
        with mock.patch.object(TaskVolume, "post", side_effect=lambda request, pk=None: api.Response(
                {"celery_task_id": f"job-{mock_counter()}"})):
            started = [self.post_volume() for _ in range(measure.VOLUME_JOBS_PER_LINK)]
            self.assertEqual([r.status_code for r in started], [200] * measure.VOLUME_JOBS_PER_LINK)
            refused = self.post_volume()
            self.assertEqual(refused.status_code, 429)
            self.assertIn("try again", refused.json()["error"])
            # A job still running keeps its place; once its result is in, the place is free
            job = started[0].json()["celery_task_id"]
            self.assertEqual(Client().get(self.token_api + f"volume/get/{job}").json(), {"error": "Task not ready"})
            self.assertEqual(self.post_volume().status_code, 429)
            MockAsyncResult.set(job, {"output": 12.5})
            self.assertEqual(Client().get(self.token_api + f"volume/get/{job}").json(), {"output": 12.5})
            self.assertEqual(self.post_volume().status_code, 200)
            # Another link has places of its own
            other = links.create_link(self.project.id, "Other", 30, self.owner)
            self.assertEqual(self.post_volume(url=f"/api/plugins/explorer/s/{other['token']}/tasks/{self.dem.id}/volume")
                             .status_code, 200)

    @override_settings(CACHES=LOCAL_CACHE)
    def test_a_job_that_never_finishes_frees_its_place_when_it_expires(self):
        with mock.patch.object(TaskVolume, "post", side_effect=lambda request, pk=None: api.Response(
                {"celery_task_id": f"stuck-{mock_counter()}"})), \
                mock.patch.object(measure, "VOLUME_SECONDS", 1):
            for _ in range(measure.VOLUME_JOBS_PER_LINK):
                self.post_volume()
            self.assertEqual(self.post_volume().status_code, 429)
            import time
            time.sleep(1.2)
            self.assertEqual(self.post_volume().status_code, 200)

    @override_settings(CACHES=LOCAL_CACHE)
    def test_a_refused_or_failed_start_gives_its_place_back(self):
        with mock.patch.object(TaskVolume, "post", side_effect=lambda request, pk=None: api.Response({"error": "No DSM"})):
            for _ in range(measure.VOLUME_JOBS_PER_LINK + 1):
                self.assertEqual(self.post_volume().json(), {"error": "No DSM"})
        with mock.patch.object(TaskVolume, "post", side_effect=RuntimeError("worker gone")):
            for _ in range(measure.VOLUME_JOBS_PER_LINK + 1):
                with self.assertRaises(RuntimeError):
                    self.post_volume()
        with self.capture_jobs():
            self.assertEqual(self.post_volume().status_code, 200)

    def test_with_the_cache_down_a_link_gets_no_volume(self):
        with mock.patch.object(measure, "cache", mock.Mock(add=mock.Mock(side_effect=ConnectionError("redis down")))):
            response = self.post_volume()
        self.assertEqual(response.status_code, 503)
        self.assertIn("right now", response.json()["error"])

    @override_settings(CACHES=LOCAL_CACHE)
    def test_a_revoked_link_starts_nothing_and_reads_no_result(self):
        with self.capture_jobs():
            job = self.post_volume().json()["celery_task_id"]
        links.revoke_link(self.project.id, self.link["token"])
        self.assertEqual(self.post_volume().status_code, 404)
        self.assertEqual(Client().get(self.token_api + f"volume/get/{job}").status_code, 404)

    def test_with_webodms_measure_plugin_disabled_there_is_no_volume(self):
        with mock.patch.object(measure, "measure_active", return_value=False):
            self.assertEqual(self.post_volume().status_code, 404)
            self.assertEqual(Client().get(self.token_api + "volume/get/abc").status_code, 404)

    def test_the_link_views_are_webodms_measure_views_with_the_token_check(self):
        self.assertTrue(issubclass(api.TokenVolume, TaskVolume))
        self.assertTrue(issubclass(api.TokenVolumeResult, TaskVolumeResult))
        self.assertIs(api.TokenVolume.get_and_check_task, api.TokenTaskMixin.get_and_check_task)


_counter = [0]


def mock_counter():
    _counter[0] += 1
    return _counter[0]


class MeasurePageTests(MeasureTestMixin, BootTestCase):
    def tool(self, html):
        start = html.index('data-tool="measure"')
        return html[html.rindex("<button", 0, start):html.index(">", start)]

    def test_a_links_map_page_measures_through_the_links_views(self):
        html = Client().get(f"/plugins/explorer/s/{self.link['token']}/map/{self.dem.id}/").content.decode()
        tool = self.tool(html)
        self.assertIn(f'data-elevation="{self.token_api}elevation/"', tool)
        self.assertIn(f'data-volume-start="{self.token_api}volume"', tool)
        self.assertIn(f'data-volume-result="{self.token_api}volume/get/"', tool)
        self.assertIn("data-dsm", tool)
        self.assertIn("data-dtm", tool)
        self.assertIn("data-link", tool)
        self.assertIn("geographiclib-geodesic-2.2.0/geographiclib-geodesic.min.js", html)
        self.assertIn('id="explorer-measure-texts"', html)
        self.assertIn("csrfmiddlewaretoken", html)

    def test_a_signed_in_users_map_measures_volume_through_webodms_measure_api(self):
        html = self.client_for("testuser").get(f"/plugins/explorer/project/{self.project.id}/map/{self.dem.id}/").content.decode()
        tool = self.tool(html)
        self.assertIn(f'data-elevation="{self.own_api}elevation/"', tool)
        self.assertIn(f'data-volume-start="/api/plugins/measure/task/{self.dem.id}/volume"', tool)
        self.assertNotIn("data-link", tool)

    def test_tools_follow_the_data_the_task_has(self):
        self.dem.available_assets = ["orthophoto.tif"]
        self.dem.save()
        tool = self.tool(Client().get(f"/plugins/explorer/s/{self.link['token']}/map/{self.dem.id}/").content.decode())
        self.assertNotIn("data-elevation", tool)
        self.assertNotIn("data-volume-start", tool)
        self.dem.available_assets = ["orthophoto.tif", "dtm.tif"]
        self.dem.save()
        tool = self.tool(Client().get(f"/plugins/explorer/s/{self.link['token']}/map/{self.dem.id}/").content.decode())
        self.assertIn("data-elevation", tool)
        self.assertIn("data-dtm", tool)
        self.assertNotIn("data-dsm", tool)
        self.assertNotIn("data-volume-start", tool)  # volume needs a DSM

    def test_no_volume_when_webodms_measure_plugin_is_disabled(self):
        with mock.patch.object(measure, "measure_active", return_value=False):
            tool = self.tool(Client().get(f"/plugins/explorer/s/{self.link['token']}/map/{self.dem.id}/").content.decode())
        self.assertNotIn("data-volume-start", tool)
        self.assertIn("data-elevation", tool)

    def test_webodms_measure_plugin_is_enabled_in_a_default_install(self):
        self.assertTrue(measure.measure_active())

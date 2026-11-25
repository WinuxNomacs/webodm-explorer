"""
Tests of Source Frames, step A (upcoming-changes.md, "Plan: Source Frames in Explorer's viewer"): frames.py's ranking
(ported from TweakUI's tests), Explorer's API for signed-in users, and the button on the map and 3D pages. Run inside
the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
"""
import json
import math
import os
import shutil
from unittest import mock

from app.models import Project
from app.tests.classes import BootTestCase
from coreplugins.explorer import frames, pages
from coreplugins.explorer.tests.test_links import ALL_OUTPUTS, LinkTestMixin
from django.test import Client
from guardian.shortcuts import assign_perm


class FramesTestMixin(LinkTestMixin):
    """Two cameras 100 m above flat ground (a DSM at 20 m), looking straight down, 30 m apart in x: each photo is
    4000 x 3000 px with a focal of 0.8 (of its largest side), so it shows the ground 62.5 m either side in x"""
    X, Y, EPSG = 500000.0, 4600000.0, 32616
    DOWN = (math.pi, 0, 0)

    def setUp(self):
        super().setUp()
        self.cameras = self.task("Cameras", ALL_OUTPUTS + ["shots.geojson", "cameras.json"], epsg=self.EPSG)
        self.url = f"/api/plugins/explorer/projects/{self.project.id}/tasks/{self.cameras.id}/frames/"
        os.makedirs(self.cameras.assets_path("odm_report"), exist_ok=True)
        os.makedirs(self.cameras.assets_path("odm_dem"), exist_ok=True)
        os.makedirs(self.cameras.assets_path("odm_georeferencing"), exist_ok=True)
        self.write_shots([self.shot("a.jpg", self.X, 1000), self.shot("b.jpg", self.X + 30, 1001)])
        with open(self.cameras.assets_path("cameras.json"), "w") as f:
            json.dump({"test 4000 3000 brown 0.8": {"projection_type": "brown", "width": 4000, "height": 3000,
                                                    "focal_x": 0.8, "focal_y": 0.8, "c_x": 0, "c_y": 0,
                                                    "k1": 0, "k2": 0, "k3": 0, "p1": 0, "p2": 0}}, f)
        with open(self.cameras.assets_path("odm_georeferencing", "coords.txt"), "w") as f:
            f.write(f"WGS84 UTM 16N\n{self.X - 100} {self.Y - 100}\n")
        self.write_dsm(20.0)

    def tearDown(self):
        path = self.cameras.task_path()
        if os.path.isdir(path) and str(self.cameras.id) in path:
            shutil.rmtree(path)
        super().tearDown()

    def write_shots(self, features):
        with open(self.cameras.assets_path("odm_report", "shots.geojson"), "w") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)

    def shot(self, name, x, time):
        return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0, 120.0]},
                "properties": {"filename": name, "camera": "v2 test 4000 3000 brown 0.8", "focal": 0.8,
                               "width": 4000, "height": 3000, "capture_time": time,
                               "translation": [x, self.Y, 120.0], "rotation": list(self.DOWN)}}

    def write_dsm(self, height):
        import numpy
        import rasterio
        from rasterio.transform import from_origin
        with rasterio.open(self.cameras.assets_path("odm_dem", "dsm.tif"), "w", driver="GTiff", width=300, height=300,
                           count=1, dtype="float32", crs=f"EPSG:{self.EPSG}", nodata=-9999.0,
                           transform=from_origin(self.X - 150, self.Y + 150, 1, 1)) as dsm:
            dsm.write(numpy.full((1, 300, 300), height, dtype="float32"))

    def lnglat(self, x, y):
        from pyproj import Transformer
        return list(Transformer.from_crs(f"EPSG:{self.EPSG}", "EPSG:4326", always_xy=True).transform(x, y))

    def post(self, data, client=None, url=None):
        client = client or self.client_for("testuser")
        return client.post(url or self.url, json.dumps(data), content_type="application/json")


class FramesRankingTests(FramesTestMixin, BootTestCase):
    def test_a_spots_photos_are_those_that_show_it_nearest_their_centre_first(self):
        response = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)})
        self.assertEqual(response.status_code, 200)
        found = response.json()["frames"]
        self.assertEqual([f["filename"] for f in found], ["a.jpg", "b.jpg"])
        # Below camera a: its photo's centre; 30 m from b at 100 m: 0.8 * 0.3 of the width left of its centre
        self.assertEqual(found[0]["spot"], [0.5, 0.5])
        self.assertAlmostEqual(found[1]["spot"][0], 0.5 - 0.8 * 0.3, places=3)
        self.assertEqual(found[0]["capture_time"], 1000)
        self.assertEqual(found[0]["altitude"], 120.0)
        # 70 m from a (out of its photo), 40 m from b
        found = self.post({"type": "Point", "coordinates": self.lnglat(self.X + 70, self.Y)}).json()["frames"]
        self.assertEqual([f["filename"] for f in found], ["b.jpg"])
        self.assertEqual(self.post({"type": "Point", "coordinates": self.lnglat(self.X + 500, self.Y)}).json(),
                         {"frames": []})

    def test_a_3d_pick_gives_its_own_height_in_the_tasks_coordinates(self):
        # Picked on a roof 60 m below the cameras: 30 m from b is 0.8 * 30 / 60 from its centre
        found = self.post({"type": "Point", "coordinates": [self.X, self.Y, 60.0], "crs": "task"}).json()["frames"]
        self.assertAlmostEqual(found[1]["spot"][0], 0.5 - 0.8 * 0.5, places=3)
        self.assertEqual(self.post({"type": "Point", "coordinates": [self.X, self.Y], "crs": "task"}).status_code, 400)

    def test_the_ground_height_comes_from_the_dsm_else_the_point_clouds_mean_height(self):
        self.write_dsm(50.0)
        found = self.post({"type": "Point", "coordinates": self.lnglat(self.X + 40, self.Y)}).json()["frames"]
        self.assertAlmostEqual(found[-1]["spot"][0], 0.5 + 0.8 * 40 / 70, places=3)
        os.remove(self.cameras.assets_path("odm_dem", "dsm.tif"))
        response = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)})
        self.assertEqual(response.status_code, 400)
        self.assertIn("no ground height", response.json()["detail"])
        os.makedirs(self.cameras.assets_path("entwine_pointcloud"), exist_ok=True)
        with open(self.cameras.assets_path("entwine_pointcloud", "ept.json"), "w") as f:
            json.dump({"schema": [{"name": "Z", "mean": 50.0}]}, f)
        found = self.post({"type": "Point", "coordinates": self.lnglat(self.X + 40, self.Y)}).json()["frames"]
        self.assertAlmostEqual(found[-1]["spot"][0], 0.5 + 0.8 * 40 / 70, places=3)

    def test_a_fisheye_lens_bends_the_spot_toward_the_centre(self):
        with open(self.cameras.assets_path("cameras.json"), "w") as f:
            json.dump({"test 4000 3000 brown 0.8": {"projection_type": "fisheye", "width": 4000, "height": 3000,
                                                    "focal": 0.8, "k1": 0, "k2": 0}}, f)
        found = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)}).json()["frames"]
        # 30 m at 100 m: atan(0.3) instead of 0.3, times the focal
        self.assertAlmostEqual(found[1]["spot"][0], 0.5 - 0.8 * math.atan(0.3), places=3)

    def test_shots_without_a_size_or_a_pose_are_left_out_and_the_others_still_found(self):
        broken = [self.shot("no-size.jpg", self.X, 1), self.shot("no-pose.jpg", self.X, 2),
                  self.shot("bad-rotation.jpg", self.X, 3), "not a shot", {"properties": None}]
        del broken[0]["properties"]["width"]
        del broken[1]["properties"]["translation"]
        broken[2]["properties"]["rotation"] = "down"
        self.write_shots(broken + [self.shot("a.jpg", self.X, 1000)])
        response = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)})
        self.assertEqual([f["filename"] for f in response.json()["frames"]], ["a.jpg"])

    def test_an_answer_lists_at_most_the_fifty_best(self):
        self.write_shots([self.shot(f"{i:03d}.jpg", self.X + i * 0.5, i) for i in range(70)])
        found = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)}).json()["frames"]
        self.assertEqual(len(found), frames.MAX_FRAMES)
        self.assertEqual(found[0]["filename"], "000.jpg")

    def test_unreadable_cameras_say_so(self):
        with open(self.cameras.assets_path("odm_report", "shots.geojson"), "w") as f:
            f.write("{not json")
        response = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "This task's cameras could not be read")

    def test_anything_but_a_spot_and_tasks_without_cameras_are_refused(self):
        for data in ({}, [], {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                     {"type": "Point", "coordinates": "x"}, {"type": "Point", "coordinates": [0, 0, 0, 0]},
                     {"type": "Point", "coordinates": [0, float("nan")]},
                     {"type": "Point", "coordinates": [0, 0], "crs": "EPSG:4326"}):
            self.assertEqual(self.post(data).status_code, 400, data)
        self.cameras.available_assets = ["orthophoto.tif"]
        self.cameras.save()
        response = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "This task has no cameras")

    def test_an_unexpected_failure_is_answered_and_logged(self):
        with mock.patch.object(frames, "rank", side_effect=RuntimeError("boom")), \
                self.assertLogs("app.logger", "ERROR"):
            response = self.post({"type": "Point", "coordinates": self.lnglat(self.X, self.Y)})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "The photos could not be found.")


class FramesAccessTests(FramesTestMixin, BootTestCase):
    def test_only_those_who_can_view_the_project_find_its_photos(self):
        point = {"type": "Point", "coordinates": self.lnglat(self.X, self.Y)}
        self.assertEqual(self.post(point, client=self.client_for("testuser2")).status_code, 404)
        self.assertIn(self.post(point, client=Client()).status_code, (401, 403))
        assign_perm("view_project", self.user("testuser2"), self.project)
        self.assertEqual(self.post(point, client=self.client_for("testuser2")).status_code, 200)
        other = Project.objects.get(name="User 2 Test Project")
        url = f"/api/plugins/explorer/projects/{other.id}/tasks/{self.cameras.id}/frames/"
        self.assertEqual(self.post(point, client=self.client_for("testuser2"), url=url).status_code, 404)
        self.assertEqual(self.client_for("testuser").get(self.url).status_code, 405)

    def test_a_post_needs_the_pages_csrf_token(self):
        strict = self.client_for("testuser", enforce_csrf_checks=True)
        point = {"type": "Point", "coordinates": self.lnglat(self.X, self.Y)}
        self.assertEqual(self.post(point, client=strict).status_code, 403)

    def user(self, username):
        from django.contrib.auth.models import User
        return User.objects.get(username=username)


class FramesPageTests(FramesTestMixin, BootTestCase):
    def html(self, path, client=None):
        response = (client or self.client_for("testuser")).get(path)
        self.assertEqual(response.status_code, 200, path)
        return response.content.decode()

    def test_the_signed_in_map_and_3d_pages_offer_source_frames(self):
        own = f"/plugins/explorer/project/{self.project.id}/"
        for kind in ("map", "3d"):
            html = self.html(f"{own}{kind}/{self.cameras.id}/")
            self.assertIn(f'data-frames-api="{self.url}"', html, kind)
            self.assertIn(f'data-images="/api/projects/{self.project.id}/tasks/{self.cameras.id}/images/"', html)
            self.assertIn('id="explorer-frames-texts"', html)
            self.assertIn("Click to View Source Frames", html)
            self.assertIn("frames.js?v=", html)
            self.assertIn('name="csrfmiddlewaretoken"', html)
        self.assertIn("S turns it on and off", self.html(f"{own}3d/{self.cameras.id}/"))

    def test_view_as_visitor_shows_it_unavailable_and_links_dont_have_it_yet(self):
        preview = self.html(f"/plugins/explorer/project/{self.project.id}/preview/map/{self.cameras.id}/")
        self.assertIn('data-tool="frames" aria-disabled="true"', preview)
        self.assertIn("not available on links yet", preview)
        self.assertNotIn("data-frames-api", preview)
        self.assertNotIn("frames.js?v=", preview)
        token = self.link()["token"]
        for kind in ("map", "3d"):
            html = self.html(f"/plugins/explorer/s/{token}/{kind}/{self.cameras.id}/", Client())
            self.assertNotIn('data-tool="frames"', html, kind)

    def test_a_task_without_cameras_has_no_button_and_a_3d_page_without_an_offset_neither(self):
        plain = self.task("Plain")
        own = f"/plugins/explorer/project/{self.project.id}/"
        self.assertNotIn('data-tool="frames"', self.html(f"{own}map/{plain.id}/"))
        os.remove(self.cameras.assets_path("odm_georeferencing", "coords.txt"))
        self.assertNotIn('data-tool="frames"', self.html(f"{own}3d/{self.cameras.id}/"))
        self.assertIn('data-tool="frames"', self.html(f"{own}map/{self.cameras.id}/"))

    def test_source_frames_needs_a_task_with_shots(self):
        viewer = pages.Viewer(project=self.project, path="/p/", api="/a/", tiles_api="/t/", downloads=True,
                              preview=False, signed_in=True)
        self.assertIsNotNone(pages.source_frames(viewer, self.cameras))
        self.assertIsNone(pages.source_frames(viewer, self.cameras, offset=False))
        self.assertIsNone(pages.source_frames(viewer, None))

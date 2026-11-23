"""
Tests of the mesh tiles (tiles_build.py, tiles.py and their views), run inside the dev stack's web container:
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests

The build runs stand-ins for Obj2Tiles and gltfpack that misbehave on request (FAKE_MODE), so each failure the
plan lists happens here.
"""
import json
import os
import platform
import shutil
import tempfile
import time
import unittest
from unittest import mock

from app.models import Task
from app.plugins import signals
from app.tests.classes import BootTestCase
from coreplugins.explorer import tiles
from coreplugins.explorer import tiles_build as build
from coreplugins.explorer.tests.test_links import LinkTestMixin
from django.conf import settings

# Obj2Tiles' stand-in: writes a two-level tileset shaped as Obj2Tiles 1.10.3 writes them (root.glb, LOD-0/, a null
# transform and null children on leaves, as captured from the user's meshes), with its progress lines, unless
# FAKE_MODE asks for a failure
FAKE_OBJ2TILES = r"""#!/bin/sh
out="$2"; for a in "$@"; do out="$a"; done
obj=""; prev=""; for a in "$@"; do [ -n "$prev" ] && [ "$a" = "$out" ] && obj="$prev"; prev="$a"; done
mode="${FAKE_MODE:-ok}"
[ -n "$FAKE_PID" ] && echo "$$" > "$FAKE_PID"
case "$mode" in
  exit) echo "Unhandled exception: boom"; exit 3 ;;
  stage) echo '{"stage":"error","message":"cannot read texture"}'; exit 1 ;;
  stall) echo '{"stage":"decimation","done":0,"total":1,"percent":1}'; sleep 600 ;;
  slow) while true; do echo '{"stage":"tiling","done":1,"total":9,"percent":50}'; sleep 0.2; done ;;
  touch) sleep 1.1; echo "x" >> "$obj" ;;
  remove) rm -f "$obj" ;;
  removetask) rm -rf "$(dirname "$(dirname "$(dirname "$obj")")")" ;;
esac
mkdir -p "$out/LOD-0"
printf 'glTF-root' > "$out/root.glb"
printf 'glTF-leaf' > "$out/LOD-0/Mesh-XL.glb"
missing=""; [ "$mode" = "missing" ] && missing=',{"geometricError":0,"content":{"uri":"LOD-0/Gone.glb"}}'
cat > "$out/tileset.json" <<EOF
{"asset":{"version":"1.1"},"geometricError":1.5,"root":{"transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"boundingVolume":{"box":[0,0,0,1,0,0,0,1,0,0,0,1]},"geometricError":1.5,"refine":"REPLACE","content":{"uri":"root.glb"},"children":[{"transform":null,"boundingVolume":{"box":[0,0,0,1,0,0,0,1,0,0,0,1]},"geometricError":0,"refine":"REPLACE","content":{"uri":"LOD-0/Mesh-XL.glb"},"children":null}$missing]}}
EOF
echo '{"stage":"tiling","done":2,"total":2,"percent":100}'
echo '{"stage":"done","percent":100,"elapsed":0.1}'
"""

# gltfpack's stand-in (run by Node, as the real one): appends its arguments to the tile, so tests see what ran
FAKE_GLTFPACK = r"""
const fs = require("fs");
const args = process.argv.slice(2);
const input = args[args.indexOf("-i") + 1], output = args[args.indexOf("-o") + 1];
if (process.env.FAKE_PACK === "fail") { console.error("Error: bad glb"); process.exit(1); }
fs.writeFileSync(output, fs.readFileSync(input, "utf8") + " packed " + args.filter((a) => a.startsWith("-") && a !== "-i" && a !== "-o").join(" ") + (args.includes("-si") ? " " + args[args.indexOf("-si") + 1] : ""));
"""


def fake_tools(folder, executable=True):
    exe = os.path.join(folder, "obj2tiles", f"linux-{platform.machine()}", "Obj2Tiles")
    os.makedirs(os.path.dirname(exe))
    with open(exe, "w") as f:
        f.write(FAKE_OBJ2TILES)
    os.chmod(exe, 0o755 if executable else 0o644)
    os.makedirs(os.path.join(folder, "gltfpack"))
    with open(os.path.join(folder, "gltfpack", "cli.js"), "w") as f:
        f.write(FAKE_GLTFPACK)
    return exe


class BuildTests(unittest.TestCase):
    """The build as the worker runs it, with the stand-in tools."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.work = os.path.join(self.dir, "work")
        self.tools = os.path.join(self.dir, "bin")
        fake_tools(self.tools)
        # WebODM's media layout: the tiles in the task's own folder, beside its assets
        self.folders = os.path.join(self.dir, "media", "project", "*", "task", "*", build.FOLDER)
        self.task = "358acbe0-a940-46c7-95f3-bbc53f3c2620"
        self.tiles, self.obj = self.mesh(self.task)
        with open(self.obj, "w") as f:
            f.write("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
        self.env = mock.patch.dict(os.environ, {"FAKE_MODE": "ok", "FAKE_PACK": "ok",
                                                "FAKE_PID": os.path.join(self.dir, "pid")})
        self.env.start()
        self.addCleanup(self.env.stop)

    def mesh(self, task, project="1"):
        """(tiles folder, mesh path) of a task folder made with its mesh's folder."""
        task_folder = os.path.join(self.dir, "media", "project", project, "task", task)
        obj = os.path.join(task_folder, "assets", "odm_texturing", "odm_textured_model_geo.obj")
        os.makedirs(os.path.dirname(obj))
        return os.path.join(task_folder, build.FOLDER), obj

    def run_build(self, **env):
        os.environ.update(env)
        return build.run(self.work, self.tiles, self.obj, self.tools, self.folders)

    def state(self):
        return build.read_state(self.tiles)

    def folder(self, *paths):
        return os.path.join(self.tiles, *paths)

    def assert_no_leftovers(self):
        self.assertEqual([e for e in os.listdir(self.folder()) if e.startswith(".tmp-")], [])

    def test_a_build_packs_every_tile_simplifies_the_root_and_becomes_ready(self):
        result = self.run_build()
        self.assertEqual(result["state"], "ready")
        state = self.state()
        self.assertEqual(state["state"], "ready")
        self.assertEqual(state["build"], build.build_id(build.fingerprint(self.obj)))
        with open(self.folder(state["build"], "root.glb")) as f:
            self.assertEqual(f.read(), "glTF-root packed -cc -kn -km -si 0.25")
        with open(self.folder(state["build"], "LOD-0", "Mesh-XL.glb")) as f:
            self.assertEqual(f.read(), "glTF-leaf packed -cc -kn -km")
        with open(self.folder(state["build"], "tileset.json")) as f:
            tileset = json.load(f)
        self.assertEqual(tileset["root"]["geometricError"], 3.0)  # raised with the simplified root
        self.assertEqual(tileset["geometricError"], 3.0)
        self.assert_no_leftovers()
        self.assertEqual(build.decide(self.state(), build.fingerprint(self.obj), time.time()), ("ready", state["build"]))

    def test_a_ready_build_is_not_built_again_and_a_new_mesh_replaces_it(self):
        first = self.run_build()["build"]
        self.assertTrue(self.run_build()["skipped"])
        with open(self.obj, "a") as f:
            f.write("f 1 2 3\n")
        self.assertEqual(build.decide(self.state(), build.fingerprint(self.obj), time.time()), ("queue", None))
        second = self.run_build()["build"]
        self.assertNotEqual(first, second)
        self.assertFalse(os.path.exists(self.folder(first)))  # the old build is removed once the new one is ready

    def test_obj2tiles_exiting_with_an_error_fails_the_build_until_it_may_be_tried_again(self):
        result = self.run_build(FAKE_MODE="exit")
        self.assertEqual(result["state"], "failed")
        self.assertIn("exit 3", result["error"])
        self.assertIn("boom", self.state()["error"])
        self.assert_no_leftovers()
        fp = build.fingerprint(self.obj)
        self.assertEqual(build.decide(self.state(), fp, time.time()), ("failed", None))
        self.assertEqual(build.decide(self.state(), fp, time.time() + build.RETRY_FAILED + 1), ("queue", None))

    def test_obj2tiles_reporting_an_error_stage_records_its_message(self):
        result = self.run_build(FAKE_MODE="stage")
        self.assertEqual(result["error"], "Obj2Tiles: cannot read texture")

    def test_a_tool_that_stops_writing_is_stopped_and_the_build_fails(self):
        with mock.patch.object(build, "STALL_SECONDS", 2), mock.patch.object(build, "KILL_GRACE", 2):
            result = self.run_build(FAKE_MODE="stall")
        self.assertEqual(result["state"], "failed")
        self.assertIn("no progress for 2 s", result["error"])
        self.assert_process_gone()

    def test_a_tool_past_its_deadline_is_stopped_although_it_keeps_writing(self):
        with mock.patch.object(build, "DEADLINE_BASE", 2), mock.patch.object(build, "KILL_GRACE", 2):
            result = self.run_build(FAKE_MODE="slow")
        self.assertIn("took over 2 s", result["error"])
        self.assert_process_gone()

    def assert_process_gone(self):
        # The stand-in wrote its pid before hanging; it must not outlive the build
        with open(os.environ["FAKE_PID"]) as f:
            pid = int(f.read())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assert_no_leftovers()

    def test_gltfpack_failing_on_a_tile_fails_the_build(self):
        result = self.run_build(FAKE_PACK="fail")
        self.assertEqual(result["state"], "failed")
        self.assertIn("gltfpack: exit 1", result["error"])
        self.assert_no_leftovers()

    def test_a_tileset_naming_a_missing_tile_fails_the_build(self):
        result = self.run_build(FAKE_MODE="missing")
        self.assertIn("missing tile: LOD-0/Gone.glb", result["error"])

    def test_too_little_disk_space_fails_before_running_anything(self):
        with mock.patch.object(build, "SPACE_FACTOR", 10**15):
            result = self.run_build()
        self.assertIn("not enough disk space", result["error"])

    def test_missing_tools_or_another_platform_fail_the_build(self):
        with mock.patch.object(build.platform, "machine", return_value="riscv64"):
            self.assertIn("no Obj2Tiles build for this platform", self.run_build()["error"])
        os.remove(os.path.join(self.tools, "gltfpack", "cli.js"))
        self.assertIn("tools are missing", self.run_build()["error"])

    def test_a_tool_unzipped_without_its_executable_bit_gets_it_back(self):
        tools = os.path.join(self.dir, "unzipped")
        exe = fake_tools(tools, executable=False)
        self.assertEqual(build.run(self.work, self.tiles, self.obj, tools, self.folders)["state"], "ready")
        self.assertTrue(os.access(exe, os.X_OK))

    def test_a_mesh_changed_during_the_build_is_not_published(self):
        result = self.run_build(FAKE_MODE="touch")
        self.assertEqual(result["error"], "the mesh changed during the build")
        self.assertFalse([e for e in os.listdir(self.folder()) if build.BUILD_ID.match(e)])

    def test_a_task_removed_during_the_build_leaves_nothing_behind(self):
        result = self.run_build(FAKE_MODE="remove")
        self.assertEqual(result["state"], "gone")
        self.assertFalse(os.path.exists(self.folder()))

    def test_a_task_folder_removed_during_the_build_is_not_made_again(self):
        result = self.run_build(FAKE_MODE="removetask")
        self.assertEqual(result["state"], "gone")
        self.assertFalse(os.path.exists(os.path.dirname(self.tiles)))
        # Nor by a state written afterwards (a heartbeat, a failure)
        with self.assertRaises(FileNotFoundError):
            build.mark_failed(self.tiles, "1-1", "late")
        self.assertFalse(os.path.exists(os.path.dirname(self.tiles)))

    def second_mesh(self, project="2"):
        other = "89d7617e-3032-4c21-b0be-bbb82d113ddb"
        tiles_folder, obj = self.mesh(other, project)
        shutil.copy(self.obj, obj)
        return tiles_folder, obj

    def test_a_job_finding_a_build_running_leaves_its_task_queued_and_ends_at_once(self):
        other, obj = self.second_mesh()
        build.claim(other, build.fingerprint(obj), obj=obj)
        fd = build.try_build_lock(self.work)
        try:
            started = time.monotonic()
            self.assertEqual(build.run(self.work, other, obj, self.tools, self.folders),
                             {"state": "queued", "deferred": True})
            self.assertLess(time.monotonic() - started, 1)  # no worker slot held while another build runs
            self.assertEqual(build.read_state(other)["state"], "queued")
        finally:
            os.close(fd)

    def test_the_running_job_builds_the_tasks_queued_meanwhile_in_any_project_before_it_ends(self):
        other, obj = self.second_mesh()
        build.claim(other, build.fingerprint(obj), obj=obj)
        build.claim(self.tiles, build.fingerprint(self.obj), obj=self.obj)
        self.assertEqual(self.run_build()["state"], "ready")
        self.assertEqual(self.state()["state"], "ready")
        self.assertEqual(build.read_state(other)["state"], "ready")  # built by the same job
        self.assertIsNotNone(build.try_build_lock(self.work))  # and the lock let go

    def test_a_queued_task_whose_mesh_is_gone_does_not_stop_the_queue(self):
        other, obj = self.second_mesh()
        build.claim(other, build.fingerprint(obj), obj=obj)
        os.remove(obj)
        self.assertEqual(self.run_build()["state"], "ready")
        self.assertIsNone(build.read_state(other))  # removed, as for a removed task

    def test_a_duplicated_tasks_queued_state_names_its_own_mesh(self):
        build.claim(self.tiles, build.fingerprint(self.obj), obj=self.obj)
        copy_tiles, copy_obj = self.mesh("00000000-0000-4000-8000-000000000001")
        os.rmdir(os.path.dirname(copy_obj))
        shutil.copytree(os.path.dirname(self.obj), os.path.dirname(copy_obj))
        shutil.copytree(self.tiles, copy_tiles, copy_function=os.link)  # as WebODM duplicates a task
        found = {build.next_queued(self.folders, tried={os.path.normpath(self.tiles)}),
                 build.next_queued(self.folders, tried={os.path.normpath(copy_tiles)})}
        self.assertEqual(found, {(os.path.normpath(copy_tiles), os.path.normpath(copy_obj)),
                                 (os.path.normpath(self.tiles), os.path.normpath(self.obj))})
        # A state naming a mesh outside its task's folder is not built
        build.write_state(copy_tiles, dict(build.read_state(copy_tiles), mesh="../../../../etc/passwd"))
        self.assertEqual(build.next_queued(self.folders, tried={os.path.normpath(self.tiles)}), None)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tiles = os.path.join(self.root, build.FOLDER)

    def test_only_the_first_request_queues_a_build(self):
        self.assertEqual(build.claim(self.tiles, "1-1"), ("queue", None))
        self.assertEqual(build.claim(self.tiles, "1-1"), ("building", None))

    def test_a_build_abandoned_by_a_restarted_worker_is_queued_again(self):
        now = time.time()
        state = {"state": "building", "fingerprint": "1-1", "updated": now - 3600, "heartbeat": now - 60}
        self.assertEqual(build.decide(state, "1-1", now), ("building", None))
        state["heartbeat"] = now - build.HEARTBEAT_STALE - 1
        self.assertEqual(build.decide(state, "1-1", now), ("queue", None))
        queued = {"state": "queued", "fingerprint": "1-1", "updated": now - build.QUEUE_STALE - 1}
        self.assertEqual(build.decide(queued, "1-1", now), ("queue", None))

    def test_a_build_of_an_older_pipeline_is_replaced(self):
        old = {"state": "ready", "fingerprint": "1-1", "updated": time.time(), "build": "0123456789abcdef"}
        self.assertEqual(build.decide(old, "1-1", time.time()), ("queue", None))
        current = dict(old, build=build.build_id("1-1"))
        self.assertEqual(build.decide(current, "1-1", time.time()), ("ready", build.build_id("1-1")))

    def test_a_ready_build_whose_folder_is_gone_is_built_again(self):
        state = {"state": "ready", "fingerprint": "1-1", "updated": time.time(), "build": "0123456789abcdef"}
        build.write_state(self.tiles, state)
        self.assertEqual(build.claim(self.tiles, "1-1"), ("queue", None))

    def test_a_state_file_that_does_not_read_is_set_aside(self):
        os.makedirs(self.tiles)
        for bad in ("{not json", '{"state": "odd", "fingerprint": "1", "updated": 1}', "[]"):
            with open(os.path.join(self.tiles, "state.json"), "w") as f:
                f.write(bad)
            self.assertIsNone(build.read_state(self.tiles))
            self.assertTrue(os.path.exists(os.path.join(self.tiles, "state.json.bad")))

    def test_tile_urls_reach_only_tile_files_inside_a_finished_build(self):
        good = "0123456789abcdef"
        base = os.path.join(self.tiles, good)
        os.makedirs(os.path.join(base, "LOD-0"))
        for name in ("tileset.json", "LOD-0/a.glb", "notes.txt"):
            with open(os.path.join(base, name), "w") as f:
                f.write("x")
        os.symlink("/etc/passwd", os.path.join(base, "LOD-0", "escape.glb"))
        with open(os.path.join(self.tiles, "state.json"), "w") as f:
            f.write("{}")
        self.assertEqual(build.tile_file(self.tiles, good, "LOD-0/a.glb"), os.path.join(base, "LOD-0/a.glb"))
        for build_id, path in ((good, "../state.json"), (good, "LOD-0/../tileset.json"), (good, "/etc/passwd"),
                               (good, "notes.txt"), (good, "LOD-0/escape.glb"), (good, "missing.glb"),
                               ("../" + good, "tileset.json"), ("0123", "tileset.json"), (good, "LOD-0//a.glb")):
            self.assertIsNone(build.tile_file(self.tiles, build_id, path), (build_id, path))


class TilesPageTests(LinkTestMixin, BootTestCase):
    """The link's 3D page, the tiles view and the signals, with the build queue stubbed."""

    def setUp(self):
        super().setUp()
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.store = tiles.Tiles(os.path.join(self.dir, "tiles"), os.path.join(self.dir, "bin"))
        patcher = mock.patch.object(tiles.Tiles, "current", return_value=self.store)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.queue = mock.patch.object(tiles, "run_function_async")
        self.queued = self.queue.start()
        self.addCleanup(self.queue.stop)
        self.mesh_task = self.task("Mesh", assets=["textured_model.glb", "textured_model.zip"])
        obj = self.mesh_task.assets_path(*tiles.MESH)
        os.makedirs(os.path.dirname(obj), exist_ok=True)
        with open(obj, "w") as f:
            f.write("f 1 2 3\n")
        self.addCleanup(shutil.rmtree, self.mesh_task.task_path(), True)
        self.token = None

    def page(self):
        if self.token is None:
            self.token = self.link()["token"]
        return self.client.get(f"/plugins/explorer/s/{self.token}/3d/{self.mesh_task.id}/?t=mesh")

    def ready(self):
        """A finished build for the mesh task, as the worker leaves it."""
        fp = build.fingerprint(self.mesh_task.assets_path(*tiles.MESH))
        build_id = build.build_id(fp)
        folder = os.path.join(tiles.folder(self.mesh_task), build_id)
        os.makedirs(os.path.join(folder, "LOD-0"))
        with open(os.path.join(folder, "tileset.json"), "w") as f:
            f.write('{"root": {}}')
        with open(os.path.join(folder, "LOD-0", "a.glb"), "wb") as f:
            f.write(b"glTF")
        build.write_state(tiles.folder(self.mesh_task),
                          {"state": "ready", "fingerprint": fp, "build": build_id, "updated": time.time()})
        return build_id

    def test_without_tiles_the_page_shows_the_glb_and_queues_one_build(self):
        response = self.page()
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertIn(f"tasks/{self.mesh_task.id}/textured_model/\"", html)
        self.assertNotIn("data-fallback", html)
        self.assertRegex(html, r'data-type="mesh"[^>]*data-preparing')
        self.assertEqual(self.queued.call_count, 1)
        func, module_path, work, folder, _obj, _tools, folders = self.queued.call_args.args
        self.assertIs(func, tiles.build_tiles)
        self.assertEqual((work, folder), (self.store.work, self.mesh_task.task_path("explorer-tiles")))
        self.assertTrue(folder.startswith(os.path.join(settings.MEDIA_ROOT, "project", str(self.project.id))))
        self.assertEqual(folders, os.path.join(settings.MEDIA_ROOT, "project", "*", "task", "*", "explorer-tiles"))
        self.assertTrue(module_path.endswith("tiles_build.py"))
        self.page()
        self.assertEqual(self.queued.call_count, 1)  # queued already: not again

    def test_with_tiles_the_page_streams_them_with_the_glb_as_fallback(self):
        build_id = self.ready()
        html = self.page().content.decode()
        self.assertIn(f'data-url="/api/plugins/explorer/s/{self.token}/tasks/{self.mesh_task.id}/tiles/{build_id}/tileset.json"', html)
        self.assertIn(f'data-fallback="/api/plugins/explorer/s/{self.token}/tasks/{self.mesh_task.id}/textured_model/"', html)
        self.assertNotRegex(html, r'data-type="mesh"[^>]*data-preparing')
        self.assertIn("3d-tiles-renderer-0.5.4/build/index.three.js", html)
        self.assertIn("libs/basis/", html)
        self.queued.assert_not_called()

    def test_a_queue_that_cannot_be_reached_leaves_the_glb_and_tries_again_soon(self):
        self.queued.side_effect = ConnectionError("broker down")
        self.assertEqual(self.page().status_code, 200)
        state = build.read_state(tiles.folder(self.mesh_task))
        self.assertEqual(state["state"], "failed")
        self.assertEqual(state["retry_after"], tiles.QUEUE_RETRY)

    def test_the_tiles_view_serves_a_build_through_a_live_link_only(self):
        build_id = self.ready()
        self.token = self.link()["token"]
        base = f"/api/plugins/explorer/s/{self.token}/tasks/{self.mesh_task.id}/tiles/{build_id}/"
        response = self.client.get(base + "LOD-0/a.glb")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content), b"glTF")
        self.assertEqual(response["Content-Type"], "model/gltf-binary")
        self.assertIn("immutable", response["Cache-Control"])
        self.assertEqual(self.client.get(base + "tileset.json")["Content-Type"], "application/json")
        for bad in ("../state.json", "LOD-0/missing.glb", "state.json", "tileset.json.tmp"):
            self.assertEqual(self.client.get(base + bad).status_code, 404, bad)
        self.assertEqual(self.client.get(base.replace(build_id, "f" * 16) + "tileset.json").status_code, 404)
        other = self.task("Other", project=self.other_project)
        self.assertEqual(self.client.get(base.replace(str(self.mesh_task.id), str(other.id)) + "tileset.json").status_code, 404)
        links_revoked = self.client_for("testuser").delete(f"{self.links_api()}{self.token}/")
        self.assertEqual(links_revoked.status_code, 204)
        self.assertEqual(self.client.get(base + "tileset.json").status_code, 404)

    def test_creating_a_link_queues_the_projects_meshes(self):
        self.task("No mesh", assets=["orthophoto.tif"])
        response = self.client_for("testuser").post(self.links_api(), {"expires_days": "30"}, content_type="application/json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual([call.args[3] for call in self.queued.call_args_list], [tiles.folder(self.mesh_task)])

    def test_a_link_is_made_even_when_queuing_fails(self):
        with mock.patch.object(self.store, "prepare", side_effect=RuntimeError("boom")):
            response = self.client_for("testuser").post(self.links_api(), {}, content_type="application/json")
        self.assertEqual(response.status_code, 201)

    def test_a_task_completed_in_a_shared_project_is_queued_and_a_removed_one_loses_its_tiles(self):
        signals.task_completed.send_robust(sender=Task, task_id=self.mesh_task.id)
        self.queued.assert_not_called()  # not shared yet
        self.link()
        signals.task_completed.send_robust(sender=Task, task_id=self.mesh_task.id)
        self.assertEqual(self.queued.call_count, 1)
        self.ready()
        tiles_folder = tiles.folder(self.mesh_task)
        self.assertTrue(os.path.isdir(tiles_folder))
        self.mesh_task.delete()  # WebODM removes the task's folder, the tiles with it
        self.assertFalse(os.path.exists(tiles_folder))

    def test_a_tile_removed_between_its_check_and_its_read_is_a_404(self):
        build_id = self.ready()
        self.token = self.link()["token"]
        url = f"/api/plugins/explorer/s/{self.token}/tasks/{self.mesh_task.id}/tiles/{build_id}/LOD-0/a.glb"
        real_open = open
        def vanished(path, *args, **kwargs):
            if str(path).endswith("a.glb"):
                raise FileNotFoundError(path)
            return real_open(path, *args, **kwargs)
        with mock.patch("builtins.open", vanished):
            self.assertEqual(self.client.get(url).status_code, 404)

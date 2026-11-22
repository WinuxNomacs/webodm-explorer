"""
Mesh tiles on the web side: which build a link's 3D page streams, and queuing builds (tiles_build.py has the build
and its saved state). Builds are queued the first time a mesh is shared or opened: when a link is created, when a
task of a shared project completes, and when a 3D page finds no tiles. Nothing waits on a build: until it is ready,
the page shows WebODM's GLB.
"""
import logging
import os

from app.plugins.functions import get_current_plugin
from app.plugins.worker import run_function_async

from . import links
from . import tiles_build as build

logger = logging.getLogger("app.logger")

MESH = ("odm_texturing", "odm_textured_model_geo.obj")
# A build that couldn't be queued (the broker down) is tried again sooner than one that failed
QUEUE_RETRY = 300


def build_tiles(module_path, root, task_id, obj_path, tools_dir):
    """Runs in the worker (run_function_async sends only this function's source): loads tiles_build by its path."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("explorer_tiles_build", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.run(root, task_id, obj_path, tools_dir)


class Tiles:
    """The plugin's tiles: root is <persistent path>/tiles, tools the plugin's bin/ folder."""

    def __init__(self, root, tools):
        self.root = root
        self.tools = tools

    @classmethod
    def current(cls):
        """For the active plugin, or None when it isn't active (signals fire whether or not it is)."""
        plugin = get_current_plugin(only_active=True)
        return cls(plugin.get_persistent_path("tiles"), plugin.get_path("bin")) if plugin else None

    def tileset(self, task):
        """(build id, preparing) for a task's 3D page: the build to stream, or None and whether one is on its way."""
        obj = task.assets_path(*MESH)
        try:
            fp = build.fingerprint(obj)
        except OSError:
            return None, False
        try:
            action, build_id = build.claim(self.root, task.id, fp, obj=obj)
        except OSError as e:
            logger.warning(f"Explorer: the mesh tiles state of task {task.id} can't be read or written: {e}")
            return None, False
        if action == "queue":
            self.enqueue(task, obj, fp)
        return build_id, action in ("queue", "building")

    def enqueue(self, task, obj, fp):
        try:
            run_function_async(build_tiles, build.__file__, self.root, str(task.id), obj, self.tools)
        except Exception as e:  # noqa: BLE001 - the broker can fail in many ways; the page carries on with the GLB
            logger.warning(f"Explorer: could not queue the mesh tiles of task {task.id}: {e}")
            try:
                build.mark_failed(self.root, task.id, fp, f"could not queue: {e}", retry_after=QUEUE_RETRY)
            except OSError:
                pass

    def prepare(self, tasks):
        """Queues the builds of tasks with a mesh and no tiles (a new link, a task completed in a shared project)."""
        for task in tasks:
            if os.path.isfile(task.assets_path(*MESH)):
                self.tileset(task)

    def remove(self, task_id):
        build.remove(self.root, task_id)

    def file(self, task_id, build_id, path):
        return build.tile_file(self.root, task_id, build_id, path)


def project_is_shared(project_id):
    return bool(links.list_links(project_id))

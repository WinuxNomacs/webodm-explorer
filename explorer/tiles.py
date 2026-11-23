"""
Mesh tiles on the web side: which build a link's 3D page streams, and queuing builds (tiles_build.py has the build
and its saved state). Builds are queued the first time a mesh is shared or opened: when a link is created, when a
task of a shared project completes, and when a 3D page finds no tiles. Nothing waits on a build: until it is ready,
the page shows WebODM's GLB.
"""
import glob
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


def build_tiles(module_path, work, folder, obj_path, tools_dir, folders):
    """Runs in the worker (run_function_async sends only this function's source): loads tiles_build by its path."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("explorer_tiles_build", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.run(work, folder, obj_path, tools_dir, folders)


def folder(task):
    """The task's tiles folder, in its own folder in WebODM's media (tiles_build.py)."""
    return task.task_path(build.FOLDER)


def folders_pattern(task):
    """Every task's tiles folder, as a glob pattern: this task's, with its project and task ids as wildcards."""
    parts = os.path.normpath(folder(task)).split(os.sep)
    ids = {str(task.id), str(task.project_id)}
    return os.sep.join("*" if part in ids else glob.escape(part) for part in parts)


class Tiles:
    """The plugin's tiles: work is <persistent path>/tiles (the build lock), tools the plugin's bin/ folder."""

    def __init__(self, work, tools):
        self.work = work
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
            action, build_id = build.claim(folder(task), fp, obj=obj)
        except OSError as e:
            logger.warning(f"Explorer: the mesh tiles state of task {task.id} can't be read or written: {e}")
            return None, False
        if action == "queue":
            self.enqueue(task, obj, fp)
        return build_id, action in ("queue", "building")

    def enqueue(self, task, obj, fp):
        try:
            run_function_async(build_tiles, build.__file__, self.work, folder(task), obj, self.tools,
                               folders_pattern(task))
        except Exception as e:  # noqa: BLE001 - the broker can fail in many ways; the page carries on with the GLB
            logger.warning(f"Explorer: could not queue the mesh tiles of task {task.id}: {e}")
            try:
                build.mark_failed(folder(task), fp, f"could not queue: {e}", retry_after=QUEUE_RETRY)
            except OSError:
                pass

    def prepare(self, tasks):
        """Queues the builds of tasks with a mesh and no tiles (a new link, a task completed in a shared project)."""
        for task in tasks:
            if os.path.isfile(task.assets_path(*MESH)):
                self.tileset(task)

    def file(self, task, build_id, path):
        return build.tile_file(folder(task), build_id, path)


def project_is_shared(project_id):
    """Whether the project has links that work: blocked links (Links for Public Projects Only) get no builds."""
    return bool(links.list_links(project_id)) and int(project_id) in links.links_work([project_id])

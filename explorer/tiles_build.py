"""
A task's textured mesh as 3D Tiles, built on demand in WebODM's worker (upcoming-changes.md, "Plan: on-demand mesh
tiling and 3D Tiles"): Obj2Tiles cuts ODM's OBJ into tiles with levels of detail and KTX2 textures, then gltfpack
compresses each tile's geometry and simplifies the root, so the first view is light.

Standard library only and no relative imports: run_function_async sends only a function's source to the worker,
which loads this file by its path (tiles.build_tiles). The web side (tiles.py) imports it for the saved state.

Each task has a folder in the plugin's persistent path, <root>/<task id>/:
- state.json: {state: queued | building | ready | failed, fingerprint (the OBJ's size and time), build (the ready
  build's id), updated, heartbeat (building), error and retry_after (failed)}, changed only under .lock;
- <build id>/: a finished build (tileset.json and its tiles), its id derived from the fingerprint and PIPELINE, so a
  URL's content never changes and browsers may keep it;
- .tmp-<build id>/: a build in progress, renamed to <build id> once read back, removed on failure.
<root>/.build.lock is held by the one build running at a time.
"""
import contextlib
import fcntl
import hashlib
import json
import logging
import os
import platform
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("app.logger")

# Bumped when the tools or their options change: a new build id, so no browser keeps tiles of the old build
PIPELINE = 3
# Octree tiles, decimated levels of detail with textures halved per coarser level, KTX2 textures, unlit (the
# textures are baked photographs), local coordinates (the OBJ's, as WebODM's GLB), machine-readable progress
OBJ2TILES_ARGS = ["--preset", "standard", "--local", "--glb", "--unlit", "--progress", "--texture-format", "Ktx2"]
# gltfpack: meshopt geometry compression and quantization; textures and materials kept as Obj2Tiles made them
GLTFPACK_ARGS = ["-cc", "-kn", "-km"]
# The root tile is what a visitor loads first: a quarter of its faces (1.25 MB instead of 12 MB on the user's
# 831k-face mesh), and its geometric error raised to match (edges about twice as long)
ROOT_SIMPLIFY = "0.25"
ROOT_ERROR_FACTOR = 2.0

STALL_SECONDS = 600  # no output from a tool for this long: it hangs
KILL_GRACE = 30  # SIGTERM, then SIGKILL after this
DEADLINE_BASE = 900  # a whole Obj2Tiles run: this plus DEADLINE_PER_FACE per face (60 s measured for 831k faces)
DEADLINE_PER_FACE = 0.002
PACK_TIMEOUT = 120  # one gltfpack run (0.3 s measured for the biggest root)
PACK_WORKERS = 4
HEARTBEAT_EVERY = 10
HEARTBEAT_STALE = STALL_SECONDS + 120  # a build whose heartbeat is older was abandoned (the worker restarted)
# A build queued this long is queued again: its job may have been lost (a worker restart, the broker flushed). Queuing
# again is harmless: a job that finds another build running leaves its task queued and ends at once.
QUEUE_STALE = 15 * 60
RETRY_FAILED = 24 * 3600
SPACE_FACTOR = 2  # free space needed: this times the OBJ's folder

STATES = ("queued", "building", "ready", "failed")
BUILD_ID = re.compile(r"^[0-9a-f]{16}$")
TASK_ID = re.compile(r"^[0-9a-fA-F-]{36}$")


SILENCE = object()  # run_tool: a second without output


class BuildError(Exception):
    pass


def task_dir(root, task_id):
    task_id = str(task_id)
    if not TASK_ID.match(task_id):
        raise ValueError("task id")
    return os.path.join(root, task_id)


@contextlib.contextmanager
def task_lock(root, task_id):
    """The task's state lock (a short critical section: reading and writing state.json)."""
    folder = task_dir(root, task_id)
    os.makedirs(folder, exist_ok=True)
    fd = os.open(os.path.join(folder, ".lock"), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def read_state(root, task_id):
    """The saved state, or None. A state file that doesn't read is set aside (renamed), never fatal."""
    path = os.path.join(task_dir(root, task_id), "state.json")
    try:
        with open(path) as f:
            state = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        state = None
    if isinstance(state, dict) and state.get("state") in STATES and isinstance(state.get("fingerprint"), str) \
            and isinstance(state.get("updated"), (int, float)):
        return state
    logger.warning(f"Explorer: the mesh tiles state of task {task_id} doesn't read; set aside")
    with contextlib.suppress(OSError):
        os.replace(path, path + ".bad")
    return None


def write_state(root, task_id, state):
    folder = task_dir(root, task_id)
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, "state.json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, os.path.join(folder, "state.json"))


def fingerprint(obj_path):
    st = os.stat(obj_path)
    return f"{st.st_size}-{st.st_mtime_ns}"


def build_id(fp):
    return hashlib.sha256(f"{PIPELINE}:{fp}".encode()).hexdigest()[:16]


def decide(state, fp, now, built=lambda build: True):
    """
    What to do for a request: ("ready", build id), ("building", None) while one is queued or running,
    ("failed", None) until it may be tried again, or ("queue", None).
    """
    if state is None:
        return "queue", None
    same = state["fingerprint"] == fp
    age = now - state["updated"]
    if state["state"] == "ready":
        build = state.get("build")
        # A build of an older pipeline is replaced too
        return ("ready", build) if same and build == build_id(fp) and built(build) else ("queue", None)
    if state["state"] == "queued":
        return ("building", None) if same and age < QUEUE_STALE else ("queue", None)
    if state["state"] == "building":
        beat = state.get("heartbeat", state["updated"])
        return ("building", None) if same and now - beat < HEARTBEAT_STALE else ("queue", None)
    retry = state.get("retry_after", RETRY_FAILED)
    return ("failed", None) if same and age < retry else ("queue", None)


def claim(root, task_id, fp, now=None, obj=None):
    """
    decide() under the task's lock; a "queue" answer is saved as queued, so only one caller queues the build. obj (the
    mesh's path) is kept with it, so the build running when this one is queued can take it next (run()).
    """
    now = time.time() if now is None else now
    folder = task_dir(root, task_id)
    with task_lock(root, task_id):
        action = decide(read_state(root, task_id), fp, now,
                        lambda build: os.path.isfile(os.path.join(folder, build, "tileset.json")))
        if action[0] == "queue":
            state = {"state": "queued", "fingerprint": fp, "updated": now}
            if obj:
                state["obj"] = obj
            write_state(root, task_id, state)
        return action


def mark_failed(root, task_id, fp, error, retry_after=RETRY_FAILED):
    with task_lock(root, task_id):
        write_state(root, task_id, {"state": "failed", "fingerprint": fp, "updated": time.time(),
                                    "error": str(error)[:500], "retry_after": retry_after})


def remove(root, task_id):
    """The task's tiles and state, once the task is removed. A build still running fails when its folder goes."""
    shutil.rmtree(task_dir(root, task_id), ignore_errors=True)


def tile_file(root, task_id, build, path):
    """The file a tile URL names, or None: only inside a finished build, only tile files, no way out of it."""
    if not (isinstance(build, str) and BUILD_ID.match(build) and isinstance(path, str)):
        return None
    if not re.match(r"^[A-Za-z0-9_\-]+(/[A-Za-z0-9_\-]+)*\.(json|glb)$", path):
        return None
    base = os.path.realpath(os.path.join(task_dir(root, task_id), build))
    full = os.path.realpath(os.path.join(base, path))
    if os.path.commonpath([base, full]) != base or not os.path.isfile(full):
        return None
    return full


# The worker side

def run_tool(cmd, deadline, on_line=None, stall=None, cwd=None):
    """
    Runs a tool with a deadline and a stall limit (no output for `stall` seconds), stopping it with SIGTERM, then
    SIGKILL; returns (exit code, last output lines). BuildError when it was stopped.
    """
    stall = STALL_SECONDS if stall is None else stall
    lines = queue.Queue()
    # At the lowest CPU priority: a build must not slow the web server's pages and tiles
    nice = shutil.which("nice")
    proc = subprocess.Popen(([nice, "-n", "19"] if nice else []) + cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            text=True, errors="replace", start_new_session=True, cwd=cwd)

    def read():
        for line in proc.stdout:
            lines.put(line.rstrip("\n"))
        lines.put(None)

    threading.Thread(target=read, daemon=True).start()
    tail = []
    start = last = time.monotonic()
    reason = None
    try:
        while True:
            try:
                line = lines.get(timeout=1)
            except queue.Empty:
                line = SILENCE
            if line is None:  # the tool closed its output: it has finished
                break
            now = time.monotonic()
            # Checked on every line too: a tool that keeps writing past its deadline is stopped all the same
            if now - start > deadline:
                reason = f"took over {int(deadline)} s"
            elif line is SILENCE and now - last > stall:
                reason = f"no progress for {int(stall)} s"
            if reason:
                break
            if line is SILENCE:
                continue
            last = now
            tail = (tail + [line])[-20:]
            if on_line:
                on_line(line)
    finally:
        if reason or proc.poll() is None:
            stop(proc)
    if reason:
        raise BuildError(f"{os.path.basename(cmd[0]) if cmd[0] != 'node' else 'gltfpack'} {reason}")
    return proc.wait(), tail


def stop(proc):
    for sig, wait in ((signal.SIGTERM, KILL_GRACE), (signal.SIGKILL, 10)):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, sig)
        try:
            proc.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def executable(tool, root):
    """
    The tool, executable. WebODM installs a plugin with zipfile, which drops the executable bit: set it again, or
    where the plugin folder can't be changed, run a copy kept in the persistent path.
    """
    if os.access(tool, os.X_OK):
        return tool
    with contextlib.suppress(OSError):
        os.chmod(tool, 0o755)
        if os.access(tool, os.X_OK):
            return tool
    copy_dir = os.path.join(root, ".bin", os.path.basename(os.path.dirname(tool)))
    os.makedirs(copy_dir, exist_ok=True)
    for name in os.listdir(os.path.dirname(tool)):  # its libktx.so too
        shutil.copy2(os.path.join(os.path.dirname(tool), name), os.path.join(copy_dir, name))
    copy = os.path.join(copy_dir, os.path.basename(tool))
    os.chmod(copy, 0o755)
    return copy


def count_faces(obj_path):
    faces = 0
    with open(obj_path, "rb") as f:
        for line in f:
            if line.startswith(b"f "):
                faces += 1
    return faces


def folder_size(path):
    total = 0
    for entry in os.scandir(path):
        if entry.is_file(follow_symlinks=False):
            total += entry.stat().st_size
    return total


def content_uris(tile):
    """Every content URI in a tileset's tile tree."""
    stack = [tile]
    while stack:
        node = stack.pop()
        content = node.get("content")
        if isinstance(content, dict) and isinstance(content.get("uri"), str):
            yield content["uri"]
        # Obj2Tiles 1.10.3 writes "children": null on leaves
        stack.extend(child for child in node.get("children") or [] if isinstance(child, dict))


def run(root, task_id, obj_path, tools_dir, now=time.time):
    """
    A build job, as the worker runs it: one build at a time, and no job waits for another, so builds never hold
    WebODM's worker slots (its processing and scheduled jobs share them). A job that finds a build running leaves its
    task queued and ends; the running job builds every queued task before it ends, and looks again after letting go
    of the lock, so a task queued meanwhile is never left behind. Returns a JSON-serialisable summary of the first
    build; never raises for a build failure.
    """
    summary = None
    job = (str(task_id), obj_path)
    tried = set()
    while True:
        fd = try_build_lock(root)
        if fd is None:
            return summary or {"state": "queued", "deferred": True}
        try:
            while job:
                tried.add(job[0])
                result = build_one(root, job[0], job[1], tools_dir, now)
                summary = summary or result
                job = next_queued(root, tried)
        finally:
            os.close(fd)
        job = next_queued(root, tried)
        if job is None:
            return summary


def try_build_lock(root):
    """<root>/.build.lock if no other build holds it, else None."""
    os.makedirs(root, exist_ok=True)
    fd = os.open(os.path.join(root, ".build.lock"), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BlockingIOError:
        os.close(fd)
        return None


def next_queued(root, tried=()):
    """The task queued longest whose mesh path was saved with it, as (task id, mesh path), or None."""
    found = []
    with contextlib.suppress(OSError):
        for entry in os.listdir(root):
            if not TASK_ID.match(entry) or entry in tried:
                continue
            with contextlib.suppress(OSError, ValueError):
                state = read_state(root, entry)
                if state and state["state"] == "queued" and isinstance(state.get("obj"), str):
                    found.append((state["updated"], entry, state["obj"]))
    if not found:
        return None
    _updated, entry, obj = min(found)
    return entry, obj


def build_one(root, task_id, obj_path, tools_dir, now=time.time):
    """One task's build, with the build lock held."""
    folder = task_dir(root, task_id)
    try:
        fp = fingerprint(obj_path)
    except OSError:
        remove(root, task_id)  # the mesh is gone: the task was removed or reprocessed without one
        return {"state": "gone"}
    build = build_id(fp)
    with task_lock(root, task_id):
        state = read_state(root, task_id)
        if state and state["fingerprint"] == fp and (
                (state["state"] == "ready" and state.get("build") == build
                 and os.path.isfile(os.path.join(folder, build, "tileset.json")))
                or (state["state"] == "building" and now() - state.get("heartbeat", 0) < HEARTBEAT_STALE)):
            return {"state": state["state"], "skipped": True}
        write_state(root, task_id, {"state": "building", "fingerprint": fp, "updated": now(), "heartbeat": now()})

    last_beat = [0.0]

    def beat(progress=None, force=False):
        if not force and now() - last_beat[0] < HEARTBEAT_EVERY:
            return
        last_beat[0] = now()
        with contextlib.suppress(OSError), task_lock(root, task_id):
            current = read_state(root, task_id)
            if current is None or current["state"] != "building" or current["fingerprint"] != fp:
                return
            current["heartbeat"] = now()
            if progress is not None:
                current["progress"] = progress
            write_state(root, task_id, current)

    tmp = os.path.join(folder, ".tmp-" + build)
    try:
        started = time.monotonic()
        build_into(tmp, obj_path, tools_dir, root, beat)
        if not os.path.isfile(obj_path) or fingerprint(obj_path) != fp:
            raise BuildError("the mesh changed during the build")
        final = os.path.join(folder, build)
        shutil.rmtree(final, ignore_errors=True)
        os.replace(os.path.join(tmp, "tiles"), final)
        with task_lock(root, task_id):
            write_state(root, task_id, {"state": "ready", "fingerprint": fp, "build": build, "updated": now()})
        for entry in os.listdir(folder):
            if BUILD_ID.match(entry) and entry != build:
                shutil.rmtree(os.path.join(folder, entry), ignore_errors=True)
        seconds = round(time.monotonic() - started)
        logger.info(f"Explorer: built the mesh tiles of task {task_id} in {seconds} s")
        return {"state": "ready", "build": build, "seconds": seconds}
    except Exception as e:  # noqa: BLE001 - every failure is recorded, and the worker carries on
        message = str(e) if isinstance(e, BuildError) else f"{type(e).__name__}: {e}"
        if not os.path.isfile(obj_path):
            remove(root, task_id)
            return {"state": "gone"}
        logger.warning(f"Explorer: the mesh tiles of task {task_id} could not be built: {message}")
        with contextlib.suppress(OSError):
            mark_failed(root, task_id, fp, message)
        return {"state": "failed", "error": message}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_into(tmp, obj_path, tools_dir, root, beat):
    arch = platform.machine()
    if arch not in ("x86_64", "aarch64"):
        raise BuildError(f"no Obj2Tiles build for this platform ({arch})")
    obj2tiles = os.path.join(tools_dir, "obj2tiles", f"linux-{arch}", "Obj2Tiles")
    gltfpack = os.path.join(tools_dir, "gltfpack", "cli.js")
    node = shutil.which("node")
    if not os.path.isfile(obj2tiles) or not os.path.isfile(gltfpack):
        raise BuildError("the mesh tiling tools are missing from the plugin")
    if node is None:
        raise BuildError("Node.js is not installed (WebODM's image has it)")
    obj2tiles = executable(obj2tiles, root)

    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    need = SPACE_FACTOR * folder_size(os.path.dirname(obj_path))
    free = shutil.disk_usage(tmp).free
    if free < need:
        raise BuildError(f"not enough disk space ({free // 2**20} MB free, {need // 2**20} MB needed)")

    faces = count_faces(obj_path)
    out = os.path.join(tmp, "tiles")
    errors = []

    def progress(line):
        beat()  # any output keeps the build alive (beat() writes at most every HEARTBEAT_EVERY)
        if not line.startswith("{"):
            return
        with contextlib.suppress(ValueError):
            event = json.loads(line)
            if event.get("stage") == "error":
                errors.append(str(event.get("message", "error")))
            elif isinstance(event.get("percent"), (int, float)):
                beat(progress=round(0.8 * event["percent"]))

    code, tail = run_tool([obj2tiles, *OBJ2TILES_ARGS, obj_path, out], DEADLINE_BASE + DEADLINE_PER_FACE * faces,
                          progress, cwd=tmp)
    if errors or code != 0:
        raise BuildError("Obj2Tiles: " + (errors[-1] if errors else f"exit {code}: " + " / ".join(tail[-3:])))
    tileset_path = os.path.join(out, "tileset.json")
    with open(tileset_path) as f:
        tileset = json.load(f)

    tiles = []
    for folder, _dirs, files in os.walk(out):
        tiles.extend(os.path.join(folder, name) for name in files if name.endswith(".glb"))
    done = [0]
    lock = threading.Lock()

    def pack(path):
        packed = path + ".packed.glb"
        args = GLTFPACK_ARGS + (["-si", ROOT_SIMPLIFY] if path == os.path.join(out, "root.glb") else [])
        code, tail = run_tool([node, gltfpack, "-i", path, "-o", packed, *args], PACK_TIMEOUT, stall=PACK_TIMEOUT)
        if code != 0 or not os.path.isfile(packed):
            raise BuildError(f"gltfpack: exit {code} on {os.path.relpath(path, out)}: " + " / ".join(tail[-2:]))
        os.replace(packed, path)
        with lock:
            done[0] += 1
            beat(progress=80 + round(19 * done[0] / len(tiles)))

    with ThreadPoolExecutor(max_workers=PACK_WORKERS) as pool:
        for future in [pool.submit(pack, path) for path in tiles]:
            future.result()

    root_tile = tileset.get("root")
    if not isinstance(root_tile, dict):
        raise BuildError("Obj2Tiles wrote a tileset without a root")
    if (root_tile.get("content") or {}).get("uri") == "root.glb":
        for holder in (root_tile, tileset):
            if isinstance(holder.get("geometricError"), (int, float)):
                holder["geometricError"] *= ROOT_ERROR_FACTOR
    # Read back: every tile the tileset names exists inside the build
    uris = list(content_uris(root_tile))
    if not uris:
        raise BuildError("Obj2Tiles wrote a tileset without tiles")
    for uri in uris:
        full = os.path.realpath(os.path.join(out, uri))
        if os.path.commonpath([os.path.realpath(out), full]) != os.path.realpath(out) or not os.path.isfile(full):
            raise BuildError(f"the tileset names a missing tile: {uri}")
    with open(tileset_path + ".tmp", "w") as f:
        json.dump(tileset, f)
    os.replace(tileset_path + ".tmp", tileset_path)

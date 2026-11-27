"""
Measurements on a task's map page (upcoming-changes.md, "Plan: measurement tools"). Lengths and areas are measured in
the browser (GeographicLib, public/measure.js); volume is WebODM's own, through its Measure plugin's views
(`coreplugins/measure`, an exception the user allowed: CLAUDE.md); this module reads the elevations under a point,
which WebODM has no view for, and keeps the cap on the volume jobs a link's visitors run at once.
"""
import hashlib
import math
import os

from django.core.cache import cache

# How many volume jobs one link's visitors can run at once, and how long a job holds its place at most: a job that
# never finishes (the worker down) frees its place by itself; the page stops waiting at the same time
VOLUME_JOBS_PER_LINK = 3
VOLUME_SECONDS = 120
MEASURE_PLUGIN = "measure"
ELEVATIONS = (("dsm", "dsm.tif"), ("dtm", "dtm.tif"))


class CapUnavailable(Exception):
    """The cache that keeps the cap can't be reached: a link's visitors get no volume (the cap fails closed)."""


def measure_active():
    """Whether WebODM's Measure plugin is enabled: its volume is offered only then (WebODM's API answers 404 if not)."""
    try:
        from app.plugins.functions import get_plugin_by_name
        return get_plugin_by_name(MEASURE_PLUGIN) is not None
    except Exception:  # noqa: BLE001 - the plugin registry unreadable: no volume, never a broken page
        return False


def elevation_assets(task):
    """The elevation rasters a task has, of "dsm" and "dtm"."""
    assets = task.available_assets or []
    return [kind for kind, asset in ELEVATIONS if asset in assets]


def read_elevation(path, lng, lat):
    """The raster's value under a WGS84 point, in its own units (ODM's DEMs are in metres), or None: outside the
    raster, on its nodata, or a file that can't be read."""
    if not os.path.isfile(path):
        return None
    try:
        import numpy
        import rasterio
        from pyproj import Transformer
        with rasterio.open(path) as dem:
            if dem.crs is None:
                return None
            x, y = Transformer.from_crs("EPSG:4326", dem.crs.to_wkt(), always_xy=True).transform(lng, lat)
            left, bottom, right, top = dem.bounds
            if not (left <= x <= right and bottom <= y <= top):
                return None
            sample = next(dem.sample([(x, y)], masked=True))
            if numpy.ma.is_masked(sample[0]):
                return None
            value = float(sample[0])
    except Exception:  # noqa: BLE001 - a broken or half-written raster: that value is missing, never an error page
        return None
    return value if math.isfinite(value) else None


def elevations(task, lng, lat):
    """{"dsm": metres or None, "dtm": ...} for the rasters the task has, under the point."""
    folder = ("odm_dem",)
    return {kind: read_elevation(task.assets_path(*folder, f"{kind}.tif"), lng, lat) for kind in elevation_assets(task)}


def grid_scale(task, offset):
    """
    The task's projected grid's scale factor at WebODM's offset (the 3D models' origin, near their middle), from
    pyproj: the 3D page divides horizontal lengths by it, so they are lengths on the ground, as the map's geodesics
    (UTM's is 0.9996 on its central meridian, about 1.001 at a zone's edge). 1.0 when unknown (no CRS or offset).
    Across one task it varies by far less than a millimetre per kilometre.
    """
    if not task.epsg or not offset:
        return 1.0
    try:
        from pyproj import CRS, Proj, Transformer
        x, y = (float(v) for v in offset.split()[:2])
        lng, lat = Transformer.from_crs(f"EPSG:{task.epsg}", "EPSG:4326", always_xy=True).transform(x, y)
        scale = float(Proj(CRS.from_epsg(task.epsg)).get_factors(lng, lat).meridional_scale)
    except Exception:  # noqa: BLE001 - an unknown CRS: lengths in the grid, uncorrected
        return 1.0
    return scale if math.isfinite(scale) and 0.9 < scale < 1.1 else 1.0


def parse_point(query):
    """(lng, lat) from a request's query (?lng=&lat=), or None."""
    try:
        lng, lat = float(query.get("lng", "")), float(query.get("lat", ""))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lng) and math.isfinite(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
        return None
    return lng, lat


def _slot_keys(token):
    digest = hashlib.sha256(token.encode()).hexdigest()[:24]
    return [f"explorer-volume-{digest}-{i}" for i in range(VOLUME_JOBS_PER_LINK)]


def claim_slot(token):
    """One of the link's places for a volume job, or None when all are taken. cache.add is atomic (Redis), so two
    visitors never take the same place; a place expires after VOLUME_SECONDS whatever happens to its job."""
    try:
        for key in _slot_keys(token):
            if cache.add(key, "starting", VOLUME_SECONDS):
                return key
    except Exception as e:  # Redis down
        raise CapUnavailable() from e
    return None


def hold_slot(key, job_id):
    """The place now names its job, so the job's result frees it."""
    try:
        cache.set(key, job_id, VOLUME_SECONDS)
    except Exception:  # noqa: BLE001, S110 - the place still expires by itself
        pass


def release_slot(token, job_id=None, key=None):
    """Frees the place of a job (once its result is in), or a given place (the job never started)."""
    try:
        if key is not None:
            cache.delete(key)
            return
        for slot in _slot_keys(token):
            if job_id is not None and cache.get(slot) == job_id:
                cache.delete(slot)
                return
    except Exception:  # noqa: BLE001, S110 - the place still expires by itself
        pass

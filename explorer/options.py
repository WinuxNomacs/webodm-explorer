"""
Explorer's settings, set by WebODM's admins on the Explorer page and kept in the plugin's GlobalDataStore:
- basemaps on links: the link and preview maps show the basemaps the admin configured in WebODM (on by default;
  decided 2026-11-21: a basemap sends visitors' map views to its provider, so an install can turn it off).
"""
from app.models import Basemap
from app.plugins.data_store import GlobalDataStore

from . import links

BASEMAPS_ON_LINKS = "settings:basemaps_on_links"


def store():
    return GlobalDataStore(links.NAMESPACE)


def basemaps_on_links():
    return store().get_bool(BASEMAPS_ON_LINKS, True)


def set_basemaps_on_links(value):
    store().set_bool(BASEMAPS_ON_LINKS, bool(value))


def all_settings():
    return {"basemaps_on_links": basemaps_on_links()}


def link_basemaps():
    """
    The basemaps a link's map offers, as WebODM's map gets them (an approved use of WebODM's Basemap model, the user,
    2026-11-21: no API lists them); none when the setting is off.
    """
    return Basemap.get_cached_basemaps() if basemaps_on_links() else []


def signed_in_basemaps():
    """
    The basemaps under the signed-in pages' maps (the home's and the project's): WebODM's own map shows them too
    (approved by the user, 2026-11-22).
    """
    return Basemap.get_cached_basemaps()

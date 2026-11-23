"""
Explorer's settings, set by WebODM's admins on the Explorer page and kept in the plugin's GlobalDataStore:
- basemaps on links: the link and preview maps show the basemaps the admin configured in WebODM (on by default;
  decided 2026-11-21: a basemap sends visitors' map views to its provider, so an install can turn it off).
- public address: the address the Share panel's link copies and embed code start with, for a WebODM reached through
  an internal address or an SSH tunnel (the user, 2026-11-22); empty means the browser's address.
- links for public projects only (links.py keeps it, as links.resolve reads it; the user, 2026-11-23).
"""
from urllib.parse import urlsplit

from app.models import Basemap
from app.plugins.data_store import GlobalDataStore

from . import links

BASEMAPS_ON_LINKS = "settings:basemaps_on_links"
PUBLIC_ADDRESS = "settings:public_address"


def store():
    return GlobalDataStore(links.NAMESPACE)


def basemaps_on_links():
    return store().get_bool(BASEMAPS_ON_LINKS, True)


def set_basemaps_on_links(value):
    store().set_bool(BASEMAPS_ON_LINKS, bool(value))


def public_address():
    return store().get_string(PUBLIC_ADDRESS, "")


def clean_public_address(value):
    """
    An address as scheme://host[:port], lower case, from what the admin typed: "" stays "" (the browser's address),
    a trailing slash is dropped. Raises ValueError for anything else: another scheme, a missing host, a user name or
    password, a path, a query or a fragment (Explorer's paths are added to it).
    """
    value = (value or "").strip()
    if not value:
        return ""
    try:
        parts = urlsplit(value)
        port = parts.port  # raises ValueError for a port that isn't a number
    except ValueError as e:
        raise ValueError("not an address") from e
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.path not in ("", "/") or parts.query or parts.fragment
            or "#" in value or "?" in value):
        raise ValueError("not an address")
    host = parts.hostname
    if ":" in host:
        host = f"[{host}]"  # an IPv6 address
    return f"{parts.scheme}://{host}" + (f":{port}" if port is not None else "")


def set_public_address(value):
    store().set_string(PUBLIC_ADDRESS, clean_public_address(value))


def all_settings():
    return {"basemaps_on_links": basemaps_on_links(), "public_address": public_address(),
            "public_projects_only": links.public_projects_only()}


def link_basemaps():
    """
    The basemaps a link's map offers, as WebODM's map gets them (an approved use of WebODM's Basemap model, the user,
    2026-11-21: no API lists them); none when the setting is off.
    """
    return Basemap.get_cached_basemaps() if basemaps_on_links() else []


def signed_in_basemaps():
    """
    The basemaps under the signed-in pages' maps (the home's, the project's and the user's own task maps, whatever
    Basemaps on Links says: the user, 2026-11-22): WebODM's own map shows them too (approved by the user, 2026-11-22).
    """
    return Basemap.get_cached_basemaps()

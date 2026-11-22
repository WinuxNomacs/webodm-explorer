"""
"Anyone with the link" shares (upcoming-changes.md, "Plan: anyone-with-the-link shares").

Links live in the plugin's global data store, which has no listing or locking:
- `links:<project id>` holds the project's links, a JSON list of {token, label, created, expires, created_by,
  downloads} (`downloads` is missing on links made before downloads existed, which means off);
- `token:<token>` holds the project id, to find a link from its token;
- `index:linked` holds the ids of the projects that have links (some may have only expired ones), for the Explorer
  home's Shared by Link filter. Links saved before it existed are found once, by reading every project's links.

Every write takes one transaction-scoped Postgres advisory lock (WebODM's Docker installs always run Postgres), so
a revoke and a create at the same moment can't bring a revoked link back. Reads take no lock: a link is valid
only while it is in its project's list and not expired, so a stale `token:` key leads nowhere.
"""
import logging
import secrets
from datetime import datetime, timedelta

from app.models import Project
from app.plugins.data_store import GlobalDataStore
from django.db import OperationalError, connection, transaction
from django.utils import timezone

logger = logging.getLogger("app.logger")

# The plugin's folder name, as WebODM names its data store (the same from coreplugins/ and app/media/plugins/)
NAMESPACE = __package__.split(".")[-1]
EXPIRY_CHOICES = (None, 7, 30, 90)  # days; None is never
DEFAULT_EXPIRY = 30
LABEL_MAX = 100
TOKEN_PATTERN = r"[A-Za-z0-9_-]{43}"  # secrets.token_urlsafe(32)
# One lock for every link write: writes are rare, and one lock can't deadlock. The number is arbitrary, chosen to
# stay clear of other users of advisory locks.
LOCK_ID = 0x45585054  # "EXPT"
LOCK_TIMEOUT = "5s"
EXPIRES_SOON_DAYS = 7


class LinkStoreBusy(Exception):
    """Another write held the lock past LOCK_TIMEOUT."""


def store():
    return GlobalDataStore(NAMESPACE)


def links_key(project_id):
    return f"links:{int(project_id)}"


def token_key(token):
    return f"token:{token}"


INDEX_KEY = "index:linked"


def _parse_time(value):
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("naive time")
    return parsed


def _valid_entry(entry):
    try:
        _parse_time(entry["expires"])
        return (isinstance(entry["token"], str) and isinstance(entry["label"], str)
                and _parse_time(entry["created"]) is not None and isinstance(entry.get("downloads", False), bool))
    except (KeyError, TypeError, ValueError):
        return False


def _read(project_id):
    """The project's links as saved, expired ones included; [] for an entry that doesn't parse (logged)."""
    value = store().get_json(links_key(project_id), None)
    if value is None:
        return []
    if not isinstance(value, list) or not all(_valid_entry(e) for e in value):
        logger.warning(f"Explorer: the share links saved for project {project_id} don't parse; treating them as "
                       "none until the next change replaces them")
        return []
    return value


def allows_downloads(link):
    return link.get("downloads") is True


def is_expired(link, now=None):
    expires = _parse_time(link["expires"])
    return expires is not None and expires <= (now or timezone.now())


def list_links(project_id):
    """The project's live links, newest first."""
    now = timezone.now()
    return sorted((link for link in _read(project_id) if not is_expired(link, now)),
                  key=lambda link: link["created"], reverse=True)


class _locked:
    """A transaction holding the link-write lock. LinkStoreBusy if it can't be had within LOCK_TIMEOUT."""

    def __enter__(self):
        self.atomic = transaction.atomic()
        self.atomic.__enter__()
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", [LOCK_ID])
        except OperationalError as e:
            self.atomic.__exit__(type(e), e, e.__traceback__)
            raise LinkStoreBusy() from e
        return self

    def __exit__(self, *exc):
        return self.atomic.__exit__(*exc)


def _write(project_id, links):
    """Saves the project's links without the expired ones, dropping the token keys of those that leave."""
    now = timezone.now()
    kept = [link for link in links if not is_expired(link, now)]
    data = store()
    kept_tokens = {link["token"] for link in kept}
    for link in links:
        if link["token"] not in kept_tokens:
            data.del_key(token_key(link["token"]))
    data.set_json(links_key(project_id), kept)
    _index(project_id, bool(kept))
    return kept


def _read_index():
    value = store().get_json(INDEX_KEY, None)
    if isinstance(value, list) and all(isinstance(i, int) for i in value):
        return value
    return None


def _index(project_id, linked):
    """Adds or removes the project in the index of linked projects; under the lock. A missing index stays missing."""
    ids = _read_index()
    if ids is None:
        return
    wanted = set(ids) | {int(project_id)} if linked else set(ids) - {int(project_id)}
    if wanted != set(ids):
        store().set_json(INDEX_KEY, sorted(wanted))


def _build_index():
    return [pk for pk in Project.objects.values_list("id", flat=True) if _read(pk)]


def linked_project_ids():
    """
    The ids of the projects that have live links. The index is built on first use (every project's links read once),
    under the lock so a link created meanwhile isn't left out; with the lock busy, the scan is used without saving.
    """
    ids = _read_index()
    if ids is None:
        try:
            with _locked():
                ids = _read_index()
                if ids is None:
                    ids = _build_index()
                    store().set_json(INDEX_KEY, ids)
        except LinkStoreBusy:
            ids = _build_index()
    return {pk for pk in ids if list_links(pk)}


def summary(project_id):
    """The project's live links in brief: how many, and whether one expires within EXPIRES_SOON_DAYS."""
    live = list_links(project_id)
    soon = timezone.now() + timedelta(days=EXPIRES_SOON_DAYS)
    return {"count": len(live),
            "expires_soon": any(link["expires"] and _parse_time(link["expires"]) <= soon for link in live)}


def create_link(project_id, label, expiry_days, user, downloads=False):
    """A new link for the project; expiry_days is one of EXPIRY_CHOICES."""
    if expiry_days not in EXPIRY_CHOICES:
        raise ValueError("expiry_days")
    if not isinstance(downloads, bool):
        raise TypeError("downloads")
    now = timezone.now()
    link = {
        "token": secrets.token_urlsafe(32),
        "label": (label or "").strip()[:LABEL_MAX],
        "created": now.isoformat(),
        "expires": (now + timedelta(days=expiry_days)).isoformat() if expiry_days else None,
        "created_by": user.id if user else None,
        "downloads": downloads,
    }
    with _locked():
        links = _read(project_id)
        links.append(link)
        _write(project_id, links)
        store().set_int(token_key(link["token"]), int(project_id))
    return link


def revoke_link(project_id, token):
    """Removes the link; False if the project has no such link."""
    with _locked():
        links = _read(project_id)
        remaining = [link for link in links if link["token"] != token]
        if len(remaining) == len(links):
            return False
        store().del_key(token_key(token))
        _write(project_id, remaining)
    return True


def set_downloads(project_id, token, downloads):
    """Allows or stops downloads through the link; the updated link, or None if the project has no such live link."""
    if not isinstance(downloads, bool):
        raise TypeError("downloads")
    with _locked():
        links = _read(project_id)
        link = next((link for link in links if link["token"] == token and not is_expired(link)), None)
        if link is None:
            return None
        link["downloads"] = downloads
        _write(project_id, links)
    return link


def project_for_token(token):
    """The project a live link opens, or None for an unknown, revoked or expired link or a removed project."""
    return resolve(token)[0]


def resolve(token):
    """(project, link) for a live link, or (None, None) for an unknown, revoked or expired link or a removed project."""
    if not isinstance(token, str) or len(token) != 43:
        return None, None
    project_id = store().get_int(token_key(token), None)
    if project_id is None:
        return None, None
    link = next((link for link in _read(project_id) if link["token"] == token), None)
    if link is None or is_expired(link):
        return None, None
    project = Project.objects.filter(pk=project_id, deleting=False).first()
    if project is None:
        # WebODM has no project-removed signal: the links of a removed project go when one of them is next used
        try:
            with _locked():
                for stale in _read(project_id):
                    store().del_key(token_key(stale["token"]))
                store().del_key(links_key(project_id))
                _index(project_id, False)
        except LinkStoreBusy:
            pass
        return None, None
    return project, link

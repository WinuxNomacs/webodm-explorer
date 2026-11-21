# Explorer

A plugin for [WebODM](https://github.com/WebODM/WebODM) 4.0 and later, to browse and share a project's outputs.
Under development.

## Features

- **Explorer** in the main menu lists the projects you can view. Each opens its Explorer page: a card per
  completed task with outputs, with a thumbnail and buttons that open WebODM's own views: **Map** (orthophoto, DSM,
  DTM), **Point Cloud**, **Textured Model** and **Gaussian Splats**. **View All on Map** shows the whole project.
- **Share** on a project's Explorer page shows and copies the page's link. It opens only for signed-in users the
  project is shared with (Dashboard: the project's Edit dialog, Permissions).
- **Anyone with the Link**, in the Share panel for users who can change the project: links that open the project
  without signing in, each with a label and an expiry (7, 30 or 90 days, or never), copied again or revoked at any
  time. A link opens a page of the project's tasks, each with a **Map** (orthophoto, DSM, DTM; no basemap) and a 3D
  view of its **Textured Model** and **Gaussian Splats**. A link serves only what these views stream, unless it has
  **Allow Downloads** (ticked when creating it, or on the link later): its task cards then get a **Download** menu
  with the orthophoto, DSM, DTM, point cloud (LAZ) and textured model (zip and glTF), but not the report, camera
  positions or All Assets. Links are kept in plain text in WebODM's database (so they can be copied again), and
  revoking one, or unticking Allow Downloads, takes effect at once.

## Install

When released: in WebODM, Administration > Plugins > Load Plugin (.zip), with `explorer-X.Y.Z.zip` from this
repository's releases.

## Development

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node.js 26 (`.nvmrc`), git.

```bash
git clone https://github.com/WebODM/WebODM ignored/WebODM && git -C ignored/WebODM switch --detach v4.0.1
uv venv --python 3.14 .venv && uv pip install -r requirements-dev.txt
npm install
dev/webodm.sh up        # WebODM 4.0.1 in dev mode on http://localhost:8008, with explorer/ mounted live
```

Checks:

```bash
.venv/bin/ruff check .
npm run lint
npm test
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
```

`dev/vendor.sh` fetches the pinned browser libraries (three.js, Spark, Leaflet) from npm into
`explorer/public/vendor/`. `dev/package.sh` builds the release zip `dist/explorer-X.Y.Z.zip` and prints its sha256.

## Licence

AGPL-3.0, see [LICENSE](LICENSE).

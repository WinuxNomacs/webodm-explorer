# Developing

Explorer is developed against a WebODM 4.0.1 dev stack in Docker, with the plugin folder mounted live.

## Setup

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node.js 26 (`.nvmrc`), git.

```bash
git clone https://github.com/WinuxNomacs/webodm-explorer && cd webodm-explorer
git clone https://github.com/WebODM/WebODM ignored/WebODM && git -C ignored/WebODM switch --detach v4.0.1
uv venv --python 3.14 .venv && uv pip install -r requirements-dev.txt
npm install
dev/tools.sh            # the mesh tiling tools, into explorer/bin/ (not committed)
dev/webodm.sh up        # WebODM 4.0.1 in dev mode on http://localhost:8008, with explorer/ mounted live
```

The first start runs WebODM's own setup for several minutes before the server answers. `dev/webodm.sh logs`,
`ps` and `down` follow, list and stop the stack. It runs beside other WebODMs (its own project name, volumes and
port).

## Layout

| Path | What it holds |
|---|---|
| `explorer/` | The plugin: the release zip's single folder |
| `explorer/public/` | Browser scripts (ES5) and `viewer/` (ES modules: the 3D viewer) |
| `explorer/public/vendor/` | Pinned browser libraries, fetched by `dev/vendor.sh` |
| `explorer/templates/` | The pages |
| `explorer/tests/` | Django tests, run in the dev stack |
| `dev/` | The dev stack, tool and vendor fetchers, packaging |
| `docs/` | This site (VitePress) |

`dev/vendor.sh` fetches the pinned browser libraries (three.js, Spark, Leaflet, laz-perf, 3DTilesRendererJS) from
npm into `explorer/public/vendor/`. `dev/tools.sh` fetches the mesh tiling tools
([Obj2Tiles](https://github.com/OpenDroneMap/Obj2Tiles) for Linux x64 and arm64, and
[gltfpack](https://github.com/zeux/meshoptimizer), run by the Node.js in WebODM's image) into `explorer/bin/`.

## Checks

```bash
.venv/bin/ruff check .
npm run lint
npm test
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests
npm run docs:build
```

Run one Django test run at a time: runs share the stack's test database. `npm run docs:build` fails on a dead
link; `npm run docs:dev` serves this site with live reload on localhost.

## Packaging

`dev/package.sh` fetches the tools and builds the release zip `dist/explorer-X.Y.Z.zip`, with its sha256. It is
installed through WebODM's **Administration > Plugins > Load Plugin (.zip)**.

## Documentation

The pages are Markdown in `docs/`. Screenshots show Explorer's interface only (panels, menus, settings) with neutral
names: never a map, orthophoto, mesh, point cloud or splat, and never a place name or coordinates.

## Licence

AGPL-3.0. Explorer is not part of WebODM.

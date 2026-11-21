# Explorer

A plugin for [WebODM](https://github.com/WebODM/WebODM) 4.0 and later. Under development: no features yet.

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
docker exec -w /webodm ex-webapp python manage.py test --noinput coreplugins.explorer.tests.test_explorer
```

`dev/package.sh` builds the release zip `dist/explorer-X.Y.Z.zip` and prints its sha256.

## Licence

AGPL-3.0, see [LICENSE](LICENSE).

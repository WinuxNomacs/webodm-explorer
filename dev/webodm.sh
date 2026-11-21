#!/usr/bin/env bash
# A WebODM checkout in dev mode, with this repo's plugin mounted (see dev/compose.yml).
#   [EX_GPU=auto|1|0] dev/webodm.sh up | down | logs [service] | ps | <any docker compose command>
# WebODM 4.0.1 (ignored/WebODM at tag v4.0.1): http://localhost:8008, livereload 35736, containers ex-webapp,
# ex-worker, ex-db, ex-broker, ex-node-odx-1, project and volumes webodm-explorer.
# The processing node uses the GPU when there is one (EX_GPU=auto, the default: an NVIDIA GPU that nvidia-smi lists
# and Docker's nvidia runtime); EX_GPU=0 runs it on the CPU, EX_GPU=1 asks for the GPU regardless.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"

# The images, pinned by digest: a tag can be pushed again, and a local `latest` tag can be another build (a fork's).
# Upgrading: move ignored/WebODM to the new tag, take the digests of its compose files' images
# (`docker buildx imagetools inspect <image>`), move them here, `dev/webodm.sh up`, run the tests.
webodm="$repo/ignored/WebODM" project=webodm-explorer EX_PREFIX=ex port=8008 livereload=35736
export EX_WEBAPP_IMAGE=webodm/webodm_webapp@sha256:29c6a79500ae40ef72a1a7f3827031f5c63743b8275dd543e28701e16ac6c508
export EX_DB_IMAGE=webodm/webodm_db@sha256:6d43e32ec24c388c5d5975bf6462d21abd6959af3c43d146a2473c1db4d5019c
export EX_BROKER_IMAGE=valkey/valkey@sha256:56729e68bdda139cbd3f6a2538683dc3523325fc5711ea1a379938f1b37893f0
export EX_NODE_IMAGE=webodm/nodeodx@sha256:e67e4cf4b2f7e2099c43d63c3e75287803bf57faf8fc2da6ab90ecbb38efd7d6
# WebODM's GPU node (webodm/nodeodx:gpu, NVIDIA only)
gpu_node_image=webodm/nodeodx@sha256:f881f6419ff023318948c61ef3b3bb61fc2a3f4eb45ea0de54f561cfe3c146de
case "${EX_GPU:=auto}" in
    auto) if nvidia-smi -L >/dev/null 2>&1 && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia
          then EX_GPU=1; else EX_GPU=0; fi ;;
    0|1) ;;
    *) echo "EX_GPU: auto, 1 or 0" >&2; exit 1 ;;
esac
if [ ! -d "$webodm" ]; then
    echo "No WebODM checkout at $webodm (CLAUDE.md, Dev environment, says how to make it)" >&2; exit 1
fi
export EX_PREFIX
export WO_PORT="${WO_PORT:-$port}" EX_LIVERELOAD_PORT="${EX_LIVERELOAD_PORT:-$livereload}"
export WO_HOST=localhost WO_DEBUG=YES WO_DEV=YES WO_BROKER=redis://broker WO_DEFAULT_NODES=1
export WO_MEDIA_DIR=appmedia WO_DB_DIR=dbdata WO_SECRET_KEY="${WO_SECRET_KEY:-}"
# EX_PLUGIN_DIR=<empty dir> runs WebODM without the mounted plugin (the release check installs the zip instead)
export EX_PLUGIN_DIR="${EX_PLUGIN_DIR:-$repo/explorer}"

compose=(docker compose -p "$project" --project-directory "$webodm"
         -f "$webodm/docker-compose.yml" -f "$webodm/docker-compose.dev.yml" -f "$repo/dev/compose.yml")
if [ "$EX_GPU" = 1 ]; then
    export EX_NODE_IMAGE="$gpu_node_image"
    compose+=(-f "$repo/dev/compose.gpu.yml")
fi

case "${1:-}" in
    # New anonymous volumes: the dev compose keeps the image's venv in one, which a new image must not reuse
    up) shift; exec "${compose[@]}" up -d --renew-anon-volumes "$@" ;;
    down) shift; exec "${compose[@]}" down --remove-orphans "$@" ;;
    logs) shift; exec "${compose[@]}" logs -f --tail 100 "$@" ;;
    "") sed -n '2,7p' "$0"; exit 1 ;;
    *) exec "${compose[@]}" "$@" ;;
esac

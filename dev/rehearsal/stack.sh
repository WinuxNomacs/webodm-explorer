#!/usr/bin/env bash
# A throwaway WebODM for release checks and upgrade rehearsals (the release-check skill): WebODM 4.0.1 as users run it
# (production settings, the image's own code, no plugin mounted), on http://127.0.0.1:8010 only, containers exr-*,
# project and volumes webodm-explorer-rehearsal, beside the dev stack (dev/webodm.sh), whose pinned images it uses.
#   dev/rehearsal/stack.sh up | down | logs [service] | ps | <any docker compose command>
# `down` keeps the volumes; `down -v` deletes them (the end of every rehearsal).
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
webodm="$repo/ignored/WebODM"
if [ ! -d "$webodm" ]; then
    echo "No WebODM checkout at $webodm (CLAUDE.md, Dev environment, says how to make it)" >&2; exit 1
fi
# The dev stack's pinned images (one place: dev/webodm.sh)
eval "$(grep -E '^export EX_(WEBAPP|DB|BROKER)_IMAGE=' "$repo/dev/webodm.sh")"
export EX_WEBAPP_IMAGE EX_DB_IMAGE EX_BROKER_IMAGE
export WO_PORT="${EX_REHEARSAL_PORT:-8010}" WO_HOST=localhost WO_DEBUG=NO WO_DEV=NO WO_BROKER=redis://broker
export WO_MEDIA_DIR=appmedia WO_DB_DIR=dbdata WO_SECRET_KEY="${WO_SECRET_KEY:-}" WO_DEFAULT_NODES=0

compose=(docker compose -p webodm-explorer-rehearsal --project-directory "$webodm"
         -f "$webodm/docker-compose.yml" -f "$repo/dev/rehearsal/compose.yml")
case "${1:-}" in
    up) shift; exec "${compose[@]}" up -d "$@" ;;
    down) shift; exec "${compose[@]}" down --remove-orphans "$@" ;;
    logs) shift; exec "${compose[@]}" logs -f --tail 100 "$@" ;;
    "") sed -n '2,6p' "$0"; exit 1 ;;
    *) exec "${compose[@]}" "$@" ;;
esac

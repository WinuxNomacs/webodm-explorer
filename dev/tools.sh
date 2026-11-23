#!/usr/bin/env bash
# Fetches the pinned tools the mesh tiling build runs in WebODM's worker (upcoming-changes.md, "Plan: on-demand mesh
# tiling and 3D Tiles", decision D3) into explorer/bin/, checking each download's sha256:
# - Obj2Tiles (OpenDroneMap, AGPL-3.0): its Linux x64 and arm64 release builds, each with its libktx.so;
# - gltfpack (meshoptimizer, MIT): its npm build, WebAssembly run by the Node.js WebODM's image ships.
# explorer/bin/ is not committed (about 60 MB of binaries); dev/package.sh runs this script and adds it to the zip.
# To upgrade: change a version and its sha256 below, run it, and test the build again.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

OBJ2TILES=1.10.3
OBJ2TILES_X64_SHA256=12594efb1e21f5a227aaf572224cd32ba1d276e086244635cca0cab04e8ea7fa
OBJ2TILES_ARM64_SHA256=c563de1fb2672b4c8dd7bd7803ce5b3fd9de6059bff4e7518eb910135a386f16
GLTFPACK=1.3.0
GLTFPACK_SHA256=56e6e7c435e347b32980767826ab425fdff2339ba3250c6e900f612460ae9839

bin="explorer/bin"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# fetch <url> <sha256> <file>
fetch() {
    curl -fsSL --retry 2 -o "$work/$3" "$1"
    local got
    got="$(shasum -a 256 "$work/$3" | cut -d' ' -f1)"
    if [ "$got" != "$2" ]; then
        echo "sha256 mismatch for $1: $got" >&2
        exit 1
    fi
}

release="https://github.com/OpenDroneMap/Obj2Tiles/releases/download/v$OBJ2TILES"
fetch "$release/Obj2Tiles-Linux64.zip" "$OBJ2TILES_X64_SHA256" x64.zip
fetch "$release/Obj2Tiles-LinuxArm64.zip" "$OBJ2TILES_ARM64_SHA256" arm64.zip
fetch "https://registry.npmjs.org/gltfpack/-/gltfpack-$GLTFPACK.tgz" "$GLTFPACK_SHA256" gltfpack.tgz

rm -rf "${bin:?}"
mkdir -p "$bin/obj2tiles/linux-x86_64" "$bin/obj2tiles/linux-aarch64" "$bin/gltfpack"
# Python's zipfile, so that no unzip tool is needed
python3 - "$work" "$bin/obj2tiles" <<'PY'
import os, sys, zipfile
work, dest = sys.argv[1], sys.argv[2]
for name, arch in (("x64.zip", "linux-x86_64"), ("arm64.zip", "linux-aarch64")):
    with zipfile.ZipFile(os.path.join(work, name)) as z:
        z.extractall(os.path.join(dest, arch))
PY
chmod 755 "$bin/obj2tiles/linux-x86_64/Obj2Tiles" "$bin/obj2tiles/linux-aarch64/Obj2Tiles"
curl -fsSL --retry 2 -o "$bin/obj2tiles/LICENSE.md" "$release/LICENSE.md"
curl -fsSL --retry 2 -o "$bin/obj2tiles/THIRD_PARTY_NOTICES.md" "$release/THIRD_PARTY_NOTICES.md"
echo "$OBJ2TILES" > "$bin/obj2tiles/VERSION"
# Obj2Tiles is AGPL-3.0: where the source of these builds is, for everyone the zip reaches (its section 6)
cat > "$bin/obj2tiles/SOURCE.md" <<SOURCE
# Obj2Tiles $OBJ2TILES: source

The Obj2Tiles programs in this folder are OpenDroneMap's own release builds of Obj2Tiles $OBJ2TILES, unmodified,
licensed under the GNU Affero General Public License 3.0 (LICENSE.md; the parts it includes: THIRD_PARTY_NOTICES.md).

- Release: https://github.com/OpenDroneMap/Obj2Tiles/releases/tag/v$OBJ2TILES
- Source: https://github.com/OpenDroneMap/Obj2Tiles/tree/v$OBJ2TILES
  (archive: https://github.com/OpenDroneMap/Obj2Tiles/archive/refs/tags/v$OBJ2TILES.tar.gz)

If those links stop working, ask Explorer's maintainers for the source through
https://github.com/WinuxNomacs/webodm-explorer/issues.
SOURCE

tar -xzf "$work/gltfpack.tgz" -C "$work"
cp "$work/package/cli.js" "$work/package/library.js" "$work/package/library.wasm" "$work/package/package.json" \
    "$work/package/LICENSE.md" "$bin/gltfpack/"

(cd "$bin" && find . -type f | sort | xargs shasum -a 256)

#!/usr/bin/env bash
# Fetches the pinned browser libraries from npm and copies the files Explorer's pages load, with each library's
# licence, into explorer/public/vendor/<lib>-<version>/ (decision D4 in upcoming-changes.md: vendored, prebuilt).
# Prints the sha256 of every vendored file. Run it again after changing a version below, and update the import map
# in explorer/templates/link_3d.html and the <script>/<link> tags in link_map.html to match (laz-perf: the paths in
# link_3d.html's data attributes).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

THREE=0.187.0
SPARK=2.4.0
LEAFLET=1.9.4
LAZPERF=0.0.7
TILES=0.5.4
# Only for their licence texts: three.js ships both minified in examples/jsm/libs without one
KTXPARSE=2.0.0
ZSTDDEC=0.3.4

vendor="explorer/public/vendor"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack --silent "three@$THREE" "@sparkjsdev/spark@$SPARK" "leaflet@$LEAFLET" "laz-perf@$LAZPERF" \
    "3d-tiles-renderer@$TILES" "ktx-parse@$KTXPARSE" "zstddec@$ZSTDDEC" >/dev/null)
for tgz in "$work"/*.tgz; do
    dir="${tgz%.tgz}"
    mkdir -p "$dir"
    tar -xzf "$tgz" -C "$dir"
done

# copy <package folder> <destination folder> <file>...: each file keeps its path below the package
copy() {
    local src="$1" dest="$2"
    shift 2
    for f in "$@"; do
        mkdir -p "$dest/$(dirname "$f")"
        cp "$src/$f" "$dest/$f"
    done
}

rm -rf "${vendor:?}"
mkdir -p "$vendor"

# three.js: the core, and the addons the viewer imports (GLTFLoader's own imports included). The glTF build of the
# Draco decoder, because WebODM's textured_model.glb requires KHR_draco_mesh_compression.
copy "$work/three-$THREE/package" "$vendor/three-$THREE" \
    LICENSE build/three.module.js build/three.core.js \
    examples/jsm/controls/OrbitControls.js \
    examples/jsm/loaders/GLTFLoader.js examples/jsm/loaders/DRACOLoader.js \
    examples/jsm/utils/BufferGeometryUtils.js examples/jsm/utils/SkeletonUtils.js \
    examples/jsm/postprocessing/Pass.js \
    examples/jsm/libs/draco/README.md \
    examples/jsm/libs/draco/gltf/draco_decoder.wasm examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js \
    examples/jsm/libs/draco/gltf/draco_decoder.js \
    examples/jsm/loaders/KTX2Loader.js examples/jsm/utils/WorkerPool.js examples/jsm/math/ColorSpaces.js \
    examples/jsm/libs/ktx-parse.module.js examples/jsm/libs/zstddec.module.js \
    examples/jsm/libs/basis/README.md examples/jsm/libs/basis/basis_transcoder.js \
    examples/jsm/libs/basis/basis_transcoder.wasm \
    examples/jsm/libs/meshopt_decoder.module.js
# The mesh tiles: KTX2 textures (Obj2Tiles) need the Basis transcoder, meshopt geometry (gltfpack) the meshopt decoder
# The Apache License 2.0's terms, which go with each Apache-licensed part (section 4a): taken from 3DTilesRendererJS's
# LICENSE, up to the end of the terms (its appendix names its own copyright)
apache="$work/apache-2.0.txt"
sed '/END OF TERMS AND CONDITIONS/q' "$work/3d-tiles-renderer-$TILES/package/LICENSE" > "$apache"
grep -q "END OF TERMS AND CONDITIONS" "$apache" || { echo "no Apache License text in 3DTilesRendererJS's LICENSE" >&2; exit 1; }
# apache_notice <file> <first lines>: the lines, then the licence's terms
apache_notice() {
    { printf '%s\n\n' "$2"; cat "$apache"; } > "$1"
}
apache_notice "$vendor/three-$THREE/examples/jsm/libs/basis/LICENSE.txt" \
"The Basis Universal transcoder (https://github.com/BinomialLLC/basis_universal), as shipped in three.js's
examples/jsm/libs/basis, is licensed under the Apache License, Version 2.0, below."
apache_notice "$vendor/three-$THREE/examples/jsm/libs/draco/LICENSE.txt" \
"The Draco decoder (https://github.com/google/draco), as shipped in three.js's examples/jsm/libs/draco, is
licensed under the Apache License, Version 2.0, below."
# ktx-parse and zstddec (zstddec's includes Zstandard's BSD licence), as their own packages carry them
cp "$work/ktx-parse-$KTXPARSE/package/LICENSE" "$vendor/three-$THREE/examples/jsm/libs/ktx-parse.LICENSE.txt"
cp "$work/zstddec-$ZSTDDEC/package/LICENSE" "$vendor/three-$THREE/examples/jsm/libs/zstddec.LICENSE.txt"

# Spark: one self-contained module (its worker is inlined); it imports "three" and three's postprocessing/Pass.js.
copy "$work/sparkjsdev-spark-$SPARK/package" "$vendor/spark-$SPARK" LICENSE dist/spark.module.min.js

# Leaflet: the script, its stylesheet and the images the stylesheet uses.
copy "$work/leaflet-$LEAFLET/package" "$vendor/leaflet-$LEAFLET" LICENSE dist/leaflet.js dist/leaflet.css
cp -R "$work/leaflet-$LEAFLET/package/dist/images" "$vendor/leaflet-$LEAFLET/dist/images"

# laz-perf: the build for workers (a classic script defining createLazPerf) and its wasm, for the point cloud
# worker (explorer/public/ept-worker.js). The npm package carries no licence file, so a notice is written.
copy "$work/laz-perf-$LAZPERF/package" "$vendor/laz-perf-$LAZPERF" lib/worker/laz-perf.js lib/worker/laz-perf.wasm
apache_notice "$vendor/laz-perf-$LAZPERF/LICENSE.txt" \
"laz-perf (https://github.com/hobuinc/laz-perf), as published on npm, is licensed under the Apache License,
Version 2.0, below."

# 3DTilesRendererJS: the three.js renderer and its plugins (fading, glTF extensions), with the chunks they import;
# they import only "three" and three's addons. Not its Babylon.js, PlayCanvas or React builds.
tiles_src="$work/3d-tiles-renderer-$TILES/package"
copy "$tiles_src" "$vendor/3d-tiles-renderer-$TILES" LICENSE build/index.three.js build/index.three-plugins.js \
    $(cd "$tiles_src" && ls build/renderer-*.js build/plugins-*.js | grep -v '\.map$')

# Every import inside the vendored modules must resolve: relative ones to a vendored file, bare ones to the import map
missing=0
while IFS= read -r line; do
    file="${line%%:*}"
    spec="$(sed -E "s/.*from ['\"]([^'\"]+)['\"].*/\1/" <<<"$line")"
    case "$spec" in
        ./*|../*) [ -f "$(dirname "$file")/$spec" ] || { echo "unresolved import $spec in $file" >&2; missing=1; } ;;
        three|three/addons/*) ;;
        *) echo "unexpected import $spec in $file" >&2; missing=1 ;;
    esac
done < <(grep -rEo "^(import|export|\}) .*from ['\"][^'\"]+['\"]" "$vendor" --include=*.js | grep -v "draco_\|basis_transcoder")
[ "$missing" = 0 ] || exit 1

(cd "$vendor" && find . -type f | sort | xargs shasum -a 256)

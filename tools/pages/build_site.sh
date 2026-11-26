#!/bin/bash
# build_site.sh OUT_DIR - assemble the static site for GitHub Pages: the Sponza map and only the
# files it loads, plus the Sponza model fetched from Khronos and its GPU-compressed textures.
# Nothing large is committed: the model is fetched at build time (tools/assets/fetch_sponza.sh).
#   tools/pages/build_site.sh _site
# Needs curl, python3 with numpy and Pillow (for tools/assets/dds_encode.py).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?usage: build_site.sh OUT_DIR}
rm -rf "$OUT"; mkdir -p "$OUT"

# 1. The model, then DXT textures for colour and metal/roughness maps. Normal maps are left out:
#    the page loads them uncompressed (BC1 breaks them).
tools/assets/fetch_sponza.sh
M=assets/models/sponza
mapfile -t ROLES < <(python3 -I - "$M/Sponza.gltf" <<'EOF'
import json, sys
g = json.load(open(sys.argv[1]))
uri = lambda i: g['images'][g['textures'][i]['source']]['uri']
base, mr = set(), set()
for m in g['materials']:
    p = m.get('pbrMetallicRoughness', {})
    if 'baseColorTexture' in p: base.add(uri(p['baseColorTexture']['index']))
    if 'metallicRoughnessTexture' in p: mr.add(uri(p['metallicRoughnessTexture']['index']))
print(' '.join(sorted(base))); print(' '.join(sorted(mr)))
EOF
)
read -ra BASE <<< "${ROLES[0]}"; read -ra MR <<< "${ROLES[1]}"
missing=()
for f in "${BASE[@]}" "${MR[@]}"; do [ -s "$M/dds/${f%.*}.dds" ] || missing+=("$f"); done
if [ ${#missing[@]} -gt 0 ]; then
  ( cd "$M" && python3 -I ../../../tools/assets/dds_encode.py dds "${missing[@]}" --linear "${MR[@]}" )
fi

# 2. The page and what it imports (see the importmap and imports in fly/sponza/index.html).
cp -r fly "$OUT/"
cp -r js "$OUT/"
mkdir -p "$OUT/vendor" "$OUT/$M/dds"
cp -r vendor/three vendor/three-mesh-bvh vendor/cannon-es "$OUT/vendor/"
cp "$M"/*.gltf "$M"/*.bin "$OUT/$M/"
for f in "$M"/*.png "$M"/*.jpg; do [ -e "$f" ] && cp "$f" "$OUT/$M/"; done
cp "$M"/dds/*.dds "$OUT/$M/dds/"
find "$OUT" -name '__pycache__' -prune -exec rm -rf {} +

# 3. The site root opens the map.
cat > "$OUT/index.html" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sponza tiny whoop</title>
<meta http-equiv="refresh" content="0; url=fly/sponza/index.html">
<a href="fly/sponza/index.html">Fly Sponza</a>
EOF
touch "$OUT/.nojekyll"
du -sh "$OUT"

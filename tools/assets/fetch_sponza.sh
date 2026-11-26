#!/bin/bash
# Fetch the Sponza atrium (Khronos glTF-Sample-Assets, Crytek/Frank Meinl, PBR textures by
# Alexandre Pestana) into assets/models/sponza/ for local use. Not committed: its licence
# (Crytek's donation "to the public for radiosity") doesn't clearly allow redistribution, so the
# map falls back to loading it from Khronos's GitHub when the local copy is missing.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=assets/models/sponza; mkdir -p "$OUT"
BASE=https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Sponza/glTF
get() { [ -s "$OUT/$1" ] || curl -sSf --retry 3 -A "Mozilla/5.0 (asset-fetch)" -o "$OUT/$1" "$BASE/$1"; }
# The file list comes from the glTF itself: no GitHub API call, which is rate-limited without a
# token (shared CI runners hit the limit).
get Sponza.gltf
python3 -I - "$OUT/Sponza.gltf" <<'PY' | while read -r f; do get "$f"; done
import json, sys
g = json.load(open(sys.argv[1]))
for x in g.get('buffers', []) + g.get('images', []):
    if 'uri' in x and not x['uri'].startswith('data:'): print(x['uri'])
PY
du -sh "$OUT"
# Optional, for speed: GPU-compressed textures (DXT1/DXT5 .dds with mips) next to the model.
#   python3 tools/assets/dds_encode.py assets/models/sponza/dds assets/models/sponza/*.{png,jpg} --linear <non-colour maps>
# (numpy; run where numpy is available). fly/sponza picks them up automatically.

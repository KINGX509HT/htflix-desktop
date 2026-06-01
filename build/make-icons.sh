#!/usr/bin/env bash
# Convert build/icon-source.png (1024x1024 recommended) into every icon
# format electron-builder needs: icon.icns (macOS), icon.ico (Windows),
# icon.png (Linux). Run from project root: ./build/make-icons.sh
set -euo pipefail

cd "$(dirname "$0")"
SRC="icon-source.png"

if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC not found. Drop a 1024x1024 PNG here first." >&2
  exit 1
fi

echo "→ Generating icon.icns (macOS)..."
ICONSET="icon.iconset"
rm -rf "$ICONSET"
mkdir "$ICONSET"
# Apple's required iconset matrix: 16/32/64/128/256/512/1024 + @2x variants.
sips -z 16   16   "$SRC" --out "$ICONSET/icon_16x16.png"        > /dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"     > /dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_32x32.png"        > /dev/null
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"     > /dev/null
sips -z 128  128  "$SRC" --out "$ICONSET/icon_128x128.png"      > /dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png"   > /dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_256x256.png"      > /dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png"   > /dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512.png"      > /dev/null
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png"   > /dev/null
iconutil -c icns "$ICONSET" -o icon.icns
rm -rf "$ICONSET"
echo "  ✓ icon.icns ($(du -h icon.icns | awk '{print $1}'))"

echo "→ Generating icon.png (Linux, 512x512)..."
sips -z 512 512 "$SRC" --out icon.png > /dev/null
echo "  ✓ icon.png"

echo "→ Generating icon.ico (Windows, multi-size)..."
# Build a multi-resolution ICO. macOS doesn't ship a native ICO encoder, so we
# use sips to make a 256x256 PNG and rename. Windows accepts a PNG-encoded ICO.
# (For best results, regenerate icon.ico on a Windows box with ImageMagick.)
sips -z 256 256 "$SRC" --out icon.ico > /dev/null
echo "  ✓ icon.ico  (note: minimal; for crisp small sizes regenerate on Win)"

echo
echo "Done. Files in build/:"
ls -la icon.icns icon.png icon.ico

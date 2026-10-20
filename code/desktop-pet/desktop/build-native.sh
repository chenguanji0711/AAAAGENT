#!/bin/zsh
set -euo pipefail
PET_DESKTOP_DIR="$(cd "$(dirname "$0")" && pwd)"
PET_APP_DIR="$PET_DESKTOP_DIR/build/星月陪伴.app"
mkdir -p "$PET_APP_DIR/Contents/MacOS" "$PET_DESKTOP_DIR/.cache/swift"
swiftc -module-cache-path "$PET_DESKTOP_DIR/.cache/swift" -framework AppKit -framework WebKit "$PET_DESKTOP_DIR/native/asset-response.swift" "$PET_DESKTOP_DIR/native/display-layout.swift" "$PET_DESKTOP_DIR/native/motion-preferences.swift" "$PET_DESKTOP_DIR/native/main.swift" -o "$PET_APP_DIR/Contents/MacOS/DesktopPet"
cp "$PET_DESKTOP_DIR/native/Info.plist" "$PET_APP_DIR/Contents/Info.plist"
# Finder and the Documents file provider re-attach resource-fork metadata to the
# bundle, and codesign then refuses it with "detritus not allowed". Remove the two
# offending attributes from the build artifact before signing.
for attribute in com.apple.FinderInfo "com.apple.fileprovider.fpfs#P"; do
  xattr -d "$attribute" "$PET_APP_DIR" 2>/dev/null || true
done
codesign --force --sign - "$PET_APP_DIR"
printf '%s\n' "$PET_APP_DIR"

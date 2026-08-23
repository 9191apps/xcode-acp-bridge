#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/ACP Bridge.app}"
XCODE_DIR="$ROOT/macos/ACPBridge"
DERIVED_DATA="$XCODE_DIR/build"

bun run --cwd "$ROOT" compile:sidecars

# Build the SwiftUI shell (ACPBridge.xcodeproj is checked in; regenerate with
# `xcodegen generate` from macos/ACPBridge/project.yml if it's ever deleted).
# Equivalent manual invocation from macos/ACPBridge/:
#   xcodebuild -project ACPBridge.xcodeproj -scheme ACPBridge \
#     -configuration Release -derivedDataPath build build
xcodebuild \
  -project "$XCODE_DIR/ACPBridge.xcodeproj" \
  -scheme ACPBridge \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  build

SWIFT_BINARY="$DERIVED_DATA/Build/Products/Release/ACPBridge.app/Contents/MacOS/ACPBridge"
if [ ! -x "$SWIFT_BINARY" ]; then
  echo "error: expected built binary at $SWIFT_BINARY (xcodebuild did not produce it)" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/public"
cp "$SWIFT_BINARY" "$APP/Contents/MacOS/ACPBridge"
chmod +x "$APP/Contents/MacOS/ACPBridge"
cp "$ROOT/dist/sidecars/"* "$APP/Contents/MacOS/"
cp -R "$ROOT/public/"* "$APP/Contents/Resources/public/"
cp "$ROOT/acp-bridge.config.json" "$APP/Contents/Resources/acp-bridge.config.default.json"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>ACPBridge</string>
	<key>CFBundleIdentifier</key>
	<string>apps.9191.ACPBridge</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>ACP Bridge</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
EOF
# Ad-hoc sign so Gatekeeper/LaunchServices treat this as a normal local app
# (no Developer ID needed for local smoke testing; notarization is a
# separate distribution step, not part of M1).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/ACP Bridge.app}"
bun run --cwd "$ROOT" compile:sidecars
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/public"
# Placeholder executable until Swift build provides ACPBridge — copy a tiny shell wrapper for CI layout check:
cat > "$APP/Contents/MacOS/ACPBridge" <<'EOF'
#!/bin/bash
echo "Swift shell not built yet; use Xcode to build ACPBridge" >&2
exit 1
EOF
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
</dict>
</plist>
EOF
echo "Built $APP"

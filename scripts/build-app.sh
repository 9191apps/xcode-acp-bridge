#!/usr/bin/env bash
# Build a complete ACP Bridge.app via Xcode (Swift shell + embedded sidecars).
# Sidecar compile/copy happens in the Xcode "Embed ACP sidecars" build phase.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/ACP Bridge.app}"
XCODE_DIR="$ROOT/macos/ACPBridge"
DERIVED_DATA="$XCODE_DIR/build"

export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# Optional: regenerate project if using XcodeGen and project.yml changed
if command -v xcodegen >/dev/null 2>&1 && [[ -f "$XCODE_DIR/project.yml" ]]; then
  (cd "$XCODE_DIR" && xcodegen generate)
fi

xcodebuild \
  -project "$XCODE_DIR/ACPBridge.xcodeproj" \
  -scheme ACPBridge \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  build

BUILT_APP="$DERIVED_DATA/Build/Products/Release/ACPBridge.app"
if [[ ! -d "$BUILT_APP" ]]; then
  echo "error: expected built app at $BUILT_APP" >&2
  exit 1
fi
if [[ ! -x "$BUILT_APP/Contents/MacOS/acp-serve" || ! -x "$BUILT_APP/Contents/MacOS/acp-bridge" ]]; then
  echo "error: built app is missing embedded sidecars (Embed ACP sidecars phase failed?)" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$(dirname "$APP")"
cp -R "$BUILT_APP" "$APP"

# Ad-hoc sign for local smoke testing (Developer ID / notarization is separate).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"

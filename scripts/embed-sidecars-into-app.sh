#!/usr/bin/env bash
# Embed compiled ACP sidecars + Observatory static assets into a built .app.
# Intended as an Xcode Run Script phase (post-build) and as a helper for build-app.sh.
#
# Required env (Xcode sets these automatically):
#   TARGET_BUILD_DIR, FULL_PRODUCT_NAME
# Optional:
#   SRCROOT          — macos/ACPBridge (defaults derived from this script)
#   ACP_FORCE_COMPILE=1 — always re-run bun compile:sidecars
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Prefer Xcode's SRCROOT (…/macos/ACPBridge) → repo root; else script location.
if [[ -n "${SRCROOT:-}" ]]; then
  REPO_ROOT="$(cd "$SRCROOT/../.." && pwd)"
fi

export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found on PATH (needed to compile ACP sidecars)" >&2
  exit 1
fi

if [[ -z "${TARGET_BUILD_DIR:-}" || -z "${FULL_PRODUCT_NAME:-}" ]]; then
  echo "error: TARGET_BUILD_DIR and FULL_PRODUCT_NAME must be set (Xcode build phase)" >&2
  exit 1
fi

APP="${TARGET_BUILD_DIR}/${FULL_PRODUCT_NAME}"
MACOS="${APP}/Contents/MacOS"
RESOURCES="${APP}/Contents/Resources"
SIDECAR_DIR="${REPO_ROOT}/dist/sidecars"

mkdir -p "$MACOS" "$RESOURCES/public" "$SIDECAR_DIR"

need_compile=0
if [[ "${ACP_FORCE_COMPILE:-}" == "1" ]]; then
  need_compile=1
else
  # `bun build --compile` inlines the whole import graph, so *any* file under src/ (or the
  # package metadata) can change a sidecar. Watching only the entry files silently ships stale
  # binaries when just a dependency changes — e.g. editing src/acp/config.ts alone.
  for out in acp-bridge acp-serve cursor-acp-resume qoder-acp-resume; do
    if [[ ! -x "${SIDECAR_DIR}/${out}" ]]; then
      need_compile=1
      break
    fi
  done
  if [[ "$need_compile" -eq 0 ]]; then
    newest_sidecar="${SIDECAR_DIR}/acp-serve"
    if [[ -n "$(find "${REPO_ROOT}/src" -name '*.ts' -newer "$newest_sidecar" -print -quit 2>/dev/null)" ]]; then
      need_compile=1
    elif [[ "${REPO_ROOT}/package.json" -nt "$newest_sidecar" || "${REPO_ROOT}/tsconfig.json" -nt "$newest_sidecar" ]]; then
      need_compile=1
    fi
  fi
fi

if [[ "$need_compile" -eq 1 ]]; then
  echo "note: compiling ACP sidecars into ${SIDECAR_DIR}"
  (cd "$REPO_ROOT" && bun run compile:sidecars)
else
  echo "note: reusing existing sidecars in ${SIDECAR_DIR} (sources unchanged)"
fi

for name in acp-bridge acp-serve cursor-acp-resume qoder-acp-resume; do
  src="${SIDECAR_DIR}/${name}"
  if [[ ! -x "$src" ]]; then
    echo "error: missing sidecar ${src}" >&2
    exit 1
  fi
  cp "$src" "${MACOS}/${name}"
  chmod +x "${MACOS}/${name}"
  bash "$SCRIPT_DIR/codesign-sidecar.sh" "${MACOS}/${name}" "apps.9191.ACPBridge.${name}"
done

# Observatory static files + default config (overwrite each build so Resources stay in sync)
rm -rf "${RESOURCES}/public"
mkdir -p "${RESOURCES}/public"
cp -R "${REPO_ROOT}/public/"* "${RESOURCES}/public/"
cp "${REPO_ROOT}/acp-bridge.config.json" "${RESOURCES}/acp-bridge.config.default.json"

echo "note: embedded sidecars + Resources into ${APP}"

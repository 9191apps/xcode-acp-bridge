#!/usr/bin/env bash
# Ad-hoc sign a bun --compile Mach-O.
#
# `bun build --compile` emits a linker-signed binary whose CDHash often does
# not match the file bytes ("invalid signature (code or signature have been
# modified)"). Executing that binary from inside a signed .app — which is how
# Xcode launches the ACP agent — is SIGKILL'd by taskgated (Code Signature
# Invalid). The process dies before process_start, so Observatory never sees
# the conversation.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <binary> [identifier]" >&2
  exit 2
fi

bin="$1"
id="${2:-$(basename "$bin")}"

if [[ ! -f "$bin" ]]; then
  echo "error: not a file: $bin" >&2
  exit 1
fi

codesign --force --sign - --identifier "$id" --timestamp=none "$bin"
codesign --verify "$bin"

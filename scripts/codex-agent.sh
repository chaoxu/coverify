#!/usr/bin/env sh
set -eu

tmp="$(mktemp)"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --color never \
  --output-last-message "$tmp" \
  - >/dev/null

cat "$tmp"

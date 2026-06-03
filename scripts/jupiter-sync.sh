#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-release}"
JUPITER_HOST="${COVERIFY_JUPITER_HOST:-jupiter}"
REMOTE_CHECKOUT="${COVERIFY_JUPITER_CHECKOUT:-/home/chaoxu/playground/coverify}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

host_identity() {
  if [[ -r /etc/lab-host ]]; then
    tr -d '[:space:]' < /etc/lab-host
  else
    hostname -s
  fi
}

remote() {
  if [[ "$(host_identity)" == "${JUPITER_HOST}" ]]; then
    "$@"
  else
    ssh "${JUPITER_HOST}" "$@"
  fi
}

remote_sh() {
  if [[ "$(host_identity)" == "${JUPITER_HOST}" ]]; then
    bash -lc "$1"
  else
    ssh "${JUPITER_HOST}" "$1"
  fi
}

sync_checkout() {
  remote mkdir -p "${REMOTE_CHECKOUT}"
  if [[ "$(host_identity)" == "${JUPITER_HOST}" ]]; then
    rsync -a --delete \
      --exclude '.git/' \
      --exclude '.coverify/' \
      --exclude '.playwright-mcp/' \
      --exclude '.pytest_cache/' \
      --exclude '.mypy_cache/' \
      --exclude '.ruff_cache/' \
      --exclude '.venv/' \
      --exclude '__pycache__/' \
      --exclude '*.pyc' \
      --exclude '*.log' \
      --exclude '.env' \
      --exclude '.env.*' \
      "${repo_root}/" "${REMOTE_CHECKOUT}/"
  else
    rsync -a --delete \
      --exclude '.git/' \
      --exclude '.coverify/' \
      --exclude '.playwright-mcp/' \
      --exclude '.pytest_cache/' \
      --exclude '.mypy_cache/' \
      --exclude '.ruff_cache/' \
      --exclude '.venv/' \
      --exclude '__pycache__/' \
      --exclude '*.pyc' \
      --exclude '*.log' \
      --exclude '.env' \
      --exclude '.env.*' \
      "${repo_root}/" "${JUPITER_HOST}:${REMOTE_CHECKOUT}/"
  fi
}

verify_checkout() {
  remote_sh "cd '${REMOTE_CHECKOUT}' && python3 scripts/check_skills.py"
  remote_sh "cd '${REMOTE_CHECKOUT}' && PYTHONPATH=src python3 -m coverify --help >/dev/null"
  remote_sh "cd '${REMOTE_CHECKOUT}' && PYTHONPATH=src python3 -m unittest discover -s tests"
}

case "${ACTION}" in
  sync)
    sync_checkout
    ;;
  verify)
    verify_checkout
    ;;
  release)
    sync_checkout
    verify_checkout
    ;;
  *)
    echo "usage: $0 {sync|verify|release}" >&2
    exit 2
    ;;
esac

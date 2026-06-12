#!/usr/bin/env bash
# Deploy the Coverify chat worker on jupiter from origin/main, and PROVE the
# running service matches it: the deploy fails unless the restarted worker
# logs the deployed sha. Idempotent — the coverify-autodeploy timer runs this
# every few minutes and it exits quickly when nothing changed.
#
# Run as the chaoxu user (systemd *user* service; SELinux blocks system units
# from /home). Secrets stay in /home/chaoxu/coverify-worker.env, never in git.
#
# Born from the 2026-06-12 stale-code incident: the venv was editable-installed
# against a different checkout than the one being synced, so prod chat ran old
# code while deploys appeared to succeed. Hence the editable-target check and
# the sha post-check below.

main() {
  set -euo pipefail

  local src="${COVERIFY_SRC:-$HOME/coverify-src}"
  local venv="${COVERIFY_VENV:-$HOME/coverify-venv}"
  local unit_dir="$HOME/.config/systemd/user"

  git -C "$src" fetch -q origin main
  local local_sha remote_sha
  local_sha=$(git -C "$src" rev-parse HEAD)
  remote_sha=$(git -C "$src" rev-parse origin/main)

  local units_changed=0
  for unit in coverify-chat-worker.service coverify-autodeploy.service coverify-autodeploy.timer; do
    cmp -s "$src/scripts/systemd/$unit" "$unit_dir/$unit" || units_changed=1
  done

  if [ "$local_sha" = "$remote_sha" ] && [ "$units_changed" = 0 ] \
      && systemctl --user is-active -q coverify-chat-worker; then
    exit 0  # fresh, units installed, running: nothing to do
  fi

  git -C "$src" reset -q --hard origin/main

  # The venv must be editable-installed against THIS checkout, or pulls here
  # change nothing the service executes.
  local target
  target=$("$venv/bin/pip" show coverify 2>/dev/null | sed -n 's/^Editable project location: //p')
  if [ "$target" != "$src" ]; then
    echo "venv editable target is '${target:-none}'; reinstalling against $src"
    "$venv/bin/pip" install -q -e "$src"
  fi

  mkdir -p "$unit_dir"
  for unit in coverify-chat-worker.service coverify-autodeploy.service coverify-autodeploy.timer; do
    install -m 0644 "$src/scripts/systemd/$unit" "$unit_dir/$unit"
  done
  systemctl --user daemon-reload
  systemctl --user restart coverify-chat-worker

  # Post-check: the RUNNING worker must report the deployed sha in its
  # startup line. No sha line, wrong sha, or dead service => deploy FAILED.
  local want line
  want=$(git -C "$src" rev-parse --short HEAD)
  for _ in $(seq 1 15); do
    sleep 1
    line=$(journalctl --user -u coverify-chat-worker -n 5 --no-pager 2>/dev/null \
      | grep -F "coverify-chat-worker up" | tail -1 || true)
    case "$line" in
      *"sha=$want"*)
        echo "deployed $want; worker live and reporting it"
        exit 0
        ;;
    esac
  done
  echo "DEPLOY FAILED: worker did not come up reporting sha=$want" >&2
  journalctl --user -u coverify-chat-worker -n 10 --no-pager >&2 || true
  exit 1
}

main "$@"

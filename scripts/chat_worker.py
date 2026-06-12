#!/usr/bin/env python3
"""Coverify chat worker (jupiter prod).

Polls Cosheaf workspaces the bot can access for chat-labelled issues whose
last turn is from the user, and runs `coverify chat-reply` for each — which
reads the thread, runs the oracle on the host, and posts the reply as the bot.

Deployed by scripts/deploy-chat-worker.sh from this checkout; the startup log
line reports the running code's git sha so a deploy can prove the service is
not running stale code.

Dedup: an in-memory set plus a per-issue TTL lock file, so a long (verifying)
reply is never started twice — even across a worker restart, where the
in-memory set is empty but the lock file (until it ages past LOCK_TTL) still
suppresses a duplicate.
"""
import json
import os
import subprocess
import threading
import time
import urllib.request

FORGEJO_URL = os.environ["FORGEJO_URL"].rstrip("/")
COSHEAF_API_URL = os.environ["COSHEAF_API_URL"].rstrip("/")
BOT = os.environ["BOT_TOKEN"]
BOT_LOGIN = os.environ.get("BOT_LOGIN", "coverify")
COVERIFY = os.environ.get("COVERIFY_BIN", "coverify")
OWNER = os.environ.get("FORGEJO_OWNER", "cosheaf-admin")
BACKEND = os.environ.get("BACKEND", "codex")
EFFORT = os.environ.get("EFFORT", "medium")
INTERVAL = int(os.environ.get("INTERVAL", "20"))
LOCK_DIR = os.environ.get("LOCK_DIR", "/tmp/coverify-chat-locks")
LOCK_TTL = int(os.environ.get("LOCK_TTL", "1800"))
REPLY_TIMEOUT = int(os.environ.get("REPLY_TIMEOUT", "1800"))
CHAT_LABEL = "chat"

os.makedirs(LOCK_DIR, exist_ok=True)
in_progress: set[tuple[str, int]] = set()
mem_lock = threading.Lock()


def code_sha() -> str:
    """Short git sha of the checkout this worker runs from (for deploy proof)."""
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        out = subprocess.run(
            ["git", "-C", repo, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001 — sha reporting must never block startup
        return "unknown"


def forgejo(path: str):
    req = urllib.request.Request(f"{FORGEJO_URL}/api/v1{path}", headers={"Authorization": f"token {BOT}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def lock_path(ws: str, number: int) -> str:
    return os.path.join(LOCK_DIR, f"{ws}__{number}.lock")


def is_locked(ws: str, number: int) -> bool:
    try:
        return (time.time() - os.path.getmtime(lock_path(ws, number))) < LOCK_TTL
    except FileNotFoundError:
        return False


def workspaces() -> list[str]:
    repos = forgejo("/repos/search?limit=50")
    return [r["name"] for r in repos.get("data", []) if (r.get("owner") or {}).get("login") == OWNER]


def pending_chats(ws: str) -> list[int]:
    out = []
    for issue in forgejo(f"/repos/{OWNER}/{ws}/issues?state=open&type=issues&limit=50"):
        if not any(label.get("name") == CHAT_LABEL for label in issue.get("labels") or []):
            continue
        number = issue["number"]
        comments = forgejo(f"/repos/{OWNER}/{ws}/issues/{number}/comments")
        last = comments[-1] if comments else issue
        if ((last.get("user") or {}).get("login")) != BOT_LOGIN:  # last turn is the user → reply owed
            out.append(number)
    return out


def reply(ws: str, number: int) -> None:
    try:
        env = {**os.environ, "COSHEAF_API_URL": COSHEAF_API_URL, "COSHEAF_TOKEN": BOT,
               "COVERIFY_ALLOW_CODEX_BACKEND": "1"}
        result = subprocess.run(
            [COVERIFY, "chat-reply", "--workspace", ws, "--issue", str(number),
             "--bot-user", BOT_LOGIN, "--backend", BACKEND, "--reasoning-effort", EFFORT,
             "--backend-timeout", "600"],
            env=env, timeout=REPLY_TIMEOUT, capture_output=True, text=True,
        )
        if result.returncode != 0:
            print(f"{ws}#{number} coverify exited {result.returncode}: {result.stderr.strip()[-500:]}", flush=True)
        else:
            print(f"{ws}#{number} done: {result.stdout.strip()[-200:]}", flush=True)
    except Exception as exc:  # noqa: BLE001 — worker must never die on one bad reply
        print(f"{ws}#{number} reply failed: {exc}", flush=True)
    finally:
        try:
            os.remove(lock_path(ws, number))
        except FileNotFoundError:
            pass
        with mem_lock:
            in_progress.discard((ws, number))


def main() -> None:
    print(
        f"coverify-chat-worker up (sha={code_sha()}, backend={BACKEND}, effort={EFFORT}, interval={INTERVAL}s)",
        flush=True,
    )
    while True:
        try:
            for ws in workspaces():
                for number in pending_chats(ws):
                    key = (ws, number)
                    with mem_lock:
                        if key in in_progress:
                            continue
                        if is_locked(ws, number):  # in-flight reply from before a restart
                            continue
                        in_progress.add(key)
                        open(lock_path(ws, number), "w").close()
                    print(f"replying to {ws}#{number}", flush=True)
                    threading.Thread(target=reply, args=(ws, number), daemon=True).start()
        except Exception as exc:  # noqa: BLE001
            print(f"poll cycle error: {exc}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()

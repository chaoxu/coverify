#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def read_prompt() -> str:
    prompt = sys.stdin.read()
    if not prompt.strip():
        raise SystemExit("chatgpt oracle backend requires a non-empty prompt on stdin")
    return prompt


def default_chatgpt_cli() -> str:
    return "chatgpt-cli"


def resolve_cli(cli: str) -> str:
    path = Path(cli).expanduser()
    if path.exists():
        return str(path.resolve())
    found = shutil.which(cli)
    if found:
        return found
    raise SystemExit(f"chatgpt-cli executable not found: {cli}")


def run_oracle(args: argparse.Namespace, prompt: str) -> str:
    workdir = Path(args.workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    raw_json_path = workdir / "chatgpt_oracle.json"
    stderr_path = workdir / "chatgpt_oracle.stderr.log"

    cli = resolve_cli(args.chatgpt_cli or os.environ.get("CHATGPT_CLI", default_chatgpt_cli()))
    command = [
        cli,
        "oracle",
        "--quiet",
        "--timeout",
        str(args.timeout),
    ]
    process = subprocess.run(
        command,
        input=prompt,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=args.timeout + args.process_grace_seconds,
        check=False,
    )
    raw_json_path.write_text(process.stdout, encoding="utf-8")
    stderr_path.write_text(process.stderr, encoding="utf-8")

    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"chatgpt-cli oracle returned non-JSON output; "
            f"returncode={process.returncode}; json={raw_json_path}; stderr={stderr_path}",
        ) from exc

    if process.returncode != 0 or not payload.get("ok"):
        error = payload.get("error") or f"returncode {process.returncode}"
        chat_id = payload.get("chat_id")
        suffix = f"; chat_id={chat_id}" if chat_id else ""
        raise SystemExit(
            f"chatgpt-cli oracle failed: {error}{suffix}; "
            f"json={raw_json_path}; stderr={stderr_path}",
        )

    text = str(payload.get("text") or "").strip()
    if not text:
        raise SystemExit(f"chatgpt-cli oracle returned empty text; json={raw_json_path}")
    return text + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Coverify script backend adapter for chatgpt-cli oracle")
    parser.add_argument("--chatgpt-cli", default="", help="chatgpt-cli executable; defaults to CHATGPT_CLI or chatgpt-cli on PATH")
    parser.add_argument("--workdir", default=".", help="adapter working directory; defaults to the backend artifact dir")
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("COVERIFY_CHATGPT_TIMEOUT_SECONDS", "6000") or "6000"))
    parser.add_argument("--process-grace-seconds", type=int, default=30)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    print(run_oracle(args, read_prompt()), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

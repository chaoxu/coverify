#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


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


def extract_codex_exec_prompt(argv: list[str]) -> tuple[str, str | None]:
    """Extract the prompt and optional -C cwd from QED's Codex CLI command.

    QED calls Codex as:
      codex --search -m <model> -c <key=value> exec --json ... -C <dir> <prompt>

    This shim only needs the final prompt and, for diagnostics, the requested
    working directory. It intentionally ignores model/reasoning flags because
    the ChatGPT browser session is assumed to already be Pro + Extended.
    """
    cwd: str | None = None
    prompt_parts: list[str] = []
    after_exec = False
    i = 0
    options_with_value = {"-m", "--model", "-c", "--config", "-C", "--cd"}
    while i < len(argv):
        arg = argv[i]
        if arg == "exec":
            after_exec = True
            i += 1
            continue
        if arg in options_with_value:
            if i + 1 >= len(argv):
                raise SystemExit(f"missing value for {arg}")
            if arg in {"-C", "--cd"}:
                cwd = argv[i + 1]
            i += 2
            continue
        if arg.startswith("-"):
            i += 1
            continue
        if after_exec:
            prompt_parts.append(arg)
        i += 1

    if not prompt_parts:
        raise SystemExit("qed chatgpt codex shim could not find a prompt argument")
    return " ".join(prompt_parts), cwd


def emit_codex_jsonl(text: str, elapsed_sec: int | None = None) -> None:
    print(json.dumps({
        "type": "item.completed",
        "item": {"type": "agent_message", "text": text},
    }))
    usage: dict[str, object] = {"input_tokens": 0, "output_tokens": 0}
    if elapsed_sec is not None:
        usage["elapsed_sec"] = elapsed_sec
    print(json.dumps({"type": "turn.completed", "usage": usage}))


def run_chatgpt_oracle(prompt: str, args: argparse.Namespace) -> dict:
    cli = resolve_cli(args.chatgpt_cli or os.environ.get("CHATGPT_CLI", default_chatgpt_cli()))
    command = [cli, "oracle", "--quiet", "--timeout", str(args.timeout)]
    process = subprocess.run(
        command,
        input=prompt,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=args.timeout + args.process_grace_seconds,
        check=False,
    )
    if process.stderr.strip():
        print(process.stderr, file=sys.stderr, end="" if process.stderr.endswith("\n") else "\n")
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"chatgpt-cli oracle returned non-JSON output; "
            f"returncode={process.returncode}; stdout={process.stdout[:1000]!r}",
        ) from exc
    if process.returncode != 0 or not payload.get("ok"):
        chat_id = payload.get("chat_id")
        suffix = f"; chat_id={chat_id}" if chat_id else ""
        raise SystemExit(f"chatgpt-cli oracle failed: {payload.get('error', process.returncode)}{suffix}")
    text = str(payload.get("text") or "").strip()
    if not text:
        raise SystemExit("chatgpt-cli oracle returned empty text")
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Codex CLI compatibility shim for QED using chatgpt-cli oracle",
        add_help=False,
    )
    parser.add_argument("--chatgpt-cli", default="")
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("QED_CHATGPT_TIMEOUT_SECONDS", os.environ.get("COVERIFY_CHATGPT_TIMEOUT_SECONDS", "6000")) or "6000"))
    parser.add_argument("--process-grace-seconds", type=int, default=30)
    return parser


def main() -> int:
    args, codex_args = build_parser().parse_known_args()
    prompt, _cwd = extract_codex_exec_prompt(codex_args)
    payload = run_chatgpt_oracle(prompt, args)
    emit_codex_jsonl(str(payload["text"]).strip(), payload.get("elapsed_sec"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

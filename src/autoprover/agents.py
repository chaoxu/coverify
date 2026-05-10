from __future__ import annotations

from dataclasses import dataclass
import os
import shlex
import subprocess


class AgentError(RuntimeError):
    pass


def resolve_agent_command(command: str | None) -> list[str]:
    raw = command or os.environ.get("AUTOPROVER_AGENT_CMD")
    if not raw:
        raise AgentError("agent command required; pass --agent-cmd or set AUTOPROVER_AGENT_CMD")
    return shlex.split(raw)


def run_agent(prompt: str, command: str | None = None) -> str:
    argv = resolve_agent_command(command)
    try:
        result = subprocess.run(
            argv,
            input=prompt,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AgentError(f"agent command not found: {argv[0]}") from exc
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or f"{argv[0]} failed"
        raise AgentError(message)
    output = result.stdout.strip()
    if not output:
        raise AgentError("agent returned empty output")
    return strip_outer_fence(output)


def strip_outer_fence(text: str) -> str:
    cleaned = text.strip()
    if not cleaned.startswith("```"):
        return cleaned
    lines = cleaned.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


@dataclass(frozen=True)
class ReviewResult:
    decision: str
    comment: str
    body: str


def parse_review_result(text: str) -> ReviewResult:
    cleaned = strip_outer_fence(text)
    lines = cleaned.splitlines()
    if len(lines) < 3:
        raise AgentError("reviewer output must use DECISION/COMMENT/BODY protocol")
    decision_line = lines[0].strip()
    comment_line = lines[1].strip()
    body_line = lines[2].strip()
    if not decision_line.lower().startswith("decision:"):
        raise AgentError("reviewer output must start with DECISION:")
    if not comment_line.lower().startswith("comment:"):
        raise AgentError("reviewer output must include COMMENT: on the second line")
    if body_line.lower() != "body:":
        raise AgentError("reviewer output must include BODY: on the third line")
    decision = decision_line.split(":", 1)[1].strip().lower()
    if decision not in {"approve", "reject"}:
        raise AgentError("reviewer decision must be approve or reject")
    comment = comment_line.split(":", 1)[1].strip()
    body = "\n".join(lines[3:]).strip()
    if not body:
        raise AgentError("review body must be non-empty")
    return ReviewResult(decision=decision, comment=comment, body=body)

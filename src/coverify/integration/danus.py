"""Thin adapter for the Danus multi-agent proving deployment.

Danus (https://github.com/frenzymath/Danus) is a *stateful* deployment, not a
one-shot batch workflow: you scaffold a project, launch autonomous worker loops
that survive your session, poll their status, and eventually pick a verified
fact as the answer. Its ``finalize`` step is deliberately a human/agent judgment
call ("Danus does not declare a problem done on its own"), so this adapter does
NOT auto-finalize. It drives the mechanical part of one project lifecycle:

    new  ->  write PROBLEM.md  ->  start  ->  poll status  ->  (stop)  ->  suggest

and returns the candidate terminal facts (``finalize`` suggestion mode, which
writes nothing) plus the fact-graph location, for Coverify to package as a
mathematical-resolution target and verify independently under its own contract.

The ``danus`` control surface is invoked through a configurable base command so
a Danus deployment can be local (``["bin/danus"]`` with ``cwd`` = the Danus repo)
or remote (``["ssh", "jupiter", "danus"]``). PROBLEM.md is written directly into
the project directory, which requires a locally reachable ``projects_root``; for
a remote deployment, set the problem out of band and pass ``write_problem=False``.
"""

from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from coverify.engine.backend import (
    BackendResult,
    ensure_artifact_dir,
    write_audit_metadata,
    write_prompt_file,
)

# Worker labels reported by ``danus status`` that mean the loop is no longer
# making progress (see danus/orchestration/cli.py::worker_status).
TERMINAL_LABELS = frozenset({"stopped", "deadline", "max_rounds", "error", "terminated", "dead"})


def _run_danus(
    base_command: list[str],
    verb_args: list[str],
    *,
    cwd: Path,
    as_json: bool = False,
    timeout: int | None = 120,
) -> tuple[int, str, str, Any]:
    """Run one ``danus`` verb. Returns (returncode, stdout, stderr, parsed_json)."""
    cmd = [*base_command, *verb_args]
    if as_json:
        cmd.append("--json")
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    parsed: Any = None
    if as_json and proc.stdout.strip():
        try:
            parsed = json.loads(proc.stdout)
        except json.JSONDecodeError:
            parsed = None
    return proc.returncode, proc.stdout, proc.stderr, parsed


def _all_terminal(status_rows: Any) -> bool:
    """True when every worker row is finished (not alive and terminal label)."""
    if not isinstance(status_rows, list) or not status_rows:
        return False
    for row in status_rows:
        if not isinstance(row, dict):
            return False
        if row.get("alive"):
            return False
        if row.get("label") not in TERMINAL_LABELS:
            return False
    return True


def run_danus_project(
    *,
    base_command: list[str],
    cwd: Path,
    problem: str,
    artifact_root: Path,
    project: str,
    roles: str = "high:3,xhigh:4",
    model: str | None = None,
    projects_root: Path | None = None,
    write_problem: bool = True,
    poll_interval_seconds: float = 30.0,
    deadline_seconds: int = 3600,
    verb_timeout_seconds: int = 120,
    provider: str = "danus",
) -> BackendResult:
    """Drive one Danus project through its mechanical lifecycle and return the
    candidate terminal facts for independent verification.

    Does not finalize: deciding which verified fact answers the goal is a
    mathematical judgment left to Coverify / the operator.
    """
    cwd = cwd.resolve()
    if not cwd.exists():
        raise FileNotFoundError(f"danus cwd not found: {cwd}")

    artifact_dir = ensure_artifact_dir(artifact_root, provider)
    oracle_call_id = artifact_dir.name
    prompt_path = write_prompt_file(artifact_dir, problem)
    answer_path = artifact_dir / "answer.md"
    metadata_path = artifact_dir / "metadata.json"

    metadata: dict[str, Any] = {
        "oracle_call_id": oracle_call_id,
        "provider": provider,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "project": project,
        "roles": roles,
        "model": model,
        "base_command": base_command,
        "command_cwd": str(cwd),
        "deadline_seconds": deadline_seconds,
        "steps": [],
    }
    artifacts = {"prompt": prompt_path, "answer": answer_path}

    def record(step: str, payload: dict[str, Any]) -> None:
        metadata["steps"].append({"step": step, **payload})
        write_audit_metadata(metadata_path, metadata, artifacts)

    # 1. scaffold the project (idempotent: an existing project is fine).
    new_args = ["new", project, "--roles", roles]
    if model:
        new_args += ["--model", model]
    rc, out, err, _ = _run_danus(base_command, new_args, cwd=cwd, timeout=verb_timeout_seconds)
    record("new", {"returncode": rc, "stdout": out.strip(), "stderr": err.strip()})

    # 2. write PROBLEM.md verbatim into the project dir (local deployments only).
    if write_problem:
        proot = (projects_root or (cwd / "runtime" / "projects")).resolve()
        problem_dir = proot / project
        problem_dir.mkdir(parents=True, exist_ok=True)
        problem_file = problem_dir / "PROBLEM.md"
        problem_file.write_text(problem if problem.endswith("\n") else problem + "\n", encoding="utf-8")
        record("problem", {"problem_file": str(problem_file)})

    # 3. launch the autonomous worker loops.
    rc, out, err, started = _run_danus(base_command, ["start", project], cwd=cwd, as_json=True, timeout=verb_timeout_seconds)
    record("start", {"returncode": rc, "started": started, "stderr": err.strip()})
    if rc != 0:
        answer = _render_answer(project, status_rows=None, suggested=None, note=f"start failed: {err.strip()}")
        answer_path.write_text(answer, encoding="utf-8")
        metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
        metadata["ok"] = False
        write_audit_metadata(metadata_path, metadata, artifacts)
        return BackendResult(answer=answer, artifact_dir=artifact_dir, provider=provider, oracle_call_id=oracle_call_id)

    # 4. poll status until all workers terminal or the deadline elapses.
    started_at = time.monotonic()
    status_rows: Any = None
    reached_deadline = False
    while True:
        rc, out, err, status_rows = _run_danus(
            base_command, ["status", project], cwd=cwd, as_json=True, timeout=verb_timeout_seconds
        )
        record("status", {"returncode": rc, "status": status_rows})
        if _all_terminal(status_rows):
            break
        if time.monotonic() - started_at >= deadline_seconds:
            reached_deadline = True
            break
        time.sleep(poll_interval_seconds)

    # 5. stop gracefully if we hit the deadline with workers still running.
    if reached_deadline:
        rc, out, err, stopped = _run_danus(base_command, ["stop", project], cwd=cwd, as_json=True, timeout=verb_timeout_seconds)
        record("stop", {"returncode": rc, "stopped": stopped, "reason": "deadline"})

    # 6. suggestion mode: list candidate terminal facts (writes nothing in Danus).
    rc, out, err, suggested = _run_danus(base_command, ["finalize", project], cwd=cwd, as_json=True, timeout=verb_timeout_seconds)
    record("suggest", {"returncode": rc, "suggested": suggested, "stderr": err.strip()})

    answer = _render_answer(
        project,
        status_rows=status_rows,
        suggested=suggested,
        note="deadline reached; workers stopped gracefully" if reached_deadline else "workers reached a terminal state",
    )
    answer_path.write_text(answer, encoding="utf-8")
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started_at, 3)
    metadata["reached_deadline"] = reached_deadline
    metadata["ok"] = True
    write_audit_metadata(metadata_path, metadata, artifacts)
    return BackendResult(answer=answer, artifact_dir=artifact_dir, provider=provider, oracle_call_id=oracle_call_id)


def _render_answer(project: str, *, status_rows: Any, suggested: Any, note: str) -> str:
    lines = [f"# Danus project `{project}`", "", note, ""]
    suggested_facts = suggested.get("suggested") if isinstance(suggested, dict) else None
    lines.append("## Candidate terminal facts (unverified by Coverify)")
    if suggested_facts:
        for fact in suggested_facts:
            lines.append(f"- {json.dumps(fact) if not isinstance(fact, str) else fact}")
    else:
        lines.append("- (none surfaced)")
    lines += ["", "## Final worker status"]
    if isinstance(status_rows, list):
        for row in status_rows:
            if isinstance(row, dict):
                lines.append(
                    f"- {row.get('worker')}: label={row.get('label')} state={row.get('state')} "
                    f"round={row.get('round')} last_fact={row.get('last_fact_id')}"
                )
    else:
        lines.append("- (unavailable)")
    lines += [
        "",
        "These facts are Danus-verified but NOT verified under Coverify's contract. "
        "Package a chosen fact as a mathematical-resolution target and run the "
        "independent verifier before treating it as an answer.",
        "",
    ]
    return "\n".join(lines)

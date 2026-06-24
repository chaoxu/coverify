from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from coverify.engine.backend import (
    BackendResult,
    ensure_artifact_dir,
    terminate_process_group,
    write_audit_metadata,
    write_prompt_file,
)


def run_external_workflow(
    *,
    command: list[str],
    cwd: Path,
    problem: str,
    artifact_root: Path,
    provider: str = "external-workflow",
    workflow: str = "external",
    problem_id: str = "coverify_problem",
    run_id: str | None = None,
    output_dir: Path | None = None,
    timeout_seconds: int | None = None,
    metadata_path_template: str = "{output_dir}/{run_id}/run-metadata.json",
) -> BackendResult:
    cwd = cwd.resolve()
    if not cwd.exists():
        raise FileNotFoundError(f"workflow cwd not found: {cwd}")
    artifact_dir = ensure_artifact_dir(artifact_root, provider)
    oracle_call_id = artifact_dir.name
    prompt_path = write_prompt_file(artifact_dir, problem)
    answer_path = artifact_dir / "answer.md"
    stdout_path = artifact_dir / "stdout.log"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
    output_dir = (output_dir or artifact_dir / "outputs").resolve()
    run_id = run_id or safe_run_id(problem_id)
    values = {
        "problem_path": str(prompt_path),
        "problem_id": problem_id,
        "run_id": run_id,
        "output_dir": str(output_dir),
        "artifact_dir": str(artifact_dir),
        "cwd": str(cwd),
    }
    cmd = [part.format(**values) for part in command]
    workflow_metadata_path = Path(metadata_path_template.format(**values))

    metadata: dict[str, Any] = {
        "oracle_call_id": oracle_call_id,
        "provider": provider,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "workflow": workflow,
        "problem_id": problem_id,
        "run_id": run_id,
        "output_dir": str(output_dir),
        "timeout_seconds": timeout_seconds,
        "command": cmd,
        "command_cwd": str(cwd),
        "workflow_metadata_path": str(workflow_metadata_path),
    }
    artifacts = {
        "prompt": prompt_path,
        "answer": answer_path,
        "stdout": stdout_path,
        "stderr": stderr_path,
    }
    write_audit_metadata(metadata_path, metadata, artifacts)
    started = time.monotonic()
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            start_new_session=True,
            env=os.environ.copy(),
        )
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            terminate_process_group(process.pid, signal.SIGKILL)
            process.wait()
            metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            metadata["returncode"] = process.returncode
            metadata["timed_out"] = True
            write_audit_metadata(metadata_path, metadata, artifacts)
            raise RuntimeError(f"{provider} timed out; artifacts={artifact_dir}") from exc
    stdout_text = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
    workflow_metadata = read_json(workflow_metadata_path)
    answer = render_workflow_answer(
        provider=provider,
        workflow=workflow,
        stdout_text=stdout_text,
        output_dir=output_dir,
        run_id=run_id,
        metadata=workflow_metadata,
        returncode=process.returncode,
    )
    answer_path.write_text(answer, encoding="utf-8")
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata["timed_out"] = False
    metadata["workflow_metadata"] = workflow_metadata if isinstance(workflow_metadata, dict) else None
    write_audit_metadata(metadata_path, metadata, artifacts)
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        raise RuntimeError(
            f"{provider} failed with code {process.returncode}; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    return BackendResult(
        answer=answer,
        artifact_dir=artifact_dir,
        provider=provider,
        oracle_call_id=oracle_call_id,
    )


def render_workflow_answer(
    *,
    provider: str,
    workflow: str,
    stdout_text: str,
    output_dir: Path,
    run_id: str,
    metadata: Any,
    returncode: int | None,
) -> str:
    lines = [
        f"# {provider} workflow result",
        "",
        f"- workflow: {workflow}",
        f"- returncode: {returncode}",
        f"- run_id: {run_id}",
        f"- output: {output_dir / run_id}",
    ]
    if isinstance(metadata, dict):
        lines.append(f"- status: {metadata.get('status')}")
        outputs = metadata.get("outputs")
        if isinstance(outputs, dict):
            for key in (
                "answer_tex_path",
                "pdf_path",
                "compiled",
                "answer_ready",
                "early_stopped",
                "rounds_completed",
            ):
                if key in outputs:
                    lines.append(f"- {key}: {outputs[key]}")
    if stdout_text.strip():
        lines += ["", "## Runner stdout", "", "```text", stdout_text.strip()[-8000:], "```"]
    return "\n".join(lines) + "\n"


def safe_run_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"coverify-{cleaned or 'problem'}-{stamp}"


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

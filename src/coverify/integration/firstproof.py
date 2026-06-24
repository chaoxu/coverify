from __future__ import annotations

import json
import os
import re
import shutil
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


DEFAULT_FIRSTPROOF_REPO = "https://github.com/1stproof/batch-2.git"
DEFAULT_FIRSTPROOF_SUBDIR = "batch-2-submissions/improofbench"


def setup_improofbench(
    *,
    checkout_dir: Path,
    repo_url: str = DEFAULT_FIRSTPROOF_REPO,
    ref: str = "main",
    force: bool = False,
) -> dict[str, Any]:
    if checkout_dir.exists():
        if not force:
            root = improofbench_root(checkout_dir)
            return {
                "ok": root.exists(),
                "checkout_dir": str(checkout_dir),
                "improofbench_root": str(root),
                "already_exists": True,
            }
        shutil.rmtree(checkout_dir)
    checkout_dir.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "git",
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        ref,
        repo_url,
        str(checkout_dir),
    ]
    subprocess.run(cmd, check=True)
    subprocess.run(
        ["git", "-C", str(checkout_dir), "sparse-checkout", "set", DEFAULT_FIRSTPROOF_SUBDIR],
        check=True,
    )
    root = improofbench_root(checkout_dir)
    return {
        "ok": root.exists(),
        "checkout_dir": str(checkout_dir),
        "improofbench_root": str(root),
        "repo_url": repo_url,
        "ref": ref,
        "already_exists": False,
    }


def improofbench_root(checkout_dir: Path) -> Path:
    if (checkout_dir / "scripts" / "run_workflow.py").exists():
        return checkout_dir
    return checkout_dir / DEFAULT_FIRSTPROOF_SUBDIR


def run_improofbench_workflow(
    *,
    improofbench_dir: Path,
    problem: str,
    artifact_root: Path,
    workflow: str = "author_critic_long",
    problem_id: str = "coverify_problem",
    run_id: str | None = None,
    output_dir: Path | None = None,
    uv_bin: str = "uv",
    timeout_seconds: int | None = None,
    budget_usd: float | None = None,
    inputs: list[str] | None = None,
    components: list[str] | None = None,
    models: list[str] | None = None,
    additional_instructions: str = "",
) -> BackendResult:
    improofbench_dir = improofbench_dir.resolve()
    if not (improofbench_dir / "scripts" / "run_workflow.py").exists():
        raise FileNotFoundError(f"improofbench root not found: {improofbench_dir}")
    artifact_dir = ensure_artifact_dir(artifact_root, "firstproof")
    oracle_call_id = artifact_dir.name
    prompt_path = write_prompt_file(artifact_dir, problem)
    answer_path = artifact_dir / "answer.md"
    stdout_path = artifact_dir / "stdout.log"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
    output_dir = (output_dir or artifact_dir / "outputs").resolve()
    run_id = run_id or _safe_run_id(problem_id)
    cmd = [
        uv_bin,
        "run",
        "python",
        "scripts/run_workflow.py",
        "--workflow",
        workflow,
        "--problem",
        str(prompt_path),
        "--problem-id",
        problem_id,
        "--run-id",
        run_id,
        "--output",
        str(output_dir),
    ]
    if additional_instructions.strip():
        cmd += ["--additional-instructions", additional_instructions.strip()]
    if budget_usd is not None:
        cmd += ["--budget-usd", str(budget_usd)]
    for value in inputs or []:
        cmd += ["--input", value]
    for value in components or []:
        cmd += ["--component", value]
    for value in models or []:
        cmd += ["--model", value]

    metadata: dict[str, Any] = {
        "oracle_call_id": oracle_call_id,
        "provider": "firstproof-improofbench",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "improofbench_dir": str(improofbench_dir),
        "workflow": workflow,
        "problem_id": problem_id,
        "run_id": run_id,
        "output_dir": str(output_dir),
        "timeout_seconds": timeout_seconds,
        "command": cmd,
        "command_cwd": str(improofbench_dir),
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
            cwd=improofbench_dir,
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
            raise RuntimeError(f"firstproof workflow timed out; artifacts={artifact_dir}") from exc
    stdout_text = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
    out_json = _read_json(output_dir / run_id / "run-metadata.json")
    answer = _render_answer(
        stdout_text=stdout_text,
        output_dir=output_dir,
        run_id=run_id,
        metadata=out_json,
        returncode=process.returncode,
    )
    answer_path.write_text(answer, encoding="utf-8")
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata["timed_out"] = False
    metadata["workflow_metadata"] = out_json if isinstance(out_json, dict) else None
    write_audit_metadata(metadata_path, metadata, artifacts)
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        raise RuntimeError(
            f"firstproof workflow failed with code {process.returncode}; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    return BackendResult(
        answer=answer,
        artifact_dir=artifact_dir,
        provider="firstproof-improofbench",
        oracle_call_id=oracle_call_id,
    )


def _render_answer(*, stdout_text: str, output_dir: Path, run_id: str, metadata: Any, returncode: int | None) -> str:
    lines = [
        "# First Proof improofbench workflow result",
        "",
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


def _safe_run_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"coverify-{cleaned or 'problem'}-{stamp}"


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

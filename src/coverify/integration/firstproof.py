from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from coverify.engine.backend import BackendResult
from coverify.integration.external_workflow import run_external_workflow


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
    subprocess.run(
        [
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
        ],
        check=True,
    )
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
    command = [
        uv_bin,
        "run",
        "python",
        "scripts/run_workflow.py",
        "--workflow",
        workflow,
        "--problem",
        "{problem_path}",
        "--problem-id",
        "{problem_id}",
        "--run-id",
        "{run_id}",
        "--output",
        "{output_dir}",
    ]
    if additional_instructions.strip():
        command += ["--additional-instructions", additional_instructions.strip()]
    if budget_usd is not None:
        command += ["--budget-usd", str(budget_usd)]
    for value in inputs or []:
        command += ["--input", value]
    for value in components or []:
        command += ["--component", value]
    for value in models or []:
        command += ["--model", value]
    return run_external_workflow(
        command=command,
        cwd=improofbench_dir,
        problem=problem,
        artifact_root=artifact_root,
        provider="firstproof-improofbench",
        workflow=workflow,
        problem_id=problem_id,
        run_id=run_id,
        output_dir=output_dir,
        timeout_seconds=timeout_seconds,
    )

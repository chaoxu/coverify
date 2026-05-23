from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class BackendResult:
    answer: str
    artifact_dir: Path
    provider: str


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def ensure_artifact_dir(root: Path, provider: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{utc_stamp()}-{provider}-", dir=root))


def run_fixture_backend(context: str, *, artifact_root: Path) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "fixture")
    answer = "\n".join(
        [
            "# Infinitely Many Primes",
            "",
            "::: {.theorem #thm:infinitely-many-primes title=\"Infinitely many primes\"}",
            "There are infinitely many prime numbers.",
            ":::",
            "",
            "::: {.proof}",
            "Suppose, for contradiction, that there are only finitely many primes,",
            "and list them as $p_1, p_2, \\ldots, p_n$.",
            "Let",
            "",
            "$$",
            "N = p_1 p_2 \\cdots p_n + 1.",
            "$$",
            "",
            "For each listed prime $p_i$, division of $N$ by $p_i$ leaves",
            "remainder $1$. Thus no $p_i$ divides $N$.",
            "",
            "Since $N > 1$, it has a prime divisor $q$. The prime $q$ is not",
            "among $p_1, \\ldots, p_n$, contradicting that the list contained",
            "all primes. Therefore there are infinitely many primes.",
            ":::",
            "",
        ],
    )
    (artifact_dir / "context.md").write_text(context, encoding="utf-8")
    (artifact_dir / "answer.md").write_text(answer, encoding="utf-8")
    (artifact_dir / "metadata.json").write_text(
        json.dumps(
            {
                "provider": "fixture",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return BackendResult(answer=answer, artifact_dir=artifact_dir, provider="fixture")


def terminate_process_group(pid: int, sig: int = signal.SIGTERM) -> None:
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        return
    except PermissionError:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return


def run_codex_backend(
    context: str,
    *,
    artifact_root: Path,
    model: str = "gpt-5.5",
    reasoning_effort: str = "xhigh",
    timeout_seconds: int | None = None,
    codex_bin: str = "codex",
    sandbox: str = "read-only",
) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "codex")
    workdir = artifact_dir / "workdir"
    workdir.mkdir()
    context_path = artifact_dir / "context.md"
    output_path = artifact_dir / "answer.md"
    stdout_path = artifact_dir / "stdout.jsonl"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
    context_path.write_text(context, encoding="utf-8")
    cmd = [
        codex_bin,
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "-C",
        str(workdir),
        "-s",
        sandbox,
        "-m",
        model,
        "-c",
        f'model_reasoning_effort="{reasoning_effort}"',
        "-o",
        str(output_path),
        "-",
    ]
    metadata: dict[str, object] = {
        "provider": "codex",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "workdir": str(workdir),
        "model": model,
        "reasoning_effort": reasoning_effort,
        "timeout_seconds": timeout_seconds,
        "command": cmd,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    started = time.monotonic()
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
        "w",
        encoding="utf-8",
    ) as stderr_file:
        process = subprocess.Popen(
            cmd,
            cwd=workdir,
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            start_new_session=True,
        )
        try:
            process.communicate(input=context, timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            terminate_process_group(process.pid, signal.SIGKILL)
            process.communicate()
            metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            metadata["returncode"] = process.returncode
            metadata["timed_out"] = True
            metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            raise RuntimeError(f"codex backend timed out; artifacts={artifact_dir}") from exc
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        raise RuntimeError(
            f"codex backend failed with code {process.returncode}; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    return BackendResult(
        answer=output_path.read_text(encoding="utf-8"),
        artifact_dir=artifact_dir,
        provider="codex",
    )


def run_script_backend(
    context: str,
    *,
    command: str,
    artifact_root: Path,
    timeout_seconds: int | None = None,
) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "script")
    context_path = artifact_dir / "context.md"
    output_path = artifact_dir / "answer.md"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
    context_path.write_text(context, encoding="utf-8")
    metadata = {
        "provider": "script",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "artifact_dir": str(artifact_dir),
        "timeout_seconds": timeout_seconds,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    started = time.monotonic()
    with output_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
        "w",
        encoding="utf-8",
    ) as stderr_file:
        process = subprocess.run(
            command,
            input=context,
            shell=True,
            text=True,
            stdout=stdout_file,
            stderr=stderr_file,
            timeout=timeout_seconds,
            cwd=artifact_dir,
        )
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8")
        raise RuntimeError(
            f"script backend failed with code {process.returncode}; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    return BackendResult(
        answer=output_path.read_text(encoding="utf-8"),
        artifact_dir=artifact_dir,
        provider="script",
    )

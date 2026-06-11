from __future__ import annotations

import json
import hashlib
import os
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class BackendResult:
    answer: str
    artifact_dir: Path
    provider: str
    oracle_call_id: str


class BackendRunner(Protocol):
    """An oracle invocation: text in, audited ``BackendResult`` out.

    This is the core backend seam. Every backend -- fixture, codex,
    script, and the composite verifying oracle -- satisfies it, which is why a
    verifying oracle can be used anywhere a plain oracle can, and can even nest.
    """

    def __call__(self, context: str) -> BackendResult: ...


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def ensure_artifact_dir(root: Path, provider: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{utc_stamp()}-{provider}-", dir=root))


def write_prompt_file(artifact_dir: Path, prompt: str) -> Path:
    prompt_path = artifact_dir / "prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    return prompt_path


def write_audit_metadata(
    metadata_path: Path,
    metadata: dict[str, object],
    artifacts: dict[str, Path],
) -> None:
    manifest: dict[str, dict[str, object]] = {}
    for name, path in artifacts.items():
        if path.exists():
            manifest[name] = {
                "path": str(path),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }

    metadata["artifacts"] = manifest
    for name, entry in manifest.items():
        metadata[f"{name}_path"] = entry["path"]
        metadata[f"{name}_sha256"] = entry["sha256"]

    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8")
    (metadata_path.parent / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def audit_summary(result: BackendResult) -> str:
    metadata_path = result.artifact_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    lines = [
        "Oracle audit:",
        f"- id: {metadata['oracle_call_id']}",
        f"- provider: {metadata['provider']}",
        f"- artifacts: {metadata['artifact_dir']}",
    ]
    model = metadata.get("model")
    if model:
        lines.append(f"- model: {model}")
    prompt_sha256 = metadata.get("prompt_sha256")
    if prompt_sha256:
        lines.append(f"- prompt_sha256: {prompt_sha256}")
    answer_sha256 = metadata.get("answer_sha256")
    if answer_sha256:
        lines.append(f"- answer_sha256: {answer_sha256}")
    return "\n".join(lines)


def run_fixture_backend(prompt: str, *, artifact_root: Path) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "fixture")
    oracle_call_id = artifact_dir.name
    started_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    answer = "\n".join(
        [
            "There are infinitely many prime numbers.",
            "",
            "Suppose, for contradiction, that there are only finitely many primes,",
            "and list them as $p_1, p_2, \\ldots, p_n$.",
            "Let $N = p_1 p_2 \\cdots p_n + 1$.",
            "For each listed prime $p_i$, division of $N$ by $p_i$ leaves",
            "remainder $1$. Thus no $p_i$ divides $N$.",
            "Since $N > 1$, it has a prime divisor $q$. The prime $q$ is not",
            "among $p_1, \\ldots, p_n$, contradicting that the list contained",
            "all primes. Therefore there are infinitely many primes.",
            "",
        ],
    )
    prompt_path = write_prompt_file(artifact_dir, prompt)
    answer_path = artifact_dir / "answer.md"
    metadata_path = artifact_dir / "metadata.json"
    answer_path.write_text(answer, encoding="utf-8")
    write_audit_metadata(
        metadata_path,
        {
            "oracle_call_id": oracle_call_id,
            "provider": "fixture",
            "started_at": started_at,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "duration_seconds": round(time.monotonic() - started, 3),
            "artifact_dir": str(artifact_dir),
            "returncode": 0,
            "timed_out": False,
        },
        {
            "prompt": prompt_path,
            "answer": answer_path,
        },
    )
    return BackendResult(
        answer=answer,
        artifact_dir=artifact_dir,
        provider="fixture",
        oracle_call_id=oracle_call_id,
    )


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
    prompt: str,
    *,
    artifact_root: Path,
    model: str = "gpt-5.5",
    reasoning_effort: str = "xhigh",
    timeout_seconds: int | None = None,
    codex_bin: str = "codex",
    sandbox: str = "read-only",
) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "codex")
    oracle_call_id = artifact_dir.name
    workdir = artifact_dir / "workdir"
    workdir.mkdir()
    prompt_path = write_prompt_file(artifact_dir, prompt)
    output_path = artifact_dir / "answer.md"
    stdout_path = artifact_dir / "stdout.jsonl"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
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
        "oracle_call_id": oracle_call_id,
        "provider": "codex",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "workdir": str(workdir),
        "model": model,
        "reasoning_effort": reasoning_effort,
        "sandbox": sandbox,
        "timeout_seconds": timeout_seconds,
        "command": cmd,
    }
    artifacts = {
        "prompt": prompt_path,
        "answer": output_path,
        "stdout": stdout_path,
        "stderr": stderr_path,
    }
    write_audit_metadata(metadata_path, metadata, artifacts)
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
            process.communicate(input=prompt, timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            terminate_process_group(process.pid, signal.SIGKILL)
            process.communicate()
            metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            metadata["returncode"] = process.returncode
            metadata["timed_out"] = True
            write_audit_metadata(metadata_path, metadata, artifacts)
            raise RuntimeError(f"codex backend timed out; artifacts={artifact_dir}") from exc
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata["timed_out"] = False
    write_audit_metadata(metadata_path, metadata, artifacts)
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        raise RuntimeError(
            f"codex backend failed with code {process.returncode}; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    if not output_path.exists():
        detail = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        raise RuntimeError(
            "codex backend finished without writing answer.md; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    return BackendResult(
        answer=output_path.read_text(encoding="utf-8"),
        artifact_dir=artifact_dir,
        provider="codex",
        oracle_call_id=oracle_call_id,
    )


def run_claude_backend(
    prompt: str,
    *,
    artifact_root: Path,
    model: str = "opus",
    timeout_seconds: int | None = None,
    claude_bin: str = "claude",
) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "claude")
    oracle_call_id = artifact_dir.name
    workdir = artifact_dir / "workdir"
    workdir.mkdir()
    prompt_path = write_prompt_file(artifact_dir, prompt)
    answer_path = artifact_dir / "answer.md"
    stdout_path = artifact_dir / "stdout.json"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
    cmd = [
        claude_bin,
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
    ]
    metadata: dict[str, object] = {
        "oracle_call_id": oracle_call_id,
        "provider": "claude",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "workdir": str(workdir),
        "model": model,
        "timeout_seconds": timeout_seconds,
        "command": cmd,
    }
    artifacts = {
        "prompt": prompt_path,
        "answer": answer_path,
        "stdout": stdout_path,
        "stderr": stderr_path,
    }
    write_audit_metadata(metadata_path, metadata, artifacts)
    started = time.monotonic()
    with stderr_path.open("w", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(
            cmd,
            cwd=workdir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            text=True,
            start_new_session=True,
        )
        try:
            stdout_text, _ = process.communicate(input=prompt, timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            terminate_process_group(process.pid, signal.SIGKILL)
            stdout_text, _ = process.communicate()
            stdout_path.write_text(stdout_text or "", encoding="utf-8")
            metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            metadata["returncode"] = process.returncode
            metadata["timed_out"] = True
            write_audit_metadata(metadata_path, metadata, artifacts)
            raise RuntimeError(f"claude backend timed out; artifacts={artifact_dir}") from exc
    stdout_path.write_text(stdout_text or "", encoding="utf-8")
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata["timed_out"] = False
    write_audit_metadata(metadata_path, metadata, artifacts)
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        raise RuntimeError(
            f"claude backend failed with code {process.returncode}; "
            f"artifacts={artifact_dir}; stderr={detail[-2000:]}",
        )
    try:
        payload = json.loads(stdout_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"claude backend produced non-JSON output; artifacts={artifact_dir}",
        ) from exc
    answer = payload.get("result") if isinstance(payload, dict) else None
    if isinstance(payload, dict) and payload.get("is_error"):
        raise RuntimeError(
            f"claude backend reported an error result; artifacts={artifact_dir}",
        )
    if not isinstance(answer, str) or not answer.strip():
        raise RuntimeError(
            f"claude backend finished without a result answer; artifacts={artifact_dir}",
        )
    answer_path.write_text(answer, encoding="utf-8")
    write_audit_metadata(metadata_path, metadata, artifacts)
    return BackendResult(
        answer=answer,
        artifact_dir=artifact_dir,
        provider="claude",
        oracle_call_id=oracle_call_id,
    )


def run_script_backend(
    prompt: str,
    *,
    command: str,
    artifact_root: Path,
    timeout_seconds: int | None = None,
) -> BackendResult:
    artifact_dir = ensure_artifact_dir(artifact_root, "script")
    oracle_call_id = artifact_dir.name
    prompt_path = write_prompt_file(artifact_dir, prompt)
    output_path = artifact_dir / "answer.md"
    stderr_path = artifact_dir / "stderr.log"
    metadata_path = artifact_dir / "metadata.json"
    metadata: dict[str, object] = {
        "oracle_call_id": oracle_call_id,
        "provider": "script",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "artifact_dir": str(artifact_dir),
        "timeout_seconds": timeout_seconds,
    }
    artifacts = {
        "prompt": prompt_path,
        "answer": output_path,
        "stderr": stderr_path,
    }
    write_audit_metadata(metadata_path, metadata, artifacts)
    started = time.monotonic()
    with output_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
        "w",
        encoding="utf-8",
    ) as stderr_file:
        process = subprocess.Popen(
            command,
            shell=True,
            text=True,
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            cwd=artifact_dir,
            start_new_session=True,
        )
        try:
            process.communicate(input=prompt, timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            terminate_process_group(process.pid, signal.SIGKILL)
            process.communicate()
            metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
            metadata["duration_seconds"] = round(time.monotonic() - started, 3)
            metadata["returncode"] = process.returncode
            metadata["timed_out"] = True
            write_audit_metadata(metadata_path, metadata, artifacts)
            raise RuntimeError(f"script backend timed out; artifacts={artifact_dir}") from exc
    metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
    metadata["duration_seconds"] = round(time.monotonic() - started, 3)
    metadata["returncode"] = process.returncode
    metadata["timed_out"] = False
    write_audit_metadata(metadata_path, metadata, artifacts)
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
        oracle_call_id=oracle_call_id,
    )

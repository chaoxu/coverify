from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
import tempfile
from typing import Callable, Protocol

from . import store


Runner = Callable[[list[str], str, Path], str]


class WorkerError(store.StoreError):
    pass


class WorkerBackend(Protocol):
    name: str

    def run(self, prompt: str, cwd: Path, model: str = "", runner: Runner | None = None) -> str:
        pass


@dataclass(frozen=True)
class CodexCliBackend:
    name: str = "codex"

    def run(self, prompt: str, cwd: Path, model: str = "", runner: Runner | None = None) -> str:
        command = ["codex"]
        if model:
            command.extend(["--model", model])
        command.extend(["--dangerously-bypass-approvals-and-sandbox"])
        return (runner or run_codex_cli)(command, prompt, cwd)


@dataclass(frozen=True)
class ClaudeCliBackend:
    name: str = "claude"

    def run(self, prompt: str, cwd: Path, model: str = "", runner: Runner | None = None) -> str:
        command = [
            "claude",
            "--print",
            "--output-format",
            "text",
            "--dangerously-skip-permissions",
            "--permission-mode",
            "bypassPermissions",
        ]
        if model:
            command.extend(["--model", model])
        return (runner or run_prompt_arg_cli)(command, prompt, cwd)


@dataclass(frozen=True)
class GeminiCliBackend:
    name: str = "gemini"

    def run(self, prompt: str, cwd: Path, model: str = "", runner: Runner | None = None) -> str:
        command = ["gemini", "--yolo", "--approval-mode", "yolo", "--output-format", "text"]
        if model:
            command.extend(["--model", model])
        command.extend(["--prompt"])
        return (runner or run_prompt_arg_cli)(command, prompt, cwd)


BACKENDS: dict[str, WorkerBackend] = {
    "codex": CodexCliBackend(),
    "claude": ClaudeCliBackend(),
    "gemini": GeminiCliBackend(),
}


def get_backend(name: str) -> WorkerBackend:
    try:
        return BACKENDS[name]
    except KeyError as exc:
        raise WorkerError(f"unknown worker backend: {name}") from exc


def run_codex_cli(command: list[str], prompt: str, cwd: Path) -> str:
    with tempfile.NamedTemporaryFile("r", encoding="utf-8", delete=False) as output_file:
        output_path = Path(output_file.name)
    full_command = [
        *command,
        "exec",
        "--cd",
        str(cwd),
        "--output-last-message",
        str(output_path),
        "--color",
        "never",
        "-",
    ]
    try:
        run_subprocess(full_command, prompt, cwd)
        return output_path.read_text(encoding="utf-8").strip()
    finally:
        output_path.unlink(missing_ok=True)


def run_prompt_arg_cli(command: list[str], prompt: str, cwd: Path) -> str:
    result = run_subprocess([*command, prompt], "", cwd)
    return result.stdout.strip()


def run_subprocess(command: list[str], stdin: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            input=stdin,
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise WorkerError(f"worker CLI not found: {command[0]}") from exc
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or f"{command[0]} failed"
        raise WorkerError(message)
    return result


def build_explorer_prompt(user_prompt: str, context: str = "") -> str:
    return "\n".join(
        [
            "You are an autoprover explorer.",
            "Write one readable Markdown exploration artifact.",
            "Be explicit about what is proved, what is only a direction, and what gaps remain.",
            "Do not claim the main theorem is solved unless the proof is complete.",
            "",
            "User prompt:",
            user_prompt,
            "",
            "Current context:",
            context or "No context supplied.",
        ]
    )


def build_verifier_prompt(artifact_id: str, artifact_text: str) -> str:
    return "\n".join(
        [
            "You are an autoprover verifier.",
            "Review exactly one submitted mathematical artifact.",
            "Be conservative. Approval means the artifact is correct as written.",
            "Return only JSON with these string fields:",
            "verdict, summary, critical_errors, gaps, repair_hints, reusable_parts.",
            "The verdict must be one of: approve, reject, unsure.",
            "",
            f"Artifact id: {artifact_id}",
            "",
            "Artifact text:",
            artifact_text,
        ]
    )


def strip_outer_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    return cleaned


def parse_verifier_json(text: str) -> dict[str, str]:
    cleaned = strip_outer_fence(text)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise WorkerError(f"could not parse verifier JSON: {exc}") from exc
    required = {"verdict", "summary", "critical_errors", "gaps", "repair_hints", "reusable_parts"}
    if not isinstance(data, dict) or not required.issubset(data):
        raise WorkerError("verifier JSON is missing required fields")
    verdict = str(data["verdict"]).strip().lower()
    if verdict not in store.VALID_VERDICTS:
        raise WorkerError(f"invalid verifier verdict: {verdict}")
    return {key: str(data.get(key, "")).strip() for key in required} | {"verdict": verdict}


def run_explorer(
    root: str | Path,
    artifact_id: str,
    title: str,
    artifact_type: str,
    user_prompt: str,
    backend_name: str = "codex",
    model: str = "",
    runner: Runner | None = None,
) -> Path:
    context = store.format_results(store.search(root, user_prompt.split()[0], mode="exploration"))
    prompt = build_explorer_prompt(user_prompt, context)
    backend = get_backend(backend_name)
    body = strip_outer_fence(backend.run(prompt, Path.cwd(), model=model, runner=runner))
    if not body:
        raise WorkerError(f"{backend.name} explorer returned empty output")
    return store.create_draft(root, artifact_id, title, artifact_type, body)


def run_verifier(
    root: str | Path,
    artifact_id: str,
    verifier: str = "worker-verifier",
    backend_name: str = "codex",
    model: str = "",
    runner: Runner | None = None,
) -> Path:
    artifact_path = store.artifact_path(root, artifact_id)
    if not artifact_path.exists():
        raise WorkerError(f"submitted artifact not found: {artifact_id}")
    artifact_text = artifact_path.read_text(encoding="utf-8")
    prompt = build_verifier_prompt(artifact_id, artifact_text)
    backend = get_backend(backend_name)
    output = backend.run(prompt, Path.cwd(), model=model, runner=runner)
    review = parse_verifier_json(output)
    return store.create_review(
        root,
        artifact_id,
        verifier=verifier,
        verdict=review["verdict"],
        summary=review["summary"],
        critical_errors=review["critical_errors"],
        gaps=review["gaps"],
        repair_hints=review["repair_hints"],
        reusable_parts=review["reusable_parts"],
    )

from __future__ import annotations

import json
import re
import shutil
import shlex
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..cosheaf.client import CosheafClient
from ..engine.backend import BackendRunner, run_script_backend, sha256_file
from .repo_oracle import export_cosheaf_source_bundle, sha256_text


PROMPT_KINDS = (
    "author",
    "critic",
    "verifier",
    "kb-writer",
    "tool-request",
    "publication-review",
)

PROMOTION_DECISIONS = ("accept", "request_changes", "reject")
REQUIRED_PUBLICATION_REVIEW_FIELDS = (
    "decision",
    "summary",
    "blocking_issues",
    "quality_issues",
    "required_changes",
)


@dataclass(frozen=True)
class AttemptPaths:
    root: Path

    @property
    def manifest(self) -> Path:
        return self.root / "manifest.json"

    @property
    def goal(self) -> Path:
        return self.root / "goal.md"

    @property
    def source_snapshot(self) -> Path:
        return self.root / "source-snapshot.json"

    @property
    def candidate(self) -> Path:
        return self.root / "candidate"

    @property
    def calls(self) -> Path:
        return self.root / "calls"

    @property
    def checks(self) -> Path:
        return self.root / "checks"

    @property
    def promotion(self) -> Path:
        return self.root / "promotion"


def utc_attempt_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def safe_fragment(value: str) -> str:
    fragment = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return fragment.strip("-") or "attempt"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def attempt_root(attempts_root: Path, attempt_id: str) -> Path:
    return attempts_root / safe_fragment(attempt_id)


def load_attempt(attempts_root: Path, attempt_id: str) -> tuple[AttemptPaths, dict[str, Any]]:
    paths = AttemptPaths(attempt_root(attempts_root, attempt_id))
    if not paths.manifest.exists():
        raise FileNotFoundError(f"attempt not found: {paths.root}")
    return paths, read_json(paths.manifest)


def create_attempt(
    *,
    attempts_root: Path,
    workspace: str,
    branch: str,
    issue: int | None,
    goal_text: str,
    client: CosheafClient,
    attempt_id: str | None = None,
    include_timeline: bool = True,
    export_source_bundle: bool = True,
) -> dict[str, Any]:
    attempt_id = safe_fragment(attempt_id or utc_attempt_id())
    paths = AttemptPaths(attempt_root(attempts_root, attempt_id))
    if paths.root.exists():
        raise FileExistsError(f"attempt already exists: {paths.root}")
    for directory in (paths.candidate, paths.calls, paths.checks, paths.promotion):
        directory.mkdir(parents=True, exist_ok=True)

    tree: Any = None
    issue_payload = client.read_issue(workspace, issue) if issue is not None else None
    timeline = (
        client.read_issue_timeline(workspace, issue)
        if issue is not None and include_timeline
        else None
    )
    if not goal_text.strip() and isinstance(issue_payload, dict):
        item = issue_payload.get("issue") if isinstance(issue_payload.get("issue"), dict) else issue_payload
        title = str(item.get("title") or "").strip() if isinstance(item, dict) else ""
        body = str(item.get("body") or "").strip() if isinstance(item, dict) else ""
        goal_text = "\n\n".join(part for part in (title, body) if part)
    goal_text = goal_text.strip() or f"Attempt for {workspace} on branch {branch}."

    source_bundle = None
    if export_source_bundle:
        bundle = export_cosheaf_source_bundle(
            client,
            workspace=workspace,
            branch=branch,
            root=paths.root / "source-bundle",
        )
        source_bundle = {
            "root": str(bundle.root),
            "source_id": bundle.source_id,
            "snapshot": bundle.snapshot,
            "files": [
                {
                    "path": item.path,
                    "sha256": item.sha256,
                    "bytes": item.byte_size,
                    "lines": item.line_count,
                }
                for item in bundle.files
            ],
            "omitted": [
                {
                    "path": item.path,
                    "reason": item.reason,
                    "bytes": item.byte_size,
                    "sha256": item.sha256,
                }
                for item in bundle.omitted
            ],
        }
        tree = {
            "files": [
                {"path": item["path"], "sha256": item["sha256"], "bytes": item["bytes"]}
                for item in source_bundle["files"]
            ],
            "source": "exported_source_bundle",
        }
    else:
        tree = client.list_workspace_files(workspace, branch=branch)

    source_snapshot = {
        "workspace": workspace,
        "branch": branch,
        "issue_number": issue,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "tree": tree,
        "issue": issue_payload,
        "timeline": timeline,
        "source_bundle": source_bundle,
    }
    paths.goal.write_text(goal_text.rstrip() + "\n", encoding="utf-8")
    write_json(paths.source_snapshot, source_snapshot)
    manifest = {
        "attempt_id": attempt_id,
        "workspace": workspace,
        "branch": branch,
        "issue_number": issue,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "root": str(paths.root),
        "goal_path": str(paths.goal),
        "source_snapshot_path": str(paths.source_snapshot),
        "source_bundle_path": source_bundle["root"] if isinstance(source_bundle, dict) else None,
        "source_id": source_bundle["source_id"] if isinstance(source_bundle, dict) else None,
        "source_snapshot": source_bundle["snapshot"] if isinstance(source_bundle, dict) else None,
        "state": "active",
    }
    write_json(paths.manifest, manifest)
    return attempt_status(paths)


def candidate_files(paths: AttemptPaths) -> list[dict[str, Any]]:
    files_root = paths.candidate / "files"
    if not files_root.exists():
        return []
    files: list[dict[str, Any]] = []
    for path in sorted(item for item in files_root.rglob("*") if item.is_file() and not item.is_symlink()):
        files.append(
            {
                "path": path.relative_to(files_root).as_posix(),
                "local_path": str(path),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            },
        )
    return files


def candidate_path_problems(paths: AttemptPaths) -> list[str]:
    files_root = paths.candidate / "files"
    if not files_root.exists():
        return []
    problems: list[str] = []
    for path in sorted(files_root.rglob("*")):
        rel = path.relative_to(files_root).as_posix()
        if path.is_symlink():
            problems.append(f"{rel} is a symlink; candidate files must be regular local UTF-8 text")
        elif path.is_file():
            try:
                path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                problems.append(f"{rel} is not valid UTF-8 text")
        elif path.is_dir():
            continue
        else:
            problems.append(f"{rel} is not a regular file")
    return problems


def list_call_records(paths: AttemptPaths) -> list[dict[str, Any]]:
    if not paths.calls.exists():
        return []
    records: list[dict[str, Any]] = []
    for directory in sorted(item for item in paths.calls.iterdir() if item.is_dir()):
        record_path = directory / "record.json"
        if record_path.exists():
            record = read_json(record_path)
        else:
            record = {"call_id": directory.name, "path": str(directory)}
        records.append(record)
    return records


def attempt_status(paths: AttemptPaths) -> dict[str, Any]:
    manifest = read_json(paths.manifest)
    promotion_record = paths.promotion / "promotion.json"
    return {
        "attempt_id": manifest.get("attempt_id"),
        "root": str(paths.root),
        "workspace": manifest.get("workspace"),
        "branch": manifest.get("branch"),
        "issue_number": manifest.get("issue_number"),
        "state": manifest.get("state"),
        "goal_path": str(paths.goal),
        "source_snapshot_path": str(paths.source_snapshot),
        "source_bundle_path": manifest.get("source_bundle_path"),
        "source_id": manifest.get("source_id"),
        "source_snapshot": manifest.get("source_snapshot"),
        "candidate_files": candidate_files(paths),
        "calls": list_call_records(paths),
        "promotion": read_json(promotion_record) if promotion_record.exists() else None,
    }


def read_text_if_exists(path: Path, default: str = "") -> str:
    return path.read_text(encoding="utf-8") if path.exists() else default


def read_candidate_text(paths: AttemptPaths, *, max_chars: int = 80000) -> str:
    parts: list[str] = []
    notes = paths.candidate / "notes.md"
    if notes.exists():
        parts.append(f"## candidate/notes.md\n\n{read_text_if_exists(notes)}")
    files_root = paths.candidate / "files"
    if files_root.exists():
        for path in sorted(files_root.rglob("*")):
            if path.is_symlink():
                parts.append(f"## candidate/files/{path.relative_to(files_root).as_posix()}\n\n(omitted: symlink candidate files are not allowed)")
                continue
            if not path.is_file():
                continue
            if path.stat().st_size > 200_000:
                parts.append(f"## candidate/files/{path.relative_to(files_root).as_posix()}\n\n(omitted: file is larger than 200000 bytes)")
                continue
            body = path.read_text(encoding="utf-8", errors="replace")
            parts.append(
                f"## candidate/files/{path.relative_to(files_root).as_posix()}\n\n{body}",
            )
    text = "\n\n".join(parts).strip()
    if len(text) > max_chars:
        return text[:max_chars] + "\n\n[truncated]"
    return text or "(no candidate files yet)"


def latest_calls_summary(paths: AttemptPaths, *, limit: int = 8) -> str:
    records = list_call_records(paths)[-limit:]
    if not records:
        return "(no call records yet)"
    lines: list[str] = []
    for record in records:
        parts = [
            str(record.get("call_id") or ""),
            f"role={record.get('role') or 'unknown'}",
            f"provider={record.get('provider') or 'unknown'}",
        ]
        decision = record.get("decision")
        if decision:
            parts.append(f"decision={decision}")
        lines.append("- " + " ".join(part for part in parts if part))
    return "\n".join(lines)


def build_attempt_prompt(
    paths: AttemptPaths,
    *,
    kind: str,
    instructions: str = "",
) -> dict[str, Any]:
    if kind not in PROMPT_KINDS:
        raise ValueError(f"unknown prompt kind: {kind}")
    manifest = read_json(paths.manifest)
    source_snapshot = read_json(paths.source_snapshot)
    goal = paths.goal.read_text(encoding="utf-8")
    candidate = read_candidate_text(paths)
    calls = latest_calls_summary(paths)
    extra = instructions.strip() or "(none)"
    body = _prompt_body(
        kind=kind,
        goal=goal,
        candidate=candidate,
        calls=calls,
        source_snapshot=source_snapshot,
        instructions=extra,
    )
    payload = {
        "attempt_id": manifest.get("attempt_id"),
        "kind": kind,
        "workspace": manifest.get("workspace"),
        "branch": manifest.get("branch"),
        "issue_number": manifest.get("issue_number"),
        "prompt": body,
        "prompt_sha256": sha256_text(body),
        "source_snapshot_path": str(paths.source_snapshot),
        "source_bundle_path": manifest.get("source_bundle_path"),
        "source_id": manifest.get("source_id"),
        "candidate_files": candidate_files(paths),
        "backend_invoked": False,
    }
    return payload


def _prompt_body(
    *,
    kind: str,
    goal: str,
    candidate: str,
    calls: str,
    source_snapshot: dict[str, Any],
    instructions: str,
) -> str:
    common = f"""\
You are working inside one local Coverify atomic attempt.

Core boundary:
- Cosheaf stores durable mathematical knowledge.
- This attempt bundle stores private work.
- Do not put raw transcripts, scratch calculations, huge logs, or half-written proof fragments into the final Coflat/Cosheaf artifact.
- Do not hard-wrap ordinary prose paragraphs at arbitrary source-column widths.
- Do not use `>` blockquotes in Coflat artifacts; use a `::: {{.blockquote}}` fenced div.
- Source-grounded claims need exact paths, ranges, and hashes when applicable.
- Label status honestly: proved, checked computation, conjectural, obstruction, precise gap, failed route, or speculative route.
- Identify the closest known failed route and explain why this attempt is materially different, or state that no close failed route was found.

Goal:
{goal.rstrip()}

Current candidate:
{candidate}

Recent call records:
{calls}

Source snapshot metadata:
```json
{json.dumps(_snapshot_summary(source_snapshot), indent=2, sort_keys=True)}
```

Extra instructions:
{instructions}
"""
    if kind == "publication-review":
        return common + """
Task:
Decide whether the proposed candidate should enter the Cosheaf knowledge base. Check correctness, usefulness, concision, source grounding, status clarity, duplicate content, artifact size, failed-route quality, and retry novelty.

Gate question:
Can this safely improve the shared mathematical memory?

Return exactly this structure:

decision: accept|request_changes|reject
summary: one concise paragraph
blocking_issues:
- ...
quality_issues:
- ...
required_changes:
- ...
"""
    if kind == "critic":
        return common + """
Task:
Review the current candidate against the goal and source snapshot. Do not rewrite the artifact. Identify blocking mathematical or knowledge-base quality issues, repeated failed routes, missing citations, unsupported claims, and the smallest concrete failure when applicable.

Return exactly this structure:

decision: accept|request_changes|reject
summary: one concise paragraph
blocking_issues:
- ...
next_feedback:
- ...
"""
    if kind == "author":
        return common + """
Task:
Produce or improve one coherent candidate Coflat/Cosheaf change. Keep scratch work out of the final artifact. If the goal is exploratory, mark speculation. If it is mathematical resolution, use one exact target with exact hypotheses, allowed context, relevant failed routes, required method if any, and one artifact type from src/coverify/math_contract.py.

Return a concise plan plus the candidate content or file patch. If a tool or council call is needed, ask one specific subquestion instead of broad brainstorming.
"""
    if kind == "kb-writer":
        return common + """
Task:
Distill only durable knowledge from this attempt into Coflat/Cosheaf-ready prose. Preserve source meaning. Do not add stronger claims than the evidence supports. Prefer compact failed-route lessons, checked computation summaries, small certificates, and status updates.
"""
    if kind == "tool-request":
        return common + """
Task:
Write one exact project-tool request. Include input, expected output, verifier or checker command when available, artifact size policy, and how the result should be cited if promoted.
"""
    return common + """
Task:
Verify the current candidate under the selected contract. Reject nearby-target answers, ignored forced methods, hidden source use, and status claims stronger than the evidence. Identify the smallest failure or precise gap when the candidate is not complete.
"""


def _snapshot_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
    tree = snapshot.get("tree")
    issue = snapshot.get("issue")
    timeline = snapshot.get("timeline")
    source_bundle = snapshot.get("source_bundle")
    return {
        "workspace": snapshot.get("workspace"),
        "branch": snapshot.get("branch"),
        "issue_number": snapshot.get("issue_number"),
        "captured_at": snapshot.get("captured_at"),
        "tree_type": type(tree).__name__,
        "issue_present": issue is not None,
        "timeline_present": timeline is not None,
        "source_bundle": (
            {
                "root": source_bundle.get("root"),
                "source_id": source_bundle.get("source_id"),
                "snapshot": source_bundle.get("snapshot"),
                "file_count": len(source_bundle.get("files") or []),
                "omitted_count": len(source_bundle.get("omitted") or []),
            }
            if isinstance(source_bundle, dict)
            else None
        ),
    }


def next_call_id(paths: AttemptPaths, role: str) -> str:
    existing = [item.name for item in paths.calls.iterdir() if item.is_dir()] if paths.calls.exists() else []
    return f"{len(existing) + 1:03d}-{safe_fragment(role)}"


def record_call(
    paths: AttemptPaths,
    *,
    call_dir: Path,
    role: str,
    copy: bool = True,
) -> dict[str, Any]:
    if not call_dir.exists() or not call_dir.is_dir():
        raise FileNotFoundError(f"call dir not found: {call_dir}")
    call_id = next_call_id(paths, role)
    target = paths.calls / call_id
    if copy:
        shutil.copytree(call_dir, target)
    else:
        target.mkdir(parents=True, exist_ok=False)
    metadata_path = target / "metadata.json"
    metadata = read_json(metadata_path) if metadata_path.exists() else {}
    answer_path = target / "answer.md"
    decision = parse_decision(answer_path.read_text(encoding="utf-8")) if answer_path.exists() else None
    prompt_path = target / "prompt.md"
    prompt_sha256 = sha256_text(prompt_path.read_text(encoding="utf-8")) if prompt_path.exists() else None
    record = {
        "call_id": call_id,
        "role": role,
        "path": str(target),
        "source_call_dir": str(call_dir),
        "provider": metadata.get("provider"),
        "oracle_call_id": metadata.get("oracle_call_id"),
        "decision": decision,
        "prompt_sha256": prompt_sha256 or metadata.get("prompt_sha256"),
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(target / "record.json", record)
    return record


def run_attempt_call(
    paths: AttemptPaths,
    *,
    kind: str,
    backend: BackendRunner,
    instructions: str = "",
) -> dict[str, Any]:
    prompt_payload = build_attempt_prompt(paths, kind=kind, instructions=instructions)
    result = backend(str(prompt_payload["prompt"]))
    record = record_call(paths, call_dir=result.artifact_dir, role=kind)
    return {
        "ok": True,
        "attempt_id": prompt_payload["attempt_id"],
        "kind": kind,
        "answer": result.answer,
        "backend_provider": result.provider,
        "oracle_call_id": result.oracle_call_id,
        "backend_artifact_dir": str(result.artifact_dir),
        "record": record,
    }


def parse_decision(text: str) -> str | None:
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            value = payload.get("decision")
            if isinstance(value, str) and value.strip().lower() in PROMOTION_DECISIONS:
                return value.strip().lower()
    match = re.search(r"(?im)^\s*decision\s*:\s*(accept|request_changes|reject)\s*$", text)
    if match:
        return match.group(1).lower()
    return None


def validate_publication_review(text: str, *, expected_prompt_sha256: str | None, record: dict[str, Any] | None) -> dict[str, Any]:
    decision = parse_decision(text)
    errors: list[str] = []
    if not decision:
        errors.append("review did not contain a valid decision")
    lower = text.lower()
    for field in REQUIRED_PUBLICATION_REVIEW_FIELDS:
        if not re.search(rf"(?im)^\s*{re.escape(field)}\s*:", text):
            errors.append(f"review missing required field: {field}")
    record_prompt_sha = str(record.get("prompt_sha256") or "") if record else ""
    if expected_prompt_sha256 and not record_prompt_sha:
        errors.append("review missing prompt hash for freshness check")
    elif expected_prompt_sha256 and record_prompt_sha != expected_prompt_sha256:
        errors.append("review prompt hash does not match current publication-review prompt")
    if "decision: accept" in lower and ("blocking_issues:\n- ..." in lower or "quality_issues:\n- ..." in lower):
        errors.append("review appears to contain placeholder issue sections")
    return {
        "decision": decision,
        "valid": not errors,
        "errors": errors,
    }


def run_candidate_checks(paths: AttemptPaths, *, max_file_bytes: int = 200_000) -> dict[str, Any]:
    files = candidate_files(paths)
    errors: list[str] = candidate_path_problems(paths)
    warnings: list[str] = []
    if not files:
        errors.append("candidate/files contains no files to promote")
    for file in files:
        if int(file["bytes"]) > max_file_bytes:
            errors.append(f"{file['path']} exceeds max file size {max_file_bytes}")
    checks = {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "candidate_files": files,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(paths.checks / "candidate.json", checks)
    return checks


def run_validation_command(
    paths: AttemptPaths,
    *,
    command: str,
    artifact_root: Path,
    timeout_seconds: int | None,
) -> dict[str, Any]:
    if not command.strip():
        return {"ok": True, "skipped": True}
    manifest = read_json(paths.manifest)
    source_bundle_path = str(manifest.get("source_bundle_path") or "")
    files_dir = paths.candidate / "files"
    replacements = {
        "attempt_root": shlex.quote(str(paths.root)),
        "candidate_dir": shlex.quote(str(paths.candidate)),
        "candidate_files_dir": shlex.quote(str(files_dir)),
        "source_bundle": shlex.quote(source_bundle_path),
        "checks_dir": shlex.quote(str(paths.checks)),
    }
    formatted = command.format(**replacements)
    try:
        result = run_script_backend(
            "",
            command=formatted,
            artifact_root=artifact_root,
            timeout_seconds=timeout_seconds,
        )
        artifact_dir = result.artifact_dir
        stdout = result.answer
        error = None
    except RuntimeError as exc:
        match = re.search(r"artifacts=([^;\\s]+)", str(exc))
        artifact_dir = Path(match.group(1)) if match else artifact_root
        stdout_path = artifact_dir / "answer.md"
        stdout = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
        error = str(exc)
    metadata_path = artifact_dir / "metadata.json"
    metadata = read_json(metadata_path) if metadata_path.exists() else {}
    validation = {
        "ok": metadata.get("returncode") == 0,
        "command": formatted,
        "artifact_dir": str(artifact_dir),
        "stdout": stdout,
        "error": error,
        "returncode": metadata.get("returncode"),
        "timed_out": metadata.get("timed_out"),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(paths.checks / "validation.json", validation)
    return validation


def run_publication_review(
    paths: AttemptPaths,
    *,
    backend: BackendRunner | None = None,
    review_call_dir: Path | None = None,
    instructions: str = "",
) -> dict[str, Any]:
    prompt_payload = build_attempt_prompt(paths, kind="publication-review", instructions=instructions)
    paths.promotion.mkdir(parents=True, exist_ok=True)
    (paths.promotion / "prompt.md").write_text(str(prompt_payload["prompt"]), encoding="utf-8")
    write_json(paths.promotion / "preview.json", prompt_payload)
    record: dict[str, Any] | None = None
    answer = ""
    if review_call_dir is not None:
        record = record_call(paths, call_dir=review_call_dir, role="publication-review")
        answer_path = Path(record["path"]) / "answer.md"
        answer = answer_path.read_text(encoding="utf-8") if answer_path.exists() else ""
    elif backend is not None:
        result = backend(str(prompt_payload["prompt"]))
        record = record_call(paths, call_dir=result.artifact_dir, role="publication-review")
        answer = result.answer
    review_validation = (
        validate_publication_review(
            answer,
            expected_prompt_sha256=str(prompt_payload["prompt_sha256"]),
            record=record,
        )
        if answer
        else {"decision": None, "valid": False, "errors": []}
    )
    decision = review_validation["decision"]
    review_valid = bool(review_validation["valid"])
    promotion = {
        "attempt_id": read_json(paths.manifest).get("attempt_id"),
        "decision": decision or ("invalid" if answer else "pending"),
        "accepted": decision == "accept",
        "review_valid": review_valid,
        "review_errors": review_validation["errors"],
        "review_record": record,
        "prompt_path": str(paths.promotion / "prompt.md"),
        "preview_path": str(paths.promotion / "preview.json"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(paths.promotion / "promotion.json", promotion)
    return promotion


def write_candidate_to_branch(
    *,
    paths: AttemptPaths,
    client: CosheafClient,
    workspace: str,
    branch: str,
    create_branch: bool,
) -> list[dict[str, Any]]:
    contents = read_candidate_contents(paths)
    if create_branch:
        client.create_branch(workspace, branch)
    results: list[dict[str, Any]] = []
    for repo_path, content in contents:
        result = client.write_branch_file(workspace, repo_path, branch, content)
        results.append({"path": repo_path, "result": result})
    return results


def read_candidate_contents(paths: AttemptPaths) -> list[tuple[str, str]]:
    files_root = paths.candidate / "files"
    if not files_root.exists():
        raise FileNotFoundError("candidate/files does not exist")
    problems = candidate_path_problems(paths)
    if problems:
        raise ValueError("; ".join(problems))
    contents: list[tuple[str, str]] = []
    for path in sorted(item for item in files_root.rglob("*") if item.is_file() and not item.is_symlink()):
        repo_path = path.relative_to(files_root).as_posix()
        contents.append((repo_path, path.read_text(encoding="utf-8")))
    return contents

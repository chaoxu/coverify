"""Repo-snapshot oracle harness.

This module is the narrow waist for v1 math chat: a caller provides a directory
containing the allowed files plus a question, and Coverify prepares bounded
repo context, asks a reasoner, and verifies the candidate before publication.
It deliberately knows nothing about Forgejo, issues, PRs, or git history.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..engine.backend import BackendResult, BackendRunner
from ..engine.verifying import ERROR, parse_verdict


CHAT_META_MARKER = "cosheaf-chat-meta"
CHAT_META_RE = re.compile(
    rf"<!--\s*{re.escape(CHAT_META_MARKER)}\s*(\{{.*?\}})\s*-->",
    re.DOTALL,
)

STOPWORDS = {
    "about",
    "again",
    "also",
    "from",
    "have",
    "into",
    "that",
    "the",
    "then",
    "there",
    "these",
    "this",
    "with",
    "what",
    "when",
    "where",
    "which",
    "while",
    "would",
    "could",
    "should",
}

STRONG_TERMS = {
    "prove",
    "proof",
    "derive",
    "theorem",
    "lemma",
    "counterexample",
    "disprove",
    "verify",
    "correct",
    "obstruction",
    "bound",
}


@dataclass(frozen=True)
class SourceFile:
    path: str
    content: str
    sha256: str
    byte_size: int
    line_count: int


@dataclass(frozen=True)
class OmittedFile:
    path: str
    reason: str
    byte_size: int
    sha256: str | None = None


@dataclass(frozen=True)
class SourceBundle:
    root: Path
    source_id: str
    snapshot: str
    files: list[SourceFile]
    omitted: list[OmittedFile]


@dataclass(frozen=True)
class SourceSnippet:
    path: str
    line_start: int
    line_end: int
    text: str
    score: int


@dataclass(frozen=True)
class GatheredContext:
    snippets: list[SourceSnippet]
    warnings: list[str]
    tier: str


@dataclass(frozen=True)
class RepoOracleResult:
    ok: bool
    answer: str
    verification: str
    tier: str
    source_id: str
    snapshot: str
    sources: list[dict[str, object]]
    warnings: list[str]
    backend_provider: str
    oracle_call_id: str
    backend_artifact_dir: str
    verifier_provider: str | None = None
    verifier_call_id: str | None = None
    verifier_artifact_dir: str | None = None
    verifier_answer: str | None = None

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = {
            "ok": self.ok,
            "answer": self.answer,
            "verification": self.verification,
            "tier": self.tier,
            "source_id": self.source_id,
            "snapshot": self.snapshot,
            "sources": self.sources,
            "warnings": self.warnings,
            "backend_provider": self.backend_provider,
            "oracle_call_id": self.oracle_call_id,
            "backend_artifact_dir": self.backend_artifact_dir,
        }
        if self.verifier_provider is not None:
            out["verifier_provider"] = self.verifier_provider
        if self.verifier_call_id is not None:
            out["verifier_call_id"] = self.verifier_call_id
        if self.verifier_artifact_dir is not None:
            out["verifier_artifact_dir"] = self.verifier_artifact_dir
        if self.verifier_answer is not None:
            out["verifier_answer"] = self.verifier_answer
        return out


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def parse_chat_metadata(body: str) -> dict[str, Any]:
    match = CHAT_META_RE.search(body)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def strip_chat_metadata(body: str) -> str:
    return CHAT_META_RE.sub("", body).strip()


def chat_metadata_comment(metadata: dict[str, object]) -> str:
    return "<!-- " + CHAT_META_MARKER + "\n" + json.dumps(metadata, indent=2, sort_keys=True) + "\n-->"


def chat_issue_body(message: str, *, branch: str) -> str:
    return "\n\n".join(
        [
            chat_metadata_comment({"kind": "cosheaf-chat", "branch": branch}),
            message.strip(),
        ],
    ).strip()


def answer_with_metadata(answer: str, metadata: dict[str, object]) -> str:
    return "\n\n".join([answer.rstrip(), chat_metadata_comment(metadata)]).strip() + "\n"


def _tracked_files(root: Path) -> list[Path] | None:
    if not (root / ".git").exists():
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    paths: list[Path] = []
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        rel = raw.decode("utf-8", errors="surrogateescape")
        paths.append(root / rel)
    return paths


def _walk_source_paths(root: Path) -> list[Path]:
    tracked = _tracked_files(root)
    if tracked is not None:
        return sorted((path for path in tracked if path.is_file()), key=lambda p: p.relative_to(root).as_posix())
    paths: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(root).parts
        if ".git" in rel_parts:
            continue
        paths.append(path)
    return sorted(paths, key=lambda p: p.relative_to(root).as_posix())


def load_source_bundle(
    root: Path,
    *,
    source_id: str | None = None,
    max_file_bytes: int = 1_000_000,
) -> SourceBundle:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"source bundle root is not a directory: {root}")
    files: list[SourceFile] = []
    omitted: list[OmittedFile] = []
    for path in _walk_source_paths(root):
        rel = path.relative_to(root).as_posix()
        data = path.read_bytes()
        digest = sha256_bytes(data)
        if len(data) > max_file_bytes:
            omitted.append(OmittedFile(path=rel, reason="too_large", byte_size=len(data), sha256=digest))
            continue
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            omitted.append(OmittedFile(path=rel, reason="non_utf8", byte_size=len(data), sha256=digest))
            continue
        files.append(
            SourceFile(
                path=rel,
                content=content,
                sha256=digest,
                byte_size=len(data),
                line_count=max(1, content.count("\n") + 1),
            ),
        )
    snapshot = source_snapshot(files, omitted)
    return SourceBundle(
        root=root,
        source_id=source_id or f"local:{snapshot}",
        snapshot=snapshot,
        files=files,
        omitted=omitted,
    )


def source_snapshot(files: list[SourceFile], omitted: list[OmittedFile]) -> str:
    digest = hashlib.sha256()
    for file in sorted(files, key=lambda f: f.path):
        digest.update(b"file\0")
        digest.update(file.path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.sha256.encode("ascii"))
        digest.update(b"\0")
    for item in sorted(omitted, key=lambda f: f.path):
        digest.update(b"omitted\0")
        digest.update(item.path.encode("utf-8"))
        digest.update(b"\0")
        digest.update((item.sha256 or "").encode("ascii"))
        digest.update(b"\0")
        digest.update(item.reason.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()[:16]


def materialize_source_bundle(
    files: dict[str, str],
    *,
    source_id: str,
    root: Path | None = None,
) -> SourceBundle:
    if root is None:
        root = Path(tempfile.mkdtemp(prefix="coverify-source-bundle-"))
    elif root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        if rel.startswith("/") or ".." in Path(rel).parts:
            raise ValueError(f"unsafe source path: {rel}")
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return load_source_bundle(root, source_id=source_id)


def export_cosheaf_source_bundle(
    client: Any,
    *,
    workspace: str,
    branch: str,
    root: Path | None = None,
) -> SourceBundle:
    tree = client.list_workspace_files(workspace, branch=branch)
    entries = tree.get("files") if isinstance(tree, dict) else None
    if not isinstance(entries, list):
        raise RuntimeError("Cosheaf tree response did not contain files")
    files: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        path = entry["path"]
        response = client.read_file(workspace, path, branch=branch)
        content = response.get("content") if isinstance(response, dict) else None
        if isinstance(content, str):
            files[path] = content
    provisional = materialize_source_bundle(
        files,
        source_id=f"cosheaf:{workspace}:{branch}:pending",
        root=root,
    )
    final_source_id = f"cosheaf:{workspace}:{branch}:{provisional.snapshot}"
    return load_source_bundle(provisional.root, source_id=final_source_id)


def _tokens(text: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[A-Za-z0-9_:@]{3,}", text.lower())
        if token not in STOPWORDS
    ]


def _score_file(file: SourceFile, tokens: list[str]) -> int:
    haystack = f"{file.path}\n{file.content}".lower()
    score = 0
    for token in tokens:
        if token in file.path.lower():
            score += 8
        score += min(haystack.count(token), 6)
    return score


def _snippet_for(file: SourceFile, tokens: list[str], *, context_lines: int = 8) -> SourceSnippet:
    lines = file.content.splitlines()
    match_index = 0
    for index, line in enumerate(lines):
        lowered = line.lower()
        if any(token in lowered for token in tokens):
            match_index = index
            break
    start = max(0, match_index - context_lines)
    end = min(len(lines), match_index + context_lines + 1)
    return SourceSnippet(
        path=file.path,
        line_start=start + 1,
        line_end=max(start + 1, end),
        text="\n".join(lines[start:end]),
        score=_score_file(file, tokens),
    )


def gather_context(
    bundle: SourceBundle,
    *,
    question: str,
    thread_context: str = "",
    max_context_chars: int = 60_000,
    max_files: int = 12,
) -> GatheredContext:
    query = f"{question}\n{thread_context}"
    tokens = _tokens(query)
    scored = [(_score_file(file, tokens), file) for file in bundle.files]
    scored.sort(key=lambda item: (-item[0], item[1].path))
    selected: list[SourceSnippet] = []
    used = 0
    for score, file in scored:
        if score <= 0 and selected:
            continue
        snippet = _snippet_for(file, tokens)
        cost = len(snippet.text) + len(snippet.path) + 80
        if selected and used + cost > max_context_chars:
            continue
        selected.append(snippet)
        used += cost
        if len(selected) >= max_files:
            break
    warnings: list[str] = []
    if not selected and bundle.files:
        for file in bundle.files[: min(max_files, len(bundle.files))]:
            snippet = _snippet_for(file, tokens)
            selected.append(snippet)
    if bundle.omitted:
        warnings.append(
            f"{len(bundle.omitted)} non-text or too-large file(s) were listed in the source bundle but not injected.",
        )
    if not bundle.files:
        warnings.append("No UTF-8 text files were available in the source bundle.")
    return GatheredContext(
        snippets=selected,
        warnings=warnings,
        tier=classify_tier(question),
    )


def classify_tier(question: str) -> str:
    tokens = set(_tokens(question))
    return "strong" if tokens & STRONG_TERMS else "light"


def _format_snippets(snippets: list[SourceSnippet]) -> str:
    parts: list[str] = []
    for snippet in snippets:
        parts.extend(
            [
                f"### {snippet.path}:{snippet.line_start}-{snippet.line_end}",
                "```text",
                snippet.text,
                "```",
                "",
            ],
        )
    return "\n".join(parts).strip()


def build_reasoner_prompt(
    *,
    question: str,
    thread_context: str,
    bundle: SourceBundle,
    gathered: GatheredContext,
) -> str:
    warnings = "\n".join(f"- {warning}" for warning in gathered.warnings) or "- none"
    return "\n".join(
        [
            "# Coverify Repo-Snapshot Math Chat",
            "",
            "Answer the user's mathematical question using only the allowed sources",
            "below plus general mathematical knowledge. You may derive new arguments",
            "from the repo context. You must not use issues, PRs, git history, web,",
            "sibling repos, local notes, or hidden memory.",
            "",
            "Repo-specific claims must be supported by the source bundle. If files",
            "conflict, report the conflict unless the source bundle resolves it.",
            "",
            "## Source bundle",
            f"- source_id: {bundle.source_id}",
            f"- snapshot: {bundle.snapshot}",
            "",
            "## Warnings",
            warnings,
            "",
            "## Current chat thread",
            thread_context.strip() or "(no prior thread context supplied)",
            "",
            "## Gathered repo context",
            _format_snippets(gathered.snippets) or "(no repo context selected)",
            "",
            "## User question",
            question.strip(),
            "",
            "## Required answer behavior",
            "- Be concise but complete.",
            "- Cite repo files for repo-specific facts using `path:line` when useful.",
            "- Standard mathematical facts do not need citations.",
            "- If support is missing, say what is missing.",
            "- Do not write or propose direct repo edits.",
        ],
    )


def build_verifier_prompt(
    *,
    question: str,
    thread_context: str,
    bundle: SourceBundle,
    gathered: GatheredContext,
    candidate: str,
) -> str:
    return "\n".join(
        [
            "# Coverify Repo-Snapshot Verification",
            "",
            "Act as an adversarial mathematical verifier. Check the candidate answer",
            "against the allowed source bundle and the current chat thread.",
            "",
            "Reject if it uses issues, PRs, git history, web, sibling repos, local",
            "notes, hidden memory, or any repo-specific fact unsupported by the",
            "source snippets. Reject if a proof step is invalid or if a conflict is",
            "smoothed over as settled knowledge.",
            "",
            "Write findings, then output exactly one line:",
            "",
            "VERDICT: PASS | FAIL",
            "",
            "## Source bundle",
            f"- source_id: {bundle.source_id}",
            f"- snapshot: {bundle.snapshot}",
            "",
            "## Current chat thread",
            thread_context.strip() or "(no prior thread context supplied)",
            "",
            "## Gathered repo context",
            _format_snippets(gathered.snippets) or "(no repo context selected)",
            "",
            "## User question",
            question.strip(),
            "",
            "## Candidate answer",
            candidate,
        ],
    )


def verification_from_metadata(result: BackendResult) -> str | None:
    metadata_path = result.artifact_dir / "metadata.json"
    if not metadata_path.exists():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if metadata.get("provider") != "verifying" and result.provider != "verifying":
        return None
    value = metadata.get("verified")
    if value is True:
        return "passed"
    if value is False:
        return "failed"
    verdicts = metadata.get("final_verdicts")
    if isinstance(verdicts, list) and verdicts:
        return "passed" if all(v == "PASS" for v in verdicts) else "failed"
    return None


def run_repo_oracle(
    *,
    bundle: SourceBundle,
    question: str,
    answer_backend: BackendRunner,
    verifier_backend: BackendRunner | None,
    thread_context: str = "",
    max_context_chars: int = 60_000,
) -> RepoOracleResult:
    if not question.strip():
        raise ValueError("question is empty")
    gathered = gather_context(
        bundle,
        question=question,
        thread_context=thread_context,
        max_context_chars=max_context_chars,
    )
    prompt = build_reasoner_prompt(
        question=question,
        thread_context=thread_context,
        bundle=bundle,
        gathered=gathered,
    )
    answer_result = answer_backend(prompt)
    verification = verification_from_metadata(answer_result)
    verifier_result: BackendResult | None = None
    verifier_answer: str | None = None
    if verification is None:
        if verifier_backend is None:
            raise ValueError("repo oracle requires a verifier backend unless the answer backend is verifying")
        verifier_result = verifier_backend(
            build_verifier_prompt(
                question=question,
                thread_context=thread_context,
                bundle=bundle,
                gathered=gathered,
                candidate=answer_result.answer,
            ),
        )
        verifier_answer = verifier_result.answer
        try:
            verdict = parse_verdict(verifier_result.answer).value
        except ValueError:
            verdict = ERROR
        verification = "passed" if verdict == "PASS" else "failed" if verdict == "FAIL" else "error"

    ok = verification == "passed"
    final_answer = answer_result.answer
    warnings = list(gathered.warnings)
    if not ok:
        warnings.append("Candidate answer was not verified; returning an explicit refusal summary.")
        final_answer = "\n".join(
            [
                "I could not confidently verify the candidate answer from the current repo snapshot.",
                "",
                "Verifier output:",
                "",
                verifier_answer or f"verification status: {verification}",
            ],
        )
    return RepoOracleResult(
        ok=ok,
        answer=final_answer,
        verification=verification,
        tier=gathered.tier,
        source_id=bundle.source_id,
        snapshot=bundle.snapshot,
        sources=[
            {
                "path": snippet.path,
                "line_start": snippet.line_start,
                "line_end": snippet.line_end,
                "score": snippet.score,
            }
            for snippet in gathered.snippets
        ],
        warnings=warnings,
        backend_provider=answer_result.provider,
        oracle_call_id=answer_result.oracle_call_id,
        backend_artifact_dir=str(answer_result.artifact_dir),
        verifier_provider=verifier_result.provider if verifier_result else None,
        verifier_call_id=verifier_result.oracle_call_id if verifier_result else None,
        verifier_artifact_dir=str(verifier_result.artifact_dir) if verifier_result else None,
        verifier_answer=verifier_answer,
    )


def export_bundle_to_temp(
    exporter: Callable[[Path], SourceBundle],
    *,
    run_root: Path,
) -> SourceBundle:
    target = Path(tempfile.mkdtemp(prefix="source-bundle-", dir=run_root))
    try:
        return exporter(target)
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise

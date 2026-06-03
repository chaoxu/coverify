"""Repo-snapshot oracle tools.

This module is the narrow interface for repo-grounded mathematical exploration:
a caller provides a directory containing the allowed files plus a question, and
Coverify prepares bounded repo context, asks a reasoner, and verifies the
candidate before publication. It deliberately knows nothing about Forgejo,
issues, PRs, or git history.
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
from ..engine.verifying import ERROR, VERDICT_LINE, Verdict, parse_verdict
from ..math_contract import RESOLUTION_OUTPUT_TYPES, RESOLUTION_OUTPUT_TYPE_LIST

VERIFICATION_PASSED = "passed"
VERIFICATION_FAILED = "failed"
VERIFICATION_ERROR = "error"
PROMPT_CONTRACT_EXPLORATORY = "exploratory"
PROMPT_CONTRACT_RESOLUTION = "resolution"
PROMPT_CONTRACTS = (PROMPT_CONTRACT_EXPLORATORY, PROMPT_CONTRACT_RESOLUTION)
PROMPT_CONTEXT_RAW = "raw"
PROMPT_CONTEXT_DIGEST = "digest"
PROMPT_CONTEXTS = (PROMPT_CONTEXT_RAW, PROMPT_CONTEXT_DIGEST)


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
    *RESOLUTION_OUTPUT_TYPES,
    "derive",
    "disprove",
    "gap",
    "prove",
    "theorem",
    "lemma",
    "verify",
    "correct",
}

RESOLUTION_LOW_VALUE_SOURCE_PATHS = {
    "AGENTS.md",
    "README.md",
}

PROMPT_PROFILE_PATHS = (
    "COVERIFY_PROMPT.md",
    ".coverify/PROMPT.md",
    ".coverify/prompt.md",
    "PROMPT.md",
)

PROMPT_PROFILE_FRONTMATTER_KEYS = (
    "coverify_prompt_profile: true",
    "coverify_prompt_profile: yes",
)

DIGEST_IMPORTANT_TERMS = {
    "attack",
    "bottleneck",
    "bound",
    "candidate",
    "certificate",
    "configuration",
    "constant",
    "constraint",
    "counterexample",
    "domain",
    "exact",
    "failed",
    "gap",
    "goal",
    "inequality",
    "invalid",
    "local",
    "output",
    "profile",
    "proof",
    "replacement",
    "target",
    "task",
    "variables",
    "verification",
    "verifier",
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
class PromptProfile:
    path: str
    content: str
    sha256: str


@dataclass(frozen=True)
class GatheredContext:
    snippets: list[SourceSnippet]
    warnings: list[str]
    tier: str
    gatherer_provider: str | None = None
    gatherer_call_id: str | None = None
    gatherer_artifact_dir: str | None = None
    gatherer_plan: dict[str, Any] | None = None


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
    gatherer_provider: str | None = None
    gatherer_call_id: str | None = None
    gatherer_artifact_dir: str | None = None
    gatherer_plan: dict[str, Any] | None = None

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
        if self.gatherer_provider is not None:
            out["gatherer_provider"] = self.gatherer_provider
        if self.gatherer_call_id is not None:
            out["gatherer_call_id"] = self.gatherer_call_id
        if self.gatherer_artifact_dir is not None:
            out["gatherer_artifact_dir"] = self.gatherer_artifact_dir
        if self.gatherer_plan is not None:
            out["gatherer_plan"] = self.gatherer_plan
        return out


@dataclass(frozen=True)
class RepoOracleLLMInput:
    """A repo-oracle prompt prepared without calling a backend."""

    step: str
    prompt: str
    prompt_contract: str
    prompt_context: str
    prompt_audit: dict[str, object]
    prompt_profile_path: str | None
    source_id: str
    snapshot: str
    source_bundle_path: str
    tier: str
    sources: list[dict[str, object]]
    warnings: list[str]
    selected_snippets_known: bool
    gatherer_configured: bool

    def to_json(self) -> dict[str, object]:
        return {
            "step": self.step,
            "prompt": self.prompt,
            "prompt_contract": self.prompt_contract,
            "prompt_context": self.prompt_context,
            "prompt_audit": self.prompt_audit,
            "prompt_profile_path": self.prompt_profile_path,
            "source_id": self.source_id,
            "snapshot": self.snapshot,
            "source_bundle_path": self.source_bundle_path,
            "tier": self.tier,
            "sources": self.sources,
            "warnings": self.warnings,
            "selected_snippets_known": self.selected_snippets_known,
            "gatherer_configured": self.gatherer_configured,
            "prompt_sha256": sha256_text(self.prompt),
        }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


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


def _normalized_phrase(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def _window_score(
    lines: list[str],
    tokens: list[str],
    index: int,
    context_lines: int,
    *,
    query: str = "",
) -> int:
    start = max(0, index - context_lines)
    end = min(len(lines), index + context_lines + 1)
    text = "\n".join(lines[start:end]).lower()
    score = 0
    for token in tokens:
        score += min(text.count(token), 8)
    line = lines[index].lower()
    if line.startswith("#"):
        score += 2
        query_tokens = set(_tokens(query))
        heading_tokens = set(_tokens(line))
        if query_tokens:
            if query_tokens <= heading_tokens:
                score += 30
            score += 3 * len(query_tokens & heading_tokens)
    query_phrase = _normalized_phrase(query)
    line_phrase = _normalized_phrase(line)
    if query_phrase and query_phrase in line_phrase:
        score += 50
    if "|" in line:
        score += 1
    return score


def _looks_like_paragraph_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if stripped.startswith(("#", "-", "*", "+", ">", "|", "```", "$$")):
        return False
    if re.match(r"^\d+[\.)]\s", stripped):
        return False
    if re.match(r"^[-*_]{3,}$", stripped):
        return False
    return True


def _expand_to_paragraph_boundaries(lines: list[str], start: int, end: int) -> tuple[int, int]:
    while start > 0 and _looks_like_paragraph_line(lines[start - 1]) and _looks_like_paragraph_line(lines[start]):
        start -= 1
    while end < len(lines) and _looks_like_paragraph_line(lines[end - 1]) and _looks_like_paragraph_line(lines[end]):
        end += 1
    return start, end


def _snippet_for(
    file: SourceFile,
    tokens: list[str],
    *,
    context_lines: int = 48,
    query: str = "",
) -> SourceSnippet:
    lines = file.content.splitlines()
    if len(lines) <= (2 * context_lines) + 80:
        return SourceSnippet(
            path=file.path,
            line_start=1,
            line_end=max(1, len(lines)),
            text="\n".join(lines),
            score=_score_file(file, tokens),
        )
    match_index = 0
    best_score = -1
    for index, line in enumerate(lines):
        lowered = line.lower()
        if not any(token in lowered for token in tokens):
            continue
        score = _window_score(lines, tokens, index, context_lines, query=query)
        if score > best_score:
            best_score = score
            match_index = index
    start = max(0, match_index - context_lines)
    end = min(len(lines), match_index + context_lines + 1)
    start, end = _expand_to_paragraph_boundaries(lines, start, end)
    return SourceSnippet(
        path=file.path,
        line_start=start + 1,
        line_end=max(start + 1, end),
        text="\n".join(lines[start:end]),
        score=_score_file(file, tokens),
    )


def _snippet_range(file: SourceFile, *, line_start: int, line_end: int, score: int) -> SourceSnippet:
    lines = file.content.splitlines()
    start = max(1, line_start)
    end = min(len(lines), line_end)
    return SourceSnippet(
        path=file.path,
        line_start=start,
        line_end=max(start, end),
        text="\n".join(lines[start - 1 : end]),
        score=score,
    )


def deterministic_gather_context(
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


def _file_catalog(files: list[SourceFile], *, max_files: int = 200, max_headings_per_file: int = 40) -> str:
    parts: list[str] = []
    for file in files[:max_files]:
        headings = [
            f"L{index}: {line.strip()}"
            for index, line in enumerate(file.content.splitlines(), start=1)
            if line.lstrip().startswith("#")
        ][:max_headings_per_file]
        parts.append(
            "\n".join(
                [
                    f"### {file.path}",
                    f"- lines: {file.line_count}",
                    "- headings:",
                    *(f"  - {heading}" for heading in headings),
                ],
            ),
        )
    if len(files) > max_files:
        parts.append(f"... {len(files) - max_files} additional files omitted from gather catalog")
    return "\n\n".join(parts)


def build_gatherer_prompt(
    *,
    question: str,
    thread_context: str,
    bundle: SourceBundle,
) -> str:
    return "\n".join(
        [
            "# Coverify Repo-Snapshot Gatherer",
            "",
            "Choose the repo passages needed for an exploratory response or a",
            "packaged mathematical-resolution target. You are only preparing",
            "context, not answering the question.",
            "",
            "Allowed sources are the current source bundle directory only. You may",
            "inspect files inside that directory directly. Do not request issues, PRs,",
            "git history, web pages, sibling repos, local notes, or hidden memory.",
            "",
            "Prefer canonical ledger/status pages, theorem statements, definitions,",
            "examples, resolution-artifact notes, failed-route notes, and forced method constraints",
            "over introductory",
            "frontmatter. For broad status questions, include the actual tables and",
            "active-front/future-work sections when they exist.",
            "",
            "Return only JSON with this shape:",
            '{"passages":[{"path":"file.md","line_start":10,"line_end":40,"purpose":"why this passage is needed"}],"notes":["optional gaps or caveats"]}',
            "",
            "Each passage path must be one of the catalog paths. Use exact 1-based",
            "inclusive line ranges from the source files. Keep the list small; usually",
            "4-10 passages are enough. Prefer a wider exact section range over many",
            "tiny adjacent ranges.",
            "",
            "## Source bundle",
            f"- root: {bundle.root}",
            f"- source_id: {bundle.source_id}",
            f"- snapshot: {bundle.snapshot}",
            "",
            "## Current chat thread",
            thread_context.strip() or "(no prior thread context supplied)",
            "",
            "## User question",
            question.strip(),
            "",
            "## Repo catalog",
            _file_catalog(bundle.files),
        ],
    )


def _json_object_from_text(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("gatherer did not return a JSON object")
    parsed = json.loads(stripped[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("gatherer JSON root must be an object")
    return parsed


def _snippets_from_gatherer_plan(
    bundle: SourceBundle,
    *,
    question: str,
    plan: dict[str, Any],
    max_context_chars: int,
    max_files: int,
) -> tuple[list[SourceSnippet], list[str]]:
    by_path = {file.path: file for file in bundle.files}
    requests = plan.get("requests")
    if not isinstance(requests, list):
        requests = []
    selected: list[SourceSnippet] = []
    warnings: list[str] = []
    seen: set[tuple[str, int, int]] = set()
    used = 0
    fallback_tokens = _tokens(question)

    def add_snippet(snippet: SourceSnippet) -> bool:
        nonlocal used
        for existing_index, existing in enumerate(selected):
            if not (
                existing.path == snippet.path
                and existing.line_start <= snippet.line_end
                and snippet.line_start <= existing.line_end
            ):
                continue
            new_start = min(existing.line_start, snippet.line_start)
            new_end = max(existing.line_end, snippet.line_end)
            if new_start == existing.line_start and new_end == existing.line_end:
                return True
            merged_snippet = _snippet_range(
                by_path[snippet.path],
                line_start=new_start,
                line_end=new_end,
                score=max(existing.score, snippet.score),
            )
            additional_cost = len(merged_snippet.text) - len(existing.text)
            if selected and used + additional_cost > max_context_chars:
                warnings.append("Gatherer-selected context exceeded max_context_chars; later requests were skipped.")
                return False
            selected[existing_index] = merged_snippet
            used += max(0, additional_cost)
            return True
        key = (snippet.path, snippet.line_start, snippet.line_end)
        if key in seen:
            return True
        cost = len(snippet.text) + len(snippet.path) + 80
        if selected and used + cost > max_context_chars:
            warnings.append("Gatherer-selected context exceeded max_context_chars; later requests were skipped.")
            return False
        selected.append(snippet)
        seen.add(key)
        used += cost
        return True

    passages = plan.get("passages")
    if isinstance(passages, list):
        for item in passages:
            if not isinstance(item, dict):
                warnings.append("Ignored non-object gatherer passage.")
                continue
            path = item.get("path")
            line_start = item.get("line_start")
            line_end = item.get("line_end")
            if not isinstance(path, str) or path not in by_path:
                warnings.append(f"Ignored gatherer passage for unavailable path {path!r}.")
                continue
            if not isinstance(line_start, int) or not isinstance(line_end, int):
                warnings.append(f"Ignored gatherer passage for {path!r}: line_start and line_end must be integers.")
                continue
            if line_start < 1 or line_end < line_start:
                warnings.append(f"Ignored gatherer passage for {path!r}: invalid line range {line_start}-{line_end}.")
                continue
            file = by_path[path]
            if line_start > file.line_count:
                warnings.append(f"Ignored gatherer passage for {path!r}: line_start is past end of file.")
                continue
            snippet = _snippet_range(
                file,
                line_start=line_start,
                line_end=min(line_end, file.line_count),
                score=_score_file(file, fallback_tokens),
            )
            if not add_snippet(snippet):
                return selected, warnings
            if len(selected) >= max_files:
                return selected, warnings
        if selected:
            return selected, warnings

    if not requests:
        raise ValueError("gatherer JSON must contain a passages or requests list")

    for item in requests:
        if not isinstance(item, dict):
            warnings.append("Ignored non-object gatherer request.")
            continue
        path = item.get("path")
        if not isinstance(path, str) or path not in by_path:
            warnings.append(f"Ignored gatherer request for unavailable path {path!r}.")
            continue
        raw_queries = item.get("queries")
        queries = [q for q in raw_queries if isinstance(q, str) and q.strip()] if isinstance(raw_queries, list) else []
        if not queries:
            queries = [question]
        for query in queries:
            tokens = _tokens(query) or fallback_tokens
            snippet = _snippet_for(by_path[path], tokens, query=query)
            if not add_snippet(snippet):
                return selected, warnings
            if len(selected) >= max_files:
                return selected, warnings
    return selected, warnings


def gather_context(
    bundle: SourceBundle,
    *,
    question: str,
    thread_context: str = "",
    max_context_chars: int = 60_000,
    max_files: int = 12,
    gatherer_backend: BackendRunner | None = None,
) -> GatheredContext:
    if gatherer_backend is None:
        return deterministic_gather_context(
            bundle,
            question=question,
            thread_context=thread_context,
            max_context_chars=max_context_chars,
            max_files=max_files,
        )
    prompt = build_gatherer_prompt(question=question, thread_context=thread_context, bundle=bundle)
    result = gatherer_backend(prompt)
    warnings: list[str] = []
    try:
        plan = _json_object_from_text(result.answer)
        snippets, plan_warnings = _snippets_from_gatherer_plan(
            bundle,
            question=question,
            plan=plan,
            max_context_chars=max_context_chars,
            max_files=max_files,
        )
        warnings.extend(plan_warnings)
    except (ValueError, json.JSONDecodeError) as err:
        fallback = deterministic_gather_context(
            bundle,
            question=question,
            thread_context=thread_context,
            max_context_chars=max_context_chars,
            max_files=max_files,
        )
        return GatheredContext(
            snippets=fallback.snippets,
            warnings=[*fallback.warnings, f"LLM gatherer failed; used deterministic fallback: {err}"],
            tier=fallback.tier,
            gatherer_provider=result.provider,
            gatherer_call_id=result.oracle_call_id,
            gatherer_artifact_dir=str(result.artifact_dir),
        )
    if not snippets:
        fallback = deterministic_gather_context(
            bundle,
            question=question,
            thread_context=thread_context,
            max_context_chars=max_context_chars,
            max_files=max_files,
        )
        snippets = fallback.snippets
        warnings.extend(fallback.warnings)
        warnings.append("LLM gatherer selected no usable snippets; used deterministic fallback snippets.")
    if bundle.omitted:
        warnings.append(
            f"{len(bundle.omitted)} non-text or too-large file(s) were listed in the source bundle but not injected.",
        )
    if not bundle.files:
        warnings.append("No UTF-8 text files were available in the source bundle.")
    return GatheredContext(
        snippets=snippets,
        warnings=warnings,
        tier=classify_tier(question),
        gatherer_provider=result.provider,
        gatherer_call_id=result.oracle_call_id,
        gatherer_artifact_dir=str(result.artifact_dir),
        gatherer_plan=plan,
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


def find_prompt_profile(bundle: SourceBundle) -> PromptProfile | None:
    by_path = {file.path: file for file in bundle.files}
    for path in PROMPT_PROFILE_PATHS:
        file = by_path.get(path)
        if file is not None:
            return PromptProfile(path=file.path, content=file.content, sha256=file.sha256)
    for file in bundle.files:
        lowered_head = "\n".join(file.content.lower().splitlines()[:12])
        if any(key in lowered_head for key in PROMPT_PROFILE_FRONTMATTER_KEYS):
            return PromptProfile(path=file.path, content=file.content, sha256=file.sha256)
    return None


def _strip_frontmatter(text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for index in range(1, min(len(lines), 80)):
        if lines[index].strip() == "---":
            return "\n".join(lines[index + 1 :])
    return text


def _markdown_units(text: str) -> list[str]:
    units: list[str] = []
    buffer: list[str] = []
    list_buffer: list[str] = []
    in_fence = False
    in_math = False

    def flush_paragraph() -> None:
        nonlocal buffer
        if buffer:
            units.append(" ".join(line.strip() for line in buffer if line.strip()))
            buffer = []

    def flush_list() -> None:
        nonlocal list_buffer
        if list_buffer:
            units.append("\n".join(list_buffer))
            list_buffer = []

    def is_list_start(value: str) -> bool:
        return value.startswith(("- ", "* ", "+ ")) or re.match(r"^\d+[\.)]\s", value) is not None

    for raw_line in _strip_frontmatter(text).splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if stripped.startswith("```"):
            flush_paragraph()
            flush_list()
            block = [line]
            if in_fence:
                units.append("\n".join(block))
            in_fence = not in_fence
            if not in_fence:
                continue
            units.append(line)
            continue
        if in_fence:
            units.append(line)
            continue
        if stripped == "$$":
            flush_paragraph()
            flush_list()
            units.append(line)
            in_math = not in_math
            continue
        if in_math:
            units.append(line)
            continue
        if not stripped:
            flush_paragraph()
            flush_list()
            continue
        if is_list_start(stripped):
            flush_paragraph()
            list_buffer.append(line)
            continue
        if list_buffer and not stripped.startswith(("#", ">", "|")):
            list_buffer.append(line)
            continue
        if stripped.startswith(("#", ">", "|")):
            flush_paragraph()
            flush_list()
            units.append(line)
            continue
        buffer.append(line)
    flush_paragraph()
    flush_list()
    return [unit for unit in units if unit.strip()]


def _unit_digest_score(unit: str, question_tokens: set[str]) -> int:
    lowered = unit.lower()
    score = 0
    if unit.lstrip().startswith("#"):
        score += 8
    if "$" in unit or "\\" in unit or re.search(r"[<>=]", unit):
        score += 7
    if unit.lstrip().startswith(("TARGET_", "CONFIGURATION", "FINITE_", "ATTACK_", "VERIFICATION_", "NEXT_", "CLAIM", "CONTRACT")):
        score += 7
    unit_tokens = set(_tokens(unit))
    score += 3 * len(unit_tokens & question_tokens)
    score += 2 * len(unit_tokens & DIGEST_IMPORTANT_TERMS)
    if "do not" in lowered or "required output" in lowered:
        score += 5
    return score


def _prune_empty_headings(units: list[str]) -> list[str]:
    pruned: list[str] = []
    for index, unit in enumerate(units):
        if unit.lstrip().startswith("#"):
            next_unit = units[index + 1] if index + 1 < len(units) else ""
            if not next_unit or next_unit.lstrip().startswith("#"):
                continue
        pruned.append(unit)
    return pruned


def _digest_markdown(text: str, *, question: str, max_chars: int = 1_300) -> str:
    units = _markdown_units(text)
    if len("\n".join(units)) <= max_chars:
        return "\n".join(units)
    question_tokens = set(_tokens(question))
    selected: list[str] = []
    used = 0
    in_code_block = False
    for unit in units:
        stripped = unit.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            keep = True
        else:
            keep = in_code_block or _unit_digest_score(unit, question_tokens) >= 5
        if not keep:
            continue
        cost = len(unit) + 1
        if selected and used + cost > max_chars:
            break
        selected.append(unit)
        used += cost
    if not selected:
        selected = units[: max(1, min(8, len(units)))]
    selected = _prune_empty_headings(selected)
    return "\n".join(selected)


def _normalize_prompt_profile(profile: PromptProfile) -> str:
    return _digest_markdown(profile.content, question="coverify prompt profile", max_chars=2_200)


def _format_context_digest(snippets: list[SourceSnippet], *, question: str) -> str:
    parts: list[str] = []
    for snippet in snippets:
        digest = _digest_markdown(snippet.text, question=question)
        parts.extend(
            [
                f"### {snippet.path}:{snippet.line_start}-{snippet.line_end}",
                digest or "(no digestible content)",
                "",
            ],
        )
    return "\n".join(parts).strip()


def _format_repo_context(
    snippets: list[SourceSnippet],
    *,
    question: str,
    prompt_context: str,
) -> str:
    if prompt_context == PROMPT_CONTEXT_DIGEST:
        return _format_context_digest(snippets, question=question)
    if prompt_context != PROMPT_CONTEXT_RAW:
        raise ValueError(f"unknown prompt context: {prompt_context}")
    return _format_snippets(snippets)


def _citation_pattern(snippets: list[SourceSnippet]) -> re.Pattern[str] | None:
    paths = sorted({snippet.path for snippet in snippets}, key=len, reverse=True)
    if not paths:
        return None
    escaped = "|".join(re.escape(path) for path in paths)
    return re.compile(
        rf"(?P<path>{escaped})(?::(?P<colon_start>\d+)(?:-(?P<colon_end>\d+))?|#L(?P<hash_start>\d+)(?:-(?P<hash_end>\d+))?)",
    )


def _containing_snippet(snippets: list[SourceSnippet], path: str, start: int, end: int) -> SourceSnippet | None:
    candidates = [
        snippet
        for snippet in snippets
        if snippet.path == path and snippet.line_start <= start and end <= snippet.line_end
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda snippet: snippet.line_end - snippet.line_start)


def normalize_answer_citations(answer: str, snippets: list[SourceSnippet]) -> tuple[str, list[str]]:
    """Rewrite cited line numbers to exact injected snippet ranges.

    The model only receives snippets, not full files. Letting it cite narrower
    line ranges invites plausible-but-shaky citations, so answers may only cite
    exact snippet ranges. Citations inside a snippet are widened to that snippet
    range and rendered as clickable Cosheaf Markdown links
    (`[path.md#L10-40](path.md#L10-40)`);
    citations outside gathered context are reported as invalid.
    """
    pattern = _citation_pattern(snippets)
    if pattern is None:
        return answer, []
    warnings: list[str] = []
    markdown_link_pattern = re.compile(r"\[(?P<label>[^\]\n]*)\]\((?P<href>[^)\n]*)\)")

    def normalized_ref_for(match: re.Match[str]) -> str | None:
        path = match.group("path")
        start_raw = match.group("colon_start") or match.group("hash_start")
        end_raw = match.group("colon_end") or match.group("hash_end") or start_raw
        if start_raw is None or end_raw is None:
            warnings.append(f"Invalid citation {match.group(0)!r}: line range was missing.")
            return None
        start = int(start_raw)
        end = int(end_raw)
        if end < start:
            warnings.append(f"Invalid descending citation {match.group(0)!r}.")
            return None
        snippet = _containing_snippet(snippets, path, start, end)
        if snippet is None:
            warnings.append(f"Invalid citation {match.group(0)!r}: line range was not in gathered context.")
            return None
        normalized_range = (
            f"L{snippet.line_start}"
            if snippet.line_start == snippet.line_end
            else f"L{snippet.line_start}-{snippet.line_end}"
        )
        return f"{path}#{normalized_range}"

    def replace_markdown_link(match: re.Match[str]) -> str:
        label = match.group("label")
        href = match.group("href")
        label_citation = pattern.fullmatch(label)
        href_citation = pattern.fullmatch(href)
        if label_citation is None and href_citation is None:
            if pattern.search(label) or pattern.search(href):
                warnings.append(
                    f"Invalid citation link {match.group(0)!r}: source refs inside Markdown links must be exact standalone source links.",
                )
            return match.group(0)

        source_match = href_citation or label_citation
        assert source_match is not None
        normalized_ref = normalized_ref_for(source_match)
        if normalized_ref is None:
            return match.group(0)
        if label_citation is not None:
            label_ref = normalized_ref_for(label_citation)
            if label_ref is None:
                return match.group(0)
            if label_ref != normalized_ref:
                warnings.append(
                    f"Invalid citation link {match.group(0)!r}: label and href resolve to different source ranges.",
                )
                return match.group(0)

        normalized = f"[{normalized_ref}]({normalized_ref})"
        if normalized != match.group(0):
            warnings.append(f"Normalized citation link {match.group(0)!r} to {normalized!r}.")
        return normalized

    normalized_answer = markdown_link_pattern.sub(replace_markdown_link, answer)
    markdown_link_content_spans = [
        (link.start("label"), link.end("label"))
        for link in markdown_link_pattern.finditer(normalized_answer)
    ] + [
        (link.start("href"), link.end("href"))
        for link in markdown_link_pattern.finditer(normalized_answer)
    ]

    def inside_markdown_link(match: re.Match[str]) -> bool:
        return any(start <= match.start() and match.end() <= end for start, end in markdown_link_content_spans)

    def replace(match: re.Match[str]) -> str:
        if inside_markdown_link(match):
            return match.group(0)
        normalized_ref = normalized_ref_for(match)
        if normalized_ref is None:
            return match.group(0)
        normalized = f"[{normalized_ref}]({normalized_ref})"
        if normalized != match.group(0):
            warnings.append(f"Normalized citation {match.group(0)!r} to {normalized!r}.")
        return normalized

    normalized_answer = pattern.sub(replace, normalized_answer)
    for path in sorted({snippet.path for snippet in snippets}, key=len, reverse=True):
        code_ref_pattern = re.compile(
            rf"`(?P<ref>(?:\[{re.escape(path)}#L\d+(?:-\d+)?\]\({re.escape(path)}#L\d+(?:-\d+)?\)|{re.escape(path)}#L\d+(?:-\d+)?))`",
        )

        def unwrap_code_ref(match: re.Match[str]) -> str:
            warnings.append(f"Unwrapped code-formatted source ref {match.group(0)!r}.")
            return match.group("ref")

        normalized_answer = code_ref_pattern.sub(unwrap_code_ref, normalized_answer)
    return normalized_answer, warnings


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
            "# Coverify Repo-Snapshot Exploratory Response",
            "",
            "Produce an exploratory response to the user's mathematical question",
            "using only the allowed sources below plus general mathematical",
            "knowledge. You may answer directly, explain source-backed status,",
            "compare plausible routes, identify gaps, call out useful tools, or",
            "package exact mathematical-resolution targets for a later strict",
            "prover/resolver call. You may derive new arguments from the repo",
            "context. You must not use issues, PRs, git history, web, sibling",
            "repos, local notes, or hidden memory.",
            "",
            "Repo-specific claims must be supported by the source bundle. If files",
            "conflict, report the conflict unless the source bundle resolves it.",
            "Do not present exploration as proof or as any stronger status than",
            "the evidence supports. If the gathered sources already settle a",
            "routine question, you may explain the resolution. If the user asks",
            "for a hard exact target, do not silently run mathematical resolution",
            "inside this exploratory response; package a strict target with the",
            "statement, hypotheses, allowed context, forced constraints, and",
            f"output type: {RESOLUTION_OUTPUT_TYPE_LIST}. Otherwise report the",
            "precise gap and strongest justified partial progress.",
            "If the user requires a particular theorem, construction shape, proof",
            "method, route, or other constraint, treat that as part of the target;",
            "do not switch methods silently.",
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
            "## Required response behavior",
            "- Write Markdown suitable for a Cosheaf issue comment.",
            "- Do not hard-wrap normal prose paragraphs in the Markdown source; write each prose paragraph as one logical line. Preserve intentional line breaks for headings, lists, tables, TeX blocks, and fenced code.",
            "- Use short headings and bullet lists when they improve scanability.",
            "- Use TeX math syntax (`$...$` or `$$...$$`) for formulas, bounds, inequalities, and named constants; do not flatten mathematical status into plain prose.",
            "- Prefer Cosheaf semantic references such as `[@thm:main]`, `[@eq:bound]`, or narrative `@sec:status` when the source defines stable ids for the relevant theorem, equation, heading, example, or status block.",
            "- Use exact gathered source-range links only as fallback evidence when no stable semantic id exists, e.g. `[model-and-bound-ledger.md#L56-80](model-and-bound-ledger.md#L56-80)`.",
            "- Put either a semantic `[@id]` reference or a fallback source-range link in every table row or bullet that states a repo-specific bound, witness, obstruction, or next-step status.",
            "- Do not wrap source refs in backticks and do not use `path.md:10-40` in the final answer.",
            "- Do not invent narrower line citations; if the snippet header is `a.md:10-40`, cite `[a.md#L10-40](a.md#L10-40)`.",
            "- Standard mathematical facts do not need citations.",
            "- If support is missing, say what is missing.",
            "- Label speculative routes, plausible strategies, and open gaps explicitly.",
            "- When useful, include `Packaged resolution targets` with exact statement, hypotheses, allowed context, and output target.",
            "- Do not write or propose direct repo edits.",
        ],
    )


def build_resolution_prompt(
    *,
    question: str,
    thread_context: str,
    bundle: SourceBundle,
    gathered: GatheredContext,
    prompt_context: str = PROMPT_CONTEXT_DIGEST,
    prompt_profile: PromptProfile | None = None,
) -> str:
    warnings = "\n".join(f"- {warning}" for warning in gathered.warnings) or "- none"
    profile_block = ""
    if prompt_profile is not None:
        profile_block = "\n".join(
            [
                "## Project prompt profile",
                f"- source: {prompt_profile.path}",
                f"- sha256: {prompt_profile.sha256}",
                "",
                _normalize_prompt_profile(prompt_profile),
                "",
            ],
        )
    context_heading = "Allowed context digest" if prompt_context == PROMPT_CONTEXT_DIGEST else "Allowed repo context"
    preference_block = (
        []
        if prompt_profile is not None
        else [
            "Prefer artifacts in this order when the user does not force a narrower type:",
            "1. A complete proof, certificate, bound, construction, or reduction for the stated target.",
            "2. A finite verifier-ready statement with exact hypotheses, domain, inequality, and what would count as proof.",
            "3. An explicit counterexample, obstruction, bottleneck, or precise gap showing why the current target or certificate family fails.",
            "",
            "Use exactly one requested resolution-artifact type when possible: "
            f"{RESOLUTION_OUTPUT_TYPE_LIST}.",
            "If the user question or allowed context defines a required output format, follow that format exactly.",
            "",
        ]
    )
    fallback_shape_block = (
        []
        if prompt_profile is not None
        else [
            "- Use this compact fallback shape if no stricter source-defined format applies:",
            "",
            "```text",
            "CLAIM:",
            "CONTRACT:",
            "RESOLUTION_ARTIFACT_TYPE:",
            "RESOLUTION_ARTIFACT:",
            "COMPLETENESS_STATUS:",
            "KEY_IDEA:",
            "NONTRIVIAL_DEPENDENCIES:",
            "UNRESOLVED_GAPS:",
            "CHECKS_FOR_REVIEWER:",
            "```",
        ]
    )
    return "\n".join(
        [
            "# Coverify Repo-Snapshot Mathematical Resolution",
            "",
            "Produce one strict mathematical-resolution artifact for the user's target using only the allowed project-local sources below plus general mathematical reasoning. Treat the project prompt profile, when present, as first-class local guidance for shaping the task and output. Do not use issues, PRs, git history, web, sibling repos, local notes, hidden memory, or unprovided computation.",
            "",
            "Do not give a broad research essay, literature survey, global theorem claim, or loose plan. If the target is not fully resolvable from the allowed context, return the strongest checkable partial artifact and state the precise gap.",
            "",
            *preference_block,
            "## Source bundle",
            f"- source_id: {bundle.source_id}",
            f"- snapshot: {bundle.snapshot}",
            "",
            "## Warnings",
            warnings,
            "",
            profile_block,
            "## Current chat thread",
            thread_context.strip() or "(no prior thread context supplied)",
            "",
            f"## {context_heading}",
            _format_repo_context(gathered.snippets, question=question, prompt_context=prompt_context) or "(no repo context selected)",
            "",
            "## User target",
            question.strip(),
            "",
            "## Required response behavior",
            "- Give one artifact, not multiple alternate routes.",
            "- Preserve the problem scope and all forced methods, construction shapes, output formats, and constraints from the user target and allowed context.",
            "- Follow the project prompt profile output shape exactly when it defines one.",
            "- State unsupported computation as an attack or gap, not as proof.",
            "- Use TeX math syntax for formulas, constants, inequalities, and domains.",
            "- Do not hard-wrap normal prose paragraphs at arbitrary source-column widths; write each prose paragraph as one logical source line.",
            *fallback_shape_block,
        ],
    )


def build_repo_oracle_prompt(
    *,
    question: str,
    thread_context: str,
    bundle: SourceBundle,
    gathered: GatheredContext,
    prompt_contract: str = PROMPT_CONTRACT_EXPLORATORY,
    prompt_context: str = PROMPT_CONTEXT_RAW,
    prompt_profile: PromptProfile | None = None,
) -> str:
    if prompt_contract == PROMPT_CONTRACT_RESOLUTION:
        return build_resolution_prompt(
            question=question,
            thread_context=thread_context,
            bundle=bundle,
            gathered=gathered,
            prompt_context=prompt_context,
            prompt_profile=prompt_profile,
        )
    if prompt_contract != PROMPT_CONTRACT_EXPLORATORY:
        raise ValueError(f"unknown prompt contract: {prompt_contract}")
    return build_reasoner_prompt(
        question=question,
        thread_context=thread_context,
        bundle=bundle,
        gathered=gathered,
    )


def audit_repo_oracle_prompt(
    *,
    prompt: str,
    prompt_contract: str,
    prompt_context: str,
    question: str,
    bundle: SourceBundle,
    gathered: GatheredContext,
    prompt_profile: PromptProfile | None,
) -> dict[str, object]:
    issues: list[dict[str, str]] = []

    def add(severity: str, code: str, message: str) -> None:
        issues.append({"severity": severity, "code": code, "message": message})

    question_tokens = set(_tokens(question))
    exact_target_terms = {
        "bound",
        "certificate",
        "checkable",
        "counterexample",
        "exact",
        "inequality",
        "prove",
        "proof",
        "resolve",
        "verifier",
    }
    if prompt_contract == PROMPT_CONTRACT_EXPLORATORY and (question_tokens & exact_target_terms):
        add(
            "warning",
            "weak_contract_for_exact_target",
            "Question looks like an exact proof/certificate target but the prompt uses the exploratory contract; use --prompt-contract resolution for expensive prover calls.",
        )
    if prompt_contract == PROMPT_CONTRACT_EXPLORATORY and "exactly one" in question.lower():
        add(
            "warning",
            "exploratory_contract_allows_broad_answer",
            "Question asks for exactly one artifact, but the exploratory contract still permits route comparison and target packaging.",
        )
    if len(prompt) > 20_000:
        add("warning", "large_prompt", f"Prompt is {len(prompt)} characters; consider stricter source selection before an expensive run.")
    elif prompt_context == PROMPT_CONTEXT_RAW and len(prompt) > 10_000:
        add(
            "info",
            "large_raw_prompt",
            f"Prompt is {len(prompt)} characters; use --prompt-context digest for a compact source digest.",
        )
    if prompt_contract == PROMPT_CONTRACT_RESOLUTION and prompt_profile is None:
        add(
            "info",
            "missing_prompt_profile",
            "No project-local prompt profile was found; add COVERIFY_PROMPT.md to shape expensive resolution prompts.",
        )
    by_path = {file.path: file for file in bundle.files}
    for snippet in gathered.snippets:
        file = by_path.get(snippet.path)
        if file is None:
            continue
        lines = file.content.splitlines()
        if snippet.line_start > 1:
            current = lines[snippet.line_start - 1] if snippet.line_start - 1 < len(lines) else ""
            previous = lines[snippet.line_start - 2]
            if _looks_like_paragraph_line(previous) and _looks_like_paragraph_line(current):
                add(
                    "warning",
                    "snippet_starts_mid_paragraph",
                    f"{snippet.path}:{snippet.line_start}-{snippet.line_end} starts inside a prose paragraph.",
                )
        if snippet.line_end < len(lines):
            current = lines[snippet.line_end - 1]
            following = lines[snippet.line_end]
            if _looks_like_paragraph_line(current) and _looks_like_paragraph_line(following):
                add(
                    "warning",
                    "snippet_ends_mid_paragraph",
                    f"{snippet.path}:{snippet.line_start}-{snippet.line_end} ends inside a prose paragraph.",
                )
    return {
        "prompt_contract": prompt_contract,
        "prompt_context": prompt_context,
        "prompt_profile_path": prompt_profile.path if prompt_profile is not None else None,
        "prompt_chars": len(prompt),
        "source_context_chars": sum(len(snippet.text) for snippet in gathered.snippets),
        "rendered_context_chars": len(
            _format_repo_context(gathered.snippets, question=question, prompt_context=prompt_context),
        ),
        "source_count": len(gathered.snippets),
        "issues": issues,
        "ok": not any(issue["severity"] == "error" for issue in issues),
    }


def _adapt_gathered_for_prompt_contract(
    gathered: GatheredContext,
    *,
    prompt_contract: str,
    prompt_profile: PromptProfile | None = None,
) -> GatheredContext:
    prompt_profile_path = prompt_profile.path if prompt_profile is not None else None
    if prompt_contract != PROMPT_CONTRACT_RESOLUTION and prompt_profile_path is None:
        return gathered
    kept = [
        snippet
        for snippet in gathered.snippets
        if snippet.path != prompt_profile_path
        and (
            prompt_contract != PROMPT_CONTRACT_RESOLUTION
            or snippet.path not in RESOLUTION_LOW_VALUE_SOURCE_PATHS
        )
    ]
    if not kept:
        return gathered
    omitted = [
        snippet.path
        for snippet in gathered.snippets
        if snippet.path == prompt_profile_path
        or (
            prompt_contract == PROMPT_CONTRACT_RESOLUTION
            and snippet.path in RESOLUTION_LOW_VALUE_SOURCE_PATHS
        )
    ]
    if not omitted:
        return gathered
    reason = (
        "Prompt context omitted source(s) already used as prompt profile or low-value operational source(s): "
        + ", ".join(omitted)
        + "."
    )
    return GatheredContext(
        snippets=kept,
        warnings=[
            *gathered.warnings,
            reason,
        ],
        tier=gathered.tier,
        gatherer_provider=gathered.gatherer_provider,
        gatherer_call_id=gathered.gatherer_call_id,
        gatherer_artifact_dir=gathered.gatherer_artifact_dir,
        gatherer_plan=gathered.gatherer_plan,
    )


def build_verifier_prompt(
    *,
    question: str,
    thread_context: str,
    bundle: SourceBundle,
    gathered: GatheredContext,
    candidate: str,
    prompt_contract: str = PROMPT_CONTRACT_EXPLORATORY,
) -> str:
    contract_label = (
        "mathematical-resolution contract"
        if prompt_contract == PROMPT_CONTRACT_RESOLUTION
        else "exploratory-response contract"
    )
    return "\n".join(
        [
            "# Coverify Repo-Snapshot Verification",
            "",
            "Act as an adversarial mathematical verifier. Check the candidate",
            "response against the allowed source bundle, the current chat thread,",
            f"and the {contract_label}.",
            "",
            "Reject if it uses issues, PRs, git history, web, sibling repos, local",
            "notes, hidden memory, or any repo-specific fact unsupported by the",
            "source snippets. Reject if a proof step is invalid or if a conflict is",
            "smoothed over as settled knowledge.",
            "Reject if exploration, a plausible route, a partial argument, a",
            "construction attempt, or a computational-looking artifact is presented",
            "with a stronger status label than the evidence supports. For a requested",
            f"resolution artifact ({RESOLUTION_OUTPUT_TYPE_LIST}), reject if the",
            "target statement or hypotheses changed, if the hard step is hidden, or",
            "if the candidate does not clearly justify completion or state the precise gap.",
            "When using the mathematical-resolution contract, reject broad essays",
            "or multiple-route brainstorming unless the candidate first gives one",
            "checkable artifact or a precise impossibility/gap artifact.",
            "Reject if the user required a particular theorem, construction shape,",
            "proof method, route, or other constraint and the candidate did not",
            "follow it.",
            "Reject citations to repo line ranges that are not exact gathered snippet",
            "headers after converting `path.md#Lx-y` references back to line ranges.",
            "Reject final answers that are not Markdown suitable for a Cosheaf issue",
            "comment or that use `path.md:x-y` instead of `path.md#Lx-y` source refs.",
            "Reject final answers that hard-wrap normal prose paragraphs in the",
            "Markdown source. Deliberate line breaks for headings, lists, tables,",
            "TeX blocks, and fenced code are fine.",
            "Reject broad status answers that omit TeX notation for mathematical",
            "bounds, or that state repo-specific bounds/witnesses/next steps without",
            "a Cosheaf semantic `[@id]`/`@id` reference or a clickable Markdown link",
            "to an exact source range.",
            "",
            "Write findings, then output exactly one line:",
            "",
            VERDICT_LINE,
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
            "## Candidate response",
            candidate,
        ],
    )


def _source_snippet_metadata(snippets: list[SourceSnippet]) -> list[dict[str, object]]:
    return [
        {
            "path": snippet.path,
            "line_start": snippet.line_start,
            "line_end": snippet.line_end,
            "score": snippet.score,
            "text": snippet.text,
        }
        for snippet in snippets
    ]


def prepare_repo_oracle_llm_input(
    *,
    bundle: SourceBundle,
    question: str,
    thread_context: str = "",
    max_context_chars: int = 60_000,
    gatherer_configured: bool = False,
    prompt_contract: str = PROMPT_CONTRACT_EXPLORATORY,
    prompt_context: str = PROMPT_CONTEXT_RAW,
) -> RepoOracleLLMInput:
    """Prepare the first repo-oracle LLM input without invoking any backend."""
    if not question.strip():
        raise ValueError("question is empty")
    if prompt_contract not in PROMPT_CONTRACTS:
        raise ValueError(f"unknown prompt contract: {prompt_contract}")
    if prompt_context not in PROMPT_CONTEXTS:
        raise ValueError(f"unknown prompt context: {prompt_context}")
    prompt_profile = find_prompt_profile(bundle)
    if gatherer_configured:
        warnings: list[str] = []
        if bundle.omitted:
            warnings.append(
                f"{len(bundle.omitted)} non-text or too-large file(s) were listed in the source bundle but not injected.",
            )
        if not bundle.files:
            warnings.append("No UTF-8 text files were available in the source bundle.")
        prompt = build_gatherer_prompt(
            question=question,
            thread_context=thread_context,
            bundle=bundle,
        )
        return RepoOracleLLMInput(
            step="gatherer",
            prompt=prompt,
            prompt_contract=prompt_contract,
            prompt_context=prompt_context,
            prompt_audit={
                "prompt_contract": prompt_contract,
                "prompt_context": prompt_context,
                "prompt_profile_path": prompt_profile.path if prompt_profile is not None else None,
                "prompt_chars": len(prompt),
                "source_context_chars": 0,
                "source_count": 0,
                "issues": [],
                "ok": True,
            },
            prompt_profile_path=prompt_profile.path if prompt_profile is not None else None,
            source_id=bundle.source_id,
            snapshot=bundle.snapshot,
            source_bundle_path=str(bundle.root),
            tier=classify_tier(question),
            sources=[],
            warnings=warnings,
            selected_snippets_known=False,
            gatherer_configured=True,
        )

    gathered = deterministic_gather_context(
        bundle,
        question=question,
        thread_context=thread_context,
        max_context_chars=max_context_chars,
    )
    gathered = _adapt_gathered_for_prompt_contract(
        gathered,
        prompt_contract=prompt_contract,
        prompt_profile=prompt_profile,
    )
    prompt = build_repo_oracle_prompt(
        question=question,
        thread_context=thread_context,
        bundle=bundle,
        gathered=gathered,
        prompt_contract=prompt_contract,
        prompt_context=prompt_context,
        prompt_profile=prompt_profile,
    )
    return RepoOracleLLMInput(
        step="answer",
        prompt=prompt,
        prompt_contract=prompt_contract,
        prompt_context=prompt_context,
        prompt_audit=audit_repo_oracle_prompt(
            prompt=prompt,
            prompt_contract=prompt_contract,
            prompt_context=prompt_context,
            question=question,
            bundle=bundle,
            gathered=gathered,
            prompt_profile=prompt_profile,
        ),
        prompt_profile_path=prompt_profile.path if prompt_profile is not None else None,
        source_id=bundle.source_id,
        snapshot=bundle.snapshot,
        source_bundle_path=str(bundle.root),
        tier=gathered.tier,
        sources=_source_snippet_metadata(gathered.snippets),
        warnings=gathered.warnings,
        selected_snippets_known=True,
        gatherer_configured=False,
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
    verdicts = metadata.get("final_verdicts")
    value = metadata.get("verified")
    if isinstance(verdicts, list):
        if not verdicts:
            return VERIFICATION_ERROR if value is False else None
        if all(v == Verdict.PASS.value for v in verdicts):
            return VERIFICATION_ERROR if value is False else VERIFICATION_PASSED
        if any(v == Verdict.FAIL.value for v in verdicts):
            return VERIFICATION_FAILED
        return VERIFICATION_ERROR
    if value is True:
        return VERIFICATION_PASSED
    if value is False:
        return VERIFICATION_FAILED
    return None


def run_repo_oracle(
    *,
    bundle: SourceBundle,
    question: str,
    answer_backend: BackendRunner,
    verifier_backend: BackendRunner | None,
    gatherer_backend: BackendRunner | None = None,
    thread_context: str = "",
    max_context_chars: int = 60_000,
    prompt_contract: str = PROMPT_CONTRACT_EXPLORATORY,
    prompt_context: str = PROMPT_CONTEXT_RAW,
) -> RepoOracleResult:
    if not question.strip():
        raise ValueError("question is empty")
    if prompt_contract not in PROMPT_CONTRACTS:
        raise ValueError(f"unknown prompt contract: {prompt_contract}")
    if prompt_context not in PROMPT_CONTEXTS:
        raise ValueError(f"unknown prompt context: {prompt_context}")
    prompt_profile = find_prompt_profile(bundle)
    gathered = gather_context(
        bundle,
        question=question,
        thread_context=thread_context,
        max_context_chars=max_context_chars,
        gatherer_backend=gatherer_backend,
    )
    gathered = _adapt_gathered_for_prompt_contract(
        gathered,
        prompt_contract=prompt_contract,
        prompt_profile=prompt_profile,
    )
    prompt = build_repo_oracle_prompt(
        question=question,
        thread_context=thread_context,
        bundle=bundle,
        gathered=gathered,
        prompt_contract=prompt_contract,
        prompt_context=prompt_context,
        prompt_profile=prompt_profile,
    )
    answer_result = answer_backend(prompt)
    candidate_answer, citation_warnings = normalize_answer_citations(answer_result.answer, gathered.snippets)
    invalid_citations = [warning for warning in citation_warnings if warning.startswith("Invalid ")]
    verification = verification_from_metadata(answer_result)
    verifier_result: BackendResult | None = None
    verifier_answer: str | None = None
    if invalid_citations:
        verification = VERIFICATION_FAILED
        verifier_answer = "\n".join(invalid_citations)
    elif verification is None:
        if verifier_backend is None:
            raise ValueError("repo oracle requires a verifier backend unless the answer backend is verifying")
        verifier_result = verifier_backend(
            build_verifier_prompt(
                question=question,
                thread_context=thread_context,
                bundle=bundle,
                gathered=gathered,
                candidate=candidate_answer,
                prompt_contract=prompt_contract,
            ),
        )
        verifier_answer = verifier_result.answer
        try:
            verdict = parse_verdict(verifier_result.answer).value
        except ValueError:
            verdict = ERROR
        verification = (
            VERIFICATION_PASSED
            if verdict == Verdict.PASS.value
            else VERIFICATION_FAILED
            if verdict == Verdict.FAIL.value
            else VERIFICATION_ERROR
        )

    ok = verification == VERIFICATION_PASSED
    final_answer = candidate_answer
    warnings = [*gathered.warnings, *citation_warnings]
    if not ok:
        warnings.append("Candidate response was not verified; returning an explicit refusal summary.")
        final_answer = "\n".join(
            [
                "I could not confidently verify the candidate response from the current repo snapshot.",
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
        gatherer_provider=gathered.gatherer_provider,
        gatherer_call_id=gathered.gatherer_call_id,
        gatherer_artifact_dir=gathered.gatherer_artifact_dir,
        gatherer_plan=gathered.gatherer_plan,
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

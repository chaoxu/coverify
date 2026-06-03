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


def _snippet_for(
    file: SourceFile,
    tokens: list[str],
    *,
    context_lines: int = 48,
    query: str = "",
) -> SourceSnippet:
    lines = file.content.splitlines()
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
            "Choose the repo passages needed to answer the user's mathematical question.",
            "You are only preparing context, not answering the question.",
            "",
            "Allowed sources are the current source bundle directory only. You may",
            "inspect files inside that directory directly. Do not request issues, PRs,",
            "git history, web pages, sibling repos, local notes, or hidden memory.",
            "",
            "Prefer canonical ledger/status pages, theorem statements, examples,",
            "proofs, obstruction notes, and active-front sections over introductory",
            "frontmatter. For broad status questions, include the actual bound tables",
            "and active-front/future-work sections when they exist.",
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

    def replace(match: re.Match[str]) -> str:
        path = match.group("path")
        start_raw = match.group("colon_start") or match.group("hash_start")
        end_raw = match.group("colon_end") or match.group("hash_end") or start_raw
        if start_raw is None or end_raw is None:
            warnings.append(f"Invalid citation {match.group(0)!r}: line range was missing.")
            return match.group(0)
        start = int(start_raw)
        end = int(end_raw)
        if end < start:
            warnings.append(f"Invalid descending citation {match.group(0)!r}.")
            return match.group(0)
        snippet = _containing_snippet(snippets, path, start, end)
        if snippet is None:
            warnings.append(f"Invalid citation {match.group(0)!r}: line range was not in gathered context.")
            return match.group(0)
        normalized_range = (
            f"L{snippet.line_start}"
            if snippet.line_start == snippet.line_end
            else f"L{snippet.line_start}-{snippet.line_end}"
        )
        normalized_ref = f"{path}#{normalized_range}"
        normalized = f"[{normalized_ref}]({normalized_ref})"
        if normalized != match.group(0):
            warnings.append(f"Normalized citation {match.group(0)!r} to {normalized!r}.")
        return normalized

    normalized_answer = pattern.sub(replace, answer)
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
            "- Write Markdown suitable for a Cosheaf issue comment.",
            "- Use short headings and bullet lists when they improve scanability.",
            "- Use TeX math syntax (`$...$` or `$$...$$`) for formulas, bounds, inequalities, and named constants; do not flatten mathematical status into plain prose.",
            "- Prefer Cosheaf semantic references such as `[@thm:main]`, `[@eq:bound]`, or narrative `@sec:status` when the source defines stable ids for the relevant theorem, equation, heading, example, or status block.",
            "- Use exact gathered source-range links only as fallback evidence when no stable semantic id exists, e.g. `[model-and-bound-ledger.md#L56-80](model-and-bound-ledger.md#L56-80)`.",
            "- Put either a semantic `[@id]` reference or a fallback source-range link in every table row or bullet that states a repo-specific bound, witness, obstruction, or next-step status.",
            "- Do not wrap source refs in backticks and do not use `path.md:10-40` in the final answer.",
            "- Do not invent narrower line citations; if the snippet header is `a.md:10-40`, cite `[a.md#L10-40](a.md#L10-40)`.",
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
            "Reject citations to repo line ranges that are not exact gathered snippet",
            "headers after converting `path.md#Lx-y` references back to line ranges.",
            "Reject final answers that are not Markdown suitable for a Cosheaf issue",
            "comment or that use `path.md:x-y` instead of `path.md#Lx-y` source refs.",
            "Reject broad status answers that omit TeX notation for mathematical",
            "bounds, or that state repo-specific bounds/witnesses/next steps without",
            "a Cosheaf semantic `[@id]`/`@id` reference or a clickable Markdown link",
            "to an exact source range.",
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
    gatherer_backend: BackendRunner | None = None,
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
        gatherer_backend=gatherer_backend,
    )
    prompt = build_reasoner_prompt(
        question=question,
        thread_context=thread_context,
        bundle=bundle,
        gathered=gathered,
    )
    answer_result = answer_backend(prompt)
    candidate_answer, citation_warnings = normalize_answer_citations(answer_result.answer, gathered.snippets)
    invalid_citations = [warning for warning in citation_warnings if warning.startswith("Invalid ")]
    verification = verification_from_metadata(answer_result)
    verifier_result: BackendResult | None = None
    verifier_answer: str | None = None
    if invalid_citations:
        verification = "failed"
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
            ),
        )
        verifier_answer = verifier_result.answer
        try:
            verdict = parse_verdict(verifier_result.answer).value
        except ValueError:
            verdict = ERROR
        verification = "passed" if verdict == "PASS" else "failed" if verdict == "FAIL" else "error"

    ok = verification == "passed"
    final_answer = candidate_answer
    warnings = [*gathered.warnings, *citation_warnings]
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

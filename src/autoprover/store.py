from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Iterable


VALID_VERDICTS = {"approve", "reject", "unsure"}
ARTIFACT_TYPES = {
    "proof-candidate",
    "lemma",
    "reduction",
    "counterexample",
    "failed-direction",
    "computation",
    "literature-claim",
    "definition",
    "formulation",
}


class StoreError(ValueError):
    pass


@dataclass(frozen=True)
class MarkdownDocument:
    metadata: dict[str, str]
    body: str


@dataclass(frozen=True)
class SearchResult:
    kind: str
    path: Path
    title: str
    status: str
    summary: str


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip().lower()).strip("-")
    if not slug:
        raise StoreError("id must contain at least one letter or number")
    return slug


def init_store(root: str | Path) -> Path:
    root_path = Path(root)
    for name in ("drafts", "artifacts", "reviews", "golden"):
        (root_path / name).mkdir(parents=True, exist_ok=True)
    return root_path


def write_markdown(path: Path, metadata: dict[str, str], body: str) -> None:
    lines = ["---"]
    for key in sorted(metadata):
        value = str(metadata[key]).replace("\n", " ").strip()
        lines.append(f"{key}: {value}")
    lines.extend(["---", "", body.rstrip(), ""])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def read_markdown(path: Path) -> MarkdownDocument:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return MarkdownDocument({}, text)
    _, rest = text.split("---\n", 1)
    meta_text, sep, body = rest.partition("\n---\n")
    if not sep:
        return MarkdownDocument({}, text)
    metadata: dict[str, str] = {}
    for line in meta_text.splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip()
    return MarkdownDocument(metadata, body.lstrip("\n"))


def draft_path(root: str | Path, artifact_id: str) -> Path:
    return Path(root) / "drafts" / f"{slugify(artifact_id)}.md"


def artifact_path(root: str | Path, artifact_id: str) -> Path:
    return Path(root) / "artifacts" / f"{slugify(artifact_id)}.md"


def review_dir(root: str | Path, artifact_id: str) -> Path:
    return Path(root) / "reviews" / slugify(artifact_id)


def create_draft(
    root: str | Path,
    artifact_id: str,
    title: str,
    artifact_type: str,
    body: str,
    source: str = "",
) -> Path:
    if artifact_type not in ARTIFACT_TYPES:
        raise StoreError(f"unknown artifact type: {artifact_type}")
    init_store(root)
    path = draft_path(root, artifact_id)
    metadata = {
        "id": slugify(artifact_id),
        "title": title,
        "type": artifact_type,
        "created": now_iso(),
    }
    if source:
        metadata["source"] = source
    write_markdown(path, metadata, body)
    return path


def submit_artifact(root: str | Path, artifact_id: str) -> Path:
    init_store(root)
    source = draft_path(root, artifact_id)
    destination = artifact_path(root, artifact_id)
    if not source.exists():
        raise StoreError(f"draft not found: {artifact_id}")
    if destination.exists():
        raise StoreError(f"submitted artifact already exists: {artifact_id}")
    doc = read_markdown(source)
    metadata = dict(doc.metadata)
    metadata["submitted"] = now_iso()
    write_markdown(destination, metadata, doc.body)
    return destination


def create_review(
    root: str | Path,
    artifact_id: str,
    verifier: str,
    verdict: str,
    summary: str,
    critical_errors: str = "",
    gaps: str = "",
    repair_hints: str = "",
    reusable_parts: str = "",
) -> Path:
    init_store(root)
    artifact = artifact_path(root, artifact_id)
    if not artifact.exists():
        raise StoreError(f"submitted artifact not found: {artifact_id}")
    verdict = verdict.strip().lower()
    review_id = f"{now_iso().replace(':', '').replace('+', 'z')}-{slugify(verifier)}"
    metadata = {
        "id": review_id,
        "artifact": slugify(artifact_id),
        "verifier": verifier,
        "verdict": verdict,
        "created": now_iso(),
        "summary": summary,
        "critical_errors": critical_errors,
        "gaps": gaps,
        "repair_hints": repair_hints,
        "reusable_parts": reusable_parts,
    }
    body = "\n".join(
        [
            f"# Review: {artifact_id}",
            "",
            f"Verdict: `{verdict}`",
            "",
            "## Summary",
            summary,
            "",
            "## Critical Errors",
            critical_errors or "None recorded.",
            "",
            "## Gaps",
            gaps or "None recorded.",
            "",
            "## Repair Hints",
            repair_hints or "None recorded.",
            "",
            "## Reusable Parts",
            reusable_parts or "None recorded.",
        ]
    )
    path = review_dir(root, artifact_id) / f"{review_id}.md"
    write_markdown(path, metadata, body)
    return path


def review_documents(root: str | Path, artifact_id: str) -> list[MarkdownDocument]:
    directory = review_dir(root, artifact_id)
    if not directory.exists():
        return []
    return [read_markdown(path) for path in sorted(directory.glob("*.md"))]


def is_valid_review(doc: MarkdownDocument, artifact_id: str) -> bool:
    required = {"id", "artifact", "verifier", "verdict", "created", "summary"}
    metadata = doc.metadata
    return (
        required.issubset(metadata)
        and metadata.get("artifact") == slugify(artifact_id)
        and metadata.get("verdict") in VALID_VERDICTS
    )


def valid_reviews(root: str | Path, artifact_id: str) -> list[MarkdownDocument]:
    return [
        doc
        for doc in review_documents(root, artifact_id)
        if is_valid_review(doc, artifact_id)
    ]


def trust_status(root: str | Path, artifact_id: str) -> str:
    artifact = artifact_path(root, artifact_id)
    if not artifact.exists():
        if draft_path(root, artifact_id).exists():
            return "draft"
        raise StoreError(f"artifact not found: {artifact_id}")
    reviews = valid_reviews(root, artifact_id)
    if not reviews:
        return "submitted"
    verdicts = {doc.metadata["verdict"] for doc in reviews}
    has_reusable = any(doc.metadata.get("reusable_parts", "").strip() for doc in reviews)
    if "approve" in verdicts and ("reject" in verdicts or "unsure" in verdicts):
        return "disputed"
    if "reject" in verdicts and "unsure" in verdicts:
        return "disputed"
    if has_reusable and "approve" not in verdicts:
        return "partial"
    if verdicts == {"approve"}:
        return "approved"
    if "reject" in verdicts:
        return "rejected"
    if verdicts == {"unsure"}:
        return "unsure"
    return "submitted"


def review_summary(root: str | Path, artifact_id: str) -> str:
    reviews = valid_reviews(root, artifact_id)
    if not reviews:
        return "No valid reviews."
    latest = reviews[-1].metadata
    return f"{latest.get('verifier', 'unknown')}: {latest.get('verdict', 'unknown')} - {latest.get('summary', '')}"


def search(root: str | Path, query: str, mode: str = "exploration") -> list[SearchResult]:
    root_path = Path(root)
    query_lower = query.lower()
    results: list[SearchResult] = []
    if mode not in {"exploration", "golden", "mixed"}:
        raise StoreError(f"unknown search mode: {mode}")
    if mode in {"golden", "mixed"}:
        for path in sorted((root_path / "golden").glob("*.md")):
            doc = read_markdown(path)
            haystack = f"{doc.metadata} {doc.body}".lower()
            if query_lower in haystack:
                results.append(
                    SearchResult(
                        kind="golden",
                        path=path,
                        title=doc.metadata.get("title", path.stem),
                        status="golden",
                        summary="Accepted golden knowledge.",
                    )
                )
    if mode in {"exploration", "mixed"}:
        for path in sorted((root_path / "artifacts").glob("*.md")):
            doc = read_markdown(path)
            haystack = f"{doc.metadata} {doc.body}".lower()
            if query_lower in haystack:
                artifact_id = doc.metadata.get("id", path.stem)
                status = trust_status(root_path, artifact_id)
                results.append(
                    SearchResult(
                        kind="artifact",
                        path=path,
                        title=doc.metadata.get("title", path.stem),
                        status=status,
                        summary=review_summary(root_path, artifact_id),
                    )
                )
    return results


def format_results(results: Iterable[SearchResult]) -> str:
    lines: list[str] = []
    for result in results:
        lines.append(f"[{result.status}] {result.kind}: {result.title}")
        lines.append(f"  {result.path}")
        lines.append(f"  {result.summary}")
    return "\n".join(lines) if lines else "No results."


def create_coin_benchmark(root: str | Path) -> list[Path]:
    init_store(root)
    created: list[Path] = []
    artifacts = [
        (
            "coin-net-formulation",
            "Reusable net formulation for divisible coin denominations",
            "formulation",
            "The two-round protocol can be phrased in terms of each person's net value change. "
            "For each denomination, the table mediates transfers between people; only the count "
            "of moved coins matters. This formulation is reusable for later attempts.",
            "approve",
            "The net-flow formulation is a useful and correct starting point.",
            "",
            "",
            "Net-flow view by denomination.",
        ),
        (
            "coin-generating-function-attempt",
            "Generating-function attempt for the coin-denomination FPT problem",
            "failed-direction",
            "Attempt: encode each person's possible placed and removed coins by a generating "
            "function and combine the functions. Gap: the construction does not yet control "
            "cost while eliminating dependence on numeric coin values.",
            "reject",
            "The attempt does not prove FPT independent of numeric values.",
            "The construction does not control cost while removing dependence on numeric coin values.",
            "Try using the divisibility chain to compress states before introducing generating functions.",
            "",
        ),
        (
            "coin-symbolic-carry-dp-attempt",
            "Symbolic carry-DP attempt for the coin-denomination FPT problem",
            "failed-direction",
            "Attempt: use the divisibility chain to propagate symbolic carries across "
            "denominations. Gap: the state bound is not justified as a function of n only.",
            "unsure",
            "Promising direction, but the state bound is not established.",
            "The proposed carry state may still depend on numerical coin ratios or bill values.",
            "Show a bound on symbolic carry states that depends only on n, then prove transitions are polynomial in m.",
            "",
        ),
    ]
    for artifact_id, title, artifact_type, body, verdict, summary, gaps, repair_hints, reusable in artifacts:
        draft = draft_path(root, artifact_id)
        submitted = artifact_path(root, artifact_id)
        if not draft.exists() and not submitted.exists():
            created.append(create_draft(root, artifact_id, title, artifact_type, body))
        if not submitted.exists():
            created.append(submit_artifact(root, artifact_id))
        if not valid_reviews(root, artifact_id):
            created.append(
                create_review(
                    root,
                    artifact_id,
                    verifier="codex-smoke",
                    verdict=verdict,
                    summary=summary,
                    gaps=gaps,
                    repair_hints=repair_hints,
                    reusable_parts=reusable,
                )
            )
    return created

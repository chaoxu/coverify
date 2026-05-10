from __future__ import annotations

from dataclasses import dataclass
import re

from .format import COFLAT_PRIMER


@dataclass(frozen=True)
class ContextDoc:
    doc_id: str
    path: str
    title: str
    doc_type: str
    status: str
    content: str


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return slug[:80] or "exploration"


def format_context(docs: list[ContextDoc]) -> str:
    if not docs:
        return "No Cosheaf context was retrieved."
    parts: list[str] = []
    for doc in docs:
        parts.append(
            "\n".join(
                [
                    f"## Context: {doc.title or doc.path}",
                    f"- id: {doc.doc_id}",
                    f"- path: {doc.path}",
                    f"- type: {doc.doc_type}",
                    f"- status: {doc.status}",
                    "- body follows without Cosheaf YAML frontmatter:",
                    "",
                    doc.content,
                ]
            )
        )
    return "\n\n---\n\n".join(parts)


def build_explore_prompt(direction: str, docs: list[ContextDoc]) -> str:
    return "\n".join(
        [
            "You are writing a mathematical exploration document for Cosheaf.",
            "",
            COFLAT_PRIMER,
            "",
            "Be precise about what is proved, what is conjectural, and what remains open.",
            "Do not claim unreviewed context is established truth.",
            "",
            "# User direction",
            direction,
            "",
            "# Retrieved Cosheaf context",
            format_context(docs),
        ]
    )


def build_proposal_prompt(direction: str, target: ContextDoc, docs: list[ContextDoc]) -> str:
    return "\n".join(
        [
            "You are proposing a replacement body for an existing Cosheaf page.",
            "",
            COFLAT_PRIMER,
            "",
            "Return the full replacement body for the target page.",
            "Preserve correct mathematical content and repair only what the direction asks for.",
            "",
            "# User direction",
            direction,
            "",
            "# Target page",
            format_context([target]),
            "",
            "# Additional context",
            format_context(docs),
        ]
    )


def build_review_prompt(target: ContextDoc) -> str:
    return "\n".join(
        [
            "You are a verifier for a Cosheaf mathematical document.",
            "Review the target document as written.",
            "",
            COFLAT_PRIMER,
            "",
            "Return exactly this plain-text protocol:",
            "DECISION: approve or reject",
            "COMMENT: one short line",
            "BODY:",
            "# Review",
            "Long-form Coflat Markdown review body.",
            "Do not wrap the response in a code fence.",
            "",
            "Approve only if the mathematical claims in the target are correct as written.",
            "Also reject if the target is malformed Coflat Markdown, lacks a clear H1 title, or uses code fences for mathematical proof blocks.",
            "Reject if a claimed result is false, unjustified, incomplete, or depends on untrusted assumptions.",
            "",
            "# Target document",
            format_context([target]),
        ]
    )


def build_repair_prompt(direction: str, target: ContextDoc, reviews: list[ContextDoc]) -> str:
    return "\n".join(
        [
            "You are repairing a rejected Cosheaf mathematical document.",
            "",
            COFLAT_PRIMER,
            "",
            "Return the full replacement body for a proposal targeting the rejected page.",
            "Use the verifier reviews as binding feedback. Preserve correct parts and fix rejected parts.",
            "",
            "# Repair direction",
            direction,
            "",
            "# Rejected target",
            format_context([target]),
            "",
            "# Verifier reviews and rejection rationale",
            format_context(reviews),
        ]
    )

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .backend import BackendResult, audit_summary
from .review import review_event_from_oracle


class BackendRunner(Protocol):
    def __call__(self, context: str) -> BackendResult: ...


@dataclass(frozen=True)
class InfinitePrimesRunOptions:
    workspace: str
    workspace_name: str
    default_md_format: str
    create_workspace: bool
    allow_existing_workspace: bool
    branch: str
    path: str
    title: str
    merge: bool
    force_merge: bool


@dataclass(frozen=True)
class KbWriteResult:
    page: str
    report: str


def default_branch_name() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"agent/infinite-primes-{stamp}"


def build_infinite_primes_context(workspace: str, existing_files: list[str]) -> str:
    files_text = "\n".join(f"- {path}" for path in existing_files) or "- none"
    return "\n".join(
        [
            "# Mathematical Oracle Task: Infinitely Many Primes",
            "",
            "You are given a Cosheaf workspace context pack.",
            "",
            "## Objective",
            "",
            "Prove that there are infinitely many prime numbers.",
            "",
            "## Workspace",
            "",
            f"- Workspace: `{workspace}`",
            "- Accepted files on `main`:",
            files_text,
            "",
            "## Required Output",
            "",
            "- Output a concise mathematical proof, not a repository document.",
            "- Do not optimize for Coflat or Markdown formatting; a KB writer",
            "  will turn useful proof text into a math document later.",
            "- Use the standard Euclid argument: assume finitely many primes,",
            "  form `N = p_1 p_2 ... p_n + 1`, and derive a new prime divisor.",
            "",
        ],
    )


def strip_markdown_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def validate_infinite_primes_oracle_answer(answer: str) -> str:
    proof = strip_markdown_fence(answer).strip()
    lowered = proof.lower()
    if not proof:
        raise ValueError("oracle proof text is empty")
    if "```" in proof or ":::" in proof or ".theorem" in lowered or ".proof" in lowered:
        raise ValueError("oracle output looks like a formatted document, not raw proof text")

    product_plus_one_pattern = re.compile(
        r"p_1\s*(?:p_2|\\cdots|\\ldots|\.\.\.|\*)[\s\S]*?p_n\s*\+\s*1",
        re.IGNORECASE,
    )
    required_checks = [
        (re.search(r"\b(finitely|finite)\b", lowered) is not None, "finite-prime contradiction setup"),
        ("p_1" in lowered, "listed primes"),
        (re.search(r"\+\s*1", proof) is not None, "Euclid plus-one construction"),
        ("divis" in lowered, "new prime divisor argument"),
        ("contradict" in lowered, "explicit contradiction"),
    ]
    missing = [label for ok, label in required_checks if not ok]
    if missing or not product_plus_one_pattern.search(proof):
        if not product_plus_one_pattern.search(proof):
            missing.append("product-plus-one construction")
        raise ValueError(f"oracle proof text is too weak for the KB writer; missing {missing}")
    return proof


def kb_write_infinite_primes_from_oracle(answer: str) -> KbWriteResult:
    proof = validate_infinite_primes_oracle_answer(answer)
    report = "\n".join(
        [
            "KB writer report:",
            "",
            "CLAIM_MAP:",
            "- The source proof claims infinitely many primes -> `@thm:infinitely-many-primes`.",
            "",
            "TRUST_LABELS:",
            "- Proposed theorem and proof: correctness-relevant PR content pending review.",
            "- Raw oracle answer: source material only, not accepted knowledge.",
            "",
            "INTERNAL_LINKS:",
            "- None; no accepted in-workspace dependency is needed for Euclid's proof.",
            "",
            "WORKFLOW_LINKS:",
            "- None.",
            "",
            "DROPPED_OR_UNCERTAIN_MATERIAL:",
            "- None.",
            "",
            "REVIEWER_CHECKLIST:",
            "- Verify the finite-prime contradiction setup.",
            "- Verify the construction $N = p_1 p_2 \\cdots p_n + 1$.",
            "- Verify that no listed prime divides $N$.",
            "- Verify that $N > 1$ has a prime divisor not in the finite list.",
        ],
    )
    page = "\n".join(
        [
            "# Infinitely Many Primes",
            "",
            "::: {.theorem #thm:infinitely-many-primes title=\"Infinitely many primes\"}",
            "There are infinitely many prime numbers.",
            ":::",
            "",
            "::: {.proof}",
            proof,
            ":::",
            "",
        ],
    )
    return KbWriteResult(page=page, report=report)


def write_infinite_primes_page_from_oracle(answer: str) -> str:
    return kb_write_infinite_primes_from_oracle(answer).page


def run_ask_oracle(*, prompt: str, backend: BackendRunner, retries: int = 0) -> dict[str, Any]:
    if not prompt.strip():
        raise ValueError("oracle prompt is empty")
    if retries < 0:
        raise ValueError("oracle retries cannot be negative")
    failures: list[Exception] = []
    for _attempt in range(retries + 1):
        try:
            backend_result = backend(prompt)
            break
        except RuntimeError as exc:
            failures.append(exc)
    else:
        raise RuntimeError(
            "oracle backend failed after "
            f"{retries + 1} attempt(s); last error: {failures[-1]}",
        ) from failures[-1]
    return {
        "ok": True,
        "answer": backend_result.answer,
        "backend_provider": backend_result.provider,
        "oracle_call_id": backend_result.oracle_call_id,
        "backend_artifact_dir": str(backend_result.artifact_dir),
        "backend_audit": audit_summary(backend_result),
    }


def build_infinite_primes_pr_body(
    *,
    backend_result: BackendResult,
    backend_audit: str,
    path: str,
    writer_report: str,
) -> str:
    return "\n".join(
        [
            "Autoprover v1 wrote a Coflat proof page for Euclid's theorem.",
            "The backend produced mathematical proof text; the local KB writer",
            "step shaped it into a Coflat theorem/proof document.",
            "",
            f"- Backend: `{backend_result.provider}`",
            f"- Oracle call id: `{backend_result.oracle_call_id}`",
            f"- Backend artifacts: `{backend_result.artifact_dir}`",
            f"- Proposed page: `{path}`",
            "",
            writer_report,
            "",
            "```text",
            backend_audit,
            "```",
        ],
    )


def validate_infinite_primes_page(page: str) -> None:
    lowered = page.lower()
    required = [
        "# infinitely many primes",
        "prime",
        "p_1",
        "1",
        ".theorem",
        ".proof",
    ]
    missing = [needle for needle in required if needle not in lowered]
    if missing:
        raise ValueError(f"backend output does not look like the required proof page; missing {missing}")
    product_pattern = re.compile(r"p_1\s*p_2|p_1.*p_n|p_1\\s*p_2", re.IGNORECASE | re.DOTALL)
    if "contradict" not in lowered or not product_pattern.search(page):
        raise ValueError("backend output does not contain the expected Euclid contradiction structure")


def build_infinite_primes_review_prompt(page: str, proposal_audit: str, writer_report: str) -> str:
    return "\n".join(
        [
            "# Oracle Task: Review Infinitely Many Primes PR",
            "",
            "Act as a careful mathematical referee and knowledge-base reviewer.",
            "Decide whether the proposed Cosheaf PR is safe to merge.",
            "",
            "Output exactly one decision line:",
            "",
            "DECISION: APPROVE | REQUEST_CHANGES | COMMENT",
            "",
            "Use APPROVE only if you do not see a logical gap and the page is",
            "safe to merge as accepted knowledge. Use REQUEST_CHANGES if there",
            "is a correctness gap, missing justification, notation problem that",
            "affects correctness, or if the PR is not decidable from the supplied",
            "evidence. Use COMMENT only for non-blocking notes.",
            "",
            "Then include FINDINGS, NONTRIVIAL_DEPENDENCIES, BLOCKING_CHANGES,",
            "and VERDICT sections explaining why.",
            "",
            "## Proposal Audit",
            "",
            proposal_audit,
            "",
            "## KB Writer Report",
            "",
            writer_report,
            "",
            "## Proposed Page",
            "",
            page,
            "",
        ],
    )


def _files_from_tree(tree: Any) -> list[str]:
    if not isinstance(tree, dict):
        return []
    files = tree.get("files")
    if not isinstance(files, list):
        return []
    out: list[str] = []
    for item in files:
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            out.append(item["path"])
    return out


def _pr_number(pr: Any) -> int:
    if isinstance(pr, dict) and isinstance(pr.get("number"), int):
        return pr["number"]
    raise RuntimeError(f"open_pull_request response did not include a PR number: {pr!r}")


def _read_content(response: Any) -> str:
    if isinstance(response, dict) and isinstance(response.get("content"), str):
        return response["content"]
    raise RuntimeError(f"read_file response did not include content: {response!r}")


def run_infinite_primes_workflow(
    *,
    client: Any,
    reviewer_client: Any | None,
    backend: BackendRunner,
    review_backend: BackendRunner | None = None,
    options: InfinitePrimesRunOptions,
) -> dict[str, Any]:
    if options.create_workspace:
        try:
            client.create_workspace(
                options.workspace,
                options.workspace_name,
                default_md_format=options.default_md_format,
            )
        except Exception as err:
            code = getattr(err, "code", None)
            if not (options.allow_existing_workspace and code == "conflict"):
                raise

    tree = client.list_workspace_files(options.workspace, branch="main")
    existing_files = _files_from_tree(tree)
    context = build_infinite_primes_context(options.workspace, existing_files)
    backend_result = backend(context)
    backend_audit = audit_summary(backend_result)
    writer_result = kb_write_infinite_primes_from_oracle(backend_result.answer)
    page = writer_result.page
    validate_infinite_primes_page(page)

    client.create_branch(options.workspace, options.branch)
    write_result = client.write_branch_file(
        options.workspace,
        options.path,
        options.branch,
        page,
    )
    pr = client.open_pull_request(
        options.workspace,
        head=options.branch,
        title=options.title,
        body=build_infinite_primes_pr_body(
            backend_result=backend_result,
            backend_audit=backend_audit,
            path=options.path,
            writer_report=writer_result.report,
        ),
    )
    pr_number = _pr_number(pr)

    reviewed = False
    review_approved = False
    review_event = None
    review_oracle_call_id = None
    if reviewer_client is not None:
        if review_backend is None:
            raise RuntimeError("reviewer client requires an oracle review backend")
        review_result = review_backend(build_infinite_primes_review_prompt(page, backend_audit, writer_result.report))
        review_event = review_event_from_oracle(review_result.answer)
        review_oracle_call_id = review_result.oracle_call_id
        review_audit = audit_summary(review_result)
        reviewer_client.review_pull_request(
            options.workspace,
            pr_number,
            event=review_event,
            body="\n".join(
                [
                    "Autoprover oracle reviewer submitted this verdict.",
                    "",
                    f"- Review backend: `{review_result.provider}`",
                    f"- Review oracle call id: `{review_result.oracle_call_id}`",
                    f"- Review backend artifacts: `{review_result.artifact_dir}`",
                    "",
                    "```text",
                    review_audit,
                    "```",
                    "",
                    review_result.answer.strip(),
                ],
            ),
        )
        reviewed = True
        review_approved = review_event == "APPROVE"

    merged = False
    if options.merge:
        if not review_approved:
            raise RuntimeError("refusing to merge without oracle reviewer approval recorded by this run")
        client.merge_pull_request(
            options.workspace,
            pr_number,
            method="squash",
            force=options.force_merge,
        )
        merged = True

    verify_branch = "main" if merged else options.branch
    written = _read_content(client.read_file(options.workspace, options.path, branch=verify_branch))
    validate_infinite_primes_page(written)

    return {
        "ok": True,
        "workspace": options.workspace,
        "branch": options.branch,
        "path": options.path,
        "pr_number": pr_number,
        "reviewed": reviewed,
        "review_event": review_event,
        "review_approved": review_approved,
        "review_oracle_call_id": review_oracle_call_id,
        "merged": merged,
        "verified_branch": verify_branch,
        "backend_provider": backend_result.provider,
        "oracle_call_id": backend_result.oracle_call_id,
        "backend_artifact_dir": str(backend_result.artifact_dir),
        "write_result": write_result,
    }

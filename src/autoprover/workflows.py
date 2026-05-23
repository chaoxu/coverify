from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .backend import BackendResult


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


def default_branch_name() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"agent/infinite-primes-{stamp}"


def build_infinite_primes_context(workspace: str, existing_files: list[str]) -> str:
    files_text = "\n".join(f"- {path}" for path in existing_files) or "- none"
    return "\n".join(
        [
            "# Oracle Task: Infinitely Many Primes",
            "",
            "You are given a Cosheaf workspace context pack.",
            "",
            "## Objective",
            "",
            "Write a concise, correct Coflat-compatible Markdown page proving",
            "that there are infinitely many prime numbers.",
            "",
            "## Workspace",
            "",
            f"- Workspace: `{workspace}`",
            "- Accepted files on `main`:",
            files_text,
            "",
            "## Required Output",
            "",
            "- Output only Markdown page body text.",
            "- Start with `# Infinitely Many Primes`.",
            "- Include one theorem block with stable id `#thm:infinitely-many-primes`.",
            "- Include one proof block.",
            "- Use the standard Euclid argument: assume finitely many primes,",
            "  form `N = p_1 p_2 ... p_n + 1`, and derive a new prime divisor.",
            "- Do not include YAML frontmatter, code fences, or workflow commentary.",
            "",
            "## Coflat Shape",
            "",
            "Use Pandoc fenced divs for theorem/proof blocks, for example:",
            "",
            "::: {.theorem #thm:infinitely-many-primes title=\"Infinitely many primes\"}",
            "Statement.",
            ":::",
            "",
            "::: {.proof}",
            "Proof.",
            ":::",
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


def normalize_proof_page(answer: str) -> str:
    page = strip_markdown_fence(answer)
    if not page.startswith("# "):
        page = "# Infinitely Many Primes\n\n" + page
    return page.rstrip() + "\n"


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
    page = normalize_proof_page(backend_result.answer)
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
        body="\n".join(
            [
                "Autoprover v1 wrote a Coflat proof page for Euclid's theorem.",
                "",
                f"- Backend: `{backend_result.provider}`",
                f"- Backend artifacts: `{backend_result.artifact_dir}`",
                f"- Proposed page: `{options.path}`",
            ],
        ),
    )
    pr_number = _pr_number(pr)

    reviewed = False
    if reviewer_client is not None:
        reviewer_client.review_pull_request(
            options.workspace,
            pr_number,
            event="APPROVE",
            body=(
                "Autoprover smoke reviewer: the page contains the standard "
                "Euclid contradiction proof and is safe for the v1 workflow test."
            ),
        )
        reviewed = True

    merged = False
    if options.merge:
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
        "merged": merged,
        "verified_branch": verify_branch,
        "backend_provider": backend_result.provider,
        "backend_artifact_dir": str(backend_result.artifact_dir),
        "write_result": write_result,
    }

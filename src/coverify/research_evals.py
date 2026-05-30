from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class ResearchEvalCandidate:
    id: str
    source: str
    source_url: str
    domain: str
    statement_sketch: str
    target_artifact: str
    why_good_eval: str
    tier: str
    one_shot_probe: str
    few_shot_probe: str


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug or "research-eval"


def require_str(raw: dict[str, Any], key: str, path: Path, line_number: int) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{path}:{line_number}: {key} must be a non-empty string")
    return value


def load_research_eval_candidates(path: Path) -> list[ResearchEvalCandidate]:
    candidates: list[ResearchEvalCandidate] = []
    with path.open(encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            raw = json.loads(text)
            candidates.append(
                ResearchEvalCandidate(
                    id=require_str(raw, "id", path, line_number),
                    source=require_str(raw, "source", path, line_number),
                    source_url=require_str(raw, "source_url", path, line_number),
                    domain=require_str(raw, "domain", path, line_number),
                    statement_sketch=require_str(raw, "statement_sketch", path, line_number),
                    target_artifact=require_str(raw, "target_artifact", path, line_number),
                    why_good_eval=require_str(raw, "why_good_eval", path, line_number),
                    tier=require_str(raw, "tier", path, line_number),
                    one_shot_probe=require_str(raw, "one_shot_probe", path, line_number),
                    few_shot_probe=require_str(raw, "few_shot_probe", path, line_number),
                ),
            )
    if not candidates:
        raise ValueError(f"research eval candidate file is empty: {path}")
    return candidates


def problem_page(candidate: ResearchEvalCandidate) -> str:
    title = f"Research Eval: {candidate.id}"
    return "\n".join(
        [
            "---",
            f"id: {slugify(candidate.id)}",
            f"title: {title}",
            "---",
            f"# {title}",
            "",
            "::: {.definition #research-eval-task}",
            f"**Source.** {candidate.source}",
            "",
            f"**Domain.** {candidate.domain}",
            "",
            "**Problem statement.**",
            "",
            candidate.statement_sketch,
            ":::",
            "",
            "## Target Artifact",
            "",
            candidate.target_artifact,
            "",
            "## Eval Protocol",
            "",
            "- Treat this as a research-level proof task, not an answer-only prompt.",
            "- Preserve useful partial progress in Cosheaf.",
            "- Do not silently change the statement or assumptions.",
            "- If the proof is incomplete, write a compact obstruction or failed-route note.",
            "- Any accepted proof must pass review before it counts as solved.",
            "",
            "## Probes",
            "",
            f"- One-shot probe: {candidate.one_shot_probe}",
            f"- Few-shot repair probe: {candidate.few_shot_probe}",
            "",
        ],
    )


def issue_body(candidate: ResearchEvalCandidate, page_path: str) -> str:
    return "\n".join(
        [
            f"Research-level Coverify eval task for `{candidate.id}`.",
            "",
            "## Statement",
            "",
            candidate.statement_sketch,
            "",
            "## Workspace Page",
            "",
            f"- `{page_path}`",
            "",
            "## Target Artifact",
            "",
            candidate.target_artifact,
            "",
            "## Why This Is In The Suite",
            "",
            candidate.why_good_eval,
            "",
            "## Scoring Rubric",
            "",
            "- Full solved proof: reviewed PR with a correct proof page.",
            "- Useful partial progress: reviewed lemma, obstruction, or failed-route note.",
            "- Repair progress: second attempt uses prior issue/PR/review state and avoids repeating a rejected route.",
            "- Failure: answer-only output, repeated known dead end, unsupported statement change, or unreviewed merge.",
            "",
            "## Guardrails",
            "",
            "- Keep durable output compact.",
            "- Prefer issue comments and PRs over local-only notes.",
            "- Record what was tried and what remains blocked.",
            "",
            "## Source",
            "",
            f"- {candidate.source}",
            f"- {candidate.source_url}",
        ],
    )


def _is_conflict(err: Exception) -> bool:
    return getattr(err, "code", None) == "conflict" or getattr(err, "status", None) == 409


def _number(response: Any) -> int:
    if isinstance(response, dict) and isinstance(response.get("number"), int):
        return response["number"]
    raise RuntimeError(f"response did not include a number: {response!r}")


def seed_research_eval_workspace(
    *,
    client: Any,
    workspace: str,
    workspace_name: str,
    candidates: Iterable[ResearchEvalCandidate],
    branch: str,
    path_prefix: str,
    create_workspace: bool,
    allow_existing_workspace: bool,
    default_md_format: str = "coflat",
) -> dict[str, Any]:
    candidate_list = list(candidates)
    if create_workspace:
        try:
            client.create_workspace(
                workspace,
                workspace_name or workspace,
                default_md_format=default_md_format,
            )
            workspace_created = True
        except Exception as err:
            if not (allow_existing_workspace and _is_conflict(err)):
                raise
            workspace_created = False
    else:
        workspace_created = False

    client.create_branch(workspace, branch)

    issues: list[dict[str, Any]] = []
    paths: list[str] = []
    write_results: list[Any] = []
    for candidate in candidate_list:
        page_path = f"{path_prefix.rstrip('/')}/{slugify(candidate.id)}.md"
        paths.append(page_path)
        issue = client.create_issue(
            workspace,
            title=f"Research eval: {candidate.id}",
            body=issue_body(candidate, page_path),
        )
        issue_number = _number(issue)
        issues.append({"id": candidate.id, "number": issue_number, "path": page_path})
        write_results.append(
            client.write_branch_file(
                workspace,
                page_path,
                branch,
                problem_page(candidate),
            ),
        )

    pr = client.open_pull_request(
        workspace,
        head=branch,
        title="Seed research-level Coverify eval tasks",
        body="\n".join(
            [
                "Seeds research-level Coverify eval problem pages.",
                "",
                "These pages define tasks; they are not accepted solutions.",
                "",
                "Seeded issues:",
                *[f"- #{item['number']} `{item['id']}` -> `{item['path']}`" for item in issues],
            ],
        ),
    )

    return {
        "ok": True,
        "workspace": workspace,
        "workspace_created": workspace_created,
        "branch": branch,
        "candidate_count": len(candidate_list),
        "issue_count": len(issues),
        "issues": issues,
        "paths": paths,
        "pr_number": _number(pr),
        "write_count": len(write_results),
    }

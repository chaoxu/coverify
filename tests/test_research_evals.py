from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from coverify.apps.research_evals import (
    ResearchEvalCandidate,
    load_research_eval_candidates,
    problem_page,
    seed_research_eval_workspace,
)


class FakeResearchEvalCosheaf:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.next_issue = 10
        self.next_pr = 3

    def create_workspace(self, slug: str, name: str, *, default_md_format: str | None = None) -> dict[str, str]:
        self.calls.append(("create_workspace", (slug, name, default_md_format)))
        return {"slug": slug, "name": name}

    def create_branch(self, workspace: str, name: str) -> dict[str, str]:
        self.calls.append(("create_branch", (workspace, name)))
        return {"name": name}

    def create_issue(self, workspace: str, *, title: str, body: str) -> dict[str, int]:
        self.calls.append(("create_issue", (workspace, title, body)))
        number = self.next_issue
        self.next_issue += 1
        return {"number": number}

    def write_branch_file(self, workspace: str, path: str, branch: str, content: str) -> dict[str, Any]:
        self.calls.append(("write_branch_file", (workspace, path, branch, content)))
        return {"ok": True}

    def open_pull_request(
        self,
        workspace: str,
        *,
        head: str,
        title: str,
        body: str,
        base: str = "main",
    ) -> dict[str, int]:
        self.calls.append(("open_pull_request", (workspace, head, base, title, body)))
        return {"number": self.next_pr}


def sample_candidate() -> ResearchEvalCandidate:
    return ResearchEvalCandidate(
        id="researchmath-14k-000-sample",
        source="ResearchMath-14k row 0 / sample",
        source_url="https://example.test/problem",
        domain="Number Theory / Diophantine equations",
        statement_sketch="Determine all integer solutions to x^2 - x = y^5 - y.",
        target_artifact="A reviewed proof attempt or obstruction note.",
        why_good_eval="It requires research-level proof progress.",
        tier="research-open",
        one_shot_probe="Attempt a proof.",
        few_shot_probe="Repair using prior Cosheaf state.",
    )


class ResearchEvalTests(unittest.TestCase):
    def test_load_research_eval_candidates(self) -> None:
        candidate = sample_candidate()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "candidates.jsonl"
            path.write_text(
                (
                    '{"id":"%s","source":"%s","source_url":"%s","domain":"%s",'
                    '"statement_sketch":"%s","target_artifact":"%s","why_good_eval":"%s",'
                    '"tier":"%s","one_shot_probe":"%s","few_shot_probe":"%s"}\n'
                )
                % (
                    candidate.id,
                    candidate.source,
                    candidate.source_url,
                    candidate.domain,
                    candidate.statement_sketch,
                    candidate.target_artifact,
                    candidate.why_good_eval,
                    candidate.tier,
                    candidate.one_shot_probe,
                    candidate.few_shot_probe,
                ),
                encoding="utf-8",
            )

            [loaded] = load_research_eval_candidates(path)

        self.assertEqual(loaded.id, candidate.id)
        self.assertEqual(loaded.domain, "Number Theory / Diophantine equations")

    def test_problem_page_contains_statement_and_protocol(self) -> None:
        page = problem_page(sample_candidate())

        self.assertIn("# Research Eval: researchmath-14k-000-sample", page)
        self.assertIn("Determine all integer solutions", page)
        self.assertIn("Any accepted proof must pass review", page)

    def test_seed_research_eval_workspace_creates_issues_pages_and_pr(self) -> None:
        client = FakeResearchEvalCosheaf()

        result = seed_research_eval_workspace(
            client=client,
            workspace="research-suite",
            workspace_name="Research Suite",
            candidates=[sample_candidate()],
            branch="research-eval-seed-test",
            path_prefix="research-evals/sample",
            create_workspace=True,
            allow_existing_workspace=False,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(result["issue_count"], 1)
        self.assertEqual(result["write_count"], 1)
        self.assertEqual(result["pr_number"], 3)
        self.assertEqual(result["issues"][0]["number"], 10)
        self.assertIn(("create_branch", ("research-suite", "research-eval-seed-test")), client.calls)
        self.assertTrue(any(call[0] == "create_issue" for call in client.calls))
        self.assertTrue(any(call[0] == "write_branch_file" for call in client.calls))
        self.assertTrue(any(call[0] == "open_pull_request" for call in client.calls))


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from autoprover.backend import run_fixture_backend
from autoprover.workflows import (
    InfinitePrimesRunOptions,
    build_infinite_primes_context,
    normalize_proof_page,
    run_infinite_primes_workflow,
    validate_infinite_primes_page,
)


class FakeCosheaf:
    def __init__(self) -> None:
        self.workspaces: set[str] = set()
        self.files: dict[tuple[str, str, str], str] = {}
        self.calls: list[tuple[str, Any]] = []
        self.next_pr = 1

    def create_workspace(self, slug: str, name: str, *, default_md_format: str | None = None) -> dict[str, str]:
        self.calls.append(("create_workspace", (slug, default_md_format)))
        self.workspaces.add(slug)
        return {"slug": slug, "name": name}

    def list_workspace_files(self, workspace: str, *, branch: str = "main") -> dict[str, list[dict[str, str]]]:
        self.calls.append(("list_workspace_files", (workspace, branch)))
        files = [
            {"path": path}
            for (ws, br, path), _content in self.files.items()
            if ws == workspace and br == branch
        ]
        return {"files": files}

    def create_branch(self, workspace: str, name: str) -> dict[str, str]:
        self.calls.append(("create_branch", (workspace, name)))
        return {"name": name}

    def write_branch_file(self, workspace: str, path: str, branch: str, content: str) -> dict[str, object]:
        self.calls.append(("write_branch_file", (workspace, path, branch)))
        self.files[(workspace, branch, path)] = content
        return {"ok": True, "branch": branch, "meta": {"id": "thm:infinitely-many-primes"}}

    def open_pull_request(self, workspace: str, *, head: str, title: str, body: str, base: str = "main") -> dict[str, object]:
        self.calls.append(("open_pull_request", (workspace, head, base, title, body)))
        number = self.next_pr
        self.next_pr += 1
        return {"number": number}

    def review_pull_request(self, workspace: str, pr_number: int, *, event: str, body: str) -> dict[str, object]:
        self.calls.append(("review_pull_request", (workspace, pr_number, event, body)))
        return {"ok": True}

    def merge_pull_request(self, workspace: str, pr_number: int, *, method: str = "squash", force: bool = False) -> dict[str, object]:
        self.calls.append(("merge_pull_request", (workspace, pr_number, method, force)))
        for (ws, branch, path), content in list(self.files.items()):
            if ws == workspace and branch != "main":
                self.files[(workspace, "main", path)] = content
        return {"ok": True}

    def read_file(self, workspace: str, path: str, *, branch: str = "main") -> dict[str, str]:
        self.calls.append(("read_file", (workspace, path, branch)))
        return {"content": self.files[(workspace, branch, path)]}


class WorkflowTests(unittest.TestCase):
    def test_fixture_backend_output_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = run_fixture_backend("context", artifact_root=Path(tmpdir))
            validate_infinite_primes_page(result.answer)
            self.assertTrue((result.artifact_dir / "prompt.md").exists())
            self.assertFalse((result.artifact_dir / "context.md").exists())
            self.assertTrue((result.artifact_dir / "answer.md").exists())

    def test_normalize_strips_markdown_fence(self) -> None:
        page = normalize_proof_page("```markdown\n# Infinitely Many Primes\n\nbody\n```")
        self.assertEqual(page, "# Infinitely Many Primes\n\nbody\n")

    def test_context_mentions_existing_files(self) -> None:
        context = build_infinite_primes_context("demo", ["knowledge.md"])
        self.assertIn("`demo`", context)
        self.assertIn("knowledge.md", context)
        self.assertIn("#thm:infinitely-many-primes", context)

    def test_workflow_writes_reviews_merges_and_verifies(self) -> None:
        author = FakeCosheaf()
        reviewer = FakeCosheaf()
        with tempfile.TemporaryDirectory() as tmpdir:
            options = InfinitePrimesRunOptions(
                workspace="prime-demo",
                workspace_name="Prime Demo",
                default_md_format="coflat",
                create_workspace=True,
                allow_existing_workspace=False,
                branch="agent/infinite-primes-test",
                path="infinite-primes.md",
                title="Proof",
                merge=True,
                force_merge=False,
            )
            result = run_infinite_primes_workflow(
                client=author,
                reviewer_client=reviewer,
                backend=lambda context: run_fixture_backend(context, artifact_root=Path(tmpdir)),
                options=options,
            )
        self.assertTrue(result["ok"])
        self.assertTrue(result["reviewed"])
        self.assertTrue(result["merged"])
        self.assertIn(("create_workspace", ("prime-demo", "coflat")), author.calls)
        self.assertTrue(any(call[0] == "write_branch_file" for call in author.calls))
        self.assertTrue(any(call[0] == "review_pull_request" for call in reviewer.calls))
        self.assertTrue(any(call[0] == "merge_pull_request" for call in author.calls))


if __name__ == "__main__":
    unittest.main()

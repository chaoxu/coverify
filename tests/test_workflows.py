from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from coverify.backend import BackendResult, run_fixture_backend, run_script_backend
from coverify.client import CosheafError
from coverify.workflows import (
    InfinitePrimesRunOptions,
    build_infinite_primes_context,
    kb_write_infinite_primes_from_oracle,
    run_ask_oracle,
    run_infinite_primes_workflow,
    validate_infinite_primes_oracle_answer,
    validate_infinite_primes_page,
    write_infinite_primes_page_from_oracle,
)


class FakeCosheaf:
    def __init__(self) -> None:
        self.workspaces: set[str] = set()
        self.files: dict[tuple[str, str, str], str] = {}
        self.calls: list[tuple[str, Any]] = []
        self.next_pr = 1
        self.list_failures_before_ready = 0

    def create_workspace(self, slug: str, name: str, *, default_md_format: str | None = None) -> dict[str, str]:
        self.calls.append(("create_workspace", (slug, default_md_format)))
        self.workspaces.add(slug)
        return {"slug": slug, "name": name}

    def list_workspace_files(self, workspace: str, *, branch: str = "main") -> dict[str, list[dict[str, str]]]:
        self.calls.append(("list_workspace_files", (workspace, branch)))
        if self.list_failures_before_ready > 0:
            self.list_failures_before_ready -= 1
            raise CosheafError("GET", f"/w/{workspace}/tree", 404, {"error": "workspace not found"})
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
    def test_run_ask_oracle_retries_transient_backend_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            calls = 0

            def flaky_backend(prompt: str) -> BackendResult:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError("codex backend finished without writing answer.md")
                return run_fixture_backend(prompt, artifact_root=Path(tmpdir))

            result = run_ask_oracle(prompt="prove something", backend=flaky_backend, retries=1)

        self.assertEqual(calls, 2)
        self.assertTrue(result["ok"])
        self.assertIn("infinitely many", result["answer"])

    def test_run_ask_oracle_reports_retry_exhaustion(self) -> None:
        def failing_backend(_prompt: str) -> BackendResult:
            raise RuntimeError("stream disconnected")

        with self.assertRaisesRegex(RuntimeError, "failed after 2 attempt"):
            run_ask_oracle(prompt="prove something", backend=failing_backend, retries=1)

    def test_fixture_backend_output_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = run_fixture_backend("context", artifact_root=Path(tmpdir))
            self.assertIn("p_1", result.answer)
            self.assertNotIn(".theorem", result.answer)
            validate_infinite_primes_page(write_infinite_primes_page_from_oracle(result.answer))
            self.assertTrue((result.artifact_dir / "prompt.md").exists())
            self.assertFalse((result.artifact_dir / "context.md").exists())
            self.assertTrue((result.artifact_dir / "answer.md").exists())

    def test_kb_writer_rejects_weak_or_formatted_oracle_output(self) -> None:
        with self.assertRaisesRegex(ValueError, "too weak"):
            validate_infinite_primes_oracle_answer("p_1 p_2 contradict")
        with self.assertRaisesRegex(ValueError, "product-plus-one"):
            validate_infinite_primes_oracle_answer(
                "\n".join(
                    [
                        "Assume there are finitely many primes listed as $p_1, p_2, \\ldots, p_n$.",
                        "Let $N = p_1 + 1$.",
                        "Then a divisor gives a contradiction.",
                    ],
                ),
            )
        with self.assertRaisesRegex(ValueError, "formatted document"):
            kb_write_infinite_primes_from_oracle(
                "\n".join(
                    [
                        "# Infinitely Many Primes",
                        "",
                        "::: {.theorem}",
                        "There are infinitely many prime numbers.",
                        ":::",
                    ],
                ),
            )

    def test_context_mentions_existing_files(self) -> None:
        context = build_infinite_primes_context("demo", ["knowledge.md"])
        self.assertIn("`demo`", context)
        self.assertIn("knowledge.md", context)
        self.assertIn("mathematical proof", context)
        self.assertIn("not a repository document", context)
        self.assertNotIn("#thm:infinitely-many-primes", context)

    def approve_review_backend(self, tmpdir: str):
        return lambda prompt: run_script_backend(
            prompt,
            command=(
                "python3 -c 'print(\"DECISION: APPROVE\\n\\n"
                "FINDINGS:\\nI do not see a logical gap.\\n\\n"
                "BLOCKING_CHANGES:\\nNone\\n\\n"
                "VERDICT:\\nThe proposed Euclid proof is correct.\")'"
            ),
            artifact_root=Path(tmpdir),
        )

    def request_changes_review_backend(self, tmpdir: str):
        return lambda prompt: run_script_backend(
            prompt,
            command=(
                "python3 -c 'print(\"DECISION: REQUEST_CHANGES\\n\\n"
                "FINDINGS:\\n- The proof is not decidable from the supplied PR.\\n\\n"
                "BLOCKING_CHANGES:\\nAdd the missing argument.\\n\\n"
                "VERDICT:\\nDo not merge yet.\")'"
            ),
            artifact_root=Path(tmpdir),
        )

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
                review_backend=self.approve_review_backend(tmpdir),
                options=options,
            )
        self.assertTrue(result["ok"])
        self.assertTrue(result["reviewed"])
        self.assertEqual(result["review_event"], "APPROVE")
        self.assertTrue(result["review_approved"])
        self.assertTrue(result["merged"])
        self.assertIn(("create_workspace", ("prime-demo", "coflat")), author.calls)
        self.assertTrue(any(call[0] == "write_branch_file" for call in author.calls))
        [open_pr_call] = [call for call in author.calls if call[0] == "open_pull_request"]
        self.assertIn("KB writer report", open_pr_call[1][4])
        self.assertIn("CLAIM_MAP", open_pr_call[1][4])
        self.assertIn("REVIEWER_CHECKLIST", open_pr_call[1][4])
        self.assertTrue(any(call[0] == "review_pull_request" for call in reviewer.calls))
        self.assertTrue(any(call[0] == "merge_pull_request" for call in author.calls))

    def test_workflow_waits_for_created_workspace_to_be_readable(self) -> None:
        author = FakeCosheaf()
        author.list_failures_before_ready = 1
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
                merge=False,
                force_merge=False,
            )
            result = run_infinite_primes_workflow(
                client=author,
                reviewer_client=None,
                backend=lambda context: run_fixture_backend(context, artifact_root=Path(tmpdir)),
                options=options,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(
            [call for call in author.calls if call[0] == "list_workspace_files"],
            [
                ("list_workspace_files", ("prime-demo", "main")),
                ("list_workspace_files", ("prime-demo", "main")),
            ],
        )

    def test_workflow_refuses_merge_without_review(self) -> None:
        author = FakeCosheaf()
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

            with self.assertRaisesRegex(RuntimeError, "refusing to merge without oracle reviewer approval"):
                run_infinite_primes_workflow(
                    client=author,
                    reviewer_client=None,
                    backend=lambda prompt: run_fixture_backend(prompt, artifact_root=Path(tmpdir)),
                    options=options,
                )

        self.assertFalse(any(call[0] == "merge_pull_request" for call in author.calls))

    def test_workflow_does_not_upgrade_request_changes(self) -> None:
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

            with self.assertRaisesRegex(RuntimeError, "refusing to merge without oracle reviewer approval"):
                run_infinite_primes_workflow(
                    client=author,
                    reviewer_client=reviewer,
                    backend=lambda prompt: run_fixture_backend(prompt, artifact_root=Path(tmpdir)),
                    review_backend=self.request_changes_review_backend(tmpdir),
                    options=options,
                )

        self.assertTrue(
            any(call[0] == "review_pull_request" and call[1][2] == "REQUEST_CHANGES" for call in reviewer.calls),
        )
        self.assertFalse(any(call[0] == "merge_pull_request" for call in author.calls))


if __name__ == "__main__":
    unittest.main()

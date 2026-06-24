from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from coverify.cli import build_parser


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def list_workspace_files(self, workspace: str, *, branch: str = "main") -> dict[str, Any]:
        self.calls.append(("list_workspace_files", (workspace,), {"branch": branch}))
        return {"files": [{"path": "README.md", "sha": "abc"}]}

    def read_file(self, workspace: str, path: str, *, branch: str = "main") -> dict[str, Any]:
        self.calls.append(("read_file", (workspace, path), {"branch": branch}))
        return {"path": path, "content": "# Source\n\nKnown fact.\n"}

    def read_issue(self, workspace: str, number: int) -> dict[str, Any]:
        self.calls.append(("read_issue", (workspace, number), {}))
        return {"issue": {"number": number, "title": "Prove a lemma", "body": "Show the useful fact."}}

    def read_issue_timeline(self, workspace: str, number: int) -> dict[str, Any]:
        self.calls.append(("read_issue_timeline", (workspace, number), {}))
        return {"events": [{"type": "comment", "body": "prior route failed"}]}

    def create_branch(self, workspace: str, name: str) -> dict[str, Any]:
        self.calls.append(("create_branch", (workspace, name), {}))
        return {"name": name}

    def write_branch_file(
        self,
        workspace: str,
        path: str,
        branch: str,
        content: str,
    ) -> dict[str, Any]:
        self.calls.append(("write_branch_file", (workspace, path, branch), {"content": content}))
        return {"path": path, "branch": branch}

    def open_pull_request(
        self,
        workspace: str,
        *,
        head: str,
        title: str,
        body: str,
        base: str = "main",
    ) -> dict[str, Any]:
        self.calls.append(("open_pull_request", (workspace,), {"head": head, "base": base, "title": title, "body": body}))
        return {"number": 11, "head": head}


class AttemptCliTests(unittest.TestCase):
    def run_cli(self, argv: list[str], client: FakeClient | None = None) -> dict[str, Any]:
        parser = build_parser()
        args = parser.parse_args(argv)
        stdout = io.StringIO()
        patches = [patch("sys.stdout", stdout)]
        if client is not None:
            patches.append(patch("coverify.cli.authed_client_from_args", return_value=client))
        with patches[0]:
            if len(patches) > 1:
                with patches[1]:
                    self.assertEqual(args.func(args), 0)
            else:
                self.assertEqual(args.func(args), 0)
        return json.loads(stdout.getvalue())

    def test_attempt_start_snapshots_cosheaf_without_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            client = FakeClient()
            result = self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--issue",
                    "5",
                    "--attempt-id",
                    "A1",
                    "--attempts-root",
                    str(Path(tmpdir) / "attempts"),
                ],
                client,
            )

            self.assertEqual(result["attempt_id"], "A1")
            self.assertEqual(result["workspace"], "owner/repo")
            self.assertTrue(Path(result["source_snapshot_path"]).exists())
            self.assertTrue(Path(result["source_bundle_path"]).exists())
            self.assertEqual(
                client.calls,
                [
                    ("read_issue", ("owner/repo", 5), {}),
                    ("read_issue_timeline", ("owner/repo", 5), {}),
                    ("list_workspace_files", ("owner/repo",), {"branch": "main"}),
                    ("read_file", ("owner/repo", "README.md"), {"branch": "main"}),
                ],
            )

    def test_attempt_prompt_writes_preview_without_backend(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A2",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Find a clean obstruction.",
                ],
                client,
            )
            output_dir = Path(tmpdir) / "preview"
            result = self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A2",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(output_dir),
                    "--json",
                ],
            )

            self.assertFalse(result["backend_invoked"])
            self.assertEqual(result["kind"], "publication-review")
            self.assertIn("Can this safely improve", result["prompt"])
            self.assertTrue((output_dir / "prompt.md").exists())
            self.assertTrue((output_dir / "preview.json").exists())

    def test_attempt_record_and_promote_accept_without_opening_pr_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A3",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Record a useful route.",
                ],
                client,
            )
            candidate_file = root / "A3" / "candidate" / "files" / "route.md"
            candidate_file.parent.mkdir(parents=True)
            candidate_file.write_text("# Route\n\nThis is compact knowledge.\n", encoding="utf-8")
            review_dir = Path(tmpdir) / "review"
            self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A3",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(review_dir),
                    "--json",
                ],
            )
            (review_dir / "answer.md").write_text(accepted_review_text(), encoding="utf-8")
            (review_dir / "metadata.json").write_text(
                json.dumps({"provider": "fixture", "oracle_call_id": "review-1"}),
                encoding="utf-8",
            )

            result = self.run_cli(
                [
                    "attempt",
                    "promote",
                    "--attempts-root",
                    str(root),
                    "A3",
                    "--review-call-dir",
                    str(review_dir),
                ],
            )

            self.assertTrue(result["checks"]["ok"])
            self.assertEqual(result["promotion"]["decision"], "accept")
            self.assertFalse(result["cosheaf_write_attempted"])
            self.assertEqual(
                client.calls,
                [
                    ("list_workspace_files", ("owner/repo",), {"branch": "main"}),
                    ("read_file", ("owner/repo", "README.md"), {"branch": "main"}),
                ],
            )

    def test_attempt_promote_opens_pr_only_after_accept(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A4",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Publish a page.",
                ],
                client,
            )
            candidate_file = root / "A4" / "candidate" / "files" / "notes" / "page.md"
            candidate_file.parent.mkdir(parents=True)
            candidate_file.write_text("# Page\n\nAccepted content.\n", encoding="utf-8")
            review_dir = Path(tmpdir) / "review"
            self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A4",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(review_dir),
                    "--json",
                ],
            )
            (review_dir / "answer.md").write_text(accepted_review_text(), encoding="utf-8")
            (review_dir / "metadata.json").write_text(
                json.dumps({"provider": "fixture", "oracle_call_id": "review-2"}),
                encoding="utf-8",
            )

            result = self.run_cli(
                [
                    "attempt",
                    "promote",
                    "--attempts-root",
                    str(root),
                    "A4",
                    "--review-call-dir",
                    str(review_dir),
                    "--open-pr",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--head",
                    "coverify/attempt-A4",
                ],
                client,
            )

            self.assertTrue(result["cosheaf_write_attempted"])
            self.assertEqual(result["pull_request"]["number"], 11)
            self.assertEqual(
                client.calls[-3:],
                [
                    ("create_branch", ("owner/repo", "coverify/attempt-A4"), {}),
                    (
                        "write_branch_file",
                        ("owner/repo", "notes/page.md", "coverify/attempt-A4"),
                        {"content": "# Page\n\nAccepted content.\n"},
                    ),
                    (
                        "open_pull_request",
                        ("owner/repo",),
                        {
                            "head": "coverify/attempt-A4",
                            "base": "main",
                            "title": "Promote Coverify attempt A4",
                            "body": "Promotes accepted Coverify attempt `A4`.\n\nPublication review decision: `accept`.\nCandidate files: 1.\nValidation: passed.\n",
                        },
                    ),
                ],
            )

    def test_attempt_call_runs_backend_and_records_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A5",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Draft one useful note.",
                ],
                client,
            )

            result = self.run_cli(
                [
                    "attempt",
                    "call",
                    "--attempts-root",
                    str(root),
                    "A5",
                    "--kind",
                    "author",
                    "--backend",
                    "script",
                    "--backend-command",
                    "python3 -c 'import sys; print(\"drafted:\" + sys.stdin.read()[:12])'",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "--json",
                ],
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["record"]["role"], "author")
            self.assertTrue((root / "A5" / "calls" / result["record"]["call_id"] / "prompt.md").exists())

    def test_attempt_promote_validation_command_blocks_pr(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A6",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Publish a checked page.",
                ],
                client,
            )
            candidate_file = root / "A6" / "candidate" / "files" / "page.md"
            candidate_file.parent.mkdir(parents=True)
            candidate_file.write_text("# Page\n\nContent.\n", encoding="utf-8")
            review_dir = Path(tmpdir) / "review"
            self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A6",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(review_dir),
                    "--json",
                ],
            )
            (review_dir / "answer.md").write_text(accepted_review_text(), encoding="utf-8")
            (review_dir / "metadata.json").write_text(
                json.dumps({"provider": "fixture", "oracle_call_id": "review-3"}),
                encoding="utf-8",
            )

            parser = build_parser()
            args = parser.parse_args(
                [
                    "attempt",
                    "promote",
                    "--attempts-root",
                    str(root),
                    "A6",
                    "--review-call-dir",
                    str(review_dir),
                    "--validation-command",
                    "python3 -c 'raise SystemExit(2)'",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "--open-pr",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                ],
            )
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                self.assertRaises(SystemExit) as raised,
            ):
                args.func(args)
            self.assertIn("validation command failed", str(raised.exception))

    def test_attempt_promote_malformed_review_blocks_pr(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A7",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Publish only after a valid review.",
                ],
                client,
            )
            candidate_file = root / "A7" / "candidate" / "files" / "page.md"
            candidate_file.parent.mkdir(parents=True)
            candidate_file.write_text("# Page\n\nContent.\n", encoding="utf-8")
            review_dir = Path(tmpdir) / "review"
            self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A7",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(review_dir),
                    "--json",
                ],
            )
            (review_dir / "answer.md").write_text("Looks fine to me.\n", encoding="utf-8")
            (review_dir / "metadata.json").write_text(
                json.dumps({"provider": "fixture", "oracle_call_id": "review-4"}),
                encoding="utf-8",
            )

            parser = build_parser()
            args = parser.parse_args(
                [
                    "attempt",
                    "promote",
                    "--attempts-root",
                    str(root),
                    "A7",
                    "--review-call-dir",
                    str(review_dir),
                    "--open-pr",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                ],
            )
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                self.assertRaises(SystemExit) as raised,
            ):
                args.func(args)
            self.assertIn("publication review did not accept", str(raised.exception))

    def test_attempt_promote_stale_review_blocks_pr(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A8",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Review must match candidate.",
                ],
                client,
            )
            candidate_file = root / "A8" / "candidate" / "files" / "page.md"
            candidate_file.parent.mkdir(parents=True)
            candidate_file.write_text("# Page\n\nOriginal content.\n", encoding="utf-8")
            review_dir = Path(tmpdir) / "review"
            self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A8",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(review_dir),
                    "--json",
                ],
            )
            (review_dir / "answer.md").write_text(accepted_review_text(), encoding="utf-8")
            (review_dir / "metadata.json").write_text(
                json.dumps({"provider": "fixture", "oracle_call_id": "review-5"}),
                encoding="utf-8",
            )
            candidate_file.write_text("# Page\n\nChanged after review.\n", encoding="utf-8")

            parser = build_parser()
            args = parser.parse_args(
                [
                    "attempt",
                    "promote",
                    "--attempts-root",
                    str(root),
                    "A8",
                    "--review-call-dir",
                    str(review_dir),
                    "--open-pr",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                ],
            )
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                self.assertRaises(SystemExit) as raised,
            ):
                args.func(args)
            self.assertIn("publication review was malformed", str(raised.exception))

    def test_attempt_promote_rejects_symlink_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "attempts"
            client = FakeClient()
            self.run_cli(
                [
                    "attempt",
                    "start",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                    "--attempt-id",
                    "A9",
                    "--attempts-root",
                    str(root),
                    "--goal",
                    "Do not publish symlink targets.",
                ],
                client,
            )
            secret = Path(tmpdir) / "secret.md"
            secret.write_text("private scratch\n", encoding="utf-8")
            link = root / "A9" / "candidate" / "files" / "leak.md"
            link.parent.mkdir(parents=True)
            link.symlink_to(secret)
            review_dir = Path(tmpdir) / "review"
            self.run_cli(
                [
                    "attempt",
                    "prompt",
                    "--attempts-root",
                    str(root),
                    "A9",
                    "--kind",
                    "publication-review",
                    "--output-dir",
                    str(review_dir),
                    "--json",
                ],
            )
            (review_dir / "answer.md").write_text(accepted_review_text(), encoding="utf-8")
            (review_dir / "metadata.json").write_text(
                json.dumps({"provider": "fixture", "oracle_call_id": "review-6"}),
                encoding="utf-8",
            )

            parser = build_parser()
            args = parser.parse_args(
                [
                    "attempt",
                    "promote",
                    "--attempts-root",
                    str(root),
                    "A9",
                    "--review-call-dir",
                    str(review_dir),
                    "--open-pr",
                    "--token",
                    "tok",
                    "--workspace",
                    "owner/repo",
                ],
            )
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                self.assertRaises(SystemExit) as raised,
            ):
                args.func(args)
            self.assertIn("candidate checks failed", str(raised.exception))


def accepted_review_text() -> str:
    return """\
decision: accept
summary: The candidate is compact, grounded, and useful.
blocking_issues:
- none
quality_issues:
- none
required_changes:
- none
"""


if __name__ == "__main__":
    unittest.main()

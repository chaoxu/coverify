from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from autoprover.cli import build_parser


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def edit_issue(
        self,
        workspace: str,
        issue: int,
        *,
        title: str | None = None,
        body: str | None = None,
    ) -> dict[str, Any]:
        self.calls.append(("edit_issue", (workspace, issue), {"title": title, "body": body}))
        return {"ok": True, "body": body}

    def delete_branch_file(self, workspace: str, path: str, branch: str) -> dict[str, Any]:
        self.calls.append(("delete_branch_file", (workspace, path, branch), {}))
        return {"ok": True}


class CliTests(unittest.TestCase):
    def run_cli(self, argv: list[str], client: FakeClient) -> dict[str, Any]:
        parser = build_parser()
        args = parser.parse_args(argv)
        stdout = io.StringIO()
        with (
            patch("autoprover.cli.authed_client_from_args", return_value=client),
            patch("sys.stdout", stdout),
        ):
            self.assertEqual(args.func(args), 0)
        return json.loads(stdout.getvalue())

    def test_edit_issue_preserves_explicit_empty_body(self) -> None:
        client = FakeClient()

        result = self.run_cli(
            [
                "edit-issue",
                "--token",
                "tok",
                "--workspace",
                "w",
                "--issue",
                "3",
                "--body",
                "",
            ],
            client,
        )

        self.assertEqual(result, {"ok": True, "body": ""})
        self.assertEqual(client.calls, [("edit_issue", ("w", 3), {"title": None, "body": ""})])

    def test_delete_file_dispatches_to_client(self) -> None:
        client = FakeClient()

        result = self.run_cli(
            [
                "delete-file",
                "--token",
                "tok",
                "--workspace",
                "w",
                "--path",
                "old.md",
                "--branch",
                "agent/cleanup",
            ],
            client,
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(client.calls, [("delete_branch_file", ("w", "old.md", "agent/cleanup"), {})])

    def test_ask_oracle_prints_raw_answer(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            parser = build_parser()
            args = parser.parse_args(
                [
                    "ask-oracle",
                    "--backend",
                    "script",
                    "--backend-command",
                    "python3 -c 'import sys; print(sys.stdin.read().upper(), end=\"\")'",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "hello",
                    "oracle",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        self.assertEqual(stdout.getvalue(), "HELLO ORACLE\n")

    def test_ask_oracle_json_includes_audit_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            parser = build_parser()
            args = parser.parse_args(
                [
                    "ask-oracle",
                    "--backend",
                    "script",
                    "--backend-command",
                    "python3 -c 'import sys; print(\"answer:\" + sys.stdin.read(), end=\"\")'",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "--prompt",
                    "question",
                    "--json",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        result = json.loads(stdout.getvalue())
        self.assertEqual(result["answer"], "answer:question")
        self.assertEqual(result["backend_provider"], "script")
        self.assertIn("oracle_call_id", result)
        self.assertIn("backend_artifact_dir", result)
        self.assertIn("Oracle audit:", result["backend_audit"])

    def test_ask_oracle_reads_prompt_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            prompt_file = Path(tmpdir) / "prompt.md"
            prompt_file.write_text("file prompt", encoding="utf-8")
            parser = build_parser()
            args = parser.parse_args(
                [
                    "ask-oracle",
                    "--backend",
                    "script",
                    "--backend-command",
                    "python3 -c 'import sys; print(sys.stdin.read(), end=\"\")'",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "--prompt-file",
                    str(prompt_file),
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        self.assertEqual(stdout.getvalue(), "file prompt\n")

    def test_ask_oracle_rejects_multiple_prompt_sources(self) -> None:
        args = build_parser().parse_args(["ask-oracle", "--prompt", "one", "two"])

        with self.assertRaises(SystemExit):
            args.func(args)

    def test_ask_oracle_defaults_to_codex_gpt55_xhigh(self) -> None:
        args = build_parser().parse_args(["ask-oracle", "hello"])

        self.assertEqual(args.backend, "codex")
        self.assertEqual(args.model, "gpt-5.5")
        self.assertEqual(args.reasoning_effort, "xhigh")

    def test_ttsp_search_cli_emits_bounded_search_payload(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "ttsp-search",
                "--min-edges",
                "2",
                "--max-edges",
                "2",
                "--terminal-scope",
                "all",
                "--limit-graphs",
                "1",
            ],
        )
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["kind"], "directed_ttsp_bounded_search")
        self.assertEqual(payload["graph_count"], 1)
        self.assertEqual(payload["parameters"]["max_edges"], 2)


if __name__ == "__main__":
    unittest.main()

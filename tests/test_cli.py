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

    def read_issue_timeline(self, workspace: str, issue: int) -> dict[str, Any]:
        self.calls.append(("read_issue_timeline", (workspace, issue), {}))
        return {"events": [{"type": "close"}]}

    def reopen_issue(self, workspace: str, issue: int) -> dict[str, Any]:
        self.calls.append(("reopen_issue", (workspace, issue), {}))
        return {"ok": True, "state": "open"}

    def set_issue_state(self, workspace: str, issue: int, state: str) -> dict[str, Any]:
        self.calls.append(("set_issue_state", (workspace, issue), {"state": state}))
        return {"ok": True, "state": state}

    def delete_branch_file(self, workspace: str, path: str, branch: str) -> dict[str, Any]:
        self.calls.append(("delete_branch_file", (workspace, path, branch), {}))
        return {"ok": True}

    def list_pull_requests(self, workspace: str, *, state: str = "open") -> dict[str, Any]:
        self.calls.append(("list_pull_requests", (workspace,), {"state": state}))
        return {"pulls": [{"number": 7}]}

    def read_pull_request(self, workspace: str, pr_number: int) -> dict[str, Any]:
        self.calls.append(("read_pull_request", (workspace, pr_number), {}))
        return {"pull": {"number": pr_number}}

    def read_pull_request_context(self, workspace: str, pr_number: int) -> dict[str, Any]:
        self.calls.append(("read_pull_request_context", (workspace, pr_number), {}))
        return {"pull_request": {"number": pr_number}, "files": {"files": []}}

    def close_pull_request(self, workspace: str, pr_number: int) -> dict[str, Any]:
        self.calls.append(("close_pull_request", (workspace, pr_number), {}))
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

    def test_read_issue_timeline_dispatches_to_client(self) -> None:
        client = FakeClient()

        result = self.run_cli(
            [
                "read-issue-timeline",
                "--token",
                "tok",
                "--workspace",
                "w",
                "--issue",
                "23",
            ],
            client,
        )

        self.assertEqual(result, {"events": [{"type": "close"}]})
        self.assertEqual(client.calls, [("read_issue_timeline", ("w", 23), {})])

    def test_reopen_issue_dispatches_to_client(self) -> None:
        client = FakeClient()

        result = self.run_cli(
            [
                "reopen-issue",
                "--token",
                "tok",
                "--workspace",
                "w",
                "--issue",
                "23",
            ],
            client,
        )

        self.assertEqual(result, {"ok": True, "state": "open"})
        self.assertEqual(client.calls, [("reopen_issue", ("w", 23), {})])

    def test_set_issue_state_dispatches_to_client(self) -> None:
        client = FakeClient()

        result = self.run_cli(
            [
                "set-issue-state",
                "--token",
                "tok",
                "--workspace",
                "w",
                "--issue",
                "23",
                "--state",
                "closed",
            ],
            client,
        )

        self.assertEqual(result, {"ok": True, "state": "closed"})
        self.assertEqual(client.calls, [("set_issue_state", ("w", 23), {"state": "closed"})])

    def test_pr_read_list_and_close_dispatch_to_client(self) -> None:
        client = FakeClient()

        list_result = self.run_cli(
            ["list-prs", "--token", "tok", "--workspace", "w", "--state", "all"],
            client,
        )
        read_result = self.run_cli(
            ["read-pr", "--token", "tok", "--workspace", "w", "--pr", "7"],
            client,
        )
        close_result = self.run_cli(
            ["close-pr", "--token", "tok", "--workspace", "w", "--pr", "7"],
            client,
        )
        context_result = self.run_cli(
            ["read-pr-context", "--token", "tok", "--workspace", "w", "--pr", "7"],
            client,
        )

        self.assertEqual(list_result, {"pulls": [{"number": 7}]})
        self.assertEqual(read_result, {"pull": {"number": 7}})
        self.assertEqual(close_result, {"ok": True})
        self.assertEqual(context_result, {"pull_request": {"number": 7}, "files": {"files": []}})
        self.assertEqual(
            client.calls,
            [
                ("list_pull_requests", ("w",), {"state": "all"}),
                ("read_pull_request", ("w", 7), {}),
                ("close_pull_request", ("w", 7), {}),
                ("read_pull_request_context", ("w", 7), {}),
            ],
        )

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
        self.assertEqual(args.allow_codex_backend, False)

    def test_ask_oracle_requires_explicit_codex_backend_opt_in(self) -> None:
        args = build_parser().parse_args(["ask-oracle", "hello"])

        with self.assertRaisesRegex(SystemExit, "codex backend is disabled"):
            args.func(args)

    def test_ask_oracle_accepts_codex_backend_opt_in_flag(self) -> None:
        args = build_parser().parse_args(["ask-oracle", "--allow-codex-backend", "hello"])

        self.assertEqual(args.allow_codex_backend, True)

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
        self.assertEqual(payload["parameters"]["terminal_scope"], "all")
        self.assertTrue(
            any(pair["is_global_pair"] for graph in payload["graphs"] for pair in graph["terminal_pairs"]),
        )

    def test_ttsp_queue_cli_emits_reduced_search_queue(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "ttsp-queue",
                "--min-edges",
                "4",
                "--max-edges",
                "8",
                "--queue-min-edges",
                "8",
                "--queue-limit",
                "1",
            ],
        )
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["kind"], "directed_ttsp_bounded_queue")
        self.assertEqual(payload["queued_graph_count_returned"], 1)
        self.assertEqual(len(payload["queued_graphs"][0]["best_terminal_quads"][0]["terminal_pair_ids"]), 4)

    def test_ttsp_queue_cli_uses_player_count_as_queue_width(self) -> None:
        parser = build_parser()
        args = parser.parse_args(
            [
                "ttsp-queue",
                "--players",
                "3",
                "--min-edges",
                "4",
                "--max-edges",
                "8",
                "--queue-min-edges",
                "8",
                "--queue-limit",
                "1",
            ],
        )
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["source_parameters"]["terminal_scope"], "internal")
        self.assertEqual(payload["queue_parameters"]["players"], 3)
        self.assertEqual(len(payload["queued_graphs"][0]["best_terminal_quads"][0]["terminal_pair_ids"]), 3)

if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from coverify.cli import build_parser
from coverify.integration.chat_metadata import CHAT_KIND_REPLY, chat_issue_body, parse_chat_metadata


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
            patch("coverify.cli.authed_client_from_args", return_value=client),
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

    def test_repo_oracle_eval_gather_reports_required_snippets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "summary.md").write_text(
                "# Summary\n\n## Current Problem Table\n\nTermination route selected.\n\n## Active Fronts\n\nImprove the construction.\n",
                encoding="utf-8",
            )
            cases = Path(tmpdir) / "cases.jsonl"
            cases.write_text(
                json.dumps(
                    {
                        "id": "status",
                        "question": "What is the current status and future work?",
                        "must_include": [
                            {"path": "summary.md", "text": "Current Problem Table"},
                            {"path": "summary.md", "text": "Active Fronts"},
                        ],
                    },
                )
                + "\n",
                encoding="utf-8",
            )
            parser = build_parser()
            args = parser.parse_args(
                [
                    "repo-oracle",
                    "eval-gather",
                    "--source-bundle",
                    str(root),
                    "--cases",
                    str(cases),
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        report = json.loads(stdout.getvalue())
        self.assertTrue(report["ok"])
        self.assertEqual(report["passed_cases"], 1)
        self.assertEqual(report["passed_requirements"], 2)

    def test_checked_in_gather_eval_fixture_runs(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        cases = repo_root / "evals" / "gather" / "sample-math-workspace.jsonl"
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "ledger.md").write_text(
                "\n".join(
                    [
                        "# Ledger",
                        "## Current Problem Table",
                        "| Problem | Current status |",
                        "| termination monovariant | proof route active |",
                        "| distinct pair sums | construction active |",
                        "## Active Fronts",
                        "- finish the termination monovariant check.",
                        "- formalize distinct pair sums construction cases.",
                    ],
                ),
                encoding="utf-8",
            )
            (root / "combinatorics.md").write_text(
                "\n".join(
                    [
                        "# Combinatorics Notes",
                        "## Termination monovariant route",
                        "The candidate proof must check both replacement operations.",
                        "A reverse lexicographic measure is the current route.",
                        "The boundary case of equal adjacent entries is closed separately.",
                        "## Distinct pair sums construction",
                        "The construction is organized by residue classes modulo 5.",
                        "The matching upper bound by total sum is recorded here.",
                    ],
                ),
                encoding="utf-8",
            )
            (root / "number-theory.md").write_text(
                "\n".join(
                    [
                        "# Number Theory Notes",
                        "## Admissible integer sets classification",
                        "The gcd obstruction gives the necessary condition.",
                        "The generation lemma remains the main sufficiency step.",
                        "## Power reciprocal classification",
                        "The parity direction is done; the constructive direction remains active.",
                    ],
                ),
                encoding="utf-8",
            )
            parser = build_parser()
            args = parser.parse_args(
                [
                    "repo-oracle",
                    "eval-gather",
                    "--source-bundle",
                    str(root),
                    "--cases",
                    str(cases),
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        report = json.loads(stdout.getvalue())
        self.assertTrue(report["ok"])
        self.assertEqual(report["passed_cases"], 4)
        self.assertEqual(report["passed_requirements"], 15)

    def test_chat_ask_creates_branch_scoped_issue_and_posts_verified_answer(self) -> None:
        class ChatClient:
            def __init__(self) -> None:
                self.issue_body = ""
                self.comments: list[str] = []

            def ensure_label(self, workspace: str, *, name: str, color: str, description: str = "") -> int:
                self.workspace = workspace
                self.label = (name, color, description)
                return 4

            def create_issue(self, workspace: str, *, title: str, body: str, labels: list[int] | None = None) -> dict[str, int]:
                self.issue_body = body
                self.created = (workspace, title, labels)
                return {"number": 12}

            def read_issue(self, workspace: str, number: int) -> dict[str, object]:
                return {
                    "number": number,
                    "user": {"login": "alice"},
                    "body": self.issue_body,
                    "labels": [{"id": 4, "name": "chat", "color": "8b5cf6"}],
                }

            def read_issue_timeline(self, workspace: str, number: int) -> list[object]:
                return []

            def list_workspace_files(self, workspace: str, *, branch: str = "main") -> dict[str, object]:
                self.branch = branch
                return {"files": [{"path": "docs/local.md", "size": 24, "kind": "markdown"}]}

            def read_file(self, workspace: str, path: str, *, branch: str = "main") -> dict[str, str]:
                return {"content": "A local lemma implies the requested theorem."}

            def comment_issue(self, workspace: str, number: int, body: str) -> dict[str, int]:
                self.comments.append(body)
                return {"id": 99}

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            answer = tmp / "answer.py"
            answer.write_text("#!/usr/bin/env python3\nprint('Using `docs/local.md:1`, the theorem follows.')\n", encoding="utf-8")
            verifier = tmp / "verify.py"
            verifier.write_text("#!/usr/bin/env python3\nprint('Supported by the supplied source.\\nVERDICT: PASS')\n", encoding="utf-8")
            client = ChatClient()
            args = build_parser().parse_args(
                [
                    "chat",
                    "ask",
                    "--token",
                    "tok",
                    "--workspace",
                    "w",
                    "--branch",
                    "agent/math",
                    "--backend",
                    "script",
                    "--backend-command",
                    f"{sys.executable} {answer}",
                    "--verifier-backend",
                    "script",
                    "--verifier-command",
                    f"{sys.executable} {verifier}",
                    "--run-dir",
                    str(tmp / "runs"),
                    "--json",
                    "--message",
                    "Prove the local theorem.",
                ],
            )
            stdout = io.StringIO()
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                patch("sys.stdout", stdout),
            ):
                self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["branch"], "agent/math")
        self.assertEqual(payload["issue_number"], 12)
        self.assertEqual(client.created, ("w", "Prove the local theorem.", [4]))
        self.assertEqual(parse_chat_metadata(client.issue_body)["branch"], "agent/math")
        self.assertEqual(parse_chat_metadata(client.comments[0])["kind"], CHAT_KIND_REPLY)
        self.assertEqual(client.branch, "agent/math")

    def test_repo_oracle_prepare_llm_writes_artifact_without_invoking_backend(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            source = tmp / "source"
            source.mkdir()
            (source / "facts.md").write_text("Local fact A is accepted.", encoding="utf-8")
            output_dir = tmp / "preview"
            args = build_parser().parse_args(
                [
                    "repo-oracle",
                    "prepare-llm",
                    "--source-bundle",
                    str(source),
                    "--backend",
                    "script",
                    "--backend-command",
                    f"{sys.executable} -c 'raise SystemExit(99)'",
                    "--output-dir",
                    str(output_dir),
                    "--json",
                    "--message",
                    "What is local fact A?",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["step"], "answer")
            self.assertFalse(payload["backend_invoked"])
            self.assertEqual(payload["source_kind"], "local")
            self.assertTrue((output_dir / "prompt.md").exists())
            self.assertTrue((output_dir / "preview.json").exists())
            self.assertIn(
                "# Coverify Repo-Snapshot Exploratory Response",
                (output_dir / "prompt.md").read_text(encoding="utf-8"),
            )

    def test_repo_oracle_prepare_llm_stops_at_configured_gatherer_without_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            source = tmp / "source"
            source.mkdir()
            (source / "facts.md").write_text("Local fact A is accepted.", encoding="utf-8")
            args = build_parser().parse_args(
                [
                    "repo-oracle",
                    "prepare-llm",
                    "--source-bundle",
                    str(source),
                    "--gatherer-backend",
                    "script",
                    "--json",
                    "--message",
                    "What is local fact A?",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["step"], "gatherer")
        self.assertFalse(payload["backend_invoked"])
        self.assertFalse(payload["selected_snippets_known"])
        self.assertIn("# Coverify Repo-Snapshot Gatherer", payload["prompt"])

    def test_chat_prepare_llm_does_not_create_issue_or_comment(self) -> None:
        class PreviewClient:
            def __init__(self) -> None:
                self.reads: list[str] = []

            def ensure_label(self, *_args, **_kwargs):
                raise AssertionError("prepare-llm must not ensure labels")

            def create_issue(self, *_args, **_kwargs):
                raise AssertionError("prepare-llm must not create issues")

            def comment_issue(self, *_args, **_kwargs):
                raise AssertionError("prepare-llm must not comment")

            def list_workspace_files(self, workspace: str, *, branch: str = "main") -> dict[str, object]:
                self.reads.append(f"tree:{workspace}:{branch}")
                return {"files": [{"path": "docs/local.md"}]}

            def read_file(self, workspace: str, path: str, *, branch: str = "main") -> dict[str, str]:
                self.reads.append(f"file:{workspace}:{branch}:{path}")
                return {"content": "A local lemma implies the requested theorem."}

        with tempfile.TemporaryDirectory() as tmpdir:
            client = PreviewClient()
            args = build_parser().parse_args(
                [
                    "chat",
                    "prepare-llm",
                    "--token",
                    "tok",
                    "--workspace",
                    "w",
                    "--branch",
                    "agent/math",
                    "--backend",
                    "verifying",
                    "--verify-inner-backend",
                    "script",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "--json",
                    "--message",
                    "Prove the local theorem.",
                ],
            )
            stdout = io.StringIO()
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                patch("sys.stdout", stdout),
            ):
                self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["step"], "generator")
        self.assertEqual(payload["workspace"], "w")
        self.assertEqual(payload["branch"], "agent/math")
        self.assertFalse(payload["backend_invoked"])
        self.assertFalse(payload["cosheaf_writes_performed"])
        self.assertTrue(payload["durable_cosheaf_writes_in_full_run"]["create_issue"])
        self.assertEqual(client.reads, ["tree:w:agent/math", "file:w:agent/math:docs/local.md"])

    def test_verifying_prepare_llm_cli_reads_resume_prompt_and_journal(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            resume = root / "verifying-run"
            resume.mkdir()
            (resume / "prompt.md").write_text("Prove Q.", encoding="utf-8")
            gen_dir = root / "gen"
            gen_dir.mkdir()
            (gen_dir / "answer.md").write_text("Candidate proof.", encoding="utf-8")
            (resume / "journal.json").write_text(
                json.dumps([
                    {"role": "generator", "round": 0, "artifact_dir": str(gen_dir)},
                ]),
                encoding="utf-8",
            )
            args = build_parser().parse_args(
                [
                    "verifying",
                    "prepare-llm",
                    "--resume",
                    str(resume),
                    "--json",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["step"], "verifier")
        self.assertFalse(payload["backend_invoked"])
        self.assertEqual(payload["round"], 0)
        self.assertEqual(payload["verifier_index"], 0)
        self.assertIn("Candidate proof.", payload["prompt"])

    def test_chat_reply_uses_pinned_branch_metadata_for_worker_path(self) -> None:
        class ReplyClient:
            def __init__(self) -> None:
                self.comments: list[str] = []

            def me(self) -> dict[str, str]:
                return {"login": "coverify"}

            def read_issue(self, workspace: str, number: int) -> dict[str, object]:
                return {
                    "number": number,
                    "user": {"login": "alice"},
                    "body": chat_issue_body("Prove the local theorem.", branch="agent/math"),
                    "labels": [{"id": 4, "name": "chat", "color": "8b5cf6"}],
                }

            def read_issue_timeline(self, workspace: str, number: int) -> list[object]:
                return []

            def list_workspace_files(self, workspace: str, *, branch: str = "main") -> dict[str, object]:
                self.branch = branch
                return {"files": [{"path": "docs/local.md", "size": 24, "kind": "markdown"}]}

            def read_file(self, workspace: str, path: str, *, branch: str = "main") -> dict[str, str]:
                return {"content": "A local lemma implies the requested theorem."}

            def comment_issue(self, workspace: str, number: int, body: str) -> dict[str, int]:
                self.comments.append(body)
                return {"id": 99}

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            answer = tmp / "answer.py"
            answer.write_text("#!/usr/bin/env python3\nprint('Using `docs/local.md:1`, the theorem follows.')\n", encoding="utf-8")
            verifier = tmp / "verify.py"
            verifier.write_text("#!/usr/bin/env python3\nprint('Supported by the supplied source.\\nVERDICT: PASS')\n", encoding="utf-8")
            client = ReplyClient()
            args = build_parser().parse_args(
                [
                    "chat-reply",
                    "--token",
                    "tok",
                    "--workspace",
                    "w",
                    "--issue",
                    "12",
                    "--bot-user",
                    "coverify",
                    "--backend",
                    "script",
                    "--backend-command",
                    f"{sys.executable} {answer}",
                    "--verifier-backend",
                    "script",
                    "--verifier-command",
                    f"{sys.executable} {verifier}",
                    "--run-dir",
                    str(tmp / "runs"),
                ],
            )
            stdout = io.StringIO()
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                patch("sys.stdout", stdout),
            ):
                self.assertEqual(args.func(args), 0)

        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["branch"], "agent/math")
        self.assertEqual(client.branch, "agent/math")
        self.assertEqual(parse_chat_metadata(client.comments[0])["kind"], CHAT_KIND_REPLY)

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

    def test_run_eval_dispatches_fixture_backend(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cases = Path(tmpdir) / "cases.jsonl"
            cases.write_text(
                (
                    '{"id":"c1","task_set":"T0","prompt":"prove primes",'
                    '"grader":"contains_all","expect":{"required":["infinitely many prime"]}}\n'
                ),
                encoding="utf-8",
            )
            args = build_parser().parse_args(
                [
                    "run-eval",
                    "--backend",
                    "fixture",
                    "--run-dir",
                    str(Path(tmpdir) / "runs"),
                    "--cases",
                    str(cases),
                ],
            )
            stdout = io.StringIO()

            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

            result = json.loads(stdout.getvalue())
            self.assertEqual(result["summary"]["passed"], 1)
            self.assertEqual(result["results"][0]["id"], "c1")

    def test_scaffold_workdir_creates_local_wrappers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            parser = build_parser()
            args = parser.parse_args(
                [
                    "scaffold-workdir",
                    "--workspace",
                    "demo-workspace",
                    "--works-root",
                    tmpdir,
                    "--coverify-checkout",
                    "/repo/coverify",
                    "--qed-root",
                    "/repo/QED",
                ],
            )
            stdout = io.StringIO()

            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

            result = json.loads(stdout.getvalue())
            workdir = Path(result["workdir"])
            self.assertEqual(workdir, Path(tmpdir) / "demo-workspace")
            self.assertTrue((workdir / "bin" / "coverify").exists())
            self.assertTrue((workdir / "bin" / "chatgpt-coverify").exists())
            self.assertTrue((workdir / "bin" / "qed-coverify").exists())
            self.assertTrue((workdir / "bin" / "qed-chatgpt-coverify").exists())
            self.assertTrue((workdir / "config" / "qed-codex-low.yaml").exists())
            self.assertTrue((workdir / "config" / "qed-chatgpt-oracle.yaml").exists())
            self.assertIn("demo-workspace", (workdir / ".env.example").read_text(encoding="utf-8"))
            self.assertIn("CHATGPT_CLI", (workdir / ".env.example").read_text(encoding="utf-8"))
            self.assertIn("/repo/coverify", (workdir / "bin" / "coverify").read_text(encoding="utf-8"))
            agents = (workdir / "AGENTS.md").read_text(encoding="utf-8")
            self.assertIn("Start day-to-day Codex sessions in this directory", agents)
            self.assertIn("Use Coverify skills", agents)
            self.assertIn("--refresh-tools", agents)
            readme = (workdir / "README.md").read_text(encoding="utf-8")
            self.assertIn("Start Codex in this directory for project work", readme)
            self.assertIn("bin/coverify chat ask", readme)
            self.assertIn("scaffold-workdir --refresh-tools", readme)
            chatgpt_config = (workdir / "config" / "qed-chatgpt-oracle.yaml").read_text(encoding="utf-8")
            self.assertIn("chatgpt:", chatgpt_config)
            self.assertIn('provider: "chatgpt"', chatgpt_config)
            self.assertNotIn("qed_chatgpt_codex_shim.py", chatgpt_config)

    def test_scaffold_refresh_tools_updates_bin_without_overwriting_docs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            parser = build_parser()
            initial = parser.parse_args(
                [
                    "scaffold-workdir",
                    "--workspace",
                    "demo-workspace",
                    "--works-root",
                    tmpdir,
                    "--coverify-checkout",
                    "/repo/coverify-old",
                ],
            )
            with patch("sys.stdout", io.StringIO()):
                self.assertEqual(initial.func(initial), 0)

            workdir = Path(tmpdir) / "demo-workspace"
            (workdir / "README.md").write_text("project notes\n", encoding="utf-8")
            refresh = parser.parse_args(
                [
                    "scaffold-workdir",
                    "--workspace",
                    "demo-workspace",
                    "--works-root",
                    tmpdir,
                    "--coverify-checkout",
                    "/repo/coverify-new",
                    "--refresh-tools",
                ],
            )
            stdout = io.StringIO()

            with patch("sys.stdout", stdout):
                self.assertEqual(refresh.func(refresh), 0)

            result = json.loads(stdout.getvalue())
            self.assertIn("/repo/coverify-new", (workdir / "bin" / "coverify").read_text(encoding="utf-8"))
            self.assertEqual((workdir / "README.md").read_text(encoding="utf-8"), "project notes\n")
            self.assertIn(str(workdir / "README.md"), result["skipped_existing"])

    def test_seed_research_evals_dispatches_to_client(self) -> None:
        class SeedClient:
            def create_branch(self, workspace: str, name: str) -> dict[str, str]:
                return {"name": name}

            def create_issue(self, workspace: str, *, title: str, body: str) -> dict[str, int]:
                return {"number": 1}

            def write_branch_file(self, workspace: str, path: str, branch: str, content: str) -> dict[str, bool]:
                return {"ok": True}

            def open_pull_request(self, workspace: str, *, head: str, title: str, body: str, base: str = "main") -> dict[str, int]:
                return {"number": 2}

        with tempfile.TemporaryDirectory() as tmpdir:
            candidates = Path(tmpdir) / "candidates.jsonl"
            candidates.write_text(
                (
                    '{"id":"researchmath-14k-000-sample","source":"ResearchMath row 0",'
                    '"source_url":"https://example.test","domain":"Number Theory",'
                    '"statement_sketch":"Prove something research-level.",'
                    '"target_artifact":"A reviewed note.","why_good_eval":"It is hard.",'
                    '"tier":"research-open","one_shot_probe":"Try it.",'
                    '"few_shot_probe":"Use prior state."}\n'
                ),
                encoding="utf-8",
            )
            args = build_parser().parse_args(
                [
                    "seed-research-evals",
                    "--token",
                    "tok",
                    "--workspace",
                    "w",
                    "--candidates",
                    str(candidates),
                    "--branch",
                    "research-eval-seed-test",
                ],
            )
            stdout = io.StringIO()

            with (
                patch("coverify.cli.build_client", return_value=SeedClient()),
                patch("sys.stdout", stdout),
            ):
                self.assertEqual(args.func(args), 0)

        result = json.loads(stdout.getvalue())
        self.assertTrue(result["ok"])
        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(result["pr_number"], 2)

if __name__ == "__main__":
    unittest.main()

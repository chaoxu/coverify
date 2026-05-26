from __future__ import annotations

import io
import json
import unittest
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


if __name__ == "__main__":
    unittest.main()

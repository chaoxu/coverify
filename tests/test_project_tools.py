from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coverify.cli import build_parser
from coverify.integration.tools import list_project_tools, run_project_tool


class ProjectToolTests(unittest.TestCase):
    def test_list_project_tools_reads_json_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tools_file = Path(tmpdir) / "coverify-tools.json"
            tools_file.write_text(
                json.dumps({
                    "tools": [
                        {
                            "name": "check-candidate",
                            "description": "Validate candidate JSON.",
                            "command": "python3 scripts/check.py",
                            "timeout_seconds": 30,
                        },
                    ],
                }),
                encoding="utf-8",
            )

            payload = list_project_tools(tools_file)

        self.assertEqual(payload["tools"][0]["name"], "check-candidate")
        self.assertEqual(payload["tools"][0]["timeout_seconds"], 30)

    def test_run_project_tool_uses_declared_cwd_and_writes_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "scripts").mkdir()
            (root / "scripts" / "echo_tool.py").write_text(
                "import pathlib, sys\n"
                "print(pathlib.Path.cwd().name + ':' + sys.stdin.read().strip())\n",
                encoding="utf-8",
            )
            tools_file = root / "coverify-tools.json"
            tools_file.write_text(
                json.dumps({
                    "tools": [
                        {
                            "name": "echo",
                            "command": f"{sys.executable} scripts/echo_tool.py",
                            "cwd": ".",
                        },
                    ],
                }),
                encoding="utf-8",
            )

            payload = run_project_tool(
                tools_file=tools_file,
                name="echo",
                input_text="hello",
                artifact_root=root / "runs",
            )

            artifact_dir = Path(str(payload["artifact_dir"]))
            metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["stdout"].strip(), f"{root.name}:hello")
            self.assertEqual(metadata["command_cwd"], str(root.resolve()))
            self.assertTrue((artifact_dir / "prompt.md").exists())
            self.assertTrue((artifact_dir / "answer.md").exists())

    def test_run_project_tool_reports_nonzero_as_failed_result_with_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tools_file = root / "coverify-tools.json"
            tools_file.write_text(
                json.dumps({
                    "tools": [
                        {
                            "name": "reject",
                            "command": f"{sys.executable} -c \"print('reject'); raise SystemExit(7)\"",
                        },
                    ],
                }),
                encoding="utf-8",
            )

            payload = run_project_tool(
                tools_file=tools_file,
                name="reject",
                input_text="candidate",
                artifact_root=root / "runs",
            )

            self.assertFalse(payload["ok"])
            self.assertEqual(payload["returncode"], 7)
            self.assertEqual(payload["stdout"].strip(), "reject")
            self.assertTrue((Path(str(payload["artifact_dir"])) / "metadata.json").exists())

    def test_tool_cli_lists_and_runs_project_tool(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tools_file = root / "coverify-tools.json"
            tools_file.write_text(
                json.dumps({
                    "tools": [
                        {
                            "name": "upper",
                            "description": "Uppercase stdin.",
                            "command": f"{sys.executable} -c \"import sys; print(sys.stdin.read().upper())\"",
                        },
                    ],
                }),
                encoding="utf-8",
            )
            parser = build_parser()
            list_args = parser.parse_args(["tool", "list", "--tools-file", str(tools_file), "--json"])
            run_args = parser.parse_args(
                [
                    "tool",
                    "run",
                    "upper",
                    "--tools-file",
                    str(tools_file),
                    "--run-dir",
                    str(root / "runs"),
                    "--message",
                    "abc",
                    "--json",
                ],
            )
            list_stdout = io.StringIO()
            run_stdout = io.StringIO()

            with patch("sys.stdout", list_stdout):
                self.assertEqual(list_args.func(list_args), 0)
            with patch("sys.stdout", run_stdout):
                self.assertEqual(run_args.func(run_args), 0)

        listed = json.loads(list_stdout.getvalue())
        ran = json.loads(run_stdout.getvalue())
        self.assertEqual(listed["tools"][0]["name"], "upper")
        self.assertEqual(ran["stdout"].strip(), "ABC")


if __name__ == "__main__":
    unittest.main()

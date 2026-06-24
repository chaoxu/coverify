from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coverify.cli import build_parser
from coverify.integration.external_workflow import run_external_workflow


class ExternalWorkflowTests(unittest.TestCase):
    def test_run_external_workflow_formats_placeholders_and_records_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            runner = root / "runner.py"
            runner.write_text(
                "import json, pathlib, sys\n"
                "problem = pathlib.Path(sys.argv[1]).read_text()\n"
                "output = pathlib.Path(sys.argv[2])\n"
                "run_id = sys.argv[3]\n"
                "run = output / run_id\n"
                "run.mkdir(parents=True, exist_ok=True)\n"
                "(run / 'run-metadata.json').write_text("
                "json.dumps({'status':'ok','outputs':{'compiled': False}}))\n"
                "print('problem', len(problem))\n",
                encoding="utf-8",
            )

            result = run_external_workflow(
                command=[sys.executable, "runner.py", "{problem_path}", "{output_dir}", "{run_id}"],
                cwd=root,
                problem="Prove something.",
                artifact_root=root / "runs",
                provider="test-workflow",
                workflow="smoke",
                problem_id="p1",
                run_id="run1",
            )
            metadata = json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))

            self.assertEqual(result.provider, "test-workflow")
            self.assertIn("compiled: False", result.answer)
            self.assertEqual(metadata["workflow"], "smoke")
            self.assertEqual(metadata["returncode"], 0)
            self.assertTrue((result.artifact_dir / "outputs" / "run1" / "run-metadata.json").exists())

    def test_workflow_run_cli_accepts_command_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            runner = root / "runner.py"
            runner.write_text(
                "import json, pathlib, sys\n"
                "output = pathlib.Path(sys.argv[2])\n"
                "run_id = sys.argv[3]\n"
                "(output / run_id).mkdir(parents=True, exist_ok=True)\n"
                "(output / run_id / 'run-metadata.json').write_text("
                "json.dumps({'status':'ok','outputs':{'rounds_completed': 1}}))\n"
                "print(pathlib.Path(sys.argv[1]).read_text())\n",
                encoding="utf-8",
            )
            command = [sys.executable, "runner.py", "{problem_path}", "{output_dir}", "{run_id}"]
            args = build_parser().parse_args(
                [
                    "workflow",
                    "run",
                    "--cwd",
                    str(root),
                    "--command-json",
                    json.dumps(command),
                    "--provider",
                    "generic-test",
                    "--workflow",
                    "generic-smoke",
                    "--workflow-run-id",
                    "cli-run",
                    "--run-dir",
                    str(root / "runs"),
                    "--message",
                    "Problem text",
                    "--json",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)
            payload = json.loads(stdout.getvalue())

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["provider"], "generic-test")


if __name__ == "__main__":
    unittest.main()

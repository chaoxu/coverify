from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coverify.cli import build_parser
from coverify.integration.firstproof import (
    improofbench_root,
    run_improofbench_workflow,
    setup_improofbench,
)


class FirstProofTests(unittest.TestCase):
    def test_improofbench_root_resolves_sparse_checkout_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            checkout = Path(tmpdir) / "batch-2"
            root = checkout / "batch-2-submissions" / "improofbench"
            (root / "scripts").mkdir(parents=True)
            (root / "scripts" / "run_workflow.py").write_text("", encoding="utf-8")

            self.assertEqual(improofbench_root(checkout), root)

    def test_setup_existing_checkout_does_not_clone(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            checkout = Path(tmpdir) / "batch-2"
            root = checkout / "batch-2-submissions" / "improofbench"
            (root / "scripts").mkdir(parents=True)
            (root / "scripts" / "run_workflow.py").write_text("", encoding="utf-8")

            payload = setup_improofbench(checkout_dir=checkout)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["already_exists"])

    def test_run_improofbench_workflow_records_coverify_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            bench = root / "improofbench"
            (bench / "scripts").mkdir(parents=True)
            (bench / "scripts" / "run_workflow.py").write_text("# fake\n", encoding="utf-8")
            fake_uv = root / "uv"
            fake_uv.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "out = pathlib.Path(args[args.index('--output') + 1])\n"
                "run_id = args[args.index('--run-id') + 1]\n"
                "problem = pathlib.Path(args[args.index('--problem') + 1]).read_text()\n"
                "run = out / run_id\n"
                "run.mkdir(parents=True, exist_ok=True)\n"
                "(run / 'run-metadata.json').write_text("
                "json.dumps({'status':'ok','outputs':{'compiled': True, 'rounds_completed': 2}}))\n"
                "print('problem-bytes', len(problem))\n",
                encoding="utf-8",
            )
            fake_uv.chmod(0o755)

            result = run_improofbench_workflow(
                improofbench_dir=bench,
                problem="Prove $1+1=2$.",
                artifact_root=root / "runs",
                workflow="author_critic_smoke",
                problem_id="tiny",
                run_id="tiny-run",
                uv_bin=str(fake_uv),
            )
            metadata = json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))

            self.assertEqual(result.provider, "firstproof-improofbench")
            self.assertIn("compiled: True", result.answer)
            self.assertEqual(metadata["workflow"], "author_critic_smoke")
            self.assertEqual(metadata["returncode"], 0)
            self.assertTrue((result.artifact_dir / "prompt.md").exists())
            self.assertTrue((result.artifact_dir / "answer.md").exists())

    def test_firstproof_run_cli_uses_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            bench = root / "improofbench"
            (bench / "scripts").mkdir(parents=True)
            (bench / "scripts" / "run_workflow.py").write_text("# fake\n", encoding="utf-8")
            fake_uv = root / "uv"
            fake_uv.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "out = pathlib.Path(args[args.index('--output') + 1])\n"
                "run_id = args[args.index('--run-id') + 1]\n"
                "(out / run_id).mkdir(parents=True, exist_ok=True)\n"
                "(out / run_id / 'run-metadata.json').write_text("
                "json.dumps({'status':'ok','outputs':{'answer_ready': False}}))\n"
                "print('ran firstproof')\n",
                encoding="utf-8",
            )
            fake_uv.chmod(0o755)
            args = build_parser().parse_args(
                [
                    "firstproof",
                    "run",
                    "--improofbench-root",
                    str(bench),
                    "--uv-bin",
                    str(fake_uv),
                    "--workflow",
                    "author_critic_smoke",
                    "--workflow-run-id",
                    "cli-run",
                    "--run-dir",
                    str(root / "runs"),
                    "--message",
                    "Prove $2+2=4$.",
                    "--json",
                ],
            )
            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                self.assertEqual(args.func(args), 0)

            payload = json.loads(stdout.getvalue())

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["provider"], "firstproof-improofbench")


if __name__ == "__main__":
    unittest.main()

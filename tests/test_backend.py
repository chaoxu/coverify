from __future__ import annotations

import json
import os
import stat
import tempfile
import textwrap
import unittest
from pathlib import Path

from coverify.engine.backend import (
    audit_summary,
    run_claude_backend,
    run_codex_backend,
    run_fixture_backend,
    run_script_backend,
)


class BackendTests(unittest.TestCase):
    def test_codex_backend_wrapper_uses_output_file_and_records_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake_codex = root / "fake-codex"
            fake_codex.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import pathlib
                    import sys

                    args = sys.argv[1:]
                    output_path = pathlib.Path(args[args.index("-o") + 1])
                    context = sys.stdin.read()
                    output_path.write_text("# Infinitely Many Primes\\n\\n" + context, encoding="utf-8")
                    print("{\\"event\\":\\"done\\"}")
                    """
                ),
                encoding="utf-8",
            )
            fake_codex.chmod(fake_codex.stat().st_mode | stat.S_IXUSR)

            result = run_codex_backend(
                "context body",
                artifact_root=root / "runs",
                model="gpt-5.5",
                reasoning_effort="xhigh",
                timeout_seconds=30,
                codex_bin=str(fake_codex),
            )

            self.assertIn("context body", result.answer)
            metadata = json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            command = metadata["command"]
            self.assertEqual(result.oracle_call_id, metadata["oracle_call_id"])
            self.assertEqual(metadata["provider"], "codex")
            self.assertIn("gpt-5.5", command)
            self.assertIn('model_reasoning_effort="xhigh"', command)
            self.assertIn("--ignore-user-config", command)
            self.assertEqual(metadata["returncode"], 0)
            self.assertEqual(metadata["timed_out"], False)
            self.assertEqual((result.artifact_dir / "prompt.md").read_text(encoding="utf-8"), "context body")
            self.assertFalse((result.artifact_dir / "context.md").exists())
            self.assertTrue(metadata["prompt_sha256"])
            self.assertTrue(metadata["answer_sha256"])
            self.assertIn("prompt", metadata["artifacts"])
            self.assertNotIn("context", metadata["artifacts"])
            self.assertIn("answer", metadata["artifacts"])
            self.assertTrue((result.artifact_dir / "manifest.json").exists())
            self.assertTrue((result.artifact_dir / "stdout.jsonl").exists())
            self.assertTrue((result.artifact_dir / "stderr.log").exists())
            self.assertIn(result.oracle_call_id, audit_summary(result))

    def test_codex_backend_fails_clearly_when_answer_file_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake_codex = root / "fake-codex"
            fake_codex.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import sys

                    sys.stdin.read()
                    print("{\\"event\\":\\"done-without-answer\\"}")
                    """
                ),
                encoding="utf-8",
            )
            fake_codex.chmod(fake_codex.stat().st_mode | stat.S_IXUSR)

            with self.assertRaisesRegex(RuntimeError, "without writing answer.md"):
                run_codex_backend(
                    "context body",
                    artifact_root=root / "runs",
                    model="gpt-5.5",
                    reasoning_effort="xhigh",
                    timeout_seconds=30,
                    codex_bin=str(fake_codex),
                )

            [artifact_dir] = (root / "runs").iterdir()
            metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["returncode"], 0)
            self.assertEqual(metadata["timed_out"], False)
            self.assertTrue(metadata["prompt_sha256"])
            self.assertNotIn("answer", metadata["artifacts"])
            self.assertFalse((artifact_dir / "answer.md").exists())

    def test_claude_backend_parses_json_result_and_records_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake_claude = root / "fake-claude"
            fake_claude.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import json
                    import sys

                    prompt = sys.stdin.read()
                    print(json.dumps({"type": "result", "is_error": False, "result": "# Checked\\n\\n" + prompt}))
                    """
                ),
                encoding="utf-8",
            )
            fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR)

            result = run_claude_backend(
                "context body",
                artifact_root=root / "runs",
                model="opus",
                timeout_seconds=30,
                claude_bin=str(fake_claude),
            )

            self.assertIn("context body", result.answer)
            metadata = json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            command = metadata["command"]
            self.assertEqual(result.oracle_call_id, metadata["oracle_call_id"])
            self.assertEqual(metadata["provider"], "claude")
            self.assertIn("opus", command)
            self.assertIn("--output-format", command)
            self.assertEqual(metadata["returncode"], 0)
            self.assertEqual(metadata["timed_out"], False)
            self.assertEqual((result.artifact_dir / "prompt.md").read_text(encoding="utf-8"), "context body")
            self.assertEqual((result.artifact_dir / "answer.md").read_text(encoding="utf-8"), result.answer)
            self.assertTrue(metadata["prompt_sha256"])
            self.assertTrue(metadata["answer_sha256"])
            self.assertIn("answer", metadata["artifacts"])
            self.assertTrue((result.artifact_dir / "stdout.json").exists())
            self.assertTrue((result.artifact_dir / "stderr.log").exists())
            self.assertIn(result.oracle_call_id, audit_summary(result))

    def test_claude_backend_fails_clearly_on_error_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake_claude = root / "fake-claude"
            fake_claude.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import json
                    import sys

                    sys.stdin.read()
                    print(json.dumps({"type": "result", "is_error": True, "result": "overloaded"}))
                    """
                ),
                encoding="utf-8",
            )
            fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR)

            with self.assertRaisesRegex(RuntimeError, "error result"):
                run_claude_backend(
                    "context body",
                    artifact_root=root / "runs",
                    claude_bin=str(fake_claude),
                )

            [artifact_dir] = (root / "runs").iterdir()
            metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["returncode"], 0)
            self.assertNotIn("answer", metadata["artifacts"])
            self.assertFalse((artifact_dir / "answer.md").exists())

    def test_claude_backend_fails_clearly_on_non_json_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake_claude = root / "fake-claude"
            fake_claude.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import sys

                    sys.stdin.read()
                    print("plain text, not the json envelope")
                    """
                ),
                encoding="utf-8",
            )
            fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR)

            with self.assertRaisesRegex(RuntimeError, "non-JSON"):
                run_claude_backend(
                    "context body",
                    artifact_root=root / "runs",
                    claude_bin=str(fake_claude),
                )

    def test_claude_backend_records_timeout_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake_claude = root / "fake-claude"
            fake_claude.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import time

                    time.sleep(5)
                    """
                ),
                encoding="utf-8",
            )
            fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR)

            with self.assertRaisesRegex(RuntimeError, "timed out"):
                run_claude_backend(
                    "slow prompt",
                    artifact_root=root / "runs",
                    timeout_seconds=1,
                    claude_bin=str(fake_claude),
                )

            [artifact_dir] = (root / "runs").iterdir()
            metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["timed_out"], True)
            self.assertEqual((artifact_dir / "prompt.md").read_text(encoding="utf-8"), "slow prompt")

    def test_script_backend_records_prompt_answer_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            result = run_script_backend(
                "review this",
                command="python3 -c 'import sys; print(sys.stdin.read().upper())'",
                artifact_root=root / "runs",
            )

            self.assertEqual(result.answer, "REVIEW THIS\n")
            metadata = json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            manifest = json.loads((result.artifact_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["provider"], "script")
            self.assertEqual(metadata["oracle_call_id"], result.oracle_call_id)
            self.assertEqual((result.artifact_dir / "prompt.md").read_text(encoding="utf-8"), "review this")
            self.assertEqual(manifest["prompt"]["sha256"], metadata["prompt_sha256"])
            self.assertEqual(manifest["answer"]["sha256"], metadata["answer_sha256"])

    def test_script_backend_records_timeout_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with self.assertRaises(RuntimeError):
                run_script_backend(
                    "slow prompt",
                    command="python3 -c 'import time; time.sleep(5)'",
                    artifact_root=root / "runs",
                    timeout_seconds=1,
                )

            [artifact_dir] = (root / "runs").iterdir()
            metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["timed_out"], True)
            self.assertEqual((artifact_dir / "prompt.md").read_text(encoding="utf-8"), "slow prompt")
            self.assertTrue(metadata["prompt_sha256"])
            self.assertIn("stderr", metadata["artifacts"])

    def test_fixture_backend_uses_same_audit_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = run_fixture_backend("prove primes", artifact_root=Path(tmpdir) / "runs")

            metadata = json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["provider"], "fixture")
            self.assertEqual(metadata["returncode"], 0)
            self.assertTrue(metadata["prompt_sha256"])
            self.assertTrue(metadata["answer_sha256"])
            self.assertIn("infinitely many prime", result.answer)
            self.assertNotIn(".theorem", result.answer)


if __name__ == "__main__":
    unittest.main()

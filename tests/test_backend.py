from __future__ import annotations

import json
import os
import stat
import tempfile
import textwrap
import unittest
from pathlib import Path

from autoprover.backend import run_codex_backend


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
            self.assertEqual(metadata["provider"], "codex")
            self.assertIn("gpt-5.5", command)
            self.assertIn('model_reasoning_effort="xhigh"', command)
            self.assertIn("--ignore-user-config", command)
            self.assertEqual(metadata["returncode"], 0)
            self.assertTrue((result.artifact_dir / "stdout.jsonl").exists())
            self.assertTrue((result.artifact_dir / "stderr.log").exists())


if __name__ == "__main__":
    unittest.main()

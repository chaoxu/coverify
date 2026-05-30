from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "chatgpt_oracle_backend.py"


class ChatGptOracleBackendScriptTests(unittest.TestCase):
    def write_fake_cli(self, tmpdir: Path, source: str) -> Path:
        fake = tmpdir / "chatgpt-cli"
        fake.write_text(textwrap.dedent(source), encoding="utf-8")
        fake.chmod(0o755)
        return fake

    def test_success_prints_text_and_records_raw_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = self.write_fake_cli(
                tmpdir,
                """\
                #!/usr/bin/env python3
                import json
                import sys
                prompt = sys.stdin.read()
                assert "prime" in prompt
                print(json.dumps({
                    "ok": True,
                    "chat_id": "chat-1",
                    "text": "There are infinitely many primes.",
                    "model": "gpt-test",
                    "thinking_effort": "extended",
                    "elapsed_sec": 12,
                }))
                """,
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--chatgpt-cli",
                    str(fake),
                    "--workdir",
                    str(tmpdir),
                    "--timeout",
                    "60",
                ],
                input="Prove that there are infinitely many prime numbers.",
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            self.assertEqual(result.stdout, "There are infinitely many primes.\n")
            payload = json.loads((tmpdir / "chatgpt_oracle.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["chat_id"], "chat-1")

    def test_failure_reports_chat_id_and_artifact_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = self.write_fake_cli(
                tmpdir,
                """\
                #!/usr/bin/env python3
                import json
                print(json.dumps({"ok": False, "error": "timeout", "chat_id": "chat-2"}))
                raise SystemExit(1)
                """,
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--chatgpt-cli",
                    str(fake),
                    "--workdir",
                    str(tmpdir),
                ],
                input="Prompt",
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("timeout", result.stderr)
            self.assertIn("chat_id=chat-2", result.stderr)
            self.assertTrue((tmpdir / "chatgpt_oracle.json").exists())


if __name__ == "__main__":
    unittest.main()

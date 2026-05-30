from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "qed_chatgpt_codex_shim.py"


class QedChatGptCodexShimTests(unittest.TestCase):
    def write_fake_cli(self, tmpdir: Path, source: str) -> Path:
        fake = tmpdir / "chatgpt-cli"
        fake.write_text(textwrap.dedent(source), encoding="utf-8")
        fake.chmod(0o755)
        return fake

    def test_emits_codex_jsonl_from_chatgpt_oracle_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = self.write_fake_cli(
                tmpdir,
                """\
                #!/usr/bin/env python3
                import json
                import sys
                prompt = sys.stdin.read()
                assert "smoke ok" in prompt
                print(json.dumps({
                    "ok": True,
                    "chat_id": "chat-1",
                    "text": "smoke ok",
                    "elapsed_sec": 3,
                }))
                """,
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--chatgpt-cli",
                    str(fake),
                    "--timeout",
                    "60",
                    "--search",
                    "-m",
                    "gpt-5.5",
                    "-c",
                    'model_reasoning_effort="xhigh"',
                    "exec",
                    "--json",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "-C",
                    str(tmpdir),
                    "Say smoke ok.",
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            events = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(events[0]["type"], "item.completed")
            self.assertEqual(events[0]["item"]["type"], "agent_message")
            self.assertEqual(events[0]["item"]["text"], "smoke ok")
            self.assertEqual(events[1]["type"], "turn.completed")

    def test_accepts_qed_codex_argument_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = self.write_fake_cli(
                tmpdir,
                """\
                #!/usr/bin/env python3
                import json
                print(json.dumps({"ok": True, "chat_id": "chat-1", "text": "ok"}))
                """,
            )
            env = os.environ.copy()
            env["CHATGPT_CLI"] = str(fake)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--search",
                    "-m",
                    "gpt-5.5",
                    "exec",
                    "--json",
                    "-C",
                    str(tmpdir),
                    "Say ok.",
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                check=True,
            )

            event = json.loads(result.stdout.splitlines()[0])
            self.assertEqual(event["item"]["text"], "ok")

    def test_failure_is_nonzero_and_mentions_chat_id(self) -> None:
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
                    "exec",
                    "--json",
                    "Prompt",
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("timeout", result.stderr)
            self.assertIn("chat_id=chat-2", result.stderr)


if __name__ == "__main__":
    unittest.main()

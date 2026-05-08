from __future__ import annotations

import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

from autoprover import store
from autoprover import worker


class WorkerTests(unittest.TestCase):
    def test_explorer_writes_backend_output_as_draft(self) -> None:
        calls: list[tuple[list[str], str]] = []

        def fake_runner(command: list[str], prompt: str, cwd: Path) -> str:
            calls.append((command, prompt))
            return "```markdown\n# Exploration\n\nA possible proof direction.\n```"

        with TemporaryDirectory() as root:
            path = worker.run_explorer(
                root,
                "new-direction",
                "New Direction",
                "proof-candidate",
                "Try a small theorem",
                runner=fake_runner,
            )

            doc = store.read_markdown(path)
            self.assertIn("possible proof direction", doc.body)
            self.assertNotIn("```markdown", doc.body)
            self.assertIn("Try a small theorem", calls[0][1])

    def test_verifier_writes_parsed_review(self) -> None:
        def fake_runner(command: list[str], prompt: str, cwd: Path) -> str:
            return json.dumps(
                {
                    "verdict": "unsure",
                    "summary": "A gap remains.",
                    "critical_errors": "",
                    "gaps": "Missing bound.",
                    "repair_hints": "Prove the bound.",
                    "reusable_parts": "Setup is useful.",
                }
            )

        with TemporaryDirectory() as root:
            store.create_draft(root, "artifact", "Artifact", "lemma", "Claim.")
            store.submit_artifact(root, "artifact")

            path = worker.run_verifier(root, "artifact", runner=fake_runner)

            review = store.read_markdown(path)
            self.assertEqual(review.metadata["verdict"], "unsure")
            self.assertEqual(store.trust_status(root, "artifact"), "partial")

    def test_verifier_parse_failure_creates_no_review(self) -> None:
        def fake_runner(command: list[str], prompt: str, cwd: Path) -> str:
            return "not json"

        with TemporaryDirectory() as root:
            store.create_draft(root, "artifact", "Artifact", "lemma", "Claim.")
            store.submit_artifact(root, "artifact")

            with self.assertRaises(worker.WorkerError):
                worker.run_verifier(root, "artifact", runner=fake_runner)

            self.assertEqual(store.review_documents(root, "artifact"), [])

    def test_backend_commands_use_yolo_mode(self) -> None:
        calls: list[list[str]] = []

        def fake_runner(command: list[str], prompt: str, cwd: Path) -> str:
            calls.append(command)
            return "# ok"

        for backend_name in ("codex", "claude", "gemini"):
            worker.get_backend(backend_name).run("prompt", Path.cwd(), runner=fake_runner)

        self.assertIn("--dangerously-bypass-approvals-and-sandbox", calls[0])
        self.assertIn("--dangerously-skip-permissions", calls[1])
        self.assertIn("bypassPermissions", calls[1])
        self.assertIn("--yolo", calls[2])
        self.assertIn("yolo", calls[2])

    def test_missing_worker_cli_is_worker_error(self) -> None:
        def missing_run(*args, **kwargs):
            raise FileNotFoundError("missing")

        original_run = subprocess.run
        subprocess.run = missing_run
        try:
            with self.assertRaisesRegex(worker.WorkerError, "worker CLI not found: missing"):
                worker.run_subprocess(["missing"], "prompt", Path.cwd())
        finally:
            subprocess.run = original_run


if __name__ == "__main__":
    unittest.main()

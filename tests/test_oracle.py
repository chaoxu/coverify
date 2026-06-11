from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from coverify.engine.backend import BackendResult, run_fixture_backend
from coverify.integration.oracle import run_ask_oracle


class OracleTests(unittest.TestCase):
    def test_run_ask_oracle_retries_transient_backend_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            calls = 0

            def flaky_backend(prompt: str) -> BackendResult:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError("codex backend finished without writing answer.md")
                return run_fixture_backend(prompt, artifact_root=Path(tmpdir))

            result = run_ask_oracle(prompt="prove something", backend=flaky_backend, retries=1)

        self.assertEqual(calls, 2)
        self.assertTrue(result["ok"])
        self.assertIn("infinitely many", result["answer"])

    def test_run_ask_oracle_reports_retry_exhaustion(self) -> None:
        def failing_backend(_prompt: str) -> BackendResult:
            raise RuntimeError("stream disconnected")

        with self.assertRaisesRegex(RuntimeError, "failed after 2 attempt"):
            run_ask_oracle(prompt="prove something", backend=failing_backend, retries=1)


if __name__ == "__main__":
    unittest.main()

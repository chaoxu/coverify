from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from coverify.engine.backend import BackendResult
from coverify.apps.evals import EvalCase, grade_answer, load_eval_cases, run_eval_cases


class EvalTests(unittest.TestCase):
    def test_load_eval_cases_from_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cases.jsonl"
            path.write_text(
                '{"id":"c1","task_set":"T0","prompt":"prove","grader":"contains_all","expect":{"required":["proof"]}}\n',
                encoding="utf-8",
            )

            [case] = load_eval_cases(path)

            self.assertEqual(case.id, "c1")
            self.assertEqual(case.task_set, "T0")
            self.assertEqual(case.prompt, "prove")
            self.assertEqual(case.expect, {"required": ["proof"]})

    def test_contains_all_grader_reports_missing_text(self) -> None:
        case = EvalCase(
            id="c1",
            task_set="T0",
            prompt="",
            grader="contains_all",
            expect={"required": ["prime", "contradiction"]},
        )

        passed, detail = grade_answer(case, "prime proof")

        self.assertEqual(passed, False)
        self.assertIn("contradiction", detail)

    def test_review_decision_grader_uses_review_parser(self) -> None:
        case = EvalCase(
            id="c1",
            task_set="T1",
            prompt="",
            grader="review_decision",
            expect={"decision": "REQUEST_CHANGES"},
        )

        passed, detail = grade_answer(case, "Reasoning...\nDECISION: REQUEST_CHANGES\n")

        self.assertEqual(passed, True)
        self.assertIn("REQUEST_CHANGES", detail)

    def test_run_eval_cases_records_backend_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_dir = Path(tmpdir) / "artifact"
            artifact_dir.mkdir()
            case = EvalCase(
                id="c1",
                task_set="T0",
                prompt="prompt",
                grader="contains_all",
                expect={"required": ["answer"]},
            )

            def backend(prompt: str) -> BackendResult:
                self.assertEqual(prompt, "prompt")
                return BackendResult(
                    answer="answer",
                    artifact_dir=artifact_dir,
                    provider="test",
                    oracle_call_id="call-1",
                )

            report = run_eval_cases([case], backend=backend)

            self.assertEqual(report["summary"], {"total": 1, "passed": 1, "failed": 0, "pass_rate": 1.0})
            self.assertEqual(report["results"][0]["artifact_dir"], str(artifact_dir))


if __name__ == "__main__":
    unittest.main()

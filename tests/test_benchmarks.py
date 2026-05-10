import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from contextlib import redirect_stdout
from io import StringIO

from autoprover.benchmarks import (
    brokenmath_expected,
    load_benchmark_items,
    normalize_expected,
    run_benchmark,
)
from autoprover.cli import main


class BenchmarkTests(unittest.TestCase):
    def test_normalize_expected(self) -> None:
        self.assertEqual(normalize_expected(True), "approve")
        self.assertEqual(normalize_expected("correct"), "approve")
        self.assertEqual(normalize_expected(False), "reject")
        self.assertEqual(normalize_expected("invalid"), "reject")
        self.assertIsNone(normalize_expected("unclear"))

    def test_brokenmath_adversarial_rows_expect_rejection(self) -> None:
        self.assertEqual(brokenmath_expected({"is_adversarial": True}), "reject")
        self.assertEqual(brokenmath_expected({"is_adversarial": False}), "approve")

    def test_load_opc_items_from_jsonl(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "opc.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "problem_id": "p1",
                        "problem": "Prove $1=1$.",
                        "proof_solution": "Trivial.",
                        "correct": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            items = load_benchmark_items("opc", path)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].item_id, "p1")
        self.assertEqual(items[0].expected_decision, "approve")

    def test_review_benchmark_writes_jsonl_summary(self) -> None:
        with TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "broken.json"
            output_path = Path(tmp) / "results.jsonl"
            input_path.write_text(
                json.dumps(
                    [
                        {
                            "problem_id": "b1",
                            "problem": "Prove the fake theorem.",
                            "solution": "Fake proof.",
                            "is_adversarial": False,
                        }
                    ]
                ),
                encoding="utf-8",
            )
            summary = run_benchmark(
                "brokenmath",
                input_path,
                output_path,
                "./scripts/fake-agent",
                None,
                "review",
                -1,
                None,
            )
            records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary["passed"], 1)
        self.assertEqual(records[0]["decision"], "approve")
        self.assertEqual(records[0]["mode"], "review")

    def test_generate_benchmark_reviews_generated_proof(self) -> None:
        with TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "opc.json"
            output_path = Path(tmp) / "results.jsonl"
            input_path.write_text(
                json.dumps(
                    [
                        {
                            "problem_id": "g1",
                            "problem": "Prove a fake workflow theorem.",
                            "solution": "Reference solution.",
                            "correct": True,
                        }
                    ]
                ),
                encoding="utf-8",
            )
            summary = run_benchmark(
                "opc",
                input_path,
                output_path,
                "./scripts/fake-agent",
                None,
                "generate",
                -1,
                None,
            )
            record = json.loads(output_path.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(summary["passed"], 1)
        self.assertEqual(record["mode"], "generate")
        self.assertIn("Fake Exploration Result", record["generated_proof"])

    def test_cli_benchmark_does_not_require_cosheaf_config(self) -> None:
        with TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "opc.json"
            output_path = Path(tmp) / "results.jsonl"
            input_path.write_text(
                json.dumps(
                    [
                        {
                            "problem_id": "cli1",
                            "problem": "Prove the fake theorem.",
                            "proof_solution": "Fake proof.",
                            "correct": True,
                        }
                    ]
                ),
                encoding="utf-8",
            )
            with redirect_stdout(StringIO()) as stdout:
                rc = main(
                    [
                        "benchmark",
                        "opc",
                        "--input",
                        str(input_path),
                        "--output",
                        str(output_path),
                        "--agent-cmd",
                        "./scripts/fake-agent",
                    ]
                )
        self.assertEqual(rc, 0)
        self.assertIn('"total": 1', stdout.getvalue())


if __name__ == "__main__":
    unittest.main()

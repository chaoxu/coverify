import json
import subprocess
import unittest


class PrepareBenchmarksTests(unittest.TestCase):
    def test_help_mentions_limit(self) -> None:
        result = subprocess.run(
            ["./scripts/prepare-benchmarks", "--help"],
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertIn("--limit", result.stdout)

    def test_brokenmath_prepared_file_is_runnable_shape(self) -> None:
        result = subprocess.run(
            ["./scripts/prepare-benchmarks", "--limit", "1"],
            text=True,
            capture_output=True,
            check=True,
        )
        line = [line for line in result.stdout.splitlines() if line.startswith("brokenmath\t")][0]
        path = line.split("\t")[2]
        with open(path, encoding="utf-8") as handle:
            row = json.loads(handle.readline())
        self.assertIn("problem", row)
        self.assertIn("solution", row)
        self.assertIn("is_adversarial", row)


if __name__ == "__main__":
    unittest.main()

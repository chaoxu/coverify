from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "qed_backend.py"


class QedBackendScriptTests(unittest.TestCase):
    def test_dry_run_wraps_plain_prompt_as_latex_problem(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--dry-run",
                    "--workdir",
                    tmpdir,
                ],
                input="Prove that there are infinitely many primes.",
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            problem = (Path(tmpdir) / "problem.tex").read_text(encoding="utf-8")
            self.assertIn("\\begin{problem}", problem)
            self.assertIn("infinitely many primes", problem)
            self.assertIn("QED_STATUS: SUCCESS", result.stdout)
            self.assertIn("QED Proof", result.stdout)

    def test_dry_run_preserves_existing_problem_environment(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            prompt = "\\begin{problem}\nShow $1+1=2$.\n\\end{problem}\n"
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--dry-run",
                    "--workdir",
                    tmpdir,
                ],
                input=prompt,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )

            self.assertEqual((Path(tmpdir) / "problem.tex").read_text(encoding="utf-8"), prompt)


if __name__ == "__main__":
    unittest.main()

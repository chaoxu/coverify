from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from coverify.integration.danus import _all_terminal, run_danus_project


def _write_stub(path: Path, status_sequence: list[list[dict]]) -> None:
    """A fake `danus` CLI. `status` returns each list in the sequence in turn,
    holding the last one; every other verb prints a small JSON envelope."""
    encoded = json.dumps(status_sequence)
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys, pathlib\n"
        f"SEQ = json.loads({encoded!r})\n"
        "root = pathlib.Path(__file__).resolve().parent\n"
        "counter = root / '.status_calls'\n"
        "verb = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        "if verb == 'status':\n"
        "    n = int(counter.read_text()) if counter.exists() else 0\n"
        "    counter.write_text(str(n + 1))\n"
        "    rows = SEQ[min(n, len(SEQ) - 1)]\n"
        "    print(json.dumps(rows))\n"
        "elif verb == 'finalize':\n"
        "    print(json.dumps({'project': sys.argv[2], 'suggested': ['fact_abc123']}))\n"
        "elif verb in ('start', 'stop'):\n"
        "    print(json.dumps([{'worker': 'high-1', 'result': verb}]))\n"
        "else:\n"
        "    print('ok ' + verb)\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


class DanusAdapterTests(unittest.TestCase):
    def test_all_terminal(self) -> None:
        self.assertFalse(_all_terminal([]))
        self.assertFalse(_all_terminal([{"alive": True, "label": "working"}]))
        self.assertFalse(_all_terminal([{"alive": False, "label": "working"}]))
        self.assertTrue(_all_terminal([{"alive": False, "label": "max_rounds"}]))
        self.assertTrue(
            _all_terminal(
                [{"alive": False, "label": "stopped"}, {"alive": False, "label": "deadline"}]
            )
        )

    def test_lifecycle_stops_when_workers_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stub = root / "danus"
            # first poll: still working; second poll: terminal -> loop exits.
            _write_stub(
                stub,
                [
                    [{"worker": "high-1", "alive": True, "label": "working", "state": "running", "round": 1, "last_fact_id": None}],
                    [{"worker": "high-1", "alive": False, "label": "max_rounds", "state": "max_rounds", "round": 4, "last_fact_id": "fact_abc123"}],
                ],
            )
            result = run_danus_project(
                base_command=[str(stub)],
                cwd=root,
                problem="Prove that 2+2=4.",
                artifact_root=root / "artifacts",
                project="demo",
                poll_interval_seconds=0.0,
                deadline_seconds=30,
            )
            self.assertIn("fact_abc123", result.answer)
            self.assertIn("demo", result.answer)
            # PROBLEM.md written into the default projects root.
            self.assertTrue((root / "runtime" / "projects" / "demo" / "PROBLEM.md").exists())
            meta = json.loads((result.artifact_dir / "metadata.json").read_text())
            self.assertTrue(meta["ok"])
            self.assertFalse(meta["reached_deadline"])
            steps = [s["step"] for s in meta["steps"]]
            self.assertEqual(steps[0], "new")
            self.assertIn("start", steps)
            self.assertIn("suggest", steps)
            self.assertNotIn("stop", steps)  # terminal before deadline -> no stop

    def test_lifecycle_stops_at_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stub = root / "danus"
            # workers never terminate -> deadline path -> graceful stop.
            _write_stub(
                stub,
                [[{"worker": "high-1", "alive": True, "label": "working", "state": "running", "round": 1, "last_fact_id": None}]],
            )
            result = run_danus_project(
                base_command=[str(stub)],
                cwd=root,
                problem="Open problem.",
                artifact_root=root / "artifacts",
                project="demo",
                poll_interval_seconds=0.0,
                deadline_seconds=0,  # first check trips the deadline
            )
            meta = json.loads((result.artifact_dir / "metadata.json").read_text())
            steps = [s["step"] for s in meta["steps"]]
            self.assertIn("stop", steps)
            self.assertTrue(meta["reached_deadline"])


if __name__ == "__main__":
    unittest.main()

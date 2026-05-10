import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from autoprover.traces import append_trace, make_trace


class TraceTests(unittest.TestCase):
    def test_append_trace_writes_jsonl(self) -> None:
        trace = make_trace("explore", "do math", ["a"], "prompt", "output", {"id": "x"})
        with TemporaryDirectory() as tmp:
            path = append_trace(trace, Path(tmp) / "runs.jsonl")
            rows = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(rows), 1)
            parsed = json.loads(rows[0])
            self.assertEqual(parsed["kind"], "explore")
            self.assertEqual(parsed["context_ids"], ["a"])
            self.assertEqual(parsed["prompt_version"], "autoprover-prompts-v1")


if __name__ == "__main__":
    unittest.main()

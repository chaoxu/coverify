import unittest

from autoprover.agents import AgentError, parse_review_result, strip_outer_fence


class AgentTests(unittest.TestCase):
    def test_strip_outer_fence(self) -> None:
        self.assertEqual(strip_outer_fence("```json\n{\"x\": 1}\n```"), '{"x": 1}')

    def test_parse_review_result(self) -> None:
        result = parse_review_result(
            "DECISION: reject\nCOMMENT: gap\nBODY:\n## Review\nMissing bound."
        )
        self.assertEqual(result.decision, "reject")
        self.assertEqual(result.comment, "gap")
        self.assertIn("Missing bound", result.body)

    def test_parse_review_result_rejects_bad_decision(self) -> None:
        with self.assertRaises(AgentError):
            parse_review_result("DECISION: maybe\nCOMMENT: bad\nBODY:\nx")

    def test_parse_review_line_protocol(self) -> None:
        result = parse_review_result(
            "DECISION: approve\nCOMMENT: correct\nBODY:\n# Review\nUses $x^2$."
        )
        self.assertEqual(result.decision, "approve")
        self.assertEqual(result.comment, "correct")
        self.assertIn("Uses $x^2$", result.body)

    def test_parse_review_result_accepts_outer_fence(self) -> None:
        result = parse_review_result(
            "```text\nDECISION: approve\nCOMMENT: correct\nBODY:\n# Review\nGood.\n```"
        )
        self.assertEqual(result.decision, "approve")
        self.assertIn("Good", result.body)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import unittest

from coverify.review import ReviewDecision, parse_review_decision, review_event_from_oracle


class ReviewDecisionTests(unittest.TestCase):
    def test_maps_request_changes_without_runner_override(self) -> None:
        answer = "\n".join(
            [
                "DECISION: REQUEST_CHANGES",
                "",
                "FINDINGS:",
                "- The proof does not justify the key implication.",
            ],
        )

        self.assertEqual(parse_review_decision(answer), ReviewDecision.REQUEST_CHANGES)
        self.assertEqual(review_event_from_oracle(answer), "REQUEST_CHANGES")

    def test_maps_approve(self) -> None:
        answer = 'DECISION: APPROVE\n\nFINDINGS:\nI do not see a logical gap.\n'

        self.assertEqual(parse_review_decision(answer), ReviewDecision.APPROVE)
        self.assertEqual(review_event_from_oracle(answer), "APPROVE")

    def test_rejects_missing_or_ambiguous_decision(self) -> None:
        with self.assertRaises(ValueError):
            parse_review_decision("FINDINGS:\nI do not see a logical gap.")

        with self.assertRaises(ValueError):
            parse_review_decision("DECISION: APPROVE\nDECISION: REQUEST_CHANGES\n")

        with self.assertRaises(ValueError):
            parse_review_decision("DECISION: APPROVE\nDECISION: APPROVE\n")

        with self.assertRaises(ValueError):
            parse_review_decision("DECISION: APPROVE | REQUEST_CHANGES | COMMENT\n")


if __name__ == "__main__":
    unittest.main()

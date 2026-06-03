from __future__ import annotations

import re
from enum import StrEnum


class ReviewDecision(StrEnum):
    APPROVE = "APPROVE"
    REQUEST_CHANGES = "REQUEST_CHANGES"
    COMMENT = "COMMENT"


REVIEW_DECISION_VALUES = tuple(decision.value for decision in ReviewDecision)
REVIEW_DECISION_LINE = "DECISION: " + " | ".join(REVIEW_DECISION_VALUES)

_DECISION_RE = re.compile(
    r"(?im)^\s*DECISION\s*:\s*(" + "|".join(re.escape(value) for value in REVIEW_DECISION_VALUES) + r")\s*$",
)


def parse_review_decision(oracle_answer: str) -> ReviewDecision:
    decisions = _DECISION_RE.findall(oracle_answer)
    if len(decisions) != 1:
        raise ValueError("oracle review must contain exactly one unambiguous DECISION line")
    return ReviewDecision(decisions[0].upper())


def review_event_from_oracle(oracle_answer: str) -> str:
    return parse_review_decision(oracle_answer).value

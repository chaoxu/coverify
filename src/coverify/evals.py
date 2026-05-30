from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .backend import BackendResult
from .review import parse_review_decision


@dataclass(frozen=True)
class EvalCase:
    id: str
    task_set: str
    prompt: str
    grader: str
    expect: dict[str, Any]


def load_eval_cases(path: Path) -> list[EvalCase]:
    cases: list[EvalCase] = []
    with path.open(encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            raw = json.loads(text)
            cases.append(
                EvalCase(
                    id=require_str(raw, "id", path, line_number),
                    task_set=require_str(raw, "task_set", path, line_number),
                    prompt=require_str(raw, "prompt", path, line_number),
                    grader=require_str(raw, "grader", path, line_number),
                    expect=require_dict(raw, "expect", path, line_number),
                ),
            )
    if not cases:
        raise ValueError(f"eval case file is empty: {path}")
    return cases


def require_str(raw: dict[str, Any], key: str, path: Path, line_number: int) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{path}:{line_number}: {key} must be a non-empty string")
    return value


def require_dict(raw: dict[str, Any], key: str, path: Path, line_number: int) -> dict[str, Any]:
    value = raw.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"{path}:{line_number}: {key} must be an object")
    return value


def grade_answer(case: EvalCase, answer: str) -> tuple[bool, str]:
    if case.grader == "contains_all":
        required = case.expect.get("required")
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            raise ValueError(f"{case.id}: contains_all expects a string list at expect.required")
        haystack = answer.casefold()
        missing = [item for item in required if item.casefold() not in haystack]
        if missing:
            return False, "missing required text: " + ", ".join(missing)
        return True, "all required text found"

    if case.grader == "review_decision":
        expected = case.expect.get("decision")
        if not isinstance(expected, str):
            raise ValueError(f"{case.id}: review_decision expects expect.decision")
        try:
            actual = parse_review_decision(answer).value
        except ValueError as exc:
            return False, str(exc)
        if actual != expected:
            return False, f"expected decision {expected}, got {actual}"
        return True, f"decision {actual}"

    raise ValueError(f"{case.id}: unknown grader {case.grader}")


def summarize_results(results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    result_list = list(results)
    passed = sum(1 for result in result_list if result["passed"])
    return {
        "total": len(result_list),
        "passed": passed,
        "failed": len(result_list) - passed,
        "pass_rate": round(passed / len(result_list), 4) if result_list else 0.0,
    }


def run_eval_cases(
    cases: Iterable[EvalCase],
    *,
    backend: Callable[[str], BackendResult],
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for case in cases:
        backend_result = backend(case.prompt)
        passed, detail = grade_answer(case, backend_result.answer)
        results.append(
            {
                "id": case.id,
                "task_set": case.task_set,
                "grader": case.grader,
                "passed": passed,
                "detail": detail,
                "provider": backend_result.provider,
                "oracle_call_id": backend_result.oracle_call_id,
                "artifact_dir": str(backend_result.artifact_dir),
            },
        )
    return {
        "summary": summarize_results(results),
        "results": results,
    }

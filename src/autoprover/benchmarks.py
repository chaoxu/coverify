from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import csv
import hashlib
import json
import os
from pathlib import Path
import random
import time
from typing import Any, Iterable

from .agents import AgentError, parse_review_result, run_agent
from .format import COFLAT_PRIMER_VERSION, PROMPT_VERSION
from .prompts import ContextDoc, build_explore_prompt, build_review_prompt, slugify


class BenchmarkError(RuntimeError):
    pass


@dataclass(frozen=True)
class BenchmarkItem:
    benchmark: str
    item_id: str
    problem: str
    proof: str
    expected_decision: str | None


@dataclass(frozen=True)
class BenchmarkRecord:
    benchmark: str
    item_id: str
    mode: str
    expected_decision: str | None
    decision: str | None
    passed: bool | None
    elapsed_ms: int
    agent_command: str | None
    explorer_command: str | None
    verifier_command: str | None
    prompt_hash: str
    prompt_version: str
    coflat_primer_version: str
    generated_proof: str | None
    comment: str | None
    error: str | None


def load_rows(path: Path) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    if suffix == ".jsonl":
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [dict(row) for row in data]
        if isinstance(data, dict):
            for key in ("data", "items", "examples", "samples", "records"):
                if isinstance(data.get(key), list):
                    return [dict(row) for row in data[key]]
        raise BenchmarkError(f"JSON benchmark file must contain a list of rows: {path}")
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    raise BenchmarkError(f"unsupported benchmark file extension: {path.suffix}")


def pick_text(row: dict[str, Any], fields: Iterable[str]) -> str:
    for field in fields:
        value = row.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def pick_problem(row: dict[str, Any]) -> str:
    return pick_text(row, ["problem", "question", "statement", "prompt", "original_problem"])


def pick_proof(row: dict[str, Any]) -> str:
    proof = pick_text(
        row,
        [
            "proof_solution",
            "proof",
            "solution",
            "model_solution",
            "generated_proof",
            "answer",
            "response",
        ],
    )
    if proof:
        return proof
    solutions = row.get("solutions")
    if isinstance(solutions, list) and solutions:
        first = solutions[0]
        if isinstance(first, dict):
            return pick_text(first, ["solution", "proof", "answer"])
        if isinstance(first, str):
            return first.strip()
    return ""


def pick_item_id(row: dict[str, Any], fallback: int) -> str:
    for field in ("id", "item_id", "problem_id", "sample_id", "uuid"):
        value = row.get(field)
        if value is not None and str(value).strip():
            return str(value)
    return str(fallback)


def normalize_expected(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "approve" if value else "reject"
    if isinstance(value, (int, float)):
        if value == 1:
            return "approve"
        if value == 0:
            return "reject"
    text = str(value).strip().lower()
    if not text:
        return None
    if text in {"1", "true", "yes", "y", "correct", "valid", "accept", "accepted", "approve", "approved"}:
        return "approve"
    if text in {"0", "false", "no", "n", "incorrect", "invalid", "reject", "rejected", "wrong"}:
        return "reject"
    return None


def opc_expected(row: dict[str, Any]) -> str | None:
    for field in (
        "correct",
        "is_correct",
        "human_label",
        "label",
        "verdict",
        "judgement",
        "judgment",
        "accepted",
    ):
        decision = normalize_expected(row.get(field))
        if decision:
            return decision
    return None


def brokenmath_expected(row: dict[str, Any]) -> str | None:
    adversarial = row.get("is_adversarial")
    if adversarial is not None:
        normalized = normalize_expected(adversarial)
        if normalized == "approve":
            return "reject"
        if normalized == "reject":
            return "approve"
    return opc_expected(row)


def load_benchmark_items(benchmark: str, path: Path) -> list[BenchmarkItem]:
    rows = load_rows(path)
    items: list[BenchmarkItem] = []
    for index, row in enumerate(rows, start=1):
        problem = pick_problem(row)
        proof = pick_proof(row)
        if not problem or not proof:
            continue
        expected = brokenmath_expected(row) if benchmark == "brokenmath" else opc_expected(row)
        items.append(
            BenchmarkItem(
                benchmark=benchmark,
                item_id=pick_item_id(row, index),
                problem=problem,
                proof=proof,
                expected_decision=expected,
            )
        )
    if not items:
        raise BenchmarkError(f"no usable benchmark rows found in {path}")
    return items


def select_items(items: list[BenchmarkItem], limit: int, seed: int | None) -> list[BenchmarkItem]:
    selected = list(items)
    if seed is not None:
        rng = random.Random(seed)
        rng.shuffle(selected)
    if limit >= 0:
        selected = selected[:limit]
    return selected


def benchmark_target_doc(item: BenchmarkItem, proof: str) -> ContextDoc:
    title = f"{item.benchmark} {item.item_id}"
    content = "\n".join(
        [
            f"# Benchmark Item: {title}",
            "",
            '::: {.problem title="Problem"}',
            item.problem,
            ":::",
            "",
            '::: {.proof title="Candidate proof"}',
            proof,
            ":::",
        ]
    )
    return ContextDoc(
        doc_id=f"benchmark:{item.benchmark}:{item.item_id}",
        path=f"benchmarks/{item.benchmark}/{slugify(item.item_id)}.md",
        title=title,
        doc_type="page",
        status="unreviewed",
        content=content,
    )


def hash_prompt(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def resolve_verifier_cmd(agent_cmd: str | None, verifier_cmd: str | None) -> str | None:
    return verifier_cmd or os.environ.get("AUTOPROVER_VERIFIER_CMD") or agent_cmd


def review_item(
    item: BenchmarkItem,
    agent_cmd: str | None,
    verifier_cmd: str | None = None,
    proof: str | None = None,
) -> BenchmarkRecord:
    candidate = proof if proof is not None else item.proof
    prompt = build_review_prompt(benchmark_target_doc(item, candidate))
    start = time.monotonic()
    generated: str | None = None if proof is None else candidate
    resolved_verifier_cmd = resolve_verifier_cmd(agent_cmd, verifier_cmd)
    try:
        raw = run_agent(prompt, resolved_verifier_cmd)
        review = parse_review_result(raw)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        passed = None
        if item.expected_decision is not None:
            passed = review.decision == item.expected_decision
        return BenchmarkRecord(
            benchmark=item.benchmark,
            item_id=item.item_id,
            mode="review",
            expected_decision=item.expected_decision,
            decision=review.decision,
            passed=passed,
            elapsed_ms=elapsed_ms,
            agent_command=resolved_verifier_cmd,
            explorer_command=None,
            verifier_command=resolved_verifier_cmd,
            prompt_hash=hash_prompt(prompt),
            prompt_version=PROMPT_VERSION,
            coflat_primer_version=COFLAT_PRIMER_VERSION,
            generated_proof=generated,
            comment=review.comment,
            error=None,
        )
    except AgentError as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return BenchmarkRecord(
            benchmark=item.benchmark,
            item_id=item.item_id,
            mode="review",
            expected_decision=item.expected_decision,
            decision=None,
            passed=False if item.expected_decision is not None else None,
            elapsed_ms=elapsed_ms,
            agent_command=resolved_verifier_cmd,
            explorer_command=None,
            verifier_command=resolved_verifier_cmd,
            prompt_hash=hash_prompt(prompt),
            prompt_version=PROMPT_VERSION,
            coflat_primer_version=COFLAT_PRIMER_VERSION,
            generated_proof=generated,
            comment=None,
            error=str(exc),
        )


def generate_item(item: BenchmarkItem, agent_cmd: str | None, verifier_cmd: str | None = None) -> BenchmarkRecord:
    direction = "\n".join(["Solve this benchmark problem with a complete proof.", "", item.problem])
    prompt = build_explore_prompt(direction, [])
    start = time.monotonic()
    try:
        proof = run_agent(prompt, agent_cmd)
    except AgentError as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return BenchmarkRecord(
            benchmark=item.benchmark,
            item_id=item.item_id,
            mode="generate",
            expected_decision=item.expected_decision,
            decision=None,
            passed=False if item.expected_decision is not None else None,
            elapsed_ms=elapsed_ms,
            agent_command=agent_cmd,
            explorer_command=agent_cmd,
            verifier_command=resolve_verifier_cmd(agent_cmd, verifier_cmd),
            prompt_hash=hash_prompt(prompt),
            prompt_version=PROMPT_VERSION,
            coflat_primer_version=COFLAT_PRIMER_VERSION,
            generated_proof=None,
            comment=None,
            error=str(exc),
        )
    record = review_item(item, agent_cmd, verifier_cmd, proof=proof)
    elapsed_ms = int((time.monotonic() - start) * 1000)
    return replace(record, mode="generate", elapsed_ms=elapsed_ms, explorer_command=agent_cmd)


def write_records(records: list[BenchmarkRecord], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")


def summarize(records: list[BenchmarkRecord]) -> dict[str, Any]:
    total = len(records)
    labeled = [record for record in records if record.expected_decision is not None]
    passed = [record for record in labeled if record.passed is True]
    false_approvals = [
        record for record in labeled if record.expected_decision == "reject" and record.decision == "approve"
    ]
    false_rejections = [
        record for record in labeled if record.expected_decision == "approve" and record.decision == "reject"
    ]
    errors = [record for record in records if record.error]
    return {
        "total": total,
        "labeled": len(labeled),
        "passed": len(passed),
        "accuracy": (len(passed) / len(labeled)) if labeled else None,
        "false_approvals": len(false_approvals),
        "false_rejections": len(false_rejections),
        "errors": len(errors),
    }


def run_benchmark(
    benchmark: str,
    input_path: Path,
    output_path: Path,
    agent_cmd: str | None,
    verifier_cmd: str | None,
    mode: str,
    limit: int,
    seed: int | None,
) -> dict[str, Any]:
    items = select_items(load_benchmark_items(benchmark, input_path), limit, seed)
    if mode == "review":
        records = [review_item(item, agent_cmd, verifier_cmd) for item in items]
    elif mode == "generate":
        records = [generate_item(item, agent_cmd, verifier_cmd) for item in items]
    else:
        raise BenchmarkError(f"unknown benchmark mode: {mode}")
    write_records(records, output_path)
    return summarize(records)

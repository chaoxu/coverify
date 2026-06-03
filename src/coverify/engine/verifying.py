"""Composite "verifying" oracle.

A verifying oracle is just another backend: it implements the same
``BackendRunner`` interface (``prompt -> BackendResult``) but produces its
response by delegating to other oracles. It runs a generate -> verify ->
adjudicate loop:

- the generator produces a candidate response;
- each verifier acts as an adversarial referee and ends its reply with the
  single required verdict line;
- any FAIL sends the concatenated critiques back to the generator for another
  round (the generator self-revises); the loop stops on the first all-PASS
  round or when ``max_rounds`` is exhausted;
- a final adjunct oracle always writes the natural-language reply, asserting
  only what was verified and being honest about what it could not.

A broken verifier (the call fails after retries, or its answer has no
parseable VERDICT line) is recorded as ERROR. In the lenient default ERROR
stops the loop like PASS -- we would rather produce something -- but the result
is not marked verified, and the final adjunct is told to flag what is not
established. A ``strict`` oracle instead refuses to answer when a required step
errors.

Each step (generator, each verifier, adjunct) is a ``Step`` = a sub-oracle
``BackendRunner`` plus optional custom role instructions, so profiles can mix
backends and verifier roles freely. Passing ``resume_dir`` reuses journaled
sub-call results: any step already completed in that bundle is served from its
recorded answer instead of being re-run.

Sub-runners must be **side-effect-free**. The loop retries failed calls and
replays completed ones on resume, so a runner that mutates the world (posts a
comment, writes a file, merges a PR) would double-fire. This is the operational
form of "verify oracles, not agents": verification applies to side-effect-free
producers of claims. An effectful agent is *gated by* a verifying oracle -- it
acts on the oracle's checked response -- but is never placed inside the loop.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any

from .backend import (
    BackendResult,
    BackendRunner,
    ensure_artifact_dir,
    write_audit_metadata,
    write_prompt_file,
)


class Verdict(StrEnum):
    PASS = "PASS"
    FAIL = "FAIL"


ERROR = "ERROR"
VERDICT_VALUES = tuple(verdict.value for verdict in Verdict)
VERDICT_LINE = "VERDICT: " + " | ".join(VERDICT_VALUES)

_VERDICT_RE = re.compile(
    r"(?im)^\s*VERDICT\s*:\s*(" + "|".join(re.escape(value) for value in VERDICT_VALUES) + r")\s*$",
)


def parse_verdict(answer: str) -> Verdict:
    """Extract the single required verdict line; raise if absent/ambiguous."""
    found = _VERDICT_RE.findall(answer)
    if len(found) != 1:
        raise ValueError("verifier answer must contain exactly one VERDICT line")
    return Verdict(found[0].upper())


def build_generator_context(
    original: str, prior_answer: str, critique: str, instructions: str | None = None
) -> str:
    task = f"{instructions}\n\n{original}" if instructions else original
    if not critique.strip():
        return task
    return "\n".join(
        [
            "# Task",
            task,
            "",
            "## Your previous attempt",
            prior_answer,
            "",
            "## Reviewer critique",
            "A reviewer found the following problems with the previous attempt.",
            "Produce a corrected, complete answer to the task that addresses every",
            "point. Do not repeat the same mistakes.",
            "",
            critique,
        ],
    )


def build_verifier_context(
    original: str, candidate: str, instructions: str | None = None
) -> str:
    guidance = instructions or (
        "Act as a careful, adversarial mathematical referee. Find any logical "
        "gap, false claim, unsupported status label, ignored constraint, "
        "unjustified step, or computational error in the candidate response "
        "below. Be skeptical."
    )
    return "\n".join(
        [
            "# Verification Task: Verify a response",
            guidance,
            "",
            "Write your findings, then output exactly one line:",
            "",
            VERDICT_LINE,
            "",
            "Use PASS only if you find no correctness problem. Use FAIL if there is",
            "any gap, target drift, ignored forced method, unsupported claim, or",
            "status-label error the author must fix.",
            "",
            "## Original question",
            original,
            "",
            "## Candidate response",
            candidate,
        ],
    )


def build_adjudicator_context(
    original: str,
    latest: str,
    verified: bool,
    *,
    quiet: bool = False,
    instructions: str | None = None,
) -> str:
    if instructions:
        head = instructions
    elif quiet:
        head = (
            "Earlier drafts were checked by adversarial reviewers. Write the final"
            " answer for the user, stating only what the checked draft establishes."
            " Be concise and direct."
        )
    else:
        status = (
            "passed all reviewer checks."
            if verified
            else "still had unresolved reviewer concerns; be especially careful to"
            " flag what is not established."
        )
        head = (
            "Earlier drafts were checked by adversarial reviewers. The latest draft "
            + status
            + "\nWrite the best, honest answer you can: assert only what the checked"
            " draft supports; for anything you cannot fully justify, say so plainly"
            " and explain why; do not introduce new claims you cannot support."
        )
    return "\n".join(
        [
            "# Final Response Task: Write the final answer",
            head,
            "",
            "## Original question",
            original,
            "",
            "## Latest checked draft",
            latest,
        ],
    )


def _call_with_retry(
    runner: BackendRunner, context: str, retries: int
) -> BackendResult | None:
    """Call a sub-oracle, retrying transient ``RuntimeError``s.

    Returns ``None`` when the call still fails after ``retries`` extra attempts;
    the loop treats that as ERROR.
    """
    for _attempt in range(max(retries, 0) + 1):
        try:
            return runner(context)
        except RuntimeError:
            continue
    return None


@dataclass(frozen=True)
class Step:
    """A sub-oracle plus optional custom role instructions."""

    runner: BackendRunner
    instructions: str | None = None


@dataclass(frozen=True)
class VerifyingLLMInput:
    """A verifying-oracle prompt prepared without calling an inner backend."""

    step: str
    prompt: str
    round: int | None = None
    verifier_index: int | None = None
    resume_dir: str | None = None
    complete: bool = False

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "step": self.step,
            "prompt": self.prompt,
            "complete": self.complete,
        }
        if self.round is not None:
            out["round"] = self.round
        if self.verifier_index is not None:
            out["verifier_index"] = self.verifier_index
        if self.resume_dir is not None:
            out["resume_dir"] = self.resume_dir
        return out


class _ResumeCache:
    """Serves journaled sub-call answers so a resumed run skips completed steps."""

    def __init__(self, resume_dir: Path | None) -> None:
        self._dirs: dict[tuple, Path] = {}
        if resume_dir is None:
            return
        journal_path = resume_dir / "journal.json"
        if not journal_path.exists():
            return
        for entry in json.loads(journal_path.read_text(encoding="utf-8")):
            if "artifact_dir" not in entry or "error" in entry:
                continue
            self._dirs[_journal_key(entry)] = Path(entry["artifact_dir"])

    def hit(self, key: tuple) -> BackendResult | None:
        artifact_dir = self._dirs.get(key)
        if artifact_dir is None:
            return None
        answer_path = artifact_dir / "answer.md"
        if not answer_path.exists():
            return None
        return BackendResult(
            answer=answer_path.read_text(encoding="utf-8"),
            artifact_dir=artifact_dir,
            provider="cached",
            oracle_call_id=artifact_dir.name,
        )


def _journal_key(entry: dict[str, Any]) -> tuple:
    role = entry["role"]
    if role == "verifier":
        return (role, entry["round"], entry["index"])
    if role == "generator":
        return (role, entry["round"])
    return (role,)


def _load_journal_entries(resume_dir: Path | None) -> dict[tuple, dict[str, Any]]:
    if resume_dir is None:
        return {}
    journal_path = resume_dir / "journal.json"
    if not journal_path.exists():
        return {}
    entries = json.loads(journal_path.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise ValueError(f"verifying journal must be a list: {journal_path}")
    out: dict[tuple, dict[str, Any]] = {}
    for entry in entries:
        if isinstance(entry, dict) and "role" in entry:
            out[_journal_key(entry)] = entry
    return out


def _entry_answer(entry: dict[str, Any] | None) -> str | None:
    if entry is None or "error" in entry:
        return None
    artifact_dir = entry.get("artifact_dir")
    if not isinstance(artifact_dir, str):
        return None
    answer_path = Path(artifact_dir) / "answer.md"
    if not answer_path.exists():
        return None
    return answer_path.read_text(encoding="utf-8")


def prepare_verifying_llm_input(
    original: str,
    config: "VerifyingConfig",
    *,
    resume_dir: Path | None = None,
    quiet_adjunct: bool = False,
) -> VerifyingLLMInput:
    """Build the first unmaterialized inner prompt without invoking a backend.

    This mirrors the generate -> verify -> adjudicate control flow using only
    journaled answers in ``resume_dir``. Missing or failed journal entries mark
    the role whose prompt is ready for inspection.
    """
    if not original.strip():
        raise ValueError("verifying oracle prompt is empty")
    if config.max_rounds < 1:
        raise ValueError("max_rounds must be at least 1")
    if resume_dir is not None and not resume_dir.exists():
        raise ValueError(f"resume dir does not exist: {resume_dir}")

    entries = _load_journal_entries(resume_dir)
    history: list[str] = []
    critique = ""
    verified = False

    for round_index in range(config.max_rounds):
        prior_answer = history[-1] if history else ""
        generator_prompt = build_generator_context(
            original,
            prior_answer,
            critique,
            config.generator.instructions,
        )
        generator_answer = _entry_answer(entries.get(("generator", round_index)))
        if generator_answer is None:
            return VerifyingLLMInput(
                step="generator",
                prompt=generator_prompt,
                round=round_index,
                resume_dir=str(resume_dir) if resume_dir is not None else None,
            )
        history.append(generator_answer)

        round_failed = False
        critiques: list[str] = []
        round_verdicts: list[str] = []
        for verifier_index, verifier in enumerate(config.verifiers):
            verifier_prompt = build_verifier_context(
                original,
                generator_answer,
                verifier.instructions,
            )
            entry = entries.get(("verifier", round_index, verifier_index))
            verifier_answer = _entry_answer(entry)
            if verifier_answer is None:
                return VerifyingLLMInput(
                    step="verifier",
                    prompt=verifier_prompt,
                    round=round_index,
                    verifier_index=verifier_index,
                    resume_dir=str(resume_dir) if resume_dir is not None else None,
                )
            raw_verdict = entry.get("verdict") if entry is not None else None
            verdict = str(raw_verdict) if raw_verdict else ERROR
            if verdict not in (*VERDICT_VALUES, ERROR):
                verdict = ERROR
            round_verdicts.append(verdict)
            if verdict == Verdict.FAIL.value:
                round_failed = True
                critiques.append(verifier_answer)

        if not round_failed:
            verified = _all_verifiers_passed(round_verdicts)
            break
        critique = "\n\n".join(critiques)

    latest = history[-1] if history else "(no answer was produced)"
    adjudicator_prompt = build_adjudicator_context(
        original,
        latest,
        verified,
        quiet=config.quiet_adjunct or quiet_adjunct,
        instructions=config.adjudicator.instructions,
    )
    adjudicator_answer = _entry_answer(entries.get(("adjudicator",)))
    if adjudicator_answer is None:
        return VerifyingLLMInput(
            step="adjudicator",
            prompt=adjudicator_prompt,
            resume_dir=str(resume_dir) if resume_dir is not None else None,
        )
    return VerifyingLLMInput(
        step="complete",
        prompt="",
        resume_dir=str(resume_dir) if resume_dir is not None else None,
        complete=True,
    )


class StrictVerificationError(RuntimeError):
    """Raised in strict mode when a required step errors out."""


@dataclass(frozen=True)
class VerifyingOracle:
    """A ``BackendRunner`` composed of generator, verifier, and adjunct oracles."""

    generator: Step
    verifiers: list[Step]
    adjudicator: Step
    artifact_root: Path
    max_rounds: int = 3
    retries: int = 1
    strict: bool = False
    quiet_adjunct: bool = False
    resume_dir: Path | None = None

    def __call__(self, prompt: str) -> BackendResult:
        if not prompt.strip():
            raise ValueError("verifying oracle prompt is empty")
        if self.max_rounds < 1:
            raise ValueError("max_rounds must be at least 1")
        if self.resume_dir is not None and not self.resume_dir.exists():
            raise ValueError(f"resume dir does not exist: {self.resume_dir}")

        cache = _ResumeCache(self.resume_dir)
        parent = self.resume_dir or ensure_artifact_dir(self.artifact_root, "verifying")
        oracle_call_id = parent.name
        started_at = datetime.now(timezone.utc).isoformat()
        started = time.monotonic()
        prompt_path = write_prompt_file(parent, prompt)

        journal: list[dict[str, Any]] = []
        history: list[str] = []
        critique = ""
        verified = False
        final_verdicts: list[str] = []

        def resolve(key: tuple, step: Step, context: str) -> BackendResult | None:
            return cache.hit(key) or _call_with_retry(step.runner, context, self.retries)

        def fail_strict(reason: str, verdicts: list[str]) -> None:
            self._finalize(
                parent, prompt_path, f"(strict mode: {reason})", journal,
                verified=False, final_verdicts=verdicts,
                started_at=started_at, started=started,
            )
            raise StrictVerificationError(
                f"verifying oracle aborted in strict mode: {reason}; artifacts={parent}"
            )

        for round_index in range(self.max_rounds):
            prior_answer = history[-1] if history else ""
            gen = resolve(
                ("generator", round_index),
                self.generator,
                build_generator_context(
                    prompt, prior_answer, critique, self.generator.instructions
                ),
            )
            if gen is None:
                journal.append({"round": round_index, "role": "generator", "error": "backend_failed"})
                if self.strict:
                    fail_strict("generator backend failed", final_verdicts)
                break
            history.append(gen.answer)
            journal.append(_call_entry(round_index, "generator", gen))

            round_failed = False
            critiques: list[str] = []
            round_verdicts: list[str] = []
            for v_index, verifier in enumerate(self.verifiers):
                result = resolve(
                    ("verifier", round_index, v_index),
                    verifier,
                    build_verifier_context(prompt, gen.answer, verifier.instructions),
                )
                verdict = _verdict_of(result)
                round_verdicts.append(verdict)
                entry = _call_entry(round_index, "verifier", result, index=v_index)
                entry["verdict"] = verdict
                journal.append(entry)
                if verdict == ERROR and self.strict:
                    fail_strict(f"verifier {v_index} unavailable", round_verdicts)
                if verdict == Verdict.FAIL.value:
                    round_failed = True
                    if result is not None:
                        critiques.append(result.answer)

            final_verdicts = round_verdicts
            if not round_failed:  # ERROR stops retries in lenient mode, but is not verified.
                verified = _all_verifiers_passed(round_verdicts)
                break
            critique = "\n\n".join(critiques)

        latest = history[-1] if history else "(no answer was produced)"
        adj = resolve(
            ("adjudicator",),
            self.adjudicator,
            build_adjudicator_context(
                prompt, latest, verified,
                quiet=self.quiet_adjunct, instructions=self.adjudicator.instructions,
            ),
        )
        if adj is not None:
            final_answer = adj.answer
            journal.append(_call_entry(None, "adjudicator", adj))
        elif self.strict:
            fail_strict("adjudicator backend failed", final_verdicts)
        else:
            final_answer = latest
            journal.append({"role": "adjudicator", "error": "backend_failed"})

        return self._finalize(
            parent, prompt_path, final_answer, journal,
            verified=verified, final_verdicts=final_verdicts,
            started_at=started_at, started=started,
        )

    def _finalize(
        self,
        parent: Path,
        prompt_path: Path,
        final_answer: str,
        journal: list[dict[str, Any]],
        *,
        verified: bool,
        final_verdicts: list[str],
        started_at: str,
        started: float,
    ) -> BackendResult:
        answer_path = parent / "answer.md"
        answer_path.write_text(final_answer, encoding="utf-8")
        journal_path = parent / "journal.json"
        journal_path.write_text(json.dumps(journal, indent=2), encoding="utf-8")
        write_audit_metadata(
            parent / "metadata.json",
            {
                "oracle_call_id": parent.name,
                "provider": "verifying",
                "started_at": started_at,
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": round(time.monotonic() - started, 3),
                "artifact_dir": str(parent),
                "rounds": sum(1 for e in journal if e["role"] == "generator" and "error" not in e),
                "max_rounds": self.max_rounds,
                "verified": verified,
                "final_verdicts": final_verdicts,
                "returncode": 0,
                "timed_out": False,
            },
            {"prompt": prompt_path, "answer": answer_path, "journal": journal_path},
        )
        return BackendResult(
            answer=final_answer,
            artifact_dir=parent,
            provider="verifying",
            oracle_call_id=parent.name,
        )


def _verdict_of(result: BackendResult | None) -> str:
    if result is None:
        return ERROR
    try:
        return parse_verdict(result.answer).value
    except ValueError:
        return ERROR


def _all_verifiers_passed(verdicts: list[str]) -> bool:
    return bool(verdicts) and all(verdict == Verdict.PASS.value for verdict in verdicts)


def _call_entry(
    round_index: int | None, role: str, result: BackendResult | None, *, index: int | None = None
) -> dict[str, Any]:
    entry: dict[str, Any] = {"role": role}
    if round_index is not None:
        entry["round"] = round_index
    if index is not None:
        entry["index"] = index
    if result is not None:
        entry["oracle_call_id"] = result.oracle_call_id
        entry["artifact_dir"] = str(result.artifact_dir)
    return entry


@dataclass(frozen=True)
class StepConfig:
    """Declarative description of one role's sub-oracle (backend selection only).

    Any field left ``None`` inherits the run's CLI defaults when the runner is
    built. ``instructions`` overrides the role's default prompt guidance.
    """

    backend: str | None = None
    command: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    instructions: str | None = None


@dataclass(frozen=True)
class VerifyingConfig:
    generator: StepConfig
    verifiers: list[StepConfig]
    adjudicator: StepConfig
    max_rounds: int = 3
    strict: bool = False
    quiet_adjunct: bool = False


def _step_config(data: Any) -> StepConfig:
    if data is None:
        return StepConfig()
    if not isinstance(data, dict):
        raise ValueError("step config must be an object")
    return StepConfig(
        backend=data.get("backend"),
        command=data.get("command"),
        model=data.get("model"),
        reasoning_effort=data.get("reasoning_effort"),
        instructions=data.get("instructions"),
    )


def verifying_config_from_dict(data: dict[str, Any]) -> VerifyingConfig:
    verifiers = data.get("verifiers") or [None]
    return VerifyingConfig(
        generator=_step_config(data.get("generator")),
        verifiers=[_step_config(v) for v in verifiers],
        adjudicator=_step_config(data.get("adjudicator")),
        max_rounds=int(data.get("max_rounds", 3)),
        strict=bool(data.get("strict", False)),
        quiet_adjunct=bool(data.get("quiet_adjunct", False)),
    )


def load_verifying_config(path: Path) -> VerifyingConfig:
    return verifying_config_from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


_BUILTIN_PROFILES: dict[str, dict[str, Any]] = {
    "default": {},
    "strict": {"strict": True},
}


def builtin_profile(name: str, *, max_rounds: int | None = None) -> VerifyingConfig:
    if name not in _BUILTIN_PROFILES:
        raise ValueError(
            f"unknown verify profile: {name}; choices: {sorted(_BUILTIN_PROFILES)}"
        )
    data = dict(_BUILTIN_PROFILES[name])
    if max_rounds is not None:
        data.setdefault("max_rounds", max_rounds)
    return verifying_config_from_dict(data)

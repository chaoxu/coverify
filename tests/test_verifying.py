from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Callable

from coverify.engine.backend import BackendResult
from coverify.engine.verifying import (
    ERROR,
    MECHANICAL_FAIL,
    Step,
    StrictVerificationError,
    Verdict,
    VerifyingOracle,
    build_verifier_context,
    builtin_profile,
    mechanical_draft_problems,
    parse_verdict,
    prepare_verifying_llm_input,
    verifying_config_from_dict,
)


def make_runner(
    fn: Callable[[str, int], str], *, provider: str = "fake"
) -> Callable[[str], BackendResult]:
    """Fake runner that does NOT persist artifacts (artifact_dir only str-ed)."""
    state = {"n": 0}

    def run(context: str) -> BackendResult:
        state["n"] += 1
        return BackendResult(
            answer=fn(context, state["n"]),
            artifact_dir=Path("/tmp/does-not-need-to-exist"),
            provider=provider,
            oracle_call_id=f"{provider}-{state['n']}",
        )

    return run


def make_writing_runner(
    fn: Callable[[str, int], str], root: Path, *, provider: str = "real"
) -> tuple[Callable[[str], BackendResult], dict]:
    """Fake runner that writes a real answer.md, like a true backend (for resume)."""
    state = {"n": 0}

    def run(context: str) -> BackendResult:
        state["n"] += 1
        artifact_dir = root / f"{provider}-{state['n']}"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        answer = fn(context, state["n"])
        (artifact_dir / "answer.md").write_text(answer, encoding="utf-8")
        return BackendResult(
            answer=answer,
            artifact_dir=artifact_dir,
            provider=provider,
            oracle_call_id=artifact_dir.name,
        )

    return run, state


def broken_runner(_context: str) -> BackendResult:
    raise RuntimeError("backend exploded")


def step(fn, **kw) -> Step:
    return Step(runner=make_runner(fn), instructions=kw.get("instructions"))


def read_metadata(result: BackendResult) -> dict:
    return json.loads((result.artifact_dir / "metadata.json").read_text(encoding="utf-8"))


def read_journal(result: BackendResult) -> list:
    return json.loads((result.artifact_dir / "journal.json").read_text(encoding="utf-8"))


class ParseVerdictTests(unittest.TestCase):
    def test_pass(self) -> None:
        self.assertEqual(parse_verdict("looks fine\nVERDICT: PASS"), Verdict.PASS)

    def test_fail(self) -> None:
        self.assertEqual(parse_verdict("gap here\nVERDICT: FAIL\n"), Verdict.FAIL)

    def test_lowercase(self) -> None:
        self.assertEqual(parse_verdict("verdict: pass"), Verdict.PASS)

    def test_missing_raises(self) -> None:
        with self.assertRaises(ValueError):
            parse_verdict("I have no opinion")

    def test_ambiguous_raises(self) -> None:
        with self.assertRaises(ValueError):
            parse_verdict("VERDICT: PASS\nVERDICT: FAIL")


class VerifyingOracleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def make_oracle(self, generator, verifiers, adjudicator, **kw) -> VerifyingOracle:
        return VerifyingOracle(
            generator=generator,
            verifiers=verifiers,
            adjudicator=adjudicator,
            artifact_root=self.root,
            retries=0,
            **kw,
        )

    def test_converges_after_revision(self) -> None:
        oracle = self.make_oracle(
            step(lambda ctx, _n: "GOOD answer" if "Reviewer critique" in ctx else "BAD answer"),
            [step(lambda ctx, _n: "gap\nVERDICT: FAIL" if "BAD answer" in ctx else "ok\nVERDICT: PASS")],
            step(lambda ctx, _n: "FINAL: " + ctx.rsplit("\n", 1)[-1]),
            max_rounds=3,
        )
        result = oracle("Prove something.")

        self.assertEqual(result.provider, "verifying")
        self.assertIn("GOOD answer", result.answer)
        meta = read_metadata(result)
        self.assertTrue(meta["verified"])
        self.assertEqual(meta["rounds"], 2)
        self.assertEqual(meta["final_verdicts"], [Verdict.PASS.value])

    def test_budget_exhaustion_still_answers(self) -> None:
        oracle = self.make_oracle(
            step(lambda _c, _n: "still wrong"),
            [step(lambda _c, _n: "nope\nVERDICT: FAIL")],
            step(lambda _c, _n: "honest reply"),
            max_rounds=2,
        )
        result = oracle("Prove something hard.")

        self.assertEqual(result.answer, "honest reply")
        meta = read_metadata(result)
        self.assertFalse(meta["verified"])
        self.assertEqual(meta["rounds"], 2)

    def test_broken_verifier_stops_loop_but_is_not_verified(self) -> None:
        oracle = self.make_oracle(
            step(lambda _c, _n: "an answer"),
            [Step(runner=broken_runner)],
            step(lambda ctx, _n: "flagged" if "still had unresolved reviewer concerns" in ctx else "final"),
            max_rounds=3,
        )
        result = oracle("Question.")

        meta = read_metadata(result)
        self.assertEqual(result.answer, "flagged")
        self.assertFalse(meta["verified"])
        self.assertEqual(meta["rounds"], 1)
        verifier_entries = [e for e in read_journal(result) if e["role"] == "verifier"]
        self.assertEqual(verifier_entries[0]["verdict"], ERROR)

    def test_unparseable_verdict_is_error(self) -> None:
        oracle = self.make_oracle(
            step(lambda _c, _n: "an answer"),
            [step(lambda _c, _n: "I cannot decide, ran out of room")],
            step(lambda _c, _n: "final"),
            max_rounds=3,
        )
        result = oracle("Question.")

        self.assertEqual(read_metadata(result)["final_verdicts"], [ERROR])
        self.assertFalse(read_metadata(result)["verified"])

    def test_no_verifier_does_not_mark_verified(self) -> None:
        oracle = self.make_oracle(
            step(lambda _c, _n: "an answer"),
            [],
            step(lambda ctx, _n: "flagged" if "still had unresolved reviewer concerns" in ctx else "final"),
            max_rounds=1,
        )
        result = oracle("Question.")

        self.assertEqual(result.answer, "flagged")
        self.assertEqual(read_metadata(result)["final_verdicts"], [])
        self.assertFalse(read_metadata(result)["verified"])

    def test_writes_journal_and_metadata(self) -> None:
        oracle = self.make_oracle(
            step(lambda _c, _n: "a"),
            [step(lambda _c, _n: "VERDICT: PASS")],
            step(lambda _c, _n: "done"),
            max_rounds=2,
        )
        result = oracle("Q.")

        self.assertTrue((result.artifact_dir / "journal.json").exists())
        self.assertTrue((result.artifact_dir / "metadata.json").exists())
        self.assertTrue((result.artifact_dir / "answer.md").exists())

    def test_strict_raises_on_broken_verifier(self) -> None:
        oracle = self.make_oracle(
            step(lambda _c, _n: "an answer"),
            [Step(runner=broken_runner)],
            step(lambda _c, _n: "final"),
            max_rounds=3,
            strict=True,
        )
        with self.assertRaises(StrictVerificationError):
            oracle("Question.")

    def test_quiet_adjunct_changes_prompt(self) -> None:
        captured: dict[str, str] = {}

        def adj(ctx: str, _n: int) -> str:
            captured["ctx"] = ctx
            return "final"

        self.make_oracle(
            step(lambda _c, _n: "a"),
            [step(lambda _c, _n: "VERDICT: PASS")],
            Step(runner=make_runner(adj)),
            max_rounds=1,
            quiet_adjunct=True,
        )("Q.")
        self.assertIn("Be concise and direct", captured["ctx"])
        self.assertNotIn("explain why", captured["ctx"])

    def test_custom_verifier_instructions_used(self) -> None:
        captured: dict[str, str] = {}

        def verifier(ctx: str, _n: int) -> str:
            captured["ctx"] = ctx
            return "VERDICT: PASS"

        self.make_oracle(
            step(lambda _c, _n: "a"),
            [Step(runner=make_runner(verifier), instructions="CHECK ARITHMETIC ONLY")],
            step(lambda _c, _n: "done"),
            max_rounds=1,
        )("Q.")
        self.assertIn("CHECK ARITHMETIC ONLY", captured["ctx"])

    def test_default_verifier_context_checks_status_and_constraints(self) -> None:
        ctx = build_verifier_context("Prove X using route R.", "Candidate response.")

        self.assertIn("unsupported status label", ctx)
        self.assertIn("ignored forced method", ctx)
        self.assertIn("target drift", ctx)
        self.assertIn("## Candidate response", ctx)

    def test_resume_reuses_journaled_steps(self) -> None:
        gen, gen_state = make_writing_runner(lambda _c, _n: "answer", self.root / "g")
        ver, ver_state = make_writing_runner(lambda _c, _n: "VERDICT: PASS", self.root / "v")
        adj, adj_state = make_writing_runner(lambda _c, _n: "final answer", self.root / "a")
        oracle = VerifyingOracle(
            generator=Step(runner=gen),
            verifiers=[Step(runner=ver)],
            adjudicator=Step(runner=adj),
            artifact_root=self.root,
            retries=0,
            max_rounds=1,
        )
        first = oracle("Q.")
        self.assertEqual((gen_state["n"], ver_state["n"], adj_state["n"]), (1, 1, 1))

        gen2, gen2_state = make_writing_runner(lambda _c, _n: "DIFFERENT", self.root / "g2")
        ver2, ver2_state = make_writing_runner(lambda _c, _n: "VERDICT: FAIL", self.root / "v2")
        adj2, adj2_state = make_writing_runner(lambda _c, _n: "DIFFERENT", self.root / "a2")
        resumed = VerifyingOracle(
            generator=Step(runner=gen2),
            verifiers=[Step(runner=ver2)],
            adjudicator=Step(runner=adj2),
            artifact_root=self.root,
            retries=0,
            max_rounds=1,
            resume_dir=first.artifact_dir,
        )("Q.")

        # all three steps served from the journal: no new runner was invoked
        self.assertEqual((gen2_state["n"], ver2_state["n"], adj2_state["n"]), (0, 0, 0))
        self.assertEqual(resumed.answer, "final answer")

    def test_prepare_verifying_llm_input_follows_resume_journal(self) -> None:
        config = verifying_config_from_dict({"max_rounds": 1})
        resume = self.root / "resume"
        resume.mkdir()
        (resume / "prompt.md").write_text("Prove Q.", encoding="utf-8")

        prepared = prepare_verifying_llm_input("Prove Q.", config, resume_dir=resume)
        self.assertEqual(prepared.step, "generator")
        self.assertEqual(prepared.round, 0)
        self.assertEqual(prepared.prompt, "Prove Q.")

        gen_dir = self.root / "gen"
        gen_dir.mkdir()
        (gen_dir / "answer.md").write_text("Candidate proof.", encoding="utf-8")
        (resume / "journal.json").write_text(
            json.dumps([
                {"role": "generator", "round": 0, "artifact_dir": str(gen_dir)},
            ]),
            encoding="utf-8",
        )
        prepared = prepare_verifying_llm_input("Prove Q.", config, resume_dir=resume)
        self.assertEqual(prepared.step, "verifier")
        self.assertEqual(prepared.verifier_index, 0)
        self.assertIn("## Candidate response\nCandidate proof.", prepared.prompt)

        ver_dir = self.root / "ver"
        ver_dir.mkdir()
        (ver_dir / "answer.md").write_text("Looks correct.\nVERDICT: PASS", encoding="utf-8")
        (resume / "journal.json").write_text(
            json.dumps(
                [
                    {"role": "generator", "round": 0, "artifact_dir": str(gen_dir)},
                    {
                        "role": "verifier",
                        "round": 0,
                        "index": 0,
                        "artifact_dir": str(ver_dir),
                        "verdict": "PASS",
                    },
                ],
            ),
            encoding="utf-8",
        )
        prepared = prepare_verifying_llm_input("Prove Q.", config, resume_dir=resume)
        self.assertEqual(prepared.step, "adjudicator")
        self.assertIn("passed all reviewer checks", prepared.prompt)

        adj_dir = self.root / "adj"
        adj_dir.mkdir()
        (adj_dir / "answer.md").write_text("Final.", encoding="utf-8")
        (resume / "journal.json").write_text(
            json.dumps(
                [
                    {"role": "generator", "round": 0, "artifact_dir": str(gen_dir)},
                    {
                        "role": "verifier",
                        "round": 0,
                        "index": 0,
                        "artifact_dir": str(ver_dir),
                        "verdict": "PASS",
                    },
                    {"role": "adjudicator", "artifact_dir": str(adj_dir)},
                ],
            ),
            encoding="utf-8",
        )
        prepared = prepare_verifying_llm_input("Prove Q.", config, resume_dir=resume)
        self.assertTrue(prepared.complete)
        self.assertEqual(prepared.step, "complete")


class VerifyingConfigTests(unittest.TestCase):
    def test_from_dict_defaults(self) -> None:
        config = verifying_config_from_dict({})
        self.assertEqual(len(config.verifiers), 1)
        self.assertEqual(config.max_rounds, 3)
        self.assertFalse(config.strict)

    def test_from_dict_custom_verifiers(self) -> None:
        config = verifying_config_from_dict(
            {
                "max_rounds": 5,
                "strict": True,
                "verifiers": [
                    {"backend": "codex", "instructions": "logic"},
                    {"backend": "script", "command": "python3 check.py"},
                ],
            }
        )
        self.assertEqual(config.max_rounds, 5)
        self.assertTrue(config.strict)
        self.assertEqual(config.verifiers[0].instructions, "logic")
        self.assertEqual(config.verifiers[1].command, "python3 check.py")

    def test_builtin_strict_profile(self) -> None:
        self.assertTrue(builtin_profile("strict").strict)
        self.assertFalse(builtin_profile("default").strict)

    def test_unknown_profile_raises(self) -> None:
        with self.assertRaises(ValueError):
            builtin_profile("nonexistent")


class MechanicalFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_problems(self) -> None:
        self.assertEqual(mechanical_draft_problems("   "), ["empty draft"])
        self.assertIn(
            'shortcut phrase: "it can be shown"',
            mechanical_draft_problems("It can be shown that the claim holds."),
        )
        self.assertIn(
            "truncated draft (unbalanced code fence)",
            mechanical_draft_problems("proof:\n```python\nx = 1\n"),
        )
        self.assertEqual(mechanical_draft_problems("A complete honest proof of the claim."), [])

    def test_bad_draft_skips_verifiers_and_loops_back(self) -> None:
        verifier_calls = {"n": 0}

        def verifier(ctx: str, _n: int) -> str:
            verifier_calls["n"] += 1
            return "ok\nVERDICT: PASS"

        oracle = VerifyingOracle(
            generator=step(
                lambda ctx, _n: "A full direct proof."
                if "mechanical pre-filter" in ctx
                else "It can be shown that the result follows."
            ),
            verifiers=[step(verifier)],
            adjudicator=step(lambda ctx, _n: "final"),
            artifact_root=self.root,
            retries=0,
        )
        result = oracle("Prove P.")
        metadata = read_metadata(result)
        self.assertTrue(metadata["verified"])
        self.assertEqual(verifier_calls["n"], 1)  # round one cost no verifier spend
        roles = [entry["role"] for entry in read_journal(result)]
        self.assertIn("mechanical_filter", roles)

    def test_always_bad_draft_is_not_verified(self) -> None:
        oracle = VerifyingOracle(
            generator=step(lambda ctx, _n: "Details omitted."),
            verifiers=[step(lambda ctx, _n: "ok\nVERDICT: PASS")],
            adjudicator=step(lambda ctx, _n: "final"),
            artifact_root=self.root,
            max_rounds=2,
            retries=0,
        )
        result = oracle("Prove P.")
        metadata = read_metadata(result)
        self.assertFalse(metadata["verified"])
        self.assertEqual(metadata["final_verdicts"], [MECHANICAL_FAIL])


if __name__ == "__main__":
    unittest.main()

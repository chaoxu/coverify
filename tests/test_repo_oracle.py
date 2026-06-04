from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from coverify.engine.backend import BackendResult, run_script_backend
from coverify.engine.verifying import Verdict
from coverify.integration.repo_oracle import (
    PROMPT_CONTEXT_DIGEST,
    PROMPT_CONTRACT_RESOLUTION,
    VERIFICATION_ERROR,
    VERIFICATION_FAILED,
    VERIFICATION_PASSED,
    build_gatherer_prompt,
    build_reasoner_prompt,
    build_verifier_prompt,
    gather_context,
    load_source_bundle,
    prepare_repo_oracle_llm_input,
    run_repo_oracle,
    verification_from_metadata,
)
from coverify.math_contract import RESOLUTION_OUTPUT_TYPE_LIST


def write_script(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)
    return path


ANSWER_SCRIPT = """#!/usr/bin/env python3
import sys

prompt = sys.stdin.read()
if "reserve-overlap.md" not in prompt or "switch-credit.md" not in prompt:
    raise SystemExit("missing source context")
print(
    "From `reserve-overlap.md:1` and `switch-credit.md:1`, each overlap debt "
    "unit is paired with an owned reserve credit. Therefore summing the signed "
    "credits cancels every overlap debt term, so the branch proves the new "
    "reserve-overlap closure claim: total uncovered overlap debt is zero."
)
"""


VERIFIER_SCRIPT = """#!/usr/bin/env python3
import sys

prompt = sys.stdin.read()
ok = (
    "reserve-overlap closure" in prompt
    and "total uncovered overlap debt is zero" in prompt
    and "owned reserve credit" in prompt
    and "reserve-overlap.md" in prompt
    and "switch-credit.md" in prompt
)
if ok:
    print("The candidate is supported by the injected repo snapshot.\\nVERDICT: PASS")
else:
    print("The candidate is not supported by the injected repo snapshot.\\nVERDICT: FAIL")
"""


PASS_VERIFIER_SCRIPT = """#!/usr/bin/env python3
print("Candidate accepted for this test.\\nVERDICT: PASS")
"""


GATHERER_SCRIPT = """#!/usr/bin/env python3
import json

print(json.dumps({
    "passages": [
        {
            "path": "project-status.md",
            "line_start": 73,
            "line_end": 84,
            "purpose": "canonical problem table and active fronts",
        }
    ],
    "notes": ["select canonical project ledger"]
}))
"""


class RepoOracleTests(unittest.TestCase):
    def test_source_bundle_uses_tracked_files_when_given_git_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            subprocess.run(["git", "init"], cwd=root, check=True, stdout=subprocess.PIPE)
            (root / "tracked.md").write_text("tracked reserve fact", encoding="utf-8")
            (root / "untracked.md").write_text("must not leak", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.md"], cwd=root, check=True)

            bundle = load_source_bundle(root)

        self.assertEqual([file.path for file in bundle.files], ["tracked.md"])
        self.assertNotIn("untracked", bundle.snapshot)

    def test_gather_context_selects_relevant_files_without_injecting_everything(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "reserve.md").write_text("Reserve credits cancel overlap debt.", encoding="utf-8")
            (root / "unrelated.md").write_text("Banana color notes.", encoding="utf-8")
            bundle = load_source_bundle(root)

            gathered = gather_context(
                bundle,
                question="Why does reserve overlap debt cancel?",
                max_context_chars=1_000,
            )

        self.assertEqual([snippet.path for snippet in gathered.snippets], ["reserve.md"])
        self.assertEqual(gathered.tier, "light")

    def test_prepare_repo_oracle_llm_input_stops_at_gatherer_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "reserve.md").write_text("Reserve credits cancel overlap debt.", encoding="utf-8")
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Why does reserve overlap debt cancel?",
                gatherer_configured=True,
            )

        self.assertEqual(prepared.step, "gatherer")
        self.assertIn("# Coverify Repo-Snapshot Gatherer", prepared.prompt)
        self.assertFalse(prepared.selected_snippets_known)
        self.assertEqual(prepared.sources, [])

    def test_prepare_repo_oracle_llm_input_builds_deterministic_answer_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "reserve.md").write_text("Reserve credits cancel overlap debt.", encoding="utf-8")
            (root / "unrelated.md").write_text("Banana color notes.", encoding="utf-8")
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Why does reserve overlap debt cancel?",
            )

        self.assertEqual(prepared.step, "answer")
        self.assertIn("# Coverify Repo-Snapshot Exploratory Response", prepared.prompt)
        self.assertIn("Do not hard-wrap normal prose paragraphs", prepared.prompt)
        self.assertTrue(prepared.selected_snippets_known)
        self.assertEqual([source["path"] for source in prepared.sources], ["reserve.md"])

    def test_prepare_repo_oracle_llm_input_can_build_resolution_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "certificate.md").write_text(
                "Target: prove a checkable local certificate.\n\nRequired output: CERTIFICATE.",
                encoding="utf-8",
            )
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Produce exactly one certificate artifact.",
                prompt_contract=PROMPT_CONTRACT_RESOLUTION,
            )

        self.assertEqual(prepared.prompt_contract, PROMPT_CONTRACT_RESOLUTION)
        self.assertIn("# Coverify Repo-Snapshot Mathematical Resolution", prepared.prompt)
        self.assertIn("Produce one strict mathematical-resolution artifact", prepared.prompt)
        self.assertIn("Give one artifact, not multiple alternate routes.", prepared.prompt)
        self.assertNotIn("Produce an exploratory response", prepared.prompt)
        self.assertEqual(prepared.prompt_audit["prompt_contract"], PROMPT_CONTRACT_RESOLUTION)
        self.assertEqual(prepared.to_json()["prompt_contract"], PROMPT_CONTRACT_RESOLUTION)

    def test_prompt_audit_flags_exploratory_contract_for_exact_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "certificate.md").write_text("Local certificate target.", encoding="utf-8")
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Produce exactly one verifier-ready certificate.",
            )

        issue_codes = {issue["code"] for issue in prepared.prompt_audit["issues"]}
        self.assertIn("weak_contract_for_exact_target", issue_codes)
        self.assertIn("exploratory_contract_allows_broad_answer", issue_codes)

    def test_resolution_prompt_omits_low_value_operational_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "PROJECT.md").write_text("Certificate target and exact inequality.", encoding="utf-8")
            (root / "AGENTS.md").write_text("Agent guidance for this certificate workspace.", encoding="utf-8")
            (root / "README.md").write_text("Certificate workspace.", encoding="utf-8")
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Produce exactly one verifier-ready certificate.",
                prompt_contract=PROMPT_CONTRACT_RESOLUTION,
            )

        self.assertEqual([source["path"] for source in prepared.sources], ["PROJECT.md"])
        self.assertNotIn("Agent guidance", prepared.prompt)
        self.assertIn("Prompt context omitted source", "\n".join(prepared.warnings))

    def test_resolution_digest_prompt_uses_project_prompt_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "COVERIFY_PROMPT.md").write_text(
                "\n".join(
                    [
                        "---",
                        "coverify_prompt_profile: true",
                        "---",
                        "# Prompt Profile",
                        "",
                        "Ask for one local certificate artifact and rank exact finite inequalities over broad plans.",
                        "",
                        "Required output fields: TARGET_CONSTANT, FINITE_INEQUALITY, VERIFICATION_TARGET.",
                    ],
                ),
                encoding="utf-8",
            )
            (root / "PROJECT.md").write_text(
                "\n".join(
                    [
                        "# Project",
                        "",
                        "This project has a local certificate target.",
                        "",
                        *[f"Unimportant filler {index}" for index in range(120)],
                        "",
                        "The exact target inequality is $R \\le L/c$.",
                        "The verifier domain is $a,b,p,q>0$ and $h\\ge0$.",
                    ],
                ),
                encoding="utf-8",
            )
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Produce exactly one verifier-ready certificate.",
                prompt_contract=PROMPT_CONTRACT_RESOLUTION,
                prompt_context=PROMPT_CONTEXT_DIGEST,
            )

        self.assertEqual(prepared.prompt_profile_path, "COVERIFY_PROMPT.md")
        self.assertEqual(prepared.prompt_context, PROMPT_CONTEXT_DIGEST)
        self.assertIn("## Project prompt profile", prepared.prompt)
        self.assertIn("rank exact finite inequalities over broad plans", prepared.prompt)
        self.assertIn("## Allowed context digest", prepared.prompt)
        self.assertIn("The exact target inequality is $R \\le L/c$.", prepared.prompt)
        self.assertNotIn("Unimportant filler 1", prepared.prompt)
        self.assertNotIn("COVERIFY_PROMPT.md:1", prepared.prompt)
        self.assertEqual([source["path"] for source in prepared.sources], ["PROJECT.md"])

    def test_resolution_prompt_treats_project_research_loop_as_executable_skill(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "PROJECT.md").write_text(
                "\n".join(
                    [
                        "# Project",
                        "",
                        "This project has a local certificate target.",
                        "",
                        "## Research Loop",
                        "",
                        "This loop is the project-local research skill for the run.",
                        "",
                        "1. Read the accepted certificate state.",
                        "2. Produce one checkable artifact.",
                        "3. Verify or falsify it.",
                        "4. Write a compact durable update that changes the next run.",
                        "",
                        "## Background",
                        "",
                        "Do not include this paragraph in the loop block.",
                    ],
                ),
                encoding="utf-8",
            )
            bundle = load_source_bundle(root)

            prepared = prepare_repo_oracle_llm_input(
                bundle=bundle,
                question="Produce exactly one verifier-ready certificate.",
                prompt_contract=PROMPT_CONTRACT_RESOLUTION,
                prompt_context=PROMPT_CONTEXT_DIGEST,
            )

        self.assertEqual(prepared.project_research_loop_path, "PROJECT.md")
        self.assertEqual(prepared.prompt_audit["project_research_loop_path"], "PROJECT.md")
        self.assertIn("## Project research loop", prepared.prompt)
        self.assertIn("project-local research skill", prepared.prompt)
        self.assertIn("Write a compact durable update", prepared.prompt)
        self.assertIn("Follow the project research loop", prepared.prompt)

    def test_short_source_file_is_not_cut_mid_paragraph(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "local.md").write_text(
                "\n".join(
                    [
                        "# Local Setup",
                        "",
                        *[f"Filler line {index}" for index in range(70)],
                        "The selected paragraph starts here and should be kept",
                        "with its continuation instead of being cut.",
                        "",
                        "## Desired Discovery",
                        "",
                        "The final section should remain available for small files.",
                    ],
                ),
                encoding="utf-8",
            )
            bundle = load_source_bundle(root)

            gathered = gather_context(bundle, question="What is the selected paragraph?")

        self.assertEqual(gathered.snippets[0].line_start, 1)
        self.assertEqual(gathered.snippets[0].line_end, 78)
        self.assertIn("Desired Discovery", gathered.snippets[0].text)

    def test_verifier_prompt_rejects_hard_wrapped_prose(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "reserve.md").write_text("Reserve credits cancel overlap debt.", encoding="utf-8")
            bundle = load_source_bundle(root)
            gathered = gather_context(
                bundle,
                question="Why does reserve overlap debt cancel?",
            )

        prompt = build_verifier_prompt(
            question="Why does reserve overlap debt cancel?",
            thread_context="",
            bundle=bundle,
            gathered=gathered,
            candidate="Reserve credits cancel overlap debt.",
        )

        self.assertIn("hard-wrap normal prose paragraphs", prompt)

    def test_gather_context_uses_best_window_not_first_generic_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "project-status.md").write_text(
                "\n".join(
                    [
                        "---",
                        "id: project-status",
                        "title: Project Status",
                        "status: accepted",
                        "---",
                        "# Project Status",
                        "",
                        "This file is the canonical current project status page.",
                        "",
                        *[f"Filler line {i}" for i in range(50)],
                        "## Current Problem Table",
                        "",
                        "| Problem | Current status | Next check |",
                        "| --- | --- | --- |",
                        "| Termination monovariant | route selected | check both operations |",
                        "",
                        "## Active Fronts",
                        "",
                        "- formalize construction cases.",
                    ],
                ),
                encoding="utf-8",
            )
            bundle = load_source_bundle(root)

            gathered = gather_context(
                bundle,
                question=(
                    "What does the Current Problem Table say about the "
                    "termination monovariant, and what are the Active Fronts?"
                ),
                max_context_chars=4_000,
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertIn("Current Problem Table", gathered.snippets[0].text)
        self.assertIn("Termination monovariant", gathered.snippets[0].text)

    def test_llm_gatherer_plan_selects_requested_sections(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "project-status.md").write_text(
                "\n".join(
                    [
                        "# Project Status",
                        "",
                        "Introductory current status line.",
                        "",
                        *[f"Filler line {i}" for i in range(70)],
                        "## Current Problem Table",
                        "",
                        "| Problem | Current status | Next check |",
                        "| --- | --- | --- |",
                        "| Termination monovariant | route selected | check both operations |",
                        "",
                        "## Active Fronts",
                        "",
                        "- formalize construction cases.",
                    ],
                ),
                encoding="utf-8",
            )
            (root / "misc.md").write_text("Miscellaneous notes.", encoding="utf-8")
            gatherer_script = write_script(Path(tmpdir) / "gather.py", GATHERER_SCRIPT)
            bundle = load_source_bundle(root, source_id="seeded:gather")

            gathered = gather_context(
                bundle,
                question="What is the current status and future work?",
                gatherer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {gatherer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertEqual(gathered.gatherer_provider, "script")
        self.assertEqual({snippet.path for snippet in gathered.snippets}, {"project-status.md"})
        combined = "\n".join(snippet.text for snippet in gathered.snippets)
        self.assertIn("Current Problem Table", combined)
        self.assertIn("Active Fronts", combined)
        self.assertIn("Termination monovariant", combined)

    def test_gatherer_prompt_invites_agentic_source_bundle_inspection(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "ledger.md").write_text("# Ledger\n\n## Current Problem Table\n", encoding="utf-8")
            bundle = load_source_bundle(root, source_id="seeded:prompt")

            prompt = build_gatherer_prompt(
                question="What is the status?",
                thread_context="",
                bundle=bundle,
            )

        self.assertIn(f"- root: {bundle.root}", prompt)
        self.assertIn("inspect files inside that directory directly", prompt)
        self.assertIn("mathematical-resolution target", prompt)
        self.assertIn("forced method constraints", prompt)
        self.assertIn('"passages"', prompt)
        self.assertIn('"line_start"', prompt)
        self.assertNotIn('"requests"', prompt)

    def test_repo_oracle_prompts_use_exploratory_response_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "lemma.md").write_text("Local lemma: A implies B.", encoding="utf-8")
            bundle = load_source_bundle(root, source_id="seeded:contract")
            gathered = gather_context(bundle, question="Can we prove B from A?")

            reasoner_prompt = build_reasoner_prompt(
                question="Can we prove B from A?",
                thread_context="",
                bundle=bundle,
                gathered=gathered,
            )
            verifier_prompt = build_verifier_prompt(
                question="Can we prove B from A?",
                thread_context="",
                bundle=bundle,
                gathered=gathered,
                candidate="A candidate response.",
            )

        self.assertIn("Repo-Snapshot Exploratory Response", reasoner_prompt)
        self.assertIn("mathematical-resolution targets", reasoner_prompt)
        self.assertIn("do not silently run mathematical resolution", reasoner_prompt)
        self.assertIn(RESOLUTION_OUTPUT_TYPE_LIST, reasoner_prompt)
        self.assertIn("any stronger status than", reasoner_prompt)
        self.assertIn("the evidence supports", reasoner_prompt)
        self.assertIn("exploratory-response contract", verifier_prompt)
        self.assertIn("construction attempt", verifier_prompt)
        self.assertIn(RESOLUTION_OUTPUT_TYPE_LIST, verifier_prompt)
        self.assertIn("required a particular theorem", verifier_prompt)

    def test_gatherer_passage_ranges_are_extracted_exactly(self) -> None:
        script = """#!/usr/bin/env python3
import json

print(json.dumps({
    "passages": [
        {
            "path": "ledger.md",
            "line_start": 4,
            "line_end": 6,
            "purpose": "selected exact range",
        }
    ]
}))
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "ledger.md").write_text(
                "\n".join(["line 1", "line 2", "line 3", "target a", "target b", "target c", "line 7"]),
                encoding="utf-8",
            )
            gatherer_script = write_script(Path(tmpdir) / "gather.py", script)
            bundle = load_source_bundle(root, source_id="seeded:passages")

            gathered = gather_context(
                bundle,
                question="What is the target?",
                gatherer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {gatherer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertEqual(gathered.snippets[0].line_start, 4)
        self.assertEqual(gathered.snippets[0].line_end, 6)
        self.assertEqual(gathered.snippets[0].text, "target a\ntarget b\ntarget c")
        self.assertEqual(gathered.gatherer_plan["passages"][0]["purpose"], "selected exact range")

    def test_llm_gatherer_exact_heading_query_beats_generic_frontmatter(self) -> None:
        script = """#!/usr/bin/env python3
import json

print(json.dumps({
    "requests": [
        {
            "path": "construction-notes.md",
            "queries": ["Canonical Distinct Pair Sum Construction"],
        }
    ]
}))
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "construction-notes.md").write_text(
                "\n".join(
                    [
                        "# Construction Notes",
                        "",
                        "This overview mentions several construction templates.",
                        "",
                        *[f"Intro construction filler {i}" for i in range(60)],
                        "## Canonical Distinct Pair Sum Construction",
                        "",
                        "The residue-class construction is the required source.",
                    ],
                ),
                encoding="utf-8",
            )
            gatherer_script = write_script(Path(tmpdir) / "gather.py", script)
            bundle = load_source_bundle(root, source_id="seeded:construction")

            gathered = gather_context(
                bundle,
                question="Explain the distinct pair sum construction.",
                gatherer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {gatherer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertIn("Canonical Distinct Pair Sum Construction", gathered.snippets[0].text)
        self.assertIn("residue-class construction is the required source", gathered.snippets[0].text)

    def test_llm_gatherer_overlapping_section_queries_are_merged(self) -> None:
        script = """#!/usr/bin/env python3
import json

print(json.dumps({
    "requests": [
        {
            "path": "combinatorics-routes.md",
            "queries": ["Termination Monovariant Route", "Distinct Pair Sums Construction"],
        }
    ]
}))
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "combinatorics-routes.md").write_text(
                "\n".join(
                    [
                        "# Combinatorics Routes",
                        "## Termination Monovariant Route",
                        "The route checks both replacement operations.",
                        *[f"Filler line {i}" for i in range(50)],
                        "## Distinct Pair Sums Construction",
                        "The construction is split by residue classes modulo 5.",
                    ],
                ),
                encoding="utf-8",
            )
            gatherer_script = write_script(Path(tmpdir) / "gather.py", script)
            bundle = load_source_bundle(root, source_id="seeded:overlap")

            gathered = gather_context(
                bundle,
                question="What are the termination and pair-sum routes?",
                gatherer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {gatherer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertIn("checks both replacement operations", gathered.snippets[0].text)
        self.assertIn("residue classes modulo 5", gathered.snippets[0].text)

    def test_proof_requests_are_strong_even_when_wording_is_simple(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "lemma.md").write_text("A implies B.", encoding="utf-8")
            bundle = load_source_bundle(root)

            gathered = gather_context(bundle, question="Prove the branch lemma.")

        self.assertEqual(gathered.tier, "strong")

    def test_repo_oracle_generates_and_verifies_new_math_from_seeded_docs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "reserve-overlap.md").write_text(
                "\n".join(
                    [
                        "# Reserve overlap invariant",
                        "",
                        "Every overlap debt unit is assigned to exactly one reserve owner.",
                        "A debt unit is uncovered iff it has no owned reserve credit.",
                    ],
                ),
                encoding="utf-8",
            )
            (root / "switch-credit.md").write_text(
                "\n".join(
                    [
                        "# Switch credit rule",
                        "",
                        "For each assigned overlap debt unit, the owning switch contributes",
                        "one signed reserve credit that cancels that unit in the total debt sum.",
                    ],
                ),
                encoding="utf-8",
            )
            answer_script = write_script(Path(tmpdir) / "answer.py", ANSWER_SCRIPT)
            verifier_script = write_script(Path(tmpdir) / "verify.py", VERIFIER_SCRIPT)
            bundle = load_source_bundle(root, source_id="seeded:reserve-overlap")
            run_root = Path(tmpdir) / "runs"

            result = run_repo_oracle(
                bundle=bundle,
                question="Prove the reserve-overlap closure lemma.",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {answer_script}",
                    artifact_root=run_root,
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {verifier_script}",
                    artifact_root=run_root,
                ),
            )

        self.assertTrue(result.ok)
        self.assertEqual(result.verification, VERIFICATION_PASSED)
        self.assertEqual(result.tier, "strong")
        self.assertIn("new reserve-overlap closure claim", result.answer)
        self.assertEqual(
            [source["path"] for source in result.sources],
            ["reserve-overlap.md", "switch-credit.md"],
        )

    def test_repo_oracle_normalizes_citations_to_gathered_snippet_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "facts.md").write_text(
                "Header\n\nLocal fact A is accepted.\n",
                encoding="utf-8",
            )
            answer_script = write_script(
                Path(tmpdir) / "answer.py",
                "#!/usr/bin/env python3\nprint('Local fact A is accepted (`facts.md:3`).')\n",
            )
            verifier_script = write_script(Path(tmpdir) / "verify.py", PASS_VERIFIER_SCRIPT)

            result = run_repo_oracle(
                bundle=load_source_bundle(root),
                question="What is local fact A?",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {answer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {verifier_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
        )

        self.assertTrue(result.ok)
        self.assertIn("facts.md#L1-3", result.answer)
        self.assertNotIn("`facts.md", result.answer)
        self.assertTrue(any("Normalized citation" in warning for warning in result.warnings))
        self.assertTrue(any("Unwrapped code-formatted source ref" in warning for warning in result.warnings))

    def test_repo_oracle_normalizes_hash_line_citations(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "facts.md").write_text(
                "Header\n\nLocal fact A is accepted.\n",
                encoding="utf-8",
            )
            answer_script = write_script(
                Path(tmpdir) / "answer.py",
                "#!/usr/bin/env python3\nprint('Local fact A is accepted (facts.md#L3).')\n",
            )
            verifier_script = write_script(Path(tmpdir) / "verify.py", PASS_VERIFIER_SCRIPT)

            result = run_repo_oracle(
                bundle=load_source_bundle(root),
                question="What is local fact A?",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {answer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {verifier_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertTrue(result.ok)
        self.assertIn("facts.md#L1-3", result.answer)

    def test_repo_oracle_preserves_already_normalized_markdown_source_links(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "facts.md").write_text(
                "Header\n\nLocal fact A is accepted.\n",
                encoding="utf-8",
            )
            answer_script = write_script(
                Path(tmpdir) / "answer.py",
                "#!/usr/bin/env python3\nprint('See [facts.md#L1-3](facts.md#L1-3).')\n",
            )
            verifier_script = write_script(Path(tmpdir) / "verify.py", PASS_VERIFIER_SCRIPT)

            result = run_repo_oracle(
                bundle=load_source_bundle(root),
                question="What is local fact A?",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {answer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {verifier_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertTrue(result.ok)
        self.assertIn("See [facts.md#L1-3](facts.md#L1-3).", result.answer)
        self.assertNotIn("[[facts.md", result.answer)
        self.assertFalse(any("Normalized citation" in warning for warning in result.warnings))

    def test_repo_oracle_rejects_source_refs_hidden_inside_markdown_links(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "facts.md").write_text(
                "Header\n\nLocal fact A is accepted.\n",
                encoding="utf-8",
            )
            answer_script = write_script(
                Path(tmpdir) / "answer.py",
                "#!/usr/bin/env python3\nprint('See [facts.md#L99 details](https://example.test) and [details](facts.md#L99?x=1).')\n",
            )
            verifier_script = write_script(Path(tmpdir) / "verify.py", PASS_VERIFIER_SCRIPT)

            result = run_repo_oracle(
                bundle=load_source_bundle(root),
                question="What is local fact A?",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {answer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {verifier_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertFalse(result.ok)
        self.assertEqual(result.verification, VERIFICATION_FAILED)
        self.assertTrue(any("Invalid citation link" in warning for warning in result.warnings))

    def test_repo_oracle_rejects_citations_outside_gathered_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "facts.md").write_text("Local fact A is accepted.\n", encoding="utf-8")
            answer_script = write_script(
                Path(tmpdir) / "answer.py",
                "#!/usr/bin/env python3\nprint('Unsupported line citation (`facts.md:99`).')\n",
            )
            verifier_script = write_script(Path(tmpdir) / "verify.py", PASS_VERIFIER_SCRIPT)

            result = run_repo_oracle(
                bundle=load_source_bundle(root),
                question="What is local fact A?",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {answer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {verifier_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertFalse(result.ok)
        self.assertEqual(result.verification, VERIFICATION_FAILED)
        self.assertIn("Invalid citation", result.answer)

    def test_repo_oracle_returns_refusal_when_verifier_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "facts.md").write_text("Only local fact A is known.", encoding="utf-8")
            bad_answer = write_script(
                Path(tmpdir) / "bad_answer.py",
                "#!/usr/bin/env python3\nprint('The repo proves unsupported fact B.')\n",
            )
            fail_verify = write_script(
                Path(tmpdir) / "fail_verify.py",
                "#!/usr/bin/env python3\nprint('Fact B is not in the supplied source.\\nVERDICT: FAIL')\n",
            )

            result = run_repo_oracle(
                bundle=load_source_bundle(root),
                question="What follows?",
                answer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {bad_answer}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
                verifier_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {fail_verify}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertFalse(result.ok)
        self.assertEqual(result.verification, VERIFICATION_FAILED)
        self.assertIn("could not confidently verify", result.answer)

    def test_verifying_metadata_error_verdict_maps_to_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_dir = Path(tmpdir)
            (artifact_dir / "metadata.json").write_text(
                json.dumps(
                    {
                        "provider": "verifying",
                        "verified": False,
                        "final_verdicts": ["ERROR"],
                    },
                ),
                encoding="utf-8",
            )
            result = BackendResult(
                answer="Unverified answer.",
                artifact_dir=artifact_dir,
                provider="verifying",
                oracle_call_id="verifying-test",
            )

            self.assertEqual(verification_from_metadata(result), VERIFICATION_ERROR)

    def test_verifying_metadata_without_verdicts_maps_to_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_dir = Path(tmpdir)
            (artifact_dir / "metadata.json").write_text(
                json.dumps(
                    {
                        "provider": "verifying",
                        "verified": False,
                        "final_verdicts": [],
                    },
                ),
                encoding="utf-8",
            )
            result = BackendResult(
                answer="Unchecked answer.",
                artifact_dir=artifact_dir,
                provider="verifying",
                oracle_call_id="verifying-test",
            )

            self.assertEqual(verification_from_metadata(result), VERIFICATION_ERROR)

    def test_verifying_metadata_false_overrides_pass_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_dir = Path(tmpdir)
            (artifact_dir / "metadata.json").write_text(
                json.dumps(
                    {
                        "provider": "verifying",
                        "verified": False,
                        "final_verdicts": [Verdict.PASS.value],
                    },
                ),
                encoding="utf-8",
            )
            result = BackendResult(
                answer="Contradictory metadata answer.",
                artifact_dir=artifact_dir,
                provider="verifying",
                oracle_call_id="verifying-test",
            )

            self.assertEqual(verification_from_metadata(result), VERIFICATION_ERROR)

    def test_repo_oracle_cli_emits_json_for_other_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "reserve-overlap.md").write_text("Every overlap debt has an owned reserve credit.", encoding="utf-8")
            (root / "switch-credit.md").write_text("Owned reserve credits cancel overlap debt terms.", encoding="utf-8")
            answer_script = write_script(Path(tmpdir) / "answer.py", ANSWER_SCRIPT)
            verifier_script = write_script(Path(tmpdir) / "verify.py", VERIFIER_SCRIPT)
            parser_cmd = [
                sys.executable,
                "-m",
                "coverify",
                "repo-oracle",
                "ask",
                "--source-bundle",
                str(root),
                "--source-id",
                "cli-smoke",
                "--backend",
                "script",
                "--backend-command",
                f"{sys.executable} {answer_script}",
                "--verifier-backend",
                "script",
                "--verifier-command",
                f"{sys.executable} {verifier_script}",
                "--run-dir",
                str(Path(tmpdir) / "runs"),
                "--json",
                "--message",
                "Prove the reserve-overlap closure lemma.",
            ]
            completed = subprocess.run(
                parser_cmd,
                check=True,
                cwd=Path(__file__).resolve().parents[1],
                env={**os.environ, "PYTHONPATH": "src"},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            payload = json.loads(completed.stdout)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["verification"], VERIFICATION_PASSED)
        self.assertEqual(payload["source_id"], "cli-smoke")
        self.assertEqual(payload["tier"], "strong")


if __name__ == "__main__":
    unittest.main()

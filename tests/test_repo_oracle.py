from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from coverify.engine.backend import run_script_backend
from coverify.integration.repo_oracle import (
    build_gatherer_prompt,
    chat_issue_body,
    gather_context,
    load_source_bundle,
    parse_chat_metadata,
    run_repo_oracle,
    strip_chat_metadata,
)


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
            "path": "poa-bound-summary.md",
            "line_start": 73,
            "line_end": 84,
            "purpose": "canonical status table and active fronts",
        }
    ],
    "notes": ["select canonical status ledger"]
}))
"""


class RepoOracleTests(unittest.TestCase):
    def test_chat_metadata_round_trips_and_strips_from_visible_body(self) -> None:
        body = chat_issue_body("Prove the reserve lemma.", branch="agent/reserve")

        self.assertEqual(parse_chat_metadata(body)["branch"], "agent/reserve")
        self.assertEqual(strip_chat_metadata(body), "Prove the reserve lemma.")

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

    def test_gather_context_uses_best_window_not_first_generic_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "poa-bound-summary.md").write_text(
                "\n".join(
                    [
                        "---",
                        "id: poa-bound-summary",
                        "title: PoA Bound Summary",
                        "status: accepted",
                        "---",
                        "# PoA Bound Summary",
                        "",
                        "This file is the canonical current project status page.",
                        "",
                        *[f"Filler line {i}" for i in range(50)],
                        "## Current Working Bound Table",
                        "",
                        "| Problem | Workspace lower bound | Workspace upper bound | Current status |",
                        "| --- | ---: | ---: | --- |",
                        "| Directed TTSP with arbitrary terminal pairs | at least $5/3$ | $5/2$ | current target barrier |",
                        "",
                        "## Active Fronts",
                        "",
                        "- improve the lower bound beyond $5/3$.",
                    ],
                ),
                encoding="utf-8",
            )
            bundle = load_source_bundle(root)

            gathered = gather_context(
                bundle,
                question="What is the current status, what is successful, and what can we work on in the future?",
                max_context_chars=4_000,
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertIn("Current Working Bound Table", gathered.snippets[0].text)
        self.assertIn("at least $5/3$", gathered.snippets[0].text)

    def test_llm_gatherer_plan_selects_requested_sections(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "poa-bound-summary.md").write_text(
                "\n".join(
                    [
                        "# PoA Bound Summary",
                        "",
                        "Introductory current status line.",
                        "",
                        *[f"Filler line {i}" for i in range(70)],
                        "## Current Working Bound Table",
                        "",
                        "| Problem | Workspace lower bound | Workspace upper bound | Current status |",
                        "| --- | ---: | ---: | --- |",
                        "| Directed TTSP with arbitrary terminal pairs | at least $5/3$ | $5/2$ | current target barrier |",
                        "",
                        "## Active Fronts",
                        "",
                        "- improve the lower bound beyond $5/3$.",
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
        self.assertEqual({snippet.path for snippet in gathered.snippets}, {"poa-bound-summary.md"})
        combined = "\n".join(snippet.text for snippet in gathered.snippets)
        self.assertIn("Current Working Bound Table", combined)
        self.assertIn("Active Fronts", combined)
        self.assertIn("at least $5/3$", combined)

    def test_gatherer_prompt_invites_agentic_source_bundle_inspection(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "ledger.md").write_text("# Ledger\n\n## Current Working Bound Table\n", encoding="utf-8")
            bundle = load_source_bundle(root, source_id="seeded:prompt")

            prompt = build_gatherer_prompt(
                question="What is the status?",
                thread_context="",
                bundle=bundle,
            )

        self.assertIn(f"- root: {bundle.root}", prompt)
        self.assertIn("inspect files inside that directory directly", prompt)
        self.assertIn('"passages"', prompt)
        self.assertIn('"line_start"', prompt)
        self.assertNotIn('"requests"', prompt)

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
            "path": "undirected-sp-underlay.md",
            "queries": ["Canonical 15/7 Diamond Lower Bound"],
        }
    ]
}))
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "undirected-sp-underlay.md").write_text(
                "\n".join(
                    [
                        "# Undirected SP-Underlay PoA Notes",
                        "",
                        "This overview mentions lower bounds and underlay models.",
                        "",
                        *[f"Intro lower-bound filler {i}" for i in range(60)],
                        "## Canonical 15/7 Diamond Lower Bound",
                        "",
                        "The diamond construction is the required arbitrary-terminal source.",
                    ],
                ),
                encoding="utf-8",
            )
            gatherer_script = write_script(Path(tmpdir) / "gather.py", script)
            bundle = load_source_bundle(root, source_id="seeded:diamond")

            gathered = gather_context(
                bundle,
                question="Explain the 15/7 diamond lower bound.",
                gatherer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {gatherer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertIn("Canonical 15/7 Diamond Lower Bound", gathered.snippets[0].text)
        self.assertIn("diamond construction is the required arbitrary-terminal source", gathered.snippets[0].text)

    def test_llm_gatherer_overlapping_section_queries_are_merged(self) -> None:
        script = """#!/usr/bin/env python3
import json

print(json.dumps({
    "requests": [
        {
            "path": "directed-ttsp.md",
            "queries": ["Symmetric Directed TTSP Bounds", "Internal-Terminal 4/3 Example"],
        }
    ]
}))
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "source"
            root.mkdir()
            (root / "directed-ttsp.md").write_text(
                "\n".join(
                    [
                        "# Directed TTSP",
                        "## Symmetric Directed TTSP Bounds",
                        "The accepted symmetric lower bound is 27/19.",
                        *[f"Filler line {i}" for i in range(50)],
                        "## Internal-Terminal 4/3 Example",
                        "This example is not the best lower bound for the broad arbitrary-terminal directed TTSP row.",
                    ],
                ),
                encoding="utf-8",
            )
            gatherer_script = write_script(Path(tmpdir) / "gather.py", script)
            bundle = load_source_bundle(root, source_id="seeded:overlap")

            gathered = gather_context(
                bundle,
                question="What is the directed arbitrary-terminal status?",
                gatherer_backend=lambda prompt: run_script_backend(
                    prompt,
                    command=f"{sys.executable} {gatherer_script}",
                    artifact_root=Path(tmpdir) / "runs",
                ),
            )

        self.assertEqual(len(gathered.snippets), 1)
        self.assertIn("The accepted symmetric lower bound is 27/19.", gathered.snippets[0].text)
        self.assertIn("not the best lower bound for the broad arbitrary-terminal", gathered.snippets[0].text)

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
        self.assertEqual(result.verification, "passed")
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
        self.assertEqual(result.verification, "failed")
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
        self.assertEqual(result.verification, "failed")
        self.assertIn("could not confidently verify", result.answer)

    def test_repo_oracle_cli_emits_json_for_other_harnesses(self) -> None:
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
        self.assertEqual(payload["verification"], "passed")
        self.assertEqual(payload["source_id"], "cli-smoke")
        self.assertEqual(payload["tier"], "strong")


if __name__ == "__main__":
    unittest.main()

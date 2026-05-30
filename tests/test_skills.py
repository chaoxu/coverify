from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECK_SKILLS = ROOT / "scripts" / "check_skills.py"
LINK_SKILLS = ROOT / "scripts" / "link_skills.py"


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


check_skills = load_script("check_skills", CHECK_SKILLS)
link_skills = load_script("link_skills", LINK_SKILLS)


class SkillCompletenessTests(unittest.TestCase):
    def test_coverify_skills_are_complete(self) -> None:
        checks = check_skills.check_all(ROOT / "skills")
        failures = {
            check.name: check.problems
            for check in checks
            if not check.ok
        }
        self.assertEqual(failures, {})

    def test_skill_manifest_is_source_of_truth(self) -> None:
        specs = check_skills.load_manifest(ROOT / "skills")
        names = [spec.name for spec in specs]
        self.assertEqual(len(names), len(set(names)))
        skill_dirs = sorted(path.name for path in (ROOT / "skills").glob("coverify-*") if (path / "SKILL.md").exists())
        self.assertEqual(sorted(names), skill_dirs)

    def test_link_skills_creates_manifest_driven_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = link_skills.main([
                    "link_skills.py",
                    "--skills-dir",
                    str(ROOT / "skills"),
                    "--codex-skills-dir",
                    str(dest),
                ])
            self.assertEqual(result, 0)
            for spec in check_skills.load_manifest(ROOT / "skills"):
                link = dest / spec.name
                self.assertTrue(link.is_symlink())
                self.assertEqual(link.resolve(), (ROOT / "skills" / spec.name).resolve())

    def test_link_skills_check_does_not_create_destination(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "missing" / "skills"
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = link_skills.main([
                    "link_skills.py",
                    "--skills-dir",
                    str(ROOT / "skills"),
                    "--codex-skills-dir",
                    str(dest),
                    "--check",
                ])
            self.assertEqual(result, 1)
            self.assertFalse(dest.exists())

    def test_check_skills_uses_exact_second_level_headings(self) -> None:
        spec = check_skills.SkillSpec("coverify-bad", ["Purpose"], [])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            skill = root / "coverify-bad"
            (skill / "agents").mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "\n".join([
                    "---",
                    "name: coverify-bad",
                    "description: " + "x" * 90,
                    "---",
                    "",
                    "### Purpose",
                    "",
                    "Wrong heading level.",
                    "",
                ]),
                encoding="utf-8",
            )
            (skill / "agents" / "openai.yaml").write_text(
                "\n".join([
                    "interface:",
                    "  display_name: \"Bad\"",
                    "  short_description: \"Bad skill heading fixture\"",
                    "  default_prompt: \"Use $coverify-bad for tests.\"",
                    "",
                ]),
                encoding="utf-8",
            )
            check = check_skills.check_skill(root, spec)
        self.assertFalse(check.ok)
        self.assertIn("missing section: Purpose", check.problems)

    def test_unmanifested_coverify_skill_fails_repository_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            extra = root / "coverify-extra"
            extra.mkdir()
            (extra / "SKILL.md").write_text("# Extra\n", encoding="utf-8")
            check = check_skills.check_repository(root, [])
        self.assertFalse(check.ok)
        self.assertIn("unmanifested skill directory: coverify-extra", check.problems)

    def test_legacy_pre_coverify_skill_fails_repository_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            legacy = root / ("auto" + "prover-context-builder")
            legacy.mkdir()
            (legacy / "SKILL.md").write_text("# Legacy\n", encoding="utf-8")
            check = check_skills.check_repository(root, [])
        self.assertFalse(check.ok)
        self.assertIn("legacy pre-Coverify skill directory: auto" + "prover-context-builder", check.problems)

    def test_context_and_planner_keep_prior_route_guard(self) -> None:
        checks = {
            "coverify-context-builder": ["closest tried route", "materially different"],
            "coverify-exploration-planner": ["Prior route check", "issue-ready"],
            "coverify-proof-attempt": ["Things tried", "Do not retry"],
            "coverify-run-loop": ["PRIOR_ROUTE_CHECK", "THINGS_TRIED_UPDATED"],
        }
        for name, phrases in checks.items():
            text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            for phrase in phrases:
                self.assertIn(phrase, text)

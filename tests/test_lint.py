import unittest

from autoprover.lint import LintError, lint_coflat_body, require_valid_coflat


class LintTests(unittest.TestCase):
    def test_accepts_basic_coflat_document(self) -> None:
        self.assertEqual(
            lint_coflat_body("# Title\n\n::: {.proof}\nProof body.\n:::\n"),
            [],
        )

    def test_rejects_missing_h1_and_code_fence(self) -> None:
        errors = lint_coflat_body("```text\nproof\n```\n")
        self.assertIn("expected exactly one H1 heading, found 0", errors)
        self.assertIn("triple-backtick code fences are not allowed in Coflat math documents", errors)

    def test_rejects_bad_frontmatter(self) -> None:
        errors = lint_coflat_body("---\nbad\n---\n# Title\n")
        self.assertIn("frontmatter line 2 is not a key/value entry", errors)

    def test_require_valid_coflat_can_be_disabled(self) -> None:
        require_valid_coflat("bad", enabled=False)
        with self.assertRaises(LintError):
            require_valid_coflat("bad")


if __name__ == "__main__":
    unittest.main()

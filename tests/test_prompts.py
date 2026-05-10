import unittest

from autoprover.context import strip_frontmatter
from autoprover.prompts import ContextDoc, build_explore_prompt, build_review_prompt, slugify


class PromptTests(unittest.TestCase):
    def test_slugify(self) -> None:
        self.assertEqual(slugify("Try compactness!"), "try-compactness")

    def test_explore_prompt_warns_about_unreviewed_context(self) -> None:
        prompt = build_explore_prompt(
            "prove it",
            [
                ContextDoc(
                    doc_id="d1",
                    path="x.md",
                    title="X",
                    doc_type="page",
                    status="unreviewed",
                    content="# X\n",
                )
            ],
        )
        self.assertIn("Do not claim unreviewed context is established truth", prompt)
        self.assertIn("status: unreviewed", prompt)
        self.assertIn("WORKING CONTEXT - NOT ESTABLISHED", prompt)
        self.assertIn("exactly one meaningful H1 heading", prompt)
        self.assertIn('Do not literally write "# Title"', prompt)
        self.assertIn("Do not use triple-backtick code fences", prompt)

    def test_explore_prompt_separates_golden_and_working_context(self) -> None:
        prompt = build_explore_prompt(
            "prove it",
            [
                ContextDoc("g", "g.md", "G", "page", "golden", "# G\n"),
                ContextDoc("u", "u.md", "U", "page", "unreviewed", "# U\n"),
            ],
        )
        self.assertIn("ESTABLISHED GOLDEN CONTEXT: G", prompt)
        self.assertIn("WORKING CONTEXT - NOT ESTABLISHED: U", prompt)

    def test_review_prompt_marks_target_as_target_not_retrieved_context(self) -> None:
        prompt = build_review_prompt(ContextDoc("d1", "x.md", "X", "page", "unreviewed", "# X\n"))
        self.assertIn("Target Document: X", prompt)
        self.assertNotIn("WORKING CONTEXT - NOT ESTABLISHED: X", prompt)

    def test_strip_frontmatter(self) -> None:
        self.assertEqual(strip_frontmatter("---\nid: x\n---\n# Body\n"), "# Body\n")


if __name__ == "__main__":
    unittest.main()

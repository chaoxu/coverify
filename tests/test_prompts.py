import unittest

from autoprover.context import strip_frontmatter
from autoprover.prompts import ContextDoc, build_explore_prompt, slugify


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
        self.assertIn("exactly one meaningful H1 heading", prompt)
        self.assertIn('Do not literally write "# Title"', prompt)
        self.assertIn("Do not use triple-backtick code fences", prompt)

    def test_strip_frontmatter(self) -> None:
        self.assertEqual(strip_frontmatter("---\nid: x\n---\n# Body\n"), "# Body\n")


if __name__ == "__main__":
    unittest.main()

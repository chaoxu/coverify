from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from autoprover import cli
from autoprover import store


class StoreTests(unittest.TestCase):
    def test_submission_is_immutable(self) -> None:
        with TemporaryDirectory() as root:
            store.create_draft(root, "simple-proof", "Simple Proof", "proof-candidate", "first")
            submitted = store.submit_artifact(root, "simple-proof")
            store.create_draft(root, "simple-proof", "Simple Proof", "proof-candidate", "changed")

            self.assertIn("first", submitted.read_text(encoding="utf-8"))
            self.assertNotIn("changed", submitted.read_text(encoding="utf-8"))
            with self.assertRaises(store.StoreError):
                store.submit_artifact(root, "simple-proof")

    def test_review_statuses(self) -> None:
        with TemporaryDirectory() as root:
            store.create_draft(root, "a", "A", "lemma", "body")
            store.submit_artifact(root, "a")
            self.assertEqual(store.trust_status(root, "a"), "submitted")

            store.create_review(root, "a", "alice", "reject", "bad proof")
            self.assertEqual(store.trust_status(root, "a"), "rejected")

            store.create_review(root, "a", "bob", "approve", "looks right")
            self.assertEqual(store.trust_status(root, "a"), "disputed")

    def test_reusable_rejection_is_partial(self) -> None:
        with TemporaryDirectory() as root:
            store.create_draft(root, "b", "B", "formulation", "body")
            store.submit_artifact(root, "b")
            store.create_review(
                root,
                "b",
                "alice",
                "reject",
                "main proof fails",
                reusable_parts="the normalization is useful",
            )
            self.assertEqual(store.trust_status(root, "b"), "partial")

    def test_invalid_review_does_not_change_status(self) -> None:
        with TemporaryDirectory() as root:
            store.create_draft(root, "c", "C", "lemma", "body")
            store.submit_artifact(root, "c")
            review_path = Path(root) / "reviews" / "c" / "bad.md"
            store.write_markdown(review_path, {"artifact": "c", "verdict": "approve"}, "bad")

            self.assertEqual(store.trust_status(root, "c"), "submitted")

    def test_search_labels_exploration_and_keeps_golden_separate(self) -> None:
        with TemporaryDirectory() as root:
            store.init_store(root)
            store.create_draft(root, "coin-x", "Coin X", "lemma", "coin content")
            store.submit_artifact(root, "coin-x")
            store.create_review(root, "coin-x", "alice", "reject", "wrong")
            store.write_markdown(Path(root) / "golden" / "coin-golden.md", {"title": "Golden Coin"}, "coin")

            exploration = store.search(root, "coin", mode="exploration")
            golden = store.search(root, "coin", mode="golden")

            self.assertEqual(exploration[0].status, "rejected")
            self.assertEqual(golden[0].status, "golden")

    def test_repair_source_link(self) -> None:
        with TemporaryDirectory() as root:
            store.create_draft(root, "old", "Old", "proof-candidate", "bad")
            store.submit_artifact(root, "old")
            store.create_review(root, "old", "alice", "reject", "gap", repair_hints="fix the gap")
            repair = store.create_draft(root, "new", "New", "proof-candidate", "fixed", source="old")
            doc = store.read_markdown(repair)

            self.assertEqual(doc.metadata["source"], "old")

    def test_coin_benchmark(self) -> None:
        with TemporaryDirectory() as root:
            store.create_coin_benchmark(root)

            self.assertEqual(store.trust_status(root, "coin-net-formulation"), "approved")
            self.assertEqual(store.trust_status(root, "coin-generating-function-attempt"), "rejected")
            self.assertEqual(store.trust_status(root, "coin-symbolic-carry-dp-attempt"), "unsure")
            results = store.search(root, "coin", mode="exploration")
            self.assertGreaterEqual(len(results), 3)

    def test_cli_draft_accepts_body_file(self) -> None:
        with TemporaryDirectory() as root:
            body_file = Path(root) / "body.md"
            body_file.write_text("# Long note\n\nThis came from a Markdown file.", encoding="utf-8")

            exit_code = cli.main(
                [
                    "draft",
                    root,
                    "long-note",
                    "--title",
                    "Long Note",
                    "--type",
                    "proof-candidate",
                    "--body-file",
                    str(body_file),
                ]
            )

            self.assertEqual(exit_code, 0)
            draft = store.read_markdown(Path(root) / "drafts" / "long-note.md")
            self.assertIn("This came from a Markdown file.", draft.body)


if __name__ == "__main__":
    unittest.main()

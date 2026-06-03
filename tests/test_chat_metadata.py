from __future__ import annotations

import unittest

from coverify.integration.chat_metadata import (
    CHAT_KIND_REPLY,
    answer_with_metadata,
    chat_issue_body,
    chat_reply_metadata,
    parse_chat_metadata,
    strip_chat_metadata,
)


class ChatMetadataTests(unittest.TestCase):
    def test_chat_metadata_round_trips_and_strips_from_visible_body(self) -> None:
        body = chat_issue_body("Prove the reserve lemma.", branch="agent/reserve")

        self.assertEqual(parse_chat_metadata(body)["branch"], "agent/reserve")
        self.assertEqual(strip_chat_metadata(body), "Prove the reserve lemma.")

    def test_answer_metadata_round_trips_without_visible_footer(self) -> None:
        body = answer_with_metadata("Checked answer.", chat_reply_metadata(branch="main"))

        self.assertEqual(parse_chat_metadata(body)["kind"], CHAT_KIND_REPLY)
        self.assertEqual(strip_chat_metadata(body), "Checked answer.")

    def test_reply_metadata_kind_is_not_overridable(self) -> None:
        with self.assertRaisesRegex(ValueError, "kind is parser-owned"):
            chat_reply_metadata(kind="wrong")


if __name__ == "__main__":
    unittest.main()

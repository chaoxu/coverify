from __future__ import annotations

import unittest
from pathlib import Path

from coverify.backend import BackendResult
from coverify.chat import (
    build_chat_prompt,
    extract_login,
    extract_turns,
    run_chat_reply,
)


class FakeClient:
    def __init__(self, issue, timeline, me=None) -> None:
        self.issue = issue
        self.timeline = timeline
        self._me = me or {"login": "bot"}
        self.comments: list[tuple[str, int, str]] = []

    def read_issue(self, workspace, number):
        return self.issue

    def read_issue_timeline(self, workspace, number):
        return self.timeline

    def comment_issue(self, workspace, number, body):
        self.comments.append((workspace, number, body))
        return {"ok": True}

    def me(self):
        return self._me


def fake_oracle(prompt: str) -> BackendResult:
    fake_oracle.seen = prompt  # type: ignore[attr-defined]
    return BackendResult(
        answer="ORACLE REPLY",
        artifact_dir=Path("/tmp/x"),
        provider="verifying",
        oracle_call_id="x",
    )


class ExtractTests(unittest.TestCase):
    def test_login_variants(self) -> None:
        self.assertEqual(extract_login({"login": "a"}), "a")
        self.assertEqual(extract_login({"username": "b"}), "b")
        self.assertEqual(extract_login("c"), "c")
        self.assertEqual(extract_login({}), "")

    def test_roles_assigned_by_bot_login(self) -> None:
        issue = {"user": {"login": "alice"}, "body": "opening question"}
        timeline = [
            {"user": {"login": "bot"}, "body": "first answer"},
            {"user": {"login": "alice"}, "body": "follow-up"},
        ]
        turns = extract_turns(issue, timeline, "bot")
        self.assertEqual([t.role for t in turns], ["user", "assistant", "user"])
        self.assertEqual(turns[0].body, "opening question")

    def test_dedup_opening_echoed_in_timeline(self) -> None:
        issue = {"author": "alice", "body": "Q"}
        timeline = [{"author": "alice", "body": "Q"}]  # same opening echoed
        turns = extract_turns(issue, timeline, "bot")
        self.assertEqual(len(turns), 1)

    def test_skips_bodyless_events(self) -> None:
        issue = {"user": {"login": "alice"}, "body": "Q"}
        timeline = [{"user": {"login": "alice"}, "type": "label"}]  # no body
        turns = extract_turns(issue, timeline, "bot")
        self.assertEqual(len(turns), 1)


class RunChatReplyTests(unittest.TestCase):
    def test_replies_when_last_turn_is_user(self) -> None:
        client = FakeClient(
            issue={"user": {"login": "alice"}, "body": "Prove X."},
            timeline=[],
        )
        result = run_chat_reply(
            client=client, workspace="w", number=7, oracle=fake_oracle, bot_login="bot"
        )
        self.assertEqual(result.status, "replied")
        self.assertTrue(result.posted)
        self.assertEqual(client.comments, [("w", 7, "ORACLE REPLY")])
        self.assertIn("Prove X.", fake_oracle.seen)  # type: ignore[attr-defined]

    def test_skips_when_already_replied(self) -> None:
        client = FakeClient(
            issue={"user": {"login": "alice"}, "body": "Prove X."},
            timeline=[{"user": {"login": "bot"}, "body": "already answered"}],
        )
        result = run_chat_reply(
            client=client, workspace="w", number=7, oracle=fake_oracle, bot_login="bot"
        )
        self.assertEqual(result.status, "skipped_already_replied")
        self.assertFalse(result.posted)
        self.assertEqual(client.comments, [])

    def test_skips_when_no_user_turn(self) -> None:
        client = FakeClient(
            issue={"user": {"login": "bot"}, "body": "bot opened this"},
            timeline=[],
        )
        result = run_chat_reply(
            client=client, workspace="w", number=7, oracle=fake_oracle, bot_login="bot"
        )
        self.assertEqual(result.status, "skipped_no_user")
        self.assertEqual(client.comments, [])

    def test_prompt_includes_all_turns(self) -> None:
        turns = extract_turns(
            {"user": {"login": "alice"}, "body": "Q1"},
            [{"user": {"login": "bot"}, "body": "A1"}, {"user": {"login": "alice"}, "body": "Q2"}],
            "bot",
        )
        prompt = build_chat_prompt(turns)
        self.assertIn("Q1", prompt)
        self.assertIn("A1", prompt)
        self.assertIn("Q2", prompt)


if __name__ == "__main__":
    unittest.main()

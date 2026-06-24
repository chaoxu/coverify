from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from coverify.cli import build_parser
from coverify.engine.backend import BackendResult
from coverify.integration.chat_metadata import parse_chat_metadata
from coverify.integration.loop import (
    LOOP_ATTEMPT_KIND,
    LOOP_CONCLUSION_KIND,
    acquire_run_lock,
    journal_append,
    journal_load,
    parse_durable_writes,
    parse_run_summary,
    pick_route,
    preflight_cross_family,
    prepare_loop_llm_input,
    prepare_run_dir,
    proposal_shape_problems,
    run_check,
    run_loop,
    write_digest,
)

RUN_SUMMARY = """TASK: explore the route
OUTPUT_CONTRACT: exploratory response
CONTEXT_USED: issue thread
ACTION_TAKEN: tried the obvious reduction
PRIOR_ROUTE_CHECK: no prior attempt covers this reduction
DURABLE_STATE_CHANGED: none
VERIFICATION: none
THINGS_TRIED_UPDATED: yes, via this record
SCRIPT_RETENTION_DECISION: nothing kept
NEXT_BLOCKER_OR_ROUTE: needs a verified bound
COMPLETENESS: partial"""


def summary_answer(extra: str = "") -> str:
    return f"Attempt narrative.\n\n```text\n{RUN_SUMMARY}\n```\n{extra}"


def make_driver(answer_fn, provider: str = "script"):
    """Fake driver in the test_chat fake-oracle style; counts its calls."""
    calls: list[str] = []

    def driver(prompt: str) -> BackendResult:
        calls.append(prompt)
        return BackendResult(
            answer=answer_fn(prompt, len(calls)),
            artifact_dir=Path(f"/tmp/driver-{len(calls)}"),
            provider=provider,
            oracle_call_id=f"d{len(calls)}",
        )

    driver.calls = calls  # type: ignore[attr-defined]
    return driver


def make_verifier(provider: str, verdict: str = "PASS"):
    """Fake gate referee; counts its calls."""
    calls: list[str] = []

    def verifier(prompt: str) -> BackendResult:
        calls.append(prompt)
        return BackendResult(
            answer=f"referee notes\nVERDICT: {verdict}",
            artifact_dir=Path(f"/tmp/gate-{provider}-{len(calls)}"),
            provider=provider,
            oracle_call_id=f"g{len(calls)}",
        )

    verifier.calls = calls  # type: ignore[attr-defined]
    return verifier


class FakeLoopClient:
    """In-process Cosheaf stub. The timeline echoes posted comments so the
    digest's bypass audit sees what a live timeline would show."""

    def __init__(self, issues: dict[int, dict], timelines: dict[int, list] | None = None) -> None:
        self.issues = issues
        self.timelines = timelines or {}
        self.comments: list[tuple[int, str]] = []
        self.closed: list[int] = []
        self.branches: list[str] = []
        self.files: list[tuple[str, str, str]] = []
        self.prs: list[dict] = []
        self.fail_comments = False
        self._comment_id = 0

    def list_issues(self, workspace, state="open", query=None):
        return [
            {
                "number": number,
                "title": issue.get("title", f"route {number}"),
                "labels": issue.get("labels", [{"name": "route"}]),
            }
            for number, issue in sorted(self.issues.items())
            if issue.get("state", "open") == "open"
        ]

    def read_issue(self, workspace, number):
        return {"number": number, **self.issues[number]}

    def read_issue_timeline(self, workspace, number):
        items = list(self.timelines.get(number, []))
        for route, body in self.comments:
            if route == number:
                items.append({"user": {"login": "bot"}, "body": body})
        return items

    def comment_issue(self, workspace, number, body):
        if self.fail_comments:
            raise RuntimeError("comment rejected")
        self._comment_id += 1
        self.comments.append((number, body))
        return {"id": self._comment_id}

    def close_issue(self, workspace, number):
        if getattr(self, "fail_close", False):
            raise RuntimeError("close rejected")
        self.closed.append(number)
        self.issues[number]["state"] = "closed"
        return {"ok": True}

    def create_branch(self, workspace, name):
        self.branches.append(name)
        return {"ok": True}

    def write_branch_file(self, workspace, path, branch, content):
        self.files.append((path, branch, content))
        return {"ok": True}

    def open_pull_request(self, workspace, *, head, title, body, base="main"):
        self.prs.append({"head": head, "title": title, "body": body})
        return {"number": len(self.prs)}

    def me(self):
        return {"login": "bot"}


class LoopTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.loop_root = self.tmp / "loop"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def start(self, client, driver, *, run_dir: Path | None = None, resume: str | None = None, **kw):
        if run_dir is None:
            run_dir, run_id, _resumed = prepare_run_dir(self.loop_root, resume)
        else:
            run_id = run_dir.name
        defaults = dict(
            client=client,
            workspace="w",
            bot_login="bot",
            driver=driver,
            gate_verifiers=[],
            loop_root=self.loop_root,
            run_dir=run_dir,
            run_id=run_id,
            max_attempts=4,
            max_wall_seconds=3600,
            attempt_timeout=60,
            resolution_command="coverify ask --generator codex --verifier claude",
            export_bundle=False,
        )
        defaults.update(kw)
        return run_loop(**defaults), run_dir, run_id


class RunLoopTests(LoopTestCase):
    def test_discovery_run_posts_record_per_attempt_and_writes_digest(self) -> None:
        client = FakeLoopClient(
            {
                1: {"title": "route one", "body": "try A", "user": {"login": "alice"}},
                2: {"title": "route two", "body": "try B", "user": {"login": "alice"}},
            }
        )

        def answers(prompt: str, _n: int) -> str:
            if "Route Pick" in prompt:
                return "ROUTE: #1"
            return summary_answer()

        driver = make_driver(answers)
        digest, run_dir, run_id = self.start(client, driver)

        self.assertEqual(digest["status"], "queue_empty")
        self.assertEqual(digest["budget"]["attempts_used"], 2)
        self.assertEqual([route for route, _ in client.comments], [1, 2])
        for _route, body in client.comments:
            self.assertIn("PRIOR_ROUTE_CHECK", body)
            metadata = parse_chat_metadata(body)
            self.assertEqual(metadata["kind"], LOOP_ATTEMPT_KIND)
            self.assertEqual(metadata["run_id"], run_id)
            self.assertEqual(metadata["outcome"], "completed")
        # pick call for the 2-route menu, then one attempt session per route
        self.assertEqual(len(driver.calls), 3)

        events = [entry["event"] for entry in journal_load(run_dir)]
        self.assertEqual(events.count("attempt_started"), 2)
        self.assertEqual(events.count("things_tried_posted"), 2)
        self.assertEqual(events.count("attempt_finished"), 2)
        self.assertEqual(events[-1], "run_finished")

        digest_md = (run_dir / "digest.md").read_text(encoding="utf-8")
        self.assertIn("attempt 1 on route #1", digest_md)
        self.assertIn(f"code sha: {digest['code_sha']}", digest_md)
        self.assertTrue((run_dir / "digest.json").exists())
        self.assertEqual(digest["bypass_audit"]["mismatches"], [])
        self.assertFalse((self.loop_root / "loop.lock").exists())

    def test_resume_of_recorded_run_invokes_no_driver_and_posts_nothing(self) -> None:
        client = FakeLoopClient({5: {"title": "r", "body": "q", "user": {"login": "alice"}}})
        driver = make_driver(lambda prompt, n: summary_answer())
        _digest, run_dir, run_id = self.start(client, driver, issues=[5])
        self.assertEqual(len(client.comments), 1)

        fresh_driver = make_driver(lambda prompt, n: summary_answer())
        digest, _run_dir, _ = self.start(
            client, fresh_driver, run_dir=run_dir, issues=[5]
        )
        self.assertEqual(digest["status"], "queue_empty")
        self.assertEqual(len(fresh_driver.calls), 0)
        self.assertEqual(len(client.comments), 1)

    def test_crash_resume_posts_exactly_one_crash_record_then_continues(self) -> None:
        client = FakeLoopClient({5: {"title": "r", "body": "q", "user": {"login": "alice"}}})
        run_dir, run_id, _resumed = prepare_run_dir(self.loop_root, None)
        now = time.time()
        journal_append(
            run_dir,
            {
                "event": "run_started",
                "run_id": run_id,
                "workspace": "w",
                "started_epoch": now,
                "deadline_epoch": now + 3600,
                "max_attempts": 4,
                "code_sha": "deadbeef",
            },
        )
        journal_append(run_dir, {"event": "attempt_started", "attempt": 1, "route": 5})

        driver = make_driver(lambda prompt, n: summary_answer())
        digest, _run_dir, _ = self.start(client, driver, run_dir=run_dir, issues=[5])

        self.assertEqual(len(driver.calls), 0)  # route 5 was already attempted
        self.assertEqual(len(client.comments), 1)
        route, body = client.comments[0]
        self.assertEqual(route, 5)
        self.assertIn("crash", body)
        self.assertEqual(parse_chat_metadata(body)["outcome"], "crash")
        self.assertEqual(digest["budget"]["attempts_used"], 1)
        self.assertEqual(digest["status"], "queue_empty")

    def test_zero_wall_budget_runs_no_attempts_but_writes_digest(self) -> None:
        client = FakeLoopClient({1: {"title": "r", "body": "q"}})
        driver = make_driver(lambda prompt, n: summary_answer())
        digest, run_dir, _ = self.start(client, driver, max_wall_seconds=0)
        self.assertEqual(digest["status"], "budget_exhausted")
        self.assertEqual(digest["budget"]["attempts_used"], 0)
        self.assertEqual(len(driver.calls), 0)
        self.assertEqual(client.comments, [])
        self.assertTrue((run_dir / "digest.md").exists())

    def test_attempt_budget_stops_the_run(self) -> None:
        client = FakeLoopClient(
            {n: {"title": f"r{n}", "body": "q"} for n in (1, 2, 3)}
        )
        driver = make_driver(lambda prompt, n: summary_answer())
        digest, _run_dir, _ = self.start(client, driver, issues=[1, 2, 3], max_attempts=1)
        self.assertEqual(digest["status"], "budget_exhausted")
        self.assertEqual(len(client.comments), 1)

    def test_driver_timeout_is_recorded_and_loop_continues(self) -> None:
        client = FakeLoopClient(
            {1: {"title": "r1", "body": "q"}, 2: {"title": "r2", "body": "q"}}
        )

        def driver(prompt: str) -> BackendResult:
            driver.calls.append(prompt)  # type: ignore[attr-defined]
            raise RuntimeError("codex backend timed out; artifacts=/tmp/x")

        driver.calls = []  # type: ignore[attr-defined]
        digest, _run_dir, _ = self.start(client, driver, issues=[1, 2])
        self.assertEqual(digest["status"], "queue_empty")
        self.assertEqual(len(client.comments), 2)
        for _route, body in client.comments:
            self.assertEqual(parse_chat_metadata(body)["outcome"], "timeout")
            self.assertIn("timed out", body)

    def test_invalid_output_is_recorded_and_route_not_repicked(self) -> None:
        client = FakeLoopClient({1: {"title": "r1", "body": "q"}})
        driver = make_driver(lambda prompt, n: "no run summary here at all")
        digest, _run_dir, _ = self.start(client, driver, max_attempts=3)
        self.assertEqual(digest["status"], "queue_empty")  # route excluded after one try
        self.assertEqual(len(driver.calls), 1)
        self.assertEqual(len(client.comments), 1)
        body = client.comments[0][1]
        self.assertEqual(parse_chat_metadata(body)["outcome"], "invalid_output")
        self.assertIn("no run summary here", body)

    def test_record_post_failure_aborts_instead_of_continuing_unrecorded(self) -> None:
        client = FakeLoopClient(
            {1: {"title": "r1", "body": "q"}, 2: {"title": "r2", "body": "q"}}
        )
        client.fail_comments = True
        driver = make_driver(lambda prompt, n: summary_answer())
        digest, run_dir, _ = self.start(client, driver, issues=[1, 2])
        self.assertEqual(digest["status"], "aborted_record_post_failed")
        self.assertEqual(len(driver.calls), 1)  # attempt 2 never starts
        events = [entry["event"] for entry in journal_load(run_dir)]
        self.assertIn("things_tried_post_failed", events)

    def test_route_pick_uses_driver_choice(self) -> None:
        client = FakeLoopClient(
            {n: {"title": f"r{n}", "body": "q"} for n in (2, 7, 9)}
        )

        def answers(prompt: str, _n: int) -> str:
            if "Route Pick" in prompt:
                return "reasoning...\nROUTE: #7"
            return summary_answer()

        driver = make_driver(answers)
        _digest, _run_dir, _ = self.start(client, driver, max_attempts=1)
        self.assertEqual(client.comments[0][0], 7)

    def test_route_pick_falls_back_to_oldest_after_garbled_picks(self) -> None:
        client = FakeLoopClient(
            {n: {"title": f"r{n}", "body": "q"} for n in (2, 7)}
        )

        def answers(prompt: str, _n: int) -> str:
            if "Route Pick" in prompt:
                return "no idea"
            return summary_answer()

        driver = make_driver(answers)
        digest, _run_dir, _ = self.start(client, driver, max_attempts=1)
        self.assertEqual(client.comments[0][0], 2)
        self.assertEqual(digest["route_pick_fallbacks"], [2])


class CrashRecoveryTests(LoopTestCase):
    def _seed_started_run(self, run_dir: Path, run_id: str, route: int = 5) -> None:
        now = time.time()
        journal_append(
            run_dir,
            {
                "event": "run_started",
                "run_id": run_id,
                "workspace": "w",
                "started_epoch": now,
                "deadline_epoch": now + 3600,
                "max_attempts": 4,
                "code_sha": "deadbeef",
            },
        )
        journal_append(run_dir, {"event": "attempt_started", "attempt": 1, "route": route})

    def test_orphan_with_posted_record_is_reconciled_not_double_posted(self) -> None:
        from coverify.integration.chat_metadata import answer_with_metadata

        client = FakeLoopClient({5: {"title": "r", "body": "q"}})
        run_dir, run_id, _resumed = prepare_run_dir(self.loop_root, None)
        self._seed_started_run(run_dir, run_id)
        # The record reached Cosheaf, but the crash hit before the journal append.
        client.comments.append(
            (
                5,
                answer_with_metadata(
                    "## Coverify loop attempt record",
                    {"kind": LOOP_ATTEMPT_KIND, "run_id": run_id, "attempt": 1, "route": 5, "outcome": "completed"},
                ),
            )
        )
        driver = make_driver(lambda prompt, n: summary_answer())
        digest, _run_dir, _ = self.start(client, driver, run_dir=run_dir, issues=[5])

        self.assertEqual(len(client.comments), 1)  # no duplicate record
        events = journal_load(run_dir)
        reconciled = [e for e in events if e.get("event") == "things_tried_posted"]
        self.assertTrue(reconciled and reconciled[0].get("reconciled"))
        self.assertEqual(digest["attempts"][0]["outcome"], "completed")
        self.assertEqual(digest["bypass_audit"]["mismatches"], [])

    def test_crash_record_lists_durable_writes_the_journal_knows_about(self) -> None:
        client = FakeLoopClient({5: {"title": "r", "body": "q"}})
        run_dir, run_id, _resumed = prepare_run_dir(self.loop_root, None)
        self._seed_started_run(run_dir, run_id)
        journal_append(
            run_dir,
            {
                "event": "durable_write_done",
                "attempt": 1,
                "route": 5,
                "action": "kb_page_pr",
                "pr_number": 7,
            },
        )
        driver = make_driver(lambda prompt, n: summary_answer())
        _digest, _run_dir, _ = self.start(client, driver, run_dir=run_dir, issues=[5])

        body = client.comments[0][1]
        self.assertIn("crash", body)
        self.assertIn("Durable writes executed", body)
        self.assertIn("pr_number=7", body)

    def test_persistent_client_errors_abort_with_digest(self) -> None:
        class BrokenClient(FakeLoopClient):
            def list_issues(self, workspace, state="open", query=None):
                raise RuntimeError("api down")

        client = BrokenClient({1: {"title": "r", "body": "q"}})
        driver = make_driver(lambda prompt, n: summary_answer())
        digest, run_dir, _ = self.start(client, driver)
        self.assertEqual(digest["status"], "aborted_client_error")
        errors = [e for e in journal_load(run_dir) if e.get("event") == "cycle_error"]
        self.assertEqual(len(errors), 3)
        self.assertTrue((run_dir / "digest.md").exists())
        self.assertIsNone(digest["open_frontier"])  # unavailable, not empty

    def test_torn_journal_line_does_not_corrupt_next_event(self) -> None:
        run_dir, _run_id, _resumed = prepare_run_dir(self.loop_root, None)
        (run_dir / "journal.jsonl").write_text('{"event": "attempt_st', encoding="utf-8")
        journal_append(run_dir, {"event": "run_finished", "status": "x"})
        events = journal_load(run_dir)
        self.assertEqual([e["event"] for e in events], ["run_finished"])


class VerifyGateTests(LoopTestCase):
    def test_verified_conclude_route_posts_and_closes(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q", "user": {"login": "alice"}}})
        proposal = json.dumps(
            [
                {
                    "action": "conclude_route",
                    "claim": "the route is resolved",
                    "content": "The full verified conclusion for this route.",
                }
            ]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```")
        )
        referee = make_verifier("claude", "PASS")
        digest, _run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[referee]
        )

        self.assertEqual(len(referee.calls), 1)
        self.assertIn("r3", referee.calls[0])  # referee saw the route context
        self.assertIn("full verified conclusion", referee.calls[0])
        self.assertEqual(len(client.comments), 2)  # conclusion, then attempt record
        conclusion_body = client.comments[0][1]
        self.assertIn("The full verified conclusion", conclusion_body)
        self.assertIn("verified: yes", conclusion_body)
        self.assertIn("gate referees: claude", conclusion_body)
        self.assertEqual(parse_chat_metadata(conclusion_body)["kind"], LOOP_CONCLUSION_KIND)
        self.assertEqual(client.closed, [3])
        self.assertEqual(len(digest["verified_writes"]), 1)
        self.assertEqual(digest["dead_routes"], [3])
        self.assertEqual(digest["quarantined"], [])
        self.assertEqual(digest["bypass_audit"]["mismatches"], [])

    def test_referee_fail_quarantines_with_no_writes(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        proposal = json.dumps(
            [{"action": "conclude_route", "content": "A plausible but wrong conclusion."}]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```")
        )
        digest, _run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[make_verifier("claude", "FAIL")]
        )
        self.assertEqual(client.closed, [])
        self.assertEqual(len(client.comments), 1)  # only the attempt record
        self.assertEqual(len(digest["quarantined"]), 1)
        problems = "; ".join(digest["quarantined"][0]["problems"])
        self.assertIn("verdict: FAIL", problems)
        self.assertIn("Quarantined durable-write proposals", client.comments[0][1])

    def test_same_family_pass_is_not_enough(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        proposal = json.dumps(
            [{"action": "conclude_route", "content": "A conclusion the author family likes."}]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```"),
            provider="codex",
        )
        digest, _run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[make_verifier("codex", "PASS")]
        )
        self.assertEqual(client.closed, [])
        self.assertEqual(len(digest["quarantined"]), 1)
        self.assertIn("cross-family", "; ".join(digest["quarantined"][0]["problems"]))

    def test_shape_and_mechanical_problems_skip_referee_spend(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        proposals = json.dumps(
            [
                {"action": "merge_pr", "content": "nice try"},
                {"action": "conclude_route"},
                {"action": "conclude_route", "content": "It can be shown that this holds."},
            ]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposals}\n```")
        )
        referee = make_verifier("claude", "PASS")
        digest, _run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[referee]
        )
        self.assertEqual(len(referee.calls), 0)  # nothing reached the referees
        self.assertEqual(client.closed, [])
        self.assertEqual(len(digest["quarantined"]), 3)
        problems = "\n".join(
            "; ".join(item.get("problems") or []) for item in digest["quarantined"]
        )
        self.assertIn("unknown action", problems)
        self.assertIn("non-empty 'content'", problems)
        self.assertIn("shortcut phrase", problems)

    def test_no_gate_verifiers_quarantines_instead_of_writing(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        proposal = json.dumps([{"action": "conclude_route", "content": "A fine conclusion."}])
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```")
        )
        digest, _run_dir, _ = self.start(client, driver, issues=[3], gate_verifiers=[])
        self.assertEqual(client.closed, [])
        self.assertEqual(len(digest["quarantined"]), 1)
        self.assertIn("no gate verifiers", "; ".join(digest["quarantined"][0]["problems"]))

    def test_content_with_code_fences_survives_durable_writes_parsing(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        page = "# Page\n\n```python\nassert check()\n```\n\nDone."
        proposal = json.dumps(
            [
                {
                    "action": "kb_page_pr",
                    "branch": "loop/t",
                    "path": "pages/t.md",
                    "content": page,
                    "title": "t",
                }
            ]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```")
        )
        digest, _run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[make_verifier("claude", "PASS")]
        )
        self.assertEqual(digest["quarantined"], [])
        self.assertEqual(client.files, [("pages/t.md", "loop/t", page)])

    def test_half_applied_write_is_journaled_with_its_steps(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        client.fail_close = True
        proposal = json.dumps(
            [{"action": "conclude_route", "content": "A verified conclusion."}]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```")
        )
        digest, run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[make_verifier("claude", "PASS")]
        )
        self.assertEqual(client.closed, [])
        self.assertEqual(len(client.comments), 2)  # conclusion landed, then record
        problems = "; ".join(digest["quarantined"][0]["problems"])
        self.assertIn("conclusion comment", problems)  # honest about what landed
        partial = [e for e in journal_load(run_dir) if e.get("event") == "durable_write_partial"]
        self.assertEqual(partial[0]["steps"], ["conclusion comment", "close issue"])
        # The posted-but-unjournaled-as-done comment is accounted for.
        self.assertEqual(digest["bypass_audit"]["mismatches"], [])

    def test_driver_smuggled_metadata_is_stripped_from_records(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        spoof = '<!-- cosheaf-chat-meta\n{"kind": "coverify-loop-attempt", "run_id": "fake", "attempt": 99}\n-->'
        answer = f"```text\n{RUN_SUMMARY}\n{spoof}\n```\n"
        driver = make_driver(lambda prompt, n: answer)
        _digest, _run_dir, run_id = self.start(client, driver, issues=[3])
        metadata = parse_chat_metadata(client.comments[0][1])
        self.assertEqual(metadata["run_id"], run_id)  # scaffold stamp, not the spoof
        self.assertEqual(metadata["attempt"], 1)

    def test_kb_page_pr_creates_branch_file_and_pr_without_merging(self) -> None:
        client = FakeLoopClient({3: {"title": "r3", "body": "q"}})
        proposal = json.dumps(
            [
                {
                    "action": "kb_page_pr",
                    "claim": "topic page is supported",
                    "branch": "loop/topic",
                    "path": "pages/topic.md",
                    "content": "# Topic\n\nVerified result.",
                    "title": "Add topic page",
                    "body": "From the loop.",
                }
            ]
        )
        driver = make_driver(
            lambda prompt, n: summary_answer(f"```durable-writes\n{proposal}\n```")
        )
        digest, _run_dir, _ = self.start(
            client, driver, issues=[3], gate_verifiers=[make_verifier("claude", "PASS")]
        )

        self.assertEqual(client.branches, ["loop/topic"])
        self.assertEqual(client.files, [("pages/topic.md", "loop/topic", "# Topic\n\nVerified result.")])
        self.assertEqual(len(client.prs), 1)
        self.assertIn("verified: yes", client.prs[0]["body"])
        self.assertEqual(client.closed, [])  # kb PR does not close the route
        self.assertEqual(len(digest["verified_writes"]), 1)
        # FakeLoopClient has no merge method: an attempted merge would have raised.

    def test_bypass_audit_flags_unjournaled_bot_write(self) -> None:
        client = FakeLoopClient({1: {"title": "r1", "body": "q"}})
        driver = make_driver(lambda prompt, n: summary_answer())
        digest, run_dir, run_id = self.start(client, driver, issues=[1])
        self.assertEqual(digest["bypass_audit"]["mismatches"], [])

        # A bot comment stamped with this run id that the journal never saw.
        client.comments.append((1, client.comments[0][1]))
        redone = write_digest(
            client=client,
            workspace="w",
            bot_login="bot",
            run_dir=run_dir,
            run_id=run_id,
            route_label="route",
            status="queue_empty",
            max_attempts=4,
            max_wall_seconds=3600,
        )
        self.assertEqual(len(redone["bypass_audit"]["mismatches"]), 1)


class HelperTests(LoopTestCase):
    def test_parse_run_summary(self) -> None:
        self.assertIsNotNone(parse_run_summary(summary_answer()))
        self.assertIsNone(parse_run_summary("free prose without the block"))
        missing = summary_answer().replace("PRIOR_ROUTE_CHECK", "PRIOR_ROUTE_CHEK")
        self.assertIsNone(parse_run_summary(missing))
        bare = "intro\n" + RUN_SUMMARY  # unfenced summary still counts
        self.assertIsNotNone(parse_run_summary(bare))

    def test_parse_durable_writes(self) -> None:
        self.assertEqual(parse_durable_writes("no block"), ([], []))
        proposals, problems = parse_durable_writes('```durable-writes\n[{"action": "x"}]\n```')
        self.assertEqual(proposals, [{"action": "x"}])
        self.assertEqual(problems, [])
        _proposals, problems = parse_durable_writes("```durable-writes\nnot json\n```")
        self.assertEqual(len(problems), 1)
        _proposals, problems = parse_durable_writes('```durable-writes\n{"action": "x"}\n```')
        self.assertEqual(problems, ["durable-writes block must be a JSON array"])

    def test_proposal_shape_problems(self) -> None:
        problems = proposal_shape_problems({"action": "kb_page_pr"})
        for field in ("branch", "path", "content", "title"):
            self.assertTrue(any(field in problem for problem in problems))
        self.assertEqual(proposal_shape_problems({"action": "conclude_route", "content": "x"}), [])
        self.assertEqual(proposal_shape_problems({"action": "merge_pr"}), ["unknown action: 'merge_pr'"])

    def test_preflight_cross_family(self) -> None:
        with self.assertRaises(SystemExit):
            preflight_cross_family("codex", ["codex"])
        with self.assertRaises(SystemExit):
            preflight_cross_family("codex", ["script", "fixture"])
        preflight_cross_family("codex", ["claude", "codex"])
        preflight_cross_family("script", ["claude"])

    def test_pick_route_single_candidate_skips_driver(self) -> None:
        driver = make_driver(lambda prompt, n: self.fail("driver must not be called"))
        number, fallback = pick_route(driver, [{"number": 4, "title": "only"}], "w")
        self.assertEqual((number, fallback), (4, False))

    def test_run_lock_blocks_second_run_until_stale(self) -> None:
        lock = acquire_run_lock(self.loop_root, run_id="a", ttl_seconds=600)
        with self.assertRaises(SystemExit):
            acquire_run_lock(self.loop_root, run_id="b", ttl_seconds=600)
        os.utime(lock, (time.time() - 1000, time.time() - 1000))
        acquire_run_lock(self.loop_root, run_id="c", ttl_seconds=600)
        self.assertEqual(lock.read_text(encoding="utf-8"), "c")

    def test_prepare_loop_llm_input_builds_grounded_prompt(self) -> None:
        client = FakeLoopClient(
            {1: {"title": "r1", "body": "the precise question", "user": {"login": "alice"}}},
            timelines={1: [{"user": {"login": "bot"}, "body": "prior attempt record"}]},
        )
        run_dir, _run_id, _resumed = prepare_run_dir(self.loop_root, None)
        payload = prepare_loop_llm_input(
            client=client,
            workspace="w",
            bot_login="bot",
            run_dir=run_dir,
            issues=None,
            route_label="route",
            resolution_command="coverify ask --generator codex --verifier claude",
            attempt_timeout=60,
            export_bundle=False,
        )
        self.assertEqual(payload["step"], "driver")
        self.assertEqual(payload["route"], 1)
        self.assertEqual(payload["eligible_routes"], [1])
        prompt = payload["prompt"]
        self.assertIn("PRIOR_ROUTE_CHECK", prompt)  # skill text embedded
        self.assertIn("the precise question", prompt)
        self.assertIn("prior attempt record", prompt)
        self.assertIn("coverify ask --generator codex --verifier claude", prompt)
        self.assertEqual(client.comments, [])

    def test_run_check_audits_success_and_failure(self) -> None:
        ok = run_check(
            f"{sys.executable} -c 'print(41 + 1)'",
            artifact_root=self.tmp / "checks",
            timeout_seconds=30,
        )
        self.assertTrue(ok["ok"])
        self.assertEqual(ok["stdout"].strip(), "42")
        self.assertTrue((Path(ok["artifact_dir"]) / "metadata.json").exists())

        bad = run_check(
            f"{sys.executable} -c 'raise SystemExit(1)'",
            artifact_root=self.tmp / "checks",
            timeout_seconds=30,
        )
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["returncode"], 1)
        self.assertTrue((Path(bad["artifact_dir"]) / "metadata.json").exists())


def hermetic_parser():
    """build_parser bakes env defaults in; clear loop-relevant vars first so
    a developer's shell cannot flip these tests."""
    with patch.dict(os.environ, {}, clear=False):
        for var in (
            "COVERIFY_LOOP_DRIVER",
            "COVERIFY_ASK_VERIFIER",
            "COVERIFY_ASK_GENERATOR",
            "COVERIFY_ASK_ADJUDICATOR",
        ):
            os.environ.pop(var, None)
        return build_parser()


class LoopCliTests(unittest.TestCase):
    def test_loop_command_end_to_end_with_script_driver(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            stub = tmp / "driver.py"
            stub.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "sys.stdin.read()\n"
                f"print({summary_answer()!r})\n",
                encoding="utf-8",
            )
            client = FakeLoopClient({4: {"title": "r4", "body": "q", "user": {"login": "alice"}}})
            args = hermetic_parser().parse_args(
                [
                    "loop",
                    "--token",
                    "tok",
                    "--workspace",
                    "w",
                    "--bot-user",
                    "bot",
                    "--issue",
                    "4",
                    "--driver",
                    "script",
                    "--backend-command",
                    f"{sys.executable} {stub}",
                    "--max-attempts",
                    "1",
                    "--no-source-bundle",
                    "--verifier",
                    "claude",
                    # Building the claude gate referee needs the opt-in; the
                    # stub posts no proposals, so it is never invoked.
                    "--allow-claude-backend",
                    "--run-dir",
                    str(tmp / "runs"),
                    "--json",
                ]
            )
            stdout = io.StringIO()
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                patch("sys.stdout", stdout),
            ):
                self.assertEqual(args.func(args), 0)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["status"], "budget_exhausted")
            self.assertEqual(payload["budget"]["attempts_used"], 1)
            self.assertEqual(len(client.comments), 1)
            self.assertIn("PRIOR_ROUTE_CHECK", client.comments[0][1])

    def test_loop_preflight_rejects_same_family_verifiers(self) -> None:
        args = hermetic_parser().parse_args(
            ["loop", "--token", "tok", "--workspace", "w", "--verifier", "codex"]
        )
        with self.assertRaises(SystemExit):
            args.func(args)

    def test_loop_dry_run_writes_preview_and_posts_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            client = FakeLoopClient({4: {"title": "r4", "body": "the question"}})
            args = hermetic_parser().parse_args(
                [
                    "loop",
                    "--token",
                    "tok",
                    "--workspace",
                    "w",
                    "--bot-user",
                    "bot",
                    "--issue",
                    "4",
                    "--dry-run",
                    "--no-source-bundle",
                    "--verifier",
                    "claude",
                    "--run-dir",
                    str(tmp / "runs"),
                    "--json",
                ]
            )
            stdout = io.StringIO()
            with (
                patch("coverify.cli.authed_client_from_args", return_value=client),
                patch("sys.stdout", stdout),
            ):
                self.assertEqual(args.func(args), 0)
            payload = json.loads(stdout.getvalue())
            self.assertFalse(payload["backend_invoked"])
            self.assertIn("the question", payload["prompt"])
            self.assertTrue(Path(payload["prompt_path"]).exists())
            self.assertTrue(Path(payload["preview_path"]).exists())
            self.assertEqual(client.comments, [])


if __name__ == "__main__":
    unittest.main()

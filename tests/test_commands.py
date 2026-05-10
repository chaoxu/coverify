from argparse import Namespace
from contextlib import redirect_stdout
from io import StringIO
import os
import unittest

from autoprover.commands import command_cycle, command_propose, command_repair, command_workstream_step


class FakeClient:
    def __init__(self) -> None:
        self.docs = {
            "target": {
                "id": "target",
                "path": "pages/target.md",
                "type": "page",
                "status": "golden",
                "title": "Target",
            }
        }
        self.notes = {
            "pages/target.md": "---\nid: target\nstatus: golden\n---\n# Target\n\nOld body.\n"
        }
        self.submitted: list[str] = []
        self.decisions: list[tuple[str, str, str | None]] = []
        self.approval_rows = [
            {
                "verifier_user_id": 1,
                "username": "fake",
                "decision": "reject",
                "comment": "needs repair",
                "review_doc_id": "review-target",
            }
        ]
        self.docs["review-target"] = {
            "id": "review-target",
            "path": "reviews/review-target.md",
            "type": "review",
            "status": "draft",
            "title": "Review Target",
            "target_id": "target",
        }
        self.notes["reviews/review-target.md"] = "# Review\n\nPlease repair the target.\n"

    def search(self, query: str):
        return []

    def queue(self):
        return []

    def documents(self):
        return list(self.docs.values())

    def get_document(self, doc_id: str):
        return self.docs[doc_id]

    def get_note(self, path: str):
        return {"content": self.notes[path], "mtime": 1}

    def put_note(self, path: str, content: str):
        doc_id = "new-page"
        self.notes[path] = content
        self.docs[doc_id] = {
            "id": doc_id,
            "path": path,
            "type": "page",
            "status": "draft",
            "title": "Fake Exploration Result",
        }
        return {"meta": self.docs[doc_id]}

    def submit(self, doc_id: str):
        self.submitted.append(doc_id)
        self.docs[doc_id]["status"] = "unreviewed"
        return {"status": "unreviewed"}

    def create_proposal(self, target_id: str, body: str):
        doc_id = "proposal"
        path = "proposals/proposal.md"
        self.docs[doc_id] = {
            "id": doc_id,
            "path": path,
            "type": "proposal",
            "status": "draft",
            "title": "Proposal",
            "target_id": target_id,
        }
        self.notes[path] = body
        return {"path": path, "meta": self.docs[doc_id]}

    def create_review(self, target_id: str, body: str):
        doc_id = "review"
        path = "reviews/review.md"
        self.docs[doc_id] = {
            "id": doc_id,
            "path": path,
            "type": "review",
            "status": "draft",
            "title": "Review",
            "target_id": target_id,
        }
        self.notes[path] = body
        return {"path": path, "meta": self.docs[doc_id]}

    def decide(self, target_id: str, decision: str, comment=None, review_doc_id=None):
        self.decisions.append((target_id, decision, review_doc_id))
        self.docs[target_id]["status"] = "golden" if decision == "approve" else "rejected"
        return {
            "decision": decision,
            "approvals": 1 if decision == "approve" else 0,
            "rejections": 1 if decision == "reject" else 0,
            "doc_status": self.docs[target_id]["status"],
        }

    def approvals(self, doc_id: str):
        return self.approval_rows if doc_id == "target" else []


def fake_agent_path() -> str:
    return os.path.abspath("scripts/fake-agent")


class CommandTests(unittest.TestCase):
    def test_cycle_creates_submits_and_reviews_same_doc(self) -> None:
        client = FakeClient()
        args = Namespace(
            direction="prove fake",
            path="explorations/fake.md",
            context_query="",
            limit=3,
            agent_cmd=fake_agent_path(),
            no_trace=True,
        )
        with redirect_stdout(StringIO()):
            rc = command_cycle(client, args)
        self.assertEqual(rc, 0)
        self.assertEqual(client.submitted, ["new-page"])
        self.assertEqual(client.decisions, [("new-page", "approve", "review")])
        self.assertEqual(client.docs["new-page"]["status"], "golden")

    def test_propose_creates_and_submits_proposal(self) -> None:
        client = FakeClient()
        args = Namespace(
            target_id="target",
            direction="repair target",
            context_query="",
            limit=3,
            agent_cmd=fake_agent_path(),
            submit=True,
            no_trace=True,
        )
        with redirect_stdout(StringIO()):
            rc = command_propose(client, args)
        self.assertEqual(rc, 0)
        self.assertEqual(client.submitted, ["proposal"])
        self.assertEqual(client.docs["proposal"]["status"], "unreviewed")

    def test_repair_uses_review_docs_and_submits_proposal(self) -> None:
        client = FakeClient()
        args = Namespace(
            target_id="target",
            direction="",
            agent_cmd=fake_agent_path(),
            submit=True,
            no_trace=True,
        )
        with redirect_stdout(StringIO()):
            rc = command_repair(client, args)
        self.assertEqual(rc, 0)
        self.assertEqual(client.submitted, ["proposal"])

    def test_workstream_step_creates_exploration_for_task(self) -> None:
        client = FakeClient()
        args = Namespace(
            task_id="target",
            direction="continue",
            path="",
            context_query="",
            limit=3,
            agent_cmd=fake_agent_path(),
            submit=True,
            no_trace=True,
        )
        with redirect_stdout(StringIO()):
            rc = command_workstream_step(client, args)
        self.assertEqual(rc, 0)
        self.assertEqual(client.submitted, ["new-page"])


if __name__ == "__main__":
    unittest.main()

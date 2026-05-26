from __future__ import annotations

import io
import json
import unittest
from typing import Any
from unittest.mock import patch

from autoprover.client import CosheafClient, CosheafConfig


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class ClientTests(unittest.TestCase):
    def test_create_workspace_sends_optional_default_format(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = dict(req.header_items())
            captured["body"] = json.loads(req.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse({"slug": "w", "default_md_format": "coflat"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.create_workspace("w", "Workspace", default_md_format="coflat")

        self.assertEqual(response["default_md_format"], "coflat")
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/workspaces")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["body"], {
            "slug": "w",
            "name": "Workspace",
            "default_md_format": "coflat",
        })
        self.assertEqual(captured["headers"]["Authorization"], "Bearer tok")
        self.assertEqual(captured["timeout"], 60)

    def test_create_workspace_omits_format_when_unspecified(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["timeout"] = timeout
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({"slug": "w"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            client.create_workspace("w", "Workspace")

        self.assertEqual(captured["body"], {"slug": "w", "name": "Workspace"})
        self.assertEqual(captured["timeout"], 60)

    def test_set_workspace_member_uses_cosheaf_members_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({"ok": True, "username": "vera", "role": "write"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.set_workspace_member("w", "vera", "write")

        self.assertEqual(response["ok"], True)
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/workspaces/w/members/vera")
        self.assertEqual(captured["method"], "PUT")
        self.assertEqual(captured["body"], {"role": "write"})

    def test_create_issue_uses_cosheaf_issue_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({"number": 3, "title": "Try lower bound", "state": "open"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.create_issue("w", title="Try lower bound", body="body")

        self.assertEqual(response["number"], 3)
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/w/w/issues")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["body"], {"title": "Try lower bound", "body": "body"})

    def test_edit_issue_uses_cosheaf_issue_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({"number": 3, "title": "Try lower bound", "body": "updated"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.edit_issue("w", 3, body="updated")

        self.assertEqual(response["body"], "updated")
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/w/w/issues/3")
        self.assertEqual(captured["method"], "PATCH")
        self.assertEqual(captured["body"], {"body": "updated"})

    def test_edit_issue_requires_title_or_body(self) -> None:
        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with self.assertRaises(ValueError):
            client.edit_issue("w", 3)

    def test_read_issue_timeline_uses_cosheaf_timeline_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            return FakeResponse({"events": [{"type": "close"}]})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.read_issue_timeline("w", 23)

        self.assertEqual(response["events"], [{"type": "close"}])
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/w/w/issues/23/timeline")
        self.assertEqual(captured["method"], "GET")

    def test_set_issue_state_uses_cosheaf_state_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({"ok": True, "state": "open"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.reopen_issue("w", 23)

        self.assertEqual(response["state"], "open")
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/w/w/issues/23/state")
        self.assertEqual(captured["method"], "PATCH")
        self.assertEqual(captured["body"], {"state": "open"})

    def test_set_issue_state_rejects_unknown_state(self) -> None:
        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with self.assertRaises(ValueError):
            client.set_issue_state("w", 23, "triaged")

    def test_search_uses_cosheaf_search_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            return FakeResponse({"results": []})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.search("w", "series parallel")

        self.assertEqual(response["results"], [])
        self.assertEqual(captured["url"], "http://cosheaf.test/api/v1/w/w/search?q=series+parallel")
        self.assertEqual(captured["method"], "GET")

    def test_delete_branch_file_uses_cosheaf_file_endpoint(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["data"] = req.data
            return FakeResponse({"ok": True, "branch": "agent/cleanup"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.delete_branch_file("w", "old.md", "agent/cleanup")

        self.assertEqual(response["ok"], True)
        self.assertEqual(
            captured["url"],
            "http://cosheaf.test/api/v1/w/w/file?path=old.md&branch=agent%2Fcleanup",
        )
        self.assertEqual(captured["method"], "DELETE")
        self.assertIsNone(captured["data"])

    def test_pull_request_read_list_and_close_use_cosheaf_endpoints(self) -> None:
        captured: list[tuple[str, str, Any]] = []

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured.append((
                req.get_method(),
                req.full_url,
                None if req.data is None else json.loads(req.data.decode("utf-8")),
            ))
            return FakeResponse({"ok": True})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            client.list_pull_requests("w", state="all")
            client.read_pull_request("w", 7)
            client.close_pull_request("w", 7)

        self.assertEqual(
            captured,
            [
                ("GET", "http://cosheaf.test/api/v1/w/w/pulls?state=all", None),
                ("GET", "http://cosheaf.test/api/v1/w/w/pulls/7", None),
                ("POST", "http://cosheaf.test/api/v1/w/w/pulls/7/close", {}),
            ],
        )

    def test_read_pull_request_context_includes_files_and_dependency_note(self) -> None:
        captured: list[tuple[str, str]] = []

        def fake_urlopen(req: Any, timeout: int) -> FakeResponse:
            captured.append((req.get_method(), req.full_url))
            if req.full_url.endswith("/files"):
                return FakeResponse({"files": [{"filename": "proof.md", "patch": "@@"}]})
            return FakeResponse({"number": 7, "title": "Proof update"})

        client = CosheafClient(CosheafConfig(api_url="http://cosheaf.test/api/v1", token="tok"))
        with patch("autoprover.client.urlopen", fake_urlopen):
            response = client.read_pull_request_context("w", 7)

        self.assertEqual(
            captured,
            [
                ("GET", "http://cosheaf.test/api/v1/w/w/pulls/7"),
                ("GET", "http://cosheaf.test/api/v1/w/w/pulls/7/files"),
            ],
        )
        self.assertEqual(response["pull_request"]["number"], 7)
        self.assertEqual(response["files"]["files"][0]["filename"], "proof.md")
        self.assertIn("accepted KB definitions", response["review_context_note"])


if __name__ == "__main__":
    unittest.main()

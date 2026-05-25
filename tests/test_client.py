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


if __name__ == "__main__":
    unittest.main()

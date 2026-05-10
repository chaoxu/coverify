from __future__ import annotations

from dataclasses import dataclass
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


class CosheafError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def normalize_api_url(url: str) -> str:
    cleaned = url.rstrip("/")
    if cleaned.endswith("/api/v1"):
        return cleaned
    return f"{cleaned}/api/v1"


@dataclass(frozen=True)
class CosheafConfig:
    url: str
    workspace: str
    token: str

    @classmethod
    def from_env(
        cls,
        url: str | None = None,
        workspace: str | None = None,
        token: str | None = None,
    ) -> "CosheafConfig":
        resolved_url = url or os.environ.get("COSHEAF_URL") or "http://localhost:3030/api/v1"
        resolved_workspace = workspace or os.environ.get("COSHEAF_WORKSPACE")
        resolved_token = token or os.environ.get("COSHEAF_TOKEN")
        if not resolved_workspace:
            raise CosheafError("workspace required; pass --workspace or set COSHEAF_WORKSPACE")
        if not resolved_token:
            raise CosheafError("token required; pass --token or set COSHEAF_TOKEN")
        return cls(normalize_api_url(resolved_url), resolved_workspace, resolved_token)


class CosheafClient:
    def __init__(self, config: CosheafConfig) -> None:
        self.config = config

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = Request(
            f"{self.config.url}{path}",
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {self.config.token}",
                "content-type": "application/json",
                "accept": "application/json",
            },
        )
        try:
            with urlopen(req, timeout=120) as res:
                raw = res.read().decode("utf-8")
        except HTTPError as exc:
            raw_error = exc.read().decode("utf-8", errors="replace")
            message = raw_error
            try:
                parsed = json.loads(raw_error)
                message = str(parsed.get("error") or raw_error)
            except json.JSONDecodeError:
                pass
            raise CosheafError(message, exc.code) from exc
        except URLError as exc:
            raise CosheafError(f"could not reach Cosheaf: {exc.reason}") from exc
        if not raw:
            return {}
        return json.loads(raw)

    def workspace_path(self, suffix: str) -> str:
        return f"/w/{quote(self.config.workspace)}/{suffix.lstrip('/')}"

    def search(self, query: str) -> list[dict[str, Any]]:
        params = urlencode({"q": query})
        data = self.request("GET", self.workspace_path(f"search?{params}"))
        return list(data.get("results", []))

    def queue(self) -> list[dict[str, Any]]:
        data = self.request("GET", self.workspace_path("queue"))
        return list(data.get("queue", []))

    def documents(self) -> list[dict[str, Any]]:
        data = self.request("GET", self.workspace_path("documents"))
        return list(data.get("documents", []))

    def get_document(self, doc_id: str) -> dict[str, Any]:
        data = self.request("GET", self.workspace_path(f"document/{quote(doc_id)}"))
        return dict(data["document"])

    def get_note(self, path: str) -> dict[str, Any]:
        params = urlencode({"path": path})
        return self.request("GET", self.workspace_path(f"note?{params}"))

    def put_note(self, path: str, content: str) -> dict[str, Any]:
        params = urlencode({"path": path})
        return self.request("PUT", self.workspace_path(f"note?{params}"), {"content": content})

    def submit(self, doc_id: str) -> dict[str, Any]:
        return self.request("POST", self.workspace_path(f"document/{quote(doc_id)}/submit"))

    def create_proposal(self, target_id: str, body: str) -> dict[str, Any]:
        return self.request("POST", self.workspace_path("proposal"), {"target_id": target_id, "body": body})

    def create_review(self, target_id: str, body: str) -> dict[str, Any]:
        return self.request("POST", self.workspace_path("review"), {"target_id": target_id, "body": body})

    def approvals(self, doc_id: str) -> list[dict[str, Any]]:
        data = self.request("GET", self.workspace_path(f"document/{quote(doc_id)}/approvals"))
        return list(data.get("approvals", []))

    def decide(
        self,
        target_id: str,
        decision: str,
        comment: str | None = None,
        review_doc_id: str | None = None,
    ) -> dict[str, Any]:
        if decision not in {"approve", "reject"}:
            raise ValueError(f"invalid decision: {decision}")
        return self.request(
            "POST",
            self.workspace_path(f"document/{quote(target_id)}/{decision}"),
            {"comment": comment, "review_doc_id": review_doc_id},
        )

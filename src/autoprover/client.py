from __future__ import annotations

import json
import ssl
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class CosheafError(RuntimeError):
    def __init__(
        self,
        method: str,
        path: str,
        status: int,
        payload: Any,
    ) -> None:
        self.method = method
        self.path = path
        self.status = status
        self.payload = payload
        message = payload
        if isinstance(payload, dict):
            message = payload.get("error") or payload.get("message") or payload
        super().__init__(f"{method} {path} -> {status}: {message}")

    @property
    def code(self) -> str | None:
        if isinstance(self.payload, dict):
            value = self.payload.get("code")
            return str(value) if value is not None else None
        return None


@dataclass(frozen=True)
class CosheafConfig:
    api_url: str
    token: str | None = None
    tls_verify: bool = True

    def with_token(self, token: str) -> "CosheafConfig":
        return CosheafConfig(api_url=self.api_url, token=token, tls_verify=self.tls_verify)


class CosheafClient:
    def __init__(self, config: CosheafConfig) -> None:
        self.config = config
        self.api_url = config.api_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        token: str | None = None,
    ) -> Any:
        if not path.startswith("/"):
            path = f"/{path}"
        data = None
        headers: dict[str, str] = {"accept": "application/json"}
        effective_token = token if token is not None else self.config.token
        if effective_token:
            headers["authorization"] = f"Bearer {effective_token}"
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = Request(
            f"{self.api_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        context = None if self.config.tls_verify else ssl._create_unverified_context()
        try:
            urlopen_kwargs: dict[str, Any] = {"timeout": 60}
            if context is not None:
                urlopen_kwargs["context"] = context
            with urlopen(req, **urlopen_kwargs) as response:
                return self._parse_response(response.read())
        except HTTPError as err:
            payload = self._parse_response(err.read())
            raise CosheafError(method, path, err.code, payload) from err
        except URLError as err:
            raise RuntimeError(f"{method} {path} failed: {err.reason}") from err

    @staticmethod
    def _parse_response(raw: bytes) -> Any:
        if not raw:
            return None
        text = raw.decode("utf-8")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    @staticmethod
    def query(**params: str | int | None) -> str:
        filtered = {k: v for k, v in params.items() if v is not None}
        return urlencode(filtered)

    def login(self, username: str, password: str) -> str:
        data = self.request(
            "POST",
            "/login",
            body={"username": username, "password": password},
            token="",
        )
        token = data.get("pat") if isinstance(data, dict) else None
        if not token:
            raise RuntimeError(f"login for {username} did not return a token")
        return str(token)

    def me(self) -> Any:
        return self.request("GET", "/me")

    def create_workspace(
        self,
        slug: str,
        name: str,
        *,
        default_md_format: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {"slug": slug, "name": name}
        if default_md_format:
            body["default_md_format"] = default_md_format
        return self.request("POST", "/workspaces", body=body)

    def list_workspaces(self) -> Any:
        return self.request("GET", "/workspaces")

    def set_workspace_member(self, workspace: str, username: str, role: str) -> Any:
        return self.request(
            "PUT",
            f"/workspaces/{workspace}/members/{username}",
            body={"role": role},
        )

    def list_workspace_files(self, workspace: str, *, branch: str = "main") -> Any:
        return self.request("GET", f"/w/{workspace}/tree?{self.query(branch=branch)}")

    def search(self, workspace: str, query: str) -> Any:
        return self.request("GET", f"/w/{workspace}/search?{self.query(q=query)}")

    def list_issues(
        self,
        workspace: str,
        *,
        state: str = "open",
        query: str | None = None,
    ) -> Any:
        return self.request(
            "GET",
            f"/w/{workspace}/issues?{self.query(state=state, filter='all', q=query)}",
        )

    def read_issue(self, workspace: str, number: int) -> Any:
        return self.request("GET", f"/w/{workspace}/issues/{number}")

    def read_issue_timeline(self, workspace: str, number: int) -> Any:
        return self.request("GET", f"/w/{workspace}/issues/{number}/timeline")

    def create_issue(
        self,
        workspace: str,
        *,
        title: str,
        body: str,
    ) -> Any:
        return self.request(
            "POST",
            f"/w/{workspace}/issues",
            body={"title": title, "body": body},
        )

    def edit_issue(
        self,
        workspace: str,
        number: int,
        *,
        title: str | None = None,
        body: str | None = None,
    ) -> Any:
        patch: dict[str, Any] = {}
        if title is not None:
            patch["title"] = title
        if body is not None:
            patch["body"] = body
        if not patch:
            raise ValueError("title or body is required")
        return self.request(
            "PATCH",
            f"/w/{workspace}/issues/{number}",
            body=patch,
        )

    def comment_issue(self, workspace: str, number: int, body: str) -> Any:
        return self.request(
            "POST",
            f"/w/{workspace}/issues/{number}/comments",
            body={"body": body},
        )

    def close_issue(self, workspace: str, number: int) -> Any:
        return self.set_issue_state(workspace, number, "closed")

    def reopen_issue(self, workspace: str, number: int) -> Any:
        return self.set_issue_state(workspace, number, "open")

    def set_issue_state(self, workspace: str, number: int, state: str) -> Any:
        if state not in {"open", "closed"}:
            raise ValueError("issue state must be open or closed")
        return self.request(
            "PATCH",
            f"/w/{workspace}/issues/{number}/state",
            body={"state": state},
        )

    def read_file(self, workspace: str, path: str, *, branch: str = "main") -> Any:
        return self.request(
            "GET",
            f"/w/{workspace}/file?{self.query(path=path, branch=branch)}",
        )

    def create_branch(self, workspace: str, name: str) -> Any:
        return self.request("POST", f"/w/{workspace}/branches", body={"name": name})

    def write_branch_file(
        self,
        workspace: str,
        path: str,
        branch: str,
        content: str,
    ) -> Any:
        return self.request(
            "PUT",
            f"/w/{workspace}/file?{self.query(path=path, branch=branch)}",
            body={"content": content},
        )

    def delete_branch_file(
        self,
        workspace: str,
        path: str,
        branch: str,
    ) -> Any:
        return self.request(
            "DELETE",
            f"/w/{workspace}/file?{self.query(path=path, branch=branch)}",
        )

    def open_pull_request(
        self,
        workspace: str,
        *,
        head: str,
        title: str,
        body: str,
        base: str = "main",
    ) -> Any:
        return self.request(
            "POST",
            f"/w/{workspace}/pulls",
            body={"head": head, "base": base, "title": title, "body": body},
        )

    def list_pull_requests(self, workspace: str, *, state: str = "open") -> Any:
        return self.request("GET", f"/w/{workspace}/pulls?{self.query(state=state)}")

    def read_pull_request(self, workspace: str, pr_number: int) -> Any:
        return self.request("GET", f"/w/{workspace}/pulls/{pr_number}")

    def read_pull_request_context(self, workspace: str, pr_number: int) -> Any:
        pull_request = self.read_pull_request(workspace, pr_number)
        files = self.request("GET", f"/w/{workspace}/pulls/{pr_number}/files")
        return {
            "pull_request": pull_request,
            "files": files,
            "review_context_note": (
                "Review context must also include accepted KB definitions, "
                "theorems, source notes, and evidence cited or used by the "
                "changed text; PR files alone are not sufficient."
            ),
        }

    def review_pull_request(
        self,
        workspace: str,
        pr_number: int,
        *,
        event: str,
        body: str,
    ) -> Any:
        return self.request(
            "POST",
            f"/w/{workspace}/pulls/{pr_number}/reviews",
            body={"event": event, "body": body},
        )

    def merge_pull_request(
        self,
        workspace: str,
        pr_number: int,
        *,
        method: str = "squash",
        force: bool = False,
    ) -> Any:
        return self.request(
            "POST",
            f"/w/{workspace}/pulls/{pr_number}/merge",
            body={"Do": method, "force": force},
        )

    def close_pull_request(self, workspace: str, pr_number: int) -> Any:
        return self.request("POST", f"/w/{workspace}/pulls/{pr_number}/close", body={})

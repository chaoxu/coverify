"""Issue-as-chat interface.

A Cosheaf issue is treated as a chat thread: the opening post and each comment
is one turn. ``chat-reply`` reads the thread, runs the verifying oracle on the
conversation, and posts one reply as a comment -- so a mathematician can talk
to a self-verifying oracle through the familiar issue UI without leaving it.

The verification rounds stay private in the oracle's audit bundle; only the
single adjudicated reply is posted to the thread.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..engine.backend import BackendRunner


@dataclass(frozen=True)
class Turn:
    role: str  # "user" or "assistant"
    author: str
    body: str


@dataclass(frozen=True)
class ChatReplyResult:
    status: str  # "replied", "skipped_no_user", "skipped_already_replied"
    posted: bool
    reply: str | None


def extract_login(obj: Any) -> str:
    """Best-effort login/username from a user object or bare string."""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        for key in ("login", "username", "name"):
            value = obj.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


def _author_of(item: dict[str, Any]) -> str:
    for key in ("user", "author", "poster"):
        if key in item:
            login = extract_login(item[key])
            if login:
                return login
    return ""


def _body_of(item: dict[str, Any]) -> str:
    for key in ("body", "content", "message"):
        value = item.get(key)
        if isinstance(value, str):
            return value
    return ""


def extract_turns(issue: Any, timeline: Any, bot_login: str) -> list[Turn]:
    """Build the conversation: the issue opening post plus each comment body.

    Timeline events without a body (label changes, state changes) are skipped.
    Consecutive duplicate turns are collapsed so an opening post echoed by the
    timeline is not double-counted.
    """
    raw: list[tuple[str, str]] = []
    if isinstance(issue, dict):
        body = _body_of(issue)
        if body.strip():
            raw.append((_author_of(issue), body))
    if isinstance(timeline, list):
        for item in timeline:
            if not isinstance(item, dict):
                continue
            body = _body_of(item)
            if body.strip():
                raw.append((_author_of(item), body))

    turns: list[Turn] = []
    for author, body in raw:
        if turns and turns[-1].author == author and turns[-1].body == body:
            continue
        role = "assistant" if author and author == bot_login else "user"
        turns.append(Turn(role=role, author=author, body=body))
    return turns


def build_chat_prompt(turns: list[Turn]) -> str:
    lines = [
        "You are answering an ongoing mathematical discussion thread. Read the",
        "whole conversation and respond to the most recent message from the user.",
        "",
    ]
    for turn in turns:
        speaker = "User" if turn.role == "user" else "Assistant"
        lines.extend([f"## {speaker}", turn.body, ""])
    return "\n".join(lines)


def run_chat_reply(
    *,
    client: Any,
    workspace: str,
    number: int,
    oracle: BackendRunner,
    bot_login: str,
) -> ChatReplyResult:
    issue = client.read_issue(workspace, number)
    timeline = client.read_issue_timeline(workspace, number)
    turns = extract_turns(issue, timeline, bot_login)

    if not any(turn.role == "user" for turn in turns):
        return ChatReplyResult("skipped_no_user", posted=False, reply=None)
    if turns[-1].role == "assistant":
        return ChatReplyResult("skipped_already_replied", posted=False, reply=None)

    result = oracle(build_chat_prompt(turns))
    client.comment_issue(workspace, number, result.answer)
    return ChatReplyResult("replied", posted=True, reply=result.answer)

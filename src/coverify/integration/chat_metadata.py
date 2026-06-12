from __future__ import annotations

import json
import re
from typing import Any

CHAT_META_MARKER = "cosheaf-chat-meta"
CHAT_KIND_ISSUE = "cosheaf-chat"
CHAT_KIND_REPLY = "coverify-chat-reply"
CHAT_META_RE = re.compile(
    rf"<!--\s*{re.escape(CHAT_META_MARKER)}\s*(\{{.*?\}})\s*-->",
    re.DOTALL,
)


def parse_chat_metadata(body: str) -> dict[str, Any]:
    match = CHAT_META_RE.search(body)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def strip_chat_metadata(body: str) -> str:
    return CHAT_META_RE.sub("", body).strip()


def chat_metadata_comment(metadata: dict[str, object]) -> str:
    return "<!-- " + CHAT_META_MARKER + "\n" + json.dumps(metadata, indent=2, sort_keys=True) + "\n-->"


def chat_issue_metadata(*, branch: str) -> dict[str, object]:
    return {"kind": CHAT_KIND_ISSUE, "branch": branch}


def chat_issue_body(message: str, *, branch: str) -> str:
    return "\n\n".join(
        [
            chat_metadata_comment(chat_issue_metadata(branch=branch)),
            message.strip(),
        ],
    ).strip()


def chat_reply_metadata(**fields: object) -> dict[str, object]:
    if "kind" in fields:
        raise ValueError("chat reply metadata kind is parser-owned")
    return {"kind": CHAT_KIND_REPLY, **fields}


def answer_with_metadata(answer: str, metadata: dict[str, object]) -> str:
    return "\n\n".join([answer.rstrip(), chat_metadata_comment(metadata)]).strip() + "\n"


def verification_footer(verification: str | None) -> str:
    """Visible verdict line appended to every chat reply.

    Chat is a trust boundary: readers act on replies without re-checking, so
    the verification status must travel with the answer, not hide in metadata.
    """
    if verification == "passed":
        status = "yes"
    elif verification == "failed":
        status = "NO -- reviewer found unresolved problems; treat as unverified"
    elif verification == "error":
        status = "NO -- verification unavailable; treat as unverified"
    else:
        status = "NO -- ran without verification"
    return f"\n\n---\nverified: {status}"

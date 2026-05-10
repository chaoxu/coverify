from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from .format import COFLAT_PRIMER_VERSION, PROMPT_VERSION


TRACE_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Trace:
    schema_version: int
    id: str
    created_at: str
    kind: str
    direction: str
    context_ids: list[str]
    prompt: str
    output: str
    cosheaf_result: dict[str, Any]
    prompt_version: str
    coflat_primer_version: str
    inputs: dict[str, Any]
    outputs: dict[str, Any]
    result: dict[str, Any]


def default_trace_path() -> Path:
    raw = os.environ.get("AUTOPROVER_TRACE_FILE")
    if raw:
        return Path(raw)
    return Path(".autoprover") / "runs.jsonl"


def make_trace(
    kind: str,
    direction: str,
    context_ids: list[str],
    prompt: str,
    output: str,
    cosheaf_result: dict[str, Any],
) -> Trace:
    return Trace(
        schema_version=TRACE_SCHEMA_VERSION,
        id=uuid4().hex,
        created_at=datetime.now(timezone.utc).isoformat(),
        kind=kind,
        direction=direction,
        context_ids=context_ids,
        prompt=prompt,
        output=output,
        cosheaf_result=cosheaf_result,
        prompt_version=PROMPT_VERSION,
        coflat_primer_version=COFLAT_PRIMER_VERSION,
        inputs={
            "direction": direction,
            "context_ids": context_ids,
            "prompt": prompt,
        },
        outputs={"raw": output},
        result={"cosheaf": cosheaf_result},
    )


def append_trace(trace: Trace, path: Path | None = None) -> Path:
    target = path or default_trace_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(asdict(trace), ensure_ascii=False) + "\n")
    return target

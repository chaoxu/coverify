from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from coverify.engine.backend import run_script_backend


@dataclass(frozen=True)
class ProjectTool:
    name: str
    command: str
    description: str = ""
    timeout_seconds: int | None = None
    cwd: str | None = None


_ARTIFACTS_IN_ERROR_RE = re.compile(r"artifacts=([^;\s]+)")


def load_project_tools(path: Path) -> list[ProjectTool]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    entries = raw.get("tools") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        raise ValueError("tool file must be a JSON object with a tools list, or a list")
    tools = [_tool_from_raw(entry) for entry in entries]
    names = [tool.name for tool in tools]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise ValueError(f"duplicate tool names: {', '.join(duplicates)}")
    return tools


def list_project_tools(path: Path) -> dict[str, Any]:
    return {
        "tools_file": str(path),
        "tools": [
            {
                "name": tool.name,
                "description": tool.description,
                "command": tool.command,
                "timeout_seconds": tool.timeout_seconds,
                "cwd": tool.cwd,
            }
            for tool in load_project_tools(path)
        ],
    }


def run_project_tool(
    *,
    tools_file: Path,
    name: str,
    input_text: str,
    artifact_root: Path,
    timeout_seconds: int | None = None,
) -> dict[str, Any]:
    tools = {tool.name: tool for tool in load_project_tools(tools_file)}
    tool = tools.get(name)
    if tool is None:
        available = ", ".join(sorted(tools)) or "none"
        raise ValueError(f"unknown tool {name!r}; available tools: {available}")
    effective_timeout = timeout_seconds if timeout_seconds is not None else tool.timeout_seconds
    cwd = _resolve_tool_cwd(tools_file, tool.cwd)
    try:
        result = run_script_backend(
            input_text,
            command=tool.command,
            artifact_root=artifact_root,
            timeout_seconds=effective_timeout,
            cwd=cwd,
        )
    except RuntimeError as exc:
        payload: dict[str, Any] = {
            "ok": False,
            "tool": tool.name,
            "description": tool.description,
            "command": tool.command,
            "cwd": str(cwd),
            "timeout_seconds": effective_timeout,
            "detail": str(exc),
        }
        match = _ARTIFACTS_IN_ERROR_RE.search(str(exc))
        if match:
            artifact_dir = Path(match.group(1))
            payload["artifact_dir"] = str(artifact_dir)
            metadata = _read_json(artifact_dir / "metadata.json")
            if isinstance(metadata, dict):
                payload["returncode"] = metadata.get("returncode")
                payload["timed_out"] = metadata.get("timed_out")
            answer = artifact_dir / "answer.md"
            if answer.exists():
                payload["stdout"] = answer.read_text(encoding="utf-8")
        return payload
    return {
        "ok": True,
        "tool": tool.name,
        "description": tool.description,
        "command": tool.command,
        "cwd": str(cwd),
        "timeout_seconds": effective_timeout,
        "stdout": result.answer,
        "artifact_dir": str(result.artifact_dir),
        "oracle_call_id": result.oracle_call_id,
    }


def _tool_from_raw(raw: object) -> ProjectTool:
    if not isinstance(raw, dict):
        raise ValueError("each tool entry must be a JSON object")
    name = str(raw.get("name") or "").strip()
    command = str(raw.get("command") or "").strip()
    if not name:
        raise ValueError("tool name is required")
    if not command:
        raise ValueError(f"tool {name!r} requires command")
    timeout_raw = raw.get("timeout_seconds")
    timeout_seconds = None
    if timeout_raw is not None:
        timeout_seconds = int(timeout_raw)
        if timeout_seconds <= 0:
            raise ValueError(f"tool {name!r} timeout_seconds must be positive")
    cwd_raw = raw.get("cwd")
    cwd = str(cwd_raw).strip() if cwd_raw is not None else None
    return ProjectTool(
        name=name,
        command=command,
        description=str(raw.get("description") or ""),
        timeout_seconds=timeout_seconds,
        cwd=cwd or None,
    )


def _resolve_tool_cwd(tools_file: Path, cwd: str | None) -> Path:
    if cwd:
        path = Path(cwd).expanduser()
        if path.is_absolute():
            return path
        return (tools_file.parent / path).resolve()
    return tools_file.parent.resolve()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

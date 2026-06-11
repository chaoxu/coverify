from __future__ import annotations

from typing import Any

from ..engine.backend import BackendRunner, audit_summary


def run_ask_oracle(*, prompt: str, backend: BackendRunner, retries: int = 0) -> dict[str, Any]:
    if not prompt.strip():
        raise ValueError("oracle prompt is empty")
    if retries < 0:
        raise ValueError("oracle retries cannot be negative")
    failures: list[Exception] = []
    for _attempt in range(retries + 1):
        try:
            backend_result = backend(prompt)
            break
        except RuntimeError as exc:
            failures.append(exc)
    else:
        raise RuntimeError(
            "oracle backend failed after "
            f"{retries + 1} attempt(s); last error: {failures[-1]}",
        ) from failures[-1]
    return {
        "ok": True,
        "answer": backend_result.answer,
        "backend_provider": backend_result.provider,
        "oracle_call_id": backend_result.oracle_call_id,
        "backend_artifact_dir": str(backend_result.artifact_dir),
        "backend_audit": audit_summary(backend_result),
    }

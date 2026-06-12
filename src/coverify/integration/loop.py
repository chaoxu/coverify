"""Unattended exploration loop ("the chat worker, generalized").

``coverify loop`` iterates the coverify-run-loop skill without a human at the
keyboard: a thin, mechanical Python scaffold (run lock, budgets, journal,
digest) around bounded frontier-CLI attempt sessions. This is Coverify's
Level-2 "overnight exploration" harness.

Division of labor:

- Judgment lives in the driver session: one ``BackendRunner`` call per
  attempt, prompted with the coverify-run-loop skill text (read from the
  skill file at call time, so there is no second copy to drift), the route
  issue thread, and the prior Things-Tried history. The driver picks routes
  and decides what to try; Python never plans.
- The scaffold is pure mechanism and holds the only Cosheaf token. The driver
  session is token-less: it *proposes* durable writes in a fenced
  ``durable-writes`` JSON block carrying the full proposed content, and the
  scaffold runs its OWN cross-family verifier referees over that content
  before any write. The driver cannot fake the gate, because the gate's
  verifier calls are built and audited by the scaffold, not cited by the
  driver (anything the driver can write inside its sandbox, it could also
  forge). Failing proposals are quarantined into the attempt record, labeled.
- Things Tried is enforced by the scaffold, not the agent: exactly one
  attempt comment is posted per attempt -- the driver's Run Summary verbatim,
  or a labeled crash/timeout/invalid-output record -- before the loop moves
  on. If that post fails, the run aborts rather than continue with
  unrecorded attempts.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..engine.backend import (
    BackendResult,
    BackendRunner,
    ensure_artifact_dir,
    run_script_backend,
)
from ..engine.verifying import (
    Verdict,
    build_verifier_context,
    mechanical_draft_problems,
    parse_verdict,
)
from .chat import extract_turns
from .chat_metadata import (
    answer_with_metadata,
    parse_chat_metadata,
    strip_chat_metadata,
    verification_footer,
)
from .repo_oracle import export_cosheaf_source_bundle, sha256_text

LOOP_ATTEMPT_KIND = "coverify-loop-attempt"
LOOP_CONCLUSION_KIND = "coverify-loop-conclusion"
ROUTE_LABEL_DEFAULT = "route"
LLM_PROVIDERS = frozenset({"codex", "claude"})
DURABLE_WRITE_ACTIONS = ("conclude_route", "kb_page_pr")
RUN_SUMMARY_REQUIRED_FIELDS = ("PRIOR_ROUTE_CHECK", "THINGS_TRIED_UPDATED")
RUN_LOOP_SKILL_GUARD_PHRASES = (
    "DURABLE_STATE_CHANGED",
    "PRIOR_ROUTE_CHECK",
    "THINGS_TRIED_UPDATED",
    "COMPLETENESS",
)

_ROUTE_PICK_RE = re.compile(r"(?m)^ROUTE:\s*#?(\d+)\s*$")
# The closing fence must sit on its own line: JSON-encoded content carries
# newlines as \n escapes, so backticks embedded in proposed page content stay
# mid-line and cannot terminate the block early.
_DURABLE_WRITES_RE = re.compile(r"(?m)^```durable-writes[ \t]*\n(.*?)\n[ \t]*```[ \t]*$", re.DOTALL)
_FENCED_BLOCK_RE = re.compile(r"```[\w-]*\n(.*?)```", re.DOTALL)
_ARTIFACTS_IN_ERROR_RE = re.compile(r"artifacts=(\S+?);?(?:\s|$)")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def code_sha() -> str:
    """Short git sha of this checkout, recorded in the digest for provenance."""
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_root()), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001 -- sha reporting must never block a run
        return "unknown"


def run_loop_skill_text() -> str:
    """The coverify-run-loop skill, read from its single source of truth.

    Headless driver sessions (codex exec runs --ephemeral --ignore-user-config)
    have no linked skills, so the loop embeds the skill text into the attempt
    prompt. Guard phrases from skills/manifest.json are re-checked here so a
    skill edit that breaks the loop's parser fails loudly, not silently.
    """
    path = repo_root() / "skills" / "coverify-run-loop" / "SKILL.md"
    text = path.read_text(encoding="utf-8")
    missing = [phrase for phrase in RUN_LOOP_SKILL_GUARD_PHRASES if phrase not in text]
    if missing:
        raise RuntimeError(f"run-loop skill at {path} lost required phrases: {missing}")
    return text


# --- run journal -------------------------------------------------------------


def journal_append(run_dir: Path, event: dict[str, Any]) -> None:
    entry = {"ts": datetime.now(timezone.utc).isoformat(), **event}
    path = run_dir / "journal.jsonl"
    # A crash mid-write can leave a torn final line without a newline; never
    # let the next event concatenate onto it and corrupt both.
    needs_newline = False
    if path.exists() and path.stat().st_size > 0:
        with path.open("rb") as file:
            file.seek(-1, 2)
            needs_newline = file.read(1) != b"\n"
    with path.open("a", encoding="utf-8") as file:
        if needs_newline:
            file.write("\n")
        file.write(json.dumps(entry, sort_keys=True) + "\n")


def journal_load(run_dir: Path) -> list[dict[str, Any]]:
    path = run_dir / "journal.jsonl"
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue  # torn final line from a crash mid-write
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


# --- run dir and lock ----------------------------------------------------------


def prepare_run_dir(loop_root: Path, resume_run_id: str | None) -> tuple[Path, str, bool]:
    loop_root.mkdir(parents=True, exist_ok=True)
    if resume_run_id:
        run_dir = loop_root / resume_run_id
        if not run_dir.is_dir():
            raise SystemExit(f"resume run dir does not exist: {run_dir}")
        return run_dir, resume_run_id, True
    run_dir = ensure_artifact_dir(loop_root, "run")
    return run_dir, run_dir.name, False


def acquire_run_lock(loop_root: Path, *, run_id: str, ttl_seconds: int) -> Path:
    """One loop run per loop root. The holder touches the lock each iteration
    (mtime heartbeat), so a fixed TTL only has to outlive one attempt."""
    loop_root.mkdir(parents=True, exist_ok=True)
    lock = loop_root / "loop.lock"
    if lock.exists() and (time.time() - lock.stat().st_mtime) < ttl_seconds:
        holder = lock.read_text(encoding="utf-8").strip()
        raise SystemExit(
            f"another loop run ({holder or 'unknown'}) holds {lock}; "
            "wait for it, or remove the lock if it is stale"
        )
    lock.write_text(run_id, encoding="utf-8")
    return lock


# --- route queue ----------------------------------------------------------------


def _issues_payload(value: Any) -> list[dict[str, Any]]:
    items: Any = value
    if isinstance(value, dict):
        for key in ("issues", "data", "items"):
            if isinstance(value.get(key), list):
                items = value[key]
                break
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _label_names(issue: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for label in issue.get("labels") or []:
        if isinstance(label, str):
            names.add(label)
        elif isinstance(label, dict) and isinstance(label.get("name"), str):
            names.add(label["name"])
    return names


def eligible_routes(
    client: Any,
    workspace: str,
    *,
    route_label: str,
    exclude: set[int],
) -> list[dict[str, Any]]:
    routes = []
    for issue in _issues_payload(client.list_issues(workspace, state="open")):
        number = issue.get("number")
        if not isinstance(number, int) or number in exclude:
            continue
        if route_label not in _label_names(issue):
            continue
        routes.append(issue)
    return sorted(routes, key=lambda issue: issue["number"])


def build_pick_prompt(routes: list[dict[str, Any]], workspace: str) -> str:
    lines = [
        "# Coverify Loop Route Pick",
        "",
        "You are choosing the next route for an unattended Coverify exploration",
        f"loop on workspace {workspace!r}. Open route issues:",
        "",
    ]
    for issue in routes:
        lines.append(f"- #{issue['number']}: {issue.get('title') or '(untitled)'}")
    lines += [
        "",
        "Pick the single route where one bounded attempt is most likely to",
        "produce durable, verifiable progress. Reply with exactly one line:",
        "",
        "ROUTE: #<number>",
    ]
    return "\n".join(lines)


def pick_route(
    driver: BackendRunner,
    routes: list[dict[str, Any]],
    workspace: str,
    heartbeat: Any = None,
) -> tuple[int, bool]:
    """Driver picks; mechanical validation; oldest-eligible fallback after two
    unusable picks (the fallback is recorded in the journal and digest)."""
    if len(routes) == 1:
        return routes[0]["number"], False
    valid = {issue["number"] for issue in routes}
    prompt = build_pick_prompt(routes, workspace)
    for _attempt in range(2):
        if heartbeat is not None:
            heartbeat()
        try:
            result = driver(prompt)
        except Exception:  # noqa: BLE001 -- an unusable pick falls through to the fallback
            continue
        match = _ROUTE_PICK_RE.search(result.answer)
        if match and int(match.group(1)) in valid:
            return int(match.group(1)), False
    return routes[0]["number"], True


# --- attempt prompt ----------------------------------------------------------------


def build_attempt_prompt(
    *,
    workspace: str,
    issue_number: int,
    issue: Any,
    timeline: Any,
    bot_login: str,
    skill_text: str,
    resolution_command: str,
    run_dir: Path,
    source_note: str,
    attempt_timeout: int,
) -> str:
    turns = extract_turns(issue, timeline, bot_login)
    thread = "\n\n".join(
        f"## {'User' if turn.role == 'user' else 'Assistant'}\n{turn.body}" for turn in turns
    ) or "(no prior discussion)"
    title = issue.get("title") if isinstance(issue, dict) else None
    return "\n".join(
        [
            "# Coverify Loop Attempt",
            "",
            "You are one bounded attempt session in an unattended Coverify",
            f"exploration loop on workspace {workspace!r}. This session has about",
            f"{attempt_timeout} seconds of wall clock. You have NO Cosheaf",
            "credentials: do not try to post, write, merge, or close anything.",
            "Durable writes happen only through the durable-writes proposals",
            "described below; the harness executes them after mechanical",
            "verification checks, and everything else you produce is recorded as",
            "labeled attempt-log material.",
            "",
            "## Loop discipline (coverify-run-loop skill, embedded)",
            "",
            "Skill references like $coverify-context-builder are advisory role",
            "descriptions; they are not installed in this session. Follow the",
            "discipline directly.",
            "",
            skill_text.strip(),
            "",
            "## Allowed sources",
            "",
            source_note,
            "",
            f"## Route issue #{issue_number}: {title or '(untitled)'}",
            "",
            "The thread below includes prior attempt records (Things Tried).",
            "Do not silently retry a recorded failed route; a retry must name",
            "what is materially different.",
            "",
            thread,
            "",
            "## Verified mathematical resolution",
            "",
            "For one exact hard target you may draft with (shell access",
            "permitting):",
            "",
            f"    {resolution_command}",
            "",
            "For finite computational checks, run them audited:",
            "",
            f"    coverify run-check --command '<cmd>' --run-dir {run_dir}",
            "",
            "## Output requirements",
            "",
            "End your reply with the Run Summary block from the skill (all",
            "fields, in a fenced text block). To propose durable writes, also",
            "emit at most one fenced block tagged `durable-writes` containing a",
            "JSON array of proposals carrying the full proposed content.",
            "JSON-encode content (real newlines as \\n) and put the closing",
            "``` on its own line:",
            "",
            "```durable-writes",
            "[",
            '  {"action": "conclude_route", "claim": "<one-line claim>",',
            '   "content": "<full conclusion text>", "close": true},',
            '  {"action": "kb_page_pr", "claim": "<one-line claim>",',
            '   "branch": "loop/<topic>", "path": "pages/<page>.md",',
            '   "content": "<full page text>", "title": "<pr title>", "body": "<pr body>"}',
            "]",
            "```",
            "",
            "Rules the harness enforces mechanically:",
            "- before any write, the harness runs its own adversarial referees",
            "  (cross-family, all must PASS) over your proposed content; you",
            "  cannot substitute your own verification for that gate;",
            "- conclude_route posts the verified content and closes this route",
            "  issue; kb_page_pr opens a pull request for human review -- the",
            "  loop never merges;",
            "- proposals that fail any check are quarantined into the attempt",
            "  record, clearly labeled. Unverified findings belong in the Run",
            "  Summary, honestly labeled, not in durable-writes.",
        ]
    )


# --- driver output parsing ------------------------------------------------------


def _has_required_summary_fields(text: str) -> bool:
    if re.search(r"(?m)^TASK:", text) is None:
        return False
    return all(
        re.search(rf"(?m)^{field}:", text) is not None
        for field in RUN_SUMMARY_REQUIRED_FIELDS
    )


def parse_run_summary(answer: str) -> str | None:
    for match in _FENCED_BLOCK_RE.finditer(answer):
        block = match.group(1)
        if _has_required_summary_fields(block):
            return block.strip()
    match = re.search(r"(?m)^TASK:", answer)
    if match is not None and _has_required_summary_fields(answer[match.start():]):
        return answer[match.start():].strip()
    return None


def parse_durable_writes(answer: str) -> tuple[list[dict[str, Any]], list[str]]:
    proposals: list[dict[str, Any]] = []
    problems: list[str] = []
    for match in _DURABLE_WRITES_RE.finditer(answer):
        try:
            block = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            problems.append(f"unparseable durable-writes block: {exc}")
            continue
        if not isinstance(block, list):
            problems.append("durable-writes block must be a JSON array")
            continue
        for index, item in enumerate(block):
            if isinstance(item, dict):
                proposals.append(item)
            else:
                problems.append(f"proposal {index} is not an object")
    return proposals, problems


# --- verify gate -------------------------------------------------------------------
#
# The gate runs scaffold-owned verifier referees over the proposed content.
# Trusting a driver-cited audit bundle instead would be hollow: any bundle the
# driver could legitimately produce inside its sandbox, it could also forge.


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def proposal_shape_problems(proposal: dict[str, Any]) -> list[str]:
    action = proposal.get("action")
    if action not in DURABLE_WRITE_ACTIONS:
        return [f"unknown action: {action!r}"]
    required = ("content",) if action == "conclude_route" else ("branch", "path", "content", "title")
    return [
        f"{action} requires a non-empty {field!r}"
        for field in required
        if not isinstance(proposal.get(field), str) or not proposal[field].strip()
    ]


def build_gate_original(issue_number: int, issue: Any, claim: str) -> str:
    title = issue.get("title") if isinstance(issue, dict) else None
    body = issue.get("body") if isinstance(issue, dict) else None
    lines = [f"Route issue #{issue_number}: {title or '(untitled)'}", "", str(body or "").strip()]
    if claim.strip():
        lines += ["", f"Claimed resolution: {claim.strip()}"]
    lines += [
        "",
        "The candidate below is proposed as DURABLE state for this route",
        "(a verified conclusion or knowledge-base page). PASS only if it fully",
        "supports its own claims at that standard.",
    ]
    return "\n".join(lines)


def verify_proposal(
    gate_verifiers: list[BackendRunner],
    *,
    original: str,
    candidate: str,
    author_provider: str,
    heartbeat: Any = None,
) -> dict[str, Any]:
    """Scaffold-side verify gate: pessimistic aggregation (every referee must
    PASS, an error counts as failure) plus the cross-family rule -- at least
    one passing referee must be an LLM from a different family than the
    content's author. Mechanical bad-case checks run first so an obviously
    broken draft costs no verifier spend.

    ``author_provider`` is the driver session's CLI family. A driver with
    shell access can launder content through another model, so against an
    adversarial driver the cross-family rule is only as strong as the
    referee set: with a single referee family, that family could in
    principle review its own laundered output. The default referee set
    spans both families with all-must-PASS aggregation, which closes the
    laundering channel; single-referee configs trade that away."""
    problems = list(mechanical_draft_problems(candidate))
    if problems:
        return {"passed": False, "problems": problems, "verdicts": [], "providers": [], "artifact_dirs": []}
    if not gate_verifiers:
        return {
            "passed": False,
            "problems": ["no gate verifiers configured"],
            "verdicts": [],
            "providers": [],
            "artifact_dirs": [],
        }
    verdicts: list[str] = []
    providers: list[str] = []
    artifact_dirs: list[str] = []
    context = build_verifier_context(original, candidate)
    for runner in gate_verifiers:
        if heartbeat is not None:
            heartbeat()
        try:
            result = runner(context)
        except Exception as exc:  # noqa: BLE001 -- a broken referee fails closed
            verdicts.append("ERROR")
            providers.append("error")
            problems.append(f"gate verifier errored: {str(exc)[:300]}")
            continue
        try:
            verdict = parse_verdict(result.answer).value
        except ValueError:
            verdict = "ERROR"
        verdicts.append(verdict)
        providers.append(result.provider)
        artifact_dirs.append(str(result.artifact_dir))
        if verdict != Verdict.PASS.value:
            problems.append(f"gate verifier {result.provider} verdict: {verdict}")
    if not any(
        verdict == Verdict.PASS.value and provider in LLM_PROVIDERS and provider != author_provider
        for verdict, provider in zip(verdicts, providers)
    ):
        problems.append(
            "no passing cross-family LLM verifier "
            f"(author={author_provider!r}, verifier providers={providers!r})"
        )
    return {
        "passed": not problems,
        "problems": problems,
        "verdicts": verdicts,
        "providers": providers,
        "artifact_dirs": artifact_dirs,
    }


def preflight_cross_family(generator: str, verifiers: list[str]) -> None:
    """Fail fast at startup if the configured resolution roles can never pass
    the gate's cross-family rule -- otherwise the whole run quarantines."""
    if not any(name in LLM_PROVIDERS and name != generator for name in verifiers):
        raise SystemExit(
            "loop preflight: no cross-family LLM verifier configured "
            f"(generator={generator!r}, verifiers={verifiers!r}); every durable "
            "write would be quarantined. Add --verifier from a different family "
            "(e.g. claude alongside a codex generator)."
        )


def execute_durable_write(
    client: Any,
    workspace: str,
    route: int,
    proposal: dict[str, Any],
    gate: dict[str, Any],
    *,
    run_id: str,
    attempt: int,
    steps: list[str],
) -> dict[str, Any]:
    """``steps`` is appended before each sub-write so a mid-write failure
    leaves an honest trail of what actually landed."""
    gate_audit = ", ".join(gate["artifact_dirs"]) or "none"
    gate_note = (
        f"\ngate referees: {', '.join(gate['providers'])} "
        f"(verdicts: {', '.join(gate['verdicts'])})\ngate audit: {gate_audit}"
    )
    metadata = {
        "kind": LOOP_CONCLUSION_KIND,
        "run_id": run_id,
        "attempt": attempt,
        "route": route,
        "gate_artifact_dirs": gate["artifact_dirs"],
    }
    # Strip any metadata blocks the driver smuggled into its content so the
    # scaffold's stamp is the only one a parser can find.
    content = strip_chat_metadata(str(proposal["content"]))
    if proposal["action"] == "conclude_route":
        body = answer_with_metadata(
            f"## Verified route conclusion\n\n{content}"
            + verification_footer("passed")
            + gate_note,
            metadata,
        )
        steps.append("conclusion comment")
        comment = client.comment_issue(workspace, route, body)
        closed = bool(proposal.get("close", True))
        if closed:
            steps.append("close issue")
            client.close_issue(workspace, route)
        return {
            "action": "conclude_route",
            "route": route,
            "comment_id": _id_of(comment),
            "closed": closed,
            "gate_providers": gate["providers"],
            "gate_artifact_dirs": gate["artifact_dirs"],
        }
    branch = str(proposal["branch"])
    path = str(proposal["path"])
    pr_body = answer_with_metadata(
        strip_chat_metadata(str(proposal.get("body") or ""))
        + f"\n\nProposed by loop run {run_id} attempt {attempt} (route #{route})."
        + verification_footer("passed")
        + gate_note,
        metadata,
    )
    steps.append(f"create branch {branch}")
    client.create_branch(workspace, branch)
    steps.append(f"write {path}")
    client.write_branch_file(workspace, path, branch, content)
    steps.append("open pull request")
    pull_request = client.open_pull_request(
        workspace, head=branch, title=str(proposal["title"]), body=pr_body
    )
    return {
        "action": "kb_page_pr",
        "route": route,
        "branch": branch,
        "path": path,
        "pr_number": _id_of(pull_request, key="number"),
        "gate_providers": gate["providers"],
        "gate_artifact_dirs": gate["artifact_dirs"],
    }


def _id_of(response: Any, key: str = "id") -> Any:
    return response.get(key) if isinstance(response, dict) else None


# --- attempt record (Things Tried, scaffold-enforced) ---------------------------


def attempt_record_body(
    *,
    run_id: str,
    attempt: int,
    route: int,
    outcome: str,
    run_summary: str | None,
    failure_note: str | None,
    executed: list[dict[str, Any]],
    quarantined: list[tuple[dict[str, Any], list[str]]],
    driver_artifact_dir: str | None,
) -> str:
    lines = [f"## Coverify loop attempt {run_id}/{attempt} on route #{route} -- {outcome}"]
    # Driver-derived text gets its metadata blocks stripped so the scaffold's
    # stamp at the end is the only one (parse takes the first match).
    if run_summary:
        lines += ["", "```text", strip_chat_metadata(run_summary), "```"]
    if failure_note:
        lines += ["", strip_chat_metadata(failure_note)]
    if executed:
        lines += ["", "### Durable writes executed (verify gate passed)"]
        for item in executed:
            detail = ", ".join(f"{key}={value}" for key, value in sorted(item.items()) if key != "action")
            lines.append(f"- {item['action']}: {detail}")
    if quarantined:
        lines += ["", "### Quarantined durable-write proposals (verify gate FAILED)"]
        for proposal, problems in quarantined:
            lines.append(f"- {proposal.get('action')!r}: " + "; ".join(problems))
    if driver_artifact_dir:
        lines += ["", f"driver audit: {driver_artifact_dir}"]
    lines += ["", "---", "tier: attempt log -- unverified except writes listed as executed"]
    return "\n".join(lines)


def attempt_record_metadata(
    *,
    run_id: str,
    attempt: int,
    route: int,
    outcome: str,
    driver_artifact_dir: str | None,
) -> dict[str, object]:
    return {
        "kind": LOOP_ATTEMPT_KIND,
        "run_id": run_id,
        "attempt": attempt,
        "route": route,
        "outcome": outcome,
        "driver_artifact_dir": driver_artifact_dir,
    }


# --- audited computation (coverify run-check) ------------------------------------


def run_check(command: str, *, artifact_root: Path, timeout_seconds: int | None) -> dict[str, Any]:
    """Run one computational check with a sha-manifested audit bundle.

    A nonzero exit is a legitimate check result (the check failed), not an
    infrastructure error, so it is reported rather than raised.
    """
    try:
        result = run_script_backend(
            "", command=command, artifact_root=artifact_root, timeout_seconds=timeout_seconds
        )
        return {
            "ok": True,
            "returncode": 0,
            "stdout": result.answer,
            "artifact_dir": str(result.artifact_dir),
        }
    except RuntimeError as exc:
        payload: dict[str, Any] = {"ok": False, "detail": str(exc)}
        match = _ARTIFACTS_IN_ERROR_RE.search(str(exc))
        if match:
            artifact_dir = Path(match.group(1))
            payload["artifact_dir"] = str(artifact_dir)
            metadata = _read_json(artifact_dir / "metadata.json")
            if isinstance(metadata, dict):
                payload["returncode"] = metadata.get("returncode")
                payload["timed_out"] = metadata.get("timed_out")
        return payload


# --- the loop ---------------------------------------------------------------------


def run_loop(
    *,
    client: Any,
    workspace: str,
    bot_login: str,
    driver: BackendRunner,
    gate_verifiers: list[BackendRunner],
    loop_root: Path,
    run_dir: Path,
    run_id: str,
    issues: list[int] | None = None,
    route_label: str = ROUTE_LABEL_DEFAULT,
    max_attempts: int,
    max_wall_seconds: int,
    attempt_timeout: int,
    resolution_command: str,
    export_bundle: bool = True,
) -> dict[str, Any]:
    if max_attempts < 1:
        raise SystemExit("--max-attempts must be at least 1")
    lock = acquire_run_lock(
        loop_root, run_id=run_id, ttl_seconds=max(attempt_timeout, 60) + 600
    )
    try:
        return _run_loop_locked(
            client=client,
            workspace=workspace,
            bot_login=bot_login,
            driver=driver,
            gate_verifiers=gate_verifiers,
            lock=lock,
            run_dir=run_dir,
            run_id=run_id,
            issues=issues,
            route_label=route_label,
            max_attempts=max_attempts,
            max_wall_seconds=max_wall_seconds,
            attempt_timeout=attempt_timeout,
            resolution_command=resolution_command,
            export_bundle=export_bundle,
        )
    finally:
        try:  # release only our own lock -- a stale holder finishing late must
            if lock.read_text(encoding="utf-8").strip() == run_id:  # not delete the new holder's
                lock.unlink(missing_ok=True)
        except OSError:
            pass


def _resume_state(entries: list[dict[str, Any]]) -> dict[str, Any]:
    attempted = {
        entry["route"]
        for entry in entries
        if entry.get("event") in {"attempt_started", "route_skipped_closed"}
        and isinstance(entry.get("route"), int)
    }
    started = [entry for entry in entries if entry.get("event") == "attempt_started"]
    recorded = {
        entry.get("attempt") for entry in entries if entry.get("event") == "things_tried_posted"
    }
    orphans = []
    for entry in started:
        if entry.get("attempt") in recorded:
            continue
        number = entry.get("attempt")
        orphans.append(
            {
                **entry,
                # Durable writes the journal knows landed before the crash;
                # the crash record must not hide them.
                "durable_writes": [
                    write
                    for write in entries
                    if write.get("event") == "durable_write_done"
                    and write.get("attempt") == number
                ],
            }
        )
    run_started = next((entry for entry in entries if entry.get("event") == "run_started"), None)
    return {
        "attempted": attempted,
        # Budget counts started attempts: a crash between journal appends must
        # not refund spent budget.
        "attempts_done": len(started),
        "next_attempt": max(
            [int(entry.get("attempt", 0)) for entry in started] or [0]
        )
        + 1,
        "orphans": orphans,
        "run_started": run_started,
    }


def _find_posted_record(
    client: Any,
    workspace: str,
    route: int,
    *,
    run_id: str,
    attempt: int,
    bot_login: str,
) -> dict[str, Any] | None:
    """State-derived idempotency for crash recovery: the posted record itself
    is the done-marker, like the chat worker's last-commenter check."""
    try:
        timeline = client.read_issue_timeline(workspace, route)
    except Exception:  # noqa: BLE001 -- if we cannot check, fall back to posting
        return None
    for item in timeline if isinstance(timeline, list) else []:
        if not isinstance(item, dict):
            continue
        author = item.get("user") or item.get("author") or item.get("poster")
        login = author.get("login") if isinstance(author, dict) else author
        if login != bot_login:
            continue
        body = item.get("body")
        if not isinstance(body, str):
            continue
        metadata = parse_chat_metadata(body)
        if (
            metadata.get("kind") == LOOP_ATTEMPT_KIND
            and metadata.get("run_id") == run_id
            and metadata.get("attempt") == attempt
        ):
            return metadata
    return None


def _source_note(client: Any, workspace: str, run_dir: Path, export_bundle: bool) -> str:
    if not export_bundle:
        return "(no source bundle exported; ground claims in the issue thread only)"
    try:
        bundle = export_cosheaf_source_bundle(
            client, workspace=workspace, branch="main", root=run_dir / "source-bundle"
        )
    except Exception as exc:  # noqa: BLE001 -- a missing bundle degrades, not aborts
        return f"(source bundle export failed: {exc}; ground claims in the issue thread only)"
    return (
        f"Workspace snapshot (read-only) at {bundle.root} "
        f"(source_id={bundle.source_id}, snapshot={bundle.snapshot}). "
        "Repo-specific claims must cite these files."
    )


def _run_loop_locked(
    *,
    client: Any,
    workspace: str,
    bot_login: str,
    driver: BackendRunner,
    gate_verifiers: list[BackendRunner],
    lock: Path,
    run_dir: Path,
    run_id: str,
    issues: list[int] | None,
    route_label: str,
    max_attempts: int,
    max_wall_seconds: int,
    attempt_timeout: int,
    resolution_command: str,
    export_bundle: bool,
) -> dict[str, Any]:
    skill_text = run_loop_skill_text()
    state = _resume_state(journal_load(run_dir))
    attempted: set[int] = set(state["attempted"])
    attempts_done: int = state["attempts_done"]
    attempt_number: int = state["next_attempt"] - 1

    if state["run_started"] is None:
        started_epoch = time.time()
        deadline_epoch = started_epoch + max_wall_seconds
        journal_append(
            run_dir,
            {
                "event": "run_started",
                "run_id": run_id,
                "workspace": workspace,
                "started_epoch": started_epoch,
                "deadline_epoch": deadline_epoch,
                "max_attempts": max_attempts,
                "code_sha": code_sha(),
            },
        )
    else:
        deadline_epoch = float(state["run_started"].get("deadline_epoch", time.time()))
        journal_append(run_dir, {"event": "run_resumed", "run_id": run_id})

    def post_record(
        attempt: int,
        route: int,
        outcome: str,
        *,
        run_summary: str | None = None,
        failure_note: str | None = None,
        executed: list[dict[str, Any]] | None = None,
        quarantined: list[tuple[dict[str, Any], list[str]]] | None = None,
        driver_artifact_dir: str | None = None,
    ) -> bool:
        body = attempt_record_body(
            run_id=run_id,
            attempt=attempt,
            route=route,
            outcome=outcome,
            run_summary=run_summary,
            failure_note=failure_note,
            executed=executed or [],
            quarantined=quarantined or [],
            driver_artifact_dir=driver_artifact_dir,
        )
        metadata = attempt_record_metadata(
            run_id=run_id,
            attempt=attempt,
            route=route,
            outcome=outcome,
            driver_artifact_dir=driver_artifact_dir,
        )
        try:
            comment = client.comment_issue(workspace, route, answer_with_metadata(body, metadata))
        except Exception as exc:  # noqa: BLE001 -- an unrecorded attempt must abort the run
            journal_append(
                run_dir,
                {"event": "things_tried_post_failed", "attempt": attempt, "route": route, "error": str(exc)},
            )
            return False
        journal_append(
            run_dir,
            {
                "event": "things_tried_posted",
                "attempt": attempt,
                "route": route,
                "comment_id": _id_of(comment),
            },
        )
        journal_append(
            run_dir, {"event": "attempt_finished", "attempt": attempt, "route": route, "outcome": outcome}
        )
        return True

    status: str | None = None

    # A crashed prior invocation may have started an attempt without landing
    # its journal record. If the comment actually reached Cosheaf before the
    # crash, reconcile the journal instead of double-posting; otherwise land a
    # labeled crash record (showing any journaled durable writes) before any
    # new work. Started attempts already count toward the budget.
    for orphan in state["orphans"]:
        attempt = int(orphan.get("attempt", 0))
        route = int(orphan.get("route", 0))
        posted = _find_posted_record(
            client, workspace, route, run_id=run_id, attempt=attempt, bot_login=bot_login
        )
        if posted is not None:
            journal_append(
                run_dir,
                {"event": "things_tried_posted", "attempt": attempt, "route": route, "reconciled": True},
            )
            journal_append(
                run_dir,
                {
                    "event": "attempt_finished",
                    "attempt": attempt,
                    "route": route,
                    "outcome": str(posted.get("outcome") or "unknown"),
                },
            )
            continue
        if not post_record(
            attempt,
            route,
            "crash",
            failure_note=(
                "The loop process died after this attempt started and before its "
                "record landed. Durable writes listed below, if any, were "
                "executed and journaled before the crash; all other progress is "
                "unknown. The driver audit dir, if any, is under the run dir."
            ),
            executed=[
                {key: value for key, value in write.items() if key not in {"event", "ts"}}
                for write in orphan.get("durable_writes") or []
            ],
        ):
            status = "aborted_record_post_failed"

    source_note = _source_note(client, workspace, run_dir, export_bundle)
    consecutive_cycle_errors = 0

    while status is None:
        if attempts_done >= max_attempts or time.time() >= deadline_epoch:
            status = "budget_exhausted"
            break
        lock.touch()

        try:
            if issues:
                routes = [
                    {"number": number}
                    for number in issues
                    if number not in attempted
                ]
            else:
                routes = eligible_routes(
                    client, workspace, route_label=route_label, exclude=attempted
                )
            if not routes:
                status = "queue_empty"
                break

            if issues:
                route_number, pick_fallback = routes[0]["number"], False
            else:
                route_number, pick_fallback = pick_route(
                    driver, routes, workspace, heartbeat=lock.touch
                )

            issue = client.read_issue(workspace, route_number)
            if isinstance(issue, dict) and issue.get("state") == "closed":
                attempted.add(route_number)
                journal_append(run_dir, {"event": "route_skipped_closed", "route": route_number})
                continue
            timeline = client.read_issue_timeline(workspace, route_number)
        except Exception as exc:  # noqa: BLE001 -- a transient API error must not kill the night without a digest
            consecutive_cycle_errors += 1
            journal_append(run_dir, {"event": "cycle_error", "error": str(exc)[:300]})
            if consecutive_cycle_errors >= 3:
                status = "aborted_client_error"
            continue
        consecutive_cycle_errors = 0

        attempt_number += 1
        attempts_done += 1
        attempted.add(route_number)
        journal_append(
            run_dir,
            {
                "event": "route_picked",
                "attempt": attempt_number,
                "route": route_number,
                "fallback": pick_fallback,
            },
        )
        prompt = build_attempt_prompt(
            workspace=workspace,
            issue_number=route_number,
            issue=issue,
            timeline=timeline,
            bot_login=bot_login,
            skill_text=skill_text,
            resolution_command=resolution_command,
            run_dir=run_dir,
            source_note=source_note,
            attempt_timeout=attempt_timeout,
        )
        journal_append(
            run_dir,
            {
                "event": "attempt_started",
                "attempt": attempt_number,
                "route": route_number,
                "prompt_sha256": sha256_text(prompt),
            },
        )

        run_summary: str | None = None
        failure_note: str | None = None
        executed: list[dict[str, Any]] = []
        quarantined: list[tuple[dict[str, Any], list[str]]] = []
        driver_artifact_dir: str | None = None
        lock.touch()
        try:
            result: BackendResult | None = driver(prompt)
        except Exception as exc:  # noqa: BLE001 -- one bad attempt must not kill the night
            result = None
            outcome = "timeout" if "timed out" in str(exc) else "driver_error"
            failure_note = f"driver session failed: {str(exc)[:1500]}"
            artifacts_match = _ARTIFACTS_IN_ERROR_RE.search(str(exc))
            if artifacts_match:
                driver_artifact_dir = artifacts_match.group(1)
        if result is not None:
            driver_artifact_dir = str(result.artifact_dir)
            run_summary = parse_run_summary(result.answer)
            if run_summary is None:
                outcome = "invalid_output"
                failure_note = (
                    "driver output had no parseable Run Summary with "
                    f"{' and '.join(RUN_SUMMARY_REQUIRED_FIELDS)}; first 1500 chars:\n\n"
                    + result.answer[:1500]
                )
            else:
                outcome = "completed"
                proposals, parse_problems = parse_durable_writes(result.answer)
                for problem in parse_problems:
                    quarantined.append(({"action": "(unparsed)"}, [problem]))
                    journal_append(
                        run_dir,
                        {
                            "event": "durable_write_quarantined",
                            "attempt": attempt_number,
                            "route": route_number,
                            "problems": [problem],
                        },
                    )
                for proposal in proposals:
                    problems = proposal_shape_problems(proposal)
                    if not problems:
                        candidate = str(proposal["content"])
                        if proposal.get("action") == "kb_page_pr" and str(proposal.get("body") or "").strip():
                            # The PR description travels under the verified
                            # footer too, so the referees must see it.
                            candidate += "\n\n---\nPR description:\n" + str(proposal["body"])
                        gate = verify_proposal(
                            gate_verifiers,
                            original=build_gate_original(
                                route_number, issue, str(proposal.get("claim") or "")
                            ),
                            candidate=candidate,
                            author_provider=result.provider,
                            heartbeat=lock.touch,
                        )
                        problems = list(gate["problems"])
                        if problems and gate["artifact_dirs"]:
                            problems.append("gate audit: " + ", ".join(gate["artifact_dirs"]))
                    if not problems:
                        steps: list[str] = []
                        try:
                            details = execute_durable_write(
                                client,
                                workspace,
                                route_number,
                                proposal,
                                gate,
                                run_id=run_id,
                                attempt=attempt_number,
                                steps=steps,
                            )
                        except Exception as exc:  # noqa: BLE001 -- a failed write is quarantined, not fatal
                            problems = [
                                f"write failed during {steps[-1] if steps else 'setup'!r} "
                                f"(attempted steps: {steps!r}): {exc}"
                            ]
                            if steps:
                                journal_append(
                                    run_dir,
                                    {
                                        "event": "durable_write_partial",
                                        "attempt": attempt_number,
                                        "route": route_number,
                                        "action": proposal.get("action"),
                                        "steps": steps,
                                        "error": str(exc)[:300],
                                    },
                                )
                    if problems:
                        quarantined.append((proposal, problems))
                        journal_append(
                            run_dir,
                            {
                                "event": "durable_write_quarantined",
                                "attempt": attempt_number,
                                "route": route_number,
                                "action": proposal.get("action"),
                                "problems": problems,
                            },
                        )
                    else:
                        executed.append(details)
                        journal_append(
                            run_dir,
                            {
                                "event": "durable_write_done",
                                "attempt": attempt_number,
                                "route": route_number,
                                **details,
                            },
                        )

        journal_append(
            run_dir,
            {
                "event": "driver_done",
                "attempt": attempt_number,
                "route": route_number,
                "outcome": outcome,
                "artifact_dir": driver_artifact_dir,
            },
        )
        if not post_record(
            attempt_number,
            route_number,
            outcome,
            run_summary=run_summary,
            failure_note=failure_note,
            executed=executed,
            quarantined=quarantined,
            driver_artifact_dir=driver_artifact_dir,
        ):
            status = "aborted_record_post_failed"

    journal_append(run_dir, {"event": "run_finished", "status": status, "attempts": attempts_done})
    return write_digest(
        client=client,
        workspace=workspace,
        bot_login=bot_login,
        run_dir=run_dir,
        run_id=run_id,
        route_label=route_label,
        status=status,
        max_attempts=max_attempts,
        max_wall_seconds=max_wall_seconds,
    )


# --- dry run --------------------------------------------------------------------


def prepare_loop_llm_input(
    *,
    client: Any,
    workspace: str,
    bot_login: str,
    run_dir: Path,
    issues: list[int] | None,
    route_label: str,
    resolution_command: str,
    attempt_timeout: int,
    export_bundle: bool = True,
) -> dict[str, Any]:
    if issues:
        routes: list[dict[str, Any]] = [{"number": number} for number in issues]
    else:
        routes = eligible_routes(client, workspace, route_label=route_label, exclude=set())
    payload: dict[str, Any] = {
        "step": "driver",
        "workspace": workspace,
        "eligible_routes": [route["number"] for route in routes],
        "resolution_command": resolution_command,
        "durable_write_actions": list(DURABLE_WRITE_ACTIONS),
        "durable_cosheaf_writes_in_full_run": [
            "one attempt-record comment per attempt (always)",
            "conclude_route comment + close-issue (gated)",
            "kb_page_pr branch + file + open PR, never merged (gated)",
        ],
    }
    if not routes:
        payload["step"] = "none"
        payload["prompt"] = ""
        return payload
    route_number = routes[0]["number"]
    issue = client.read_issue(workspace, route_number)
    timeline = client.read_issue_timeline(workspace, route_number)
    prompt = build_attempt_prompt(
        workspace=workspace,
        issue_number=route_number,
        issue=issue,
        timeline=timeline,
        bot_login=bot_login,
        skill_text=run_loop_skill_text(),
        resolution_command=resolution_command,
        run_dir=run_dir,
        source_note=_source_note(client, workspace, run_dir, export_bundle),
        attempt_timeout=attempt_timeout,
    )
    payload["route"] = route_number
    payload["prompt"] = prompt
    payload["prompt_sha256"] = sha256_text(prompt)
    return payload


# --- morning digest ----------------------------------------------------------------


def _audit_bot_writes(
    client: Any,
    workspace: str,
    *,
    bot_login: str,
    run_id: str,
    routes: list[int],
    entries: list[dict[str, Any]],
) -> dict[str, Any]:
    """Defense-in-depth: every bot comment stamped with this run_id should
    match a journaled write. A mismatch usually means a scaffold bug or
    another actor, but out-of-band reruns (write_digest after manual edits)
    can also trip it -- it is a flag to investigate, not a verdict."""
    expected: dict[int, int] = {}
    for entry in entries:
        if (
            entry.get("event") == "things_tried_posted"
            or (
                entry.get("event") == "durable_write_done"
                and entry.get("action") == "conclude_route"
            )
            or (
                # A half-applied conclude_route may still have landed its comment.
                entry.get("event") == "durable_write_partial"
                and "conclusion comment" in (entry.get("steps") or [])
            )
        ):
            route = entry.get("route")
            if isinstance(route, int):
                expected[route] = expected.get(route, 0) + 1
    mismatches: list[str] = []
    checked: list[int] = []
    for route in routes:
        try:
            timeline = client.read_issue_timeline(workspace, route)
        except Exception as exc:  # noqa: BLE001 -- audit degrades, not aborts
            mismatches.append(f"route #{route}: timeline unavailable ({exc})")
            continue
        observed = 0
        for item in timeline if isinstance(timeline, list) else []:
            if not isinstance(item, dict):
                continue
            author = item.get("user") or item.get("author") or item.get("poster")
            login = author.get("login") if isinstance(author, dict) else author
            if login != bot_login:
                continue
            body = item.get("body")
            if isinstance(body, str) and parse_chat_metadata(body).get("run_id") == run_id:
                observed += 1
        checked.append(route)
        if observed != expected.get(route, 0):
            mismatches.append(
                f"route #{route}: journal records {expected.get(route, 0)} bot writes "
                f"for this run, timeline shows {observed}"
            )
    return {"checked_routes": checked, "mismatches": mismatches}


def write_digest(
    *,
    client: Any,
    workspace: str,
    bot_login: str,
    run_dir: Path,
    run_id: str,
    route_label: str,
    status: str | None,
    max_attempts: int,
    max_wall_seconds: int,
) -> dict[str, Any]:
    entries = journal_load(run_dir)
    run_started = next((entry for entry in entries if entry.get("event") == "run_started"), {})
    started_epoch = float(run_started.get("started_epoch") or time.time())

    attempts: list[dict[str, Any]] = []
    for start in (entry for entry in entries if entry.get("event") == "attempt_started"):
        number = start.get("attempt")

        def event_for(name: str) -> dict[str, Any]:
            return next(
                (
                    entry
                    for entry in entries
                    if entry.get("event") == name and entry.get("attempt") == number
                ),
                {},
            )

        finish = event_for("attempt_finished")
        attempts.append(
            {
                "attempt": number,
                "route": start.get("route"),
                "outcome": finish.get("outcome") or "unrecorded (crashed mid-attempt)",
                "driver_artifact_dir": event_for("driver_done").get("artifact_dir"),
                "things_tried_comment_id": event_for("things_tried_posted").get("comment_id"),
            }
        )

    verified_writes = [
        {key: value for key, value in entry.items() if key not in {"event", "ts"}}
        for entry in entries
        if entry.get("event") == "durable_write_done"
    ]
    quarantined = [
        {key: value for key, value in entry.items() if key not in {"event", "ts"}}
        for entry in entries
        if entry.get("event") == "durable_write_quarantined"
    ]
    dead_routes = sorted(
        {
            entry["route"]
            for entry in entries
            if entry.get("event") == "durable_write_done"
            and entry.get("action") == "conclude_route"
            and entry.get("closed")
            and isinstance(entry.get("route"), int)
        }
    )
    pick_fallbacks = [
        entry.get("route")
        for entry in entries
        if entry.get("event") == "route_picked" and entry.get("fallback")
    ]
    attempted_routes = sorted(
        {
            entry["route"]
            for entry in entries
            if entry.get("event") == "attempt_started" and isinstance(entry.get("route"), int)
        }
    )
    frontier: list[int] | None
    try:
        frontier = [
            issue["number"]
            for issue in eligible_routes(client, workspace, route_label=route_label, exclude=set())
        ]
    except Exception:  # noqa: BLE001 -- frontier listing degrades, not aborts
        frontier = None  # unavailable, which is not the same as empty

    digest: dict[str, Any] = {
        "run_id": run_id,
        "workspace": workspace,
        "status": status,
        "code_sha": run_started.get("code_sha") or code_sha(),
        "budget": {
            "attempts_used": len(attempts),
            "max_attempts": max_attempts,
            "wall_seconds_used": round(time.time() - started_epoch, 1),
            "max_wall_seconds": max_wall_seconds,
        },
        "attempts": attempts,
        "verified_writes": verified_writes,
        "quarantined": quarantined,
        "dead_routes": dead_routes,
        "open_frontier": frontier,
        "route_pick_fallbacks": pick_fallbacks,
        "bypass_audit": _audit_bot_writes(
            client,
            workspace,
            bot_login=bot_login,
            run_id=run_id,
            routes=attempted_routes,
            entries=entries,
        ),
        "run_dir": str(run_dir),
        "journal": str(run_dir / "journal.jsonl"),
    }
    (run_dir / "digest.json").write_text(
        json.dumps(digest, indent=2, sort_keys=True), encoding="utf-8"
    )
    (run_dir / "digest.md").write_text(render_digest_md(digest), encoding="utf-8")
    digest["digest_md"] = str(run_dir / "digest.md")
    digest["digest_json"] = str(run_dir / "digest.json")
    return digest


def render_digest_md(digest: dict[str, Any]) -> str:
    budget = digest["budget"]
    lines = [
        f"# Coverify loop digest: {digest['run_id']}",
        "",
        f"- workspace: {digest['workspace']}",
        f"- status: {digest['status']}",
        f"- code sha: {digest['code_sha']}",
        f"- budget: {budget['attempts_used']}/{budget['max_attempts']} attempts, "
        f"{budget['wall_seconds_used']}/{budget['max_wall_seconds']} wall seconds",
        f"- journal: {digest['journal']}",
        "",
        "## Attempts",
        "",
    ]
    for attempt in digest["attempts"] or []:
        lines.append(
            f"- attempt {attempt['attempt']} on route #{attempt['route']}: "
            f"{attempt['outcome']} (driver audit: {attempt['driver_artifact_dir'] or 'none'})"
        )
    if not digest["attempts"]:
        lines.append("- (none)")
    lines += ["", "## Verified durable writes", ""]
    for item in digest["verified_writes"] or []:
        detail = ", ".join(f"{key}={value}" for key, value in sorted(item.items()))
        lines.append(f"- {detail}")
    if not digest["verified_writes"]:
        lines.append("- (none)")
    lines += ["", "## Quarantined proposals", ""]
    for item in digest["quarantined"] or []:
        lines.append(f"- attempt {item.get('attempt')}: {'; '.join(item.get('problems') or [])}")
    if not digest["quarantined"]:
        lines.append("- (none)")
    lines += [
        "",
        "## Dead routes (closed this run)",
        "",
        "- " + (", ".join(f"#{route}" for route in digest["dead_routes"]) or "(none)"),
        "",
        "## Open frontier (route issues still open)",
        "",
        "- "
        + (
            "(listing unavailable)"
            if digest["open_frontier"] is None
            else ", ".join(f"#{route}" for route in digest["open_frontier"]) or "(none)"
        ),
        "",
        "## Route-pick fallbacks",
        "",
        "- " + (", ".join(f"#{route}" for route in digest["route_pick_fallbacks"]) or "(none)"),
        "",
        "## Bypass audit",
        "",
    ]
    mismatches = digest["bypass_audit"].get("mismatches") or []
    if mismatches:
        lines += [f"- MISMATCH: {item}" for item in mismatches]
    else:
        lines.append(
            "- clean: every bot write stamped with this run id matches a journal event "
            f"(checked routes: {digest['bypass_audit'].get('checked_routes')})"
        )
    return "\n".join(lines) + "\n"

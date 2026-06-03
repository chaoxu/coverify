from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Callable

from .engine.backend import (
    BackendResult,
    run_codex_backend,
    run_fixture_backend,
    run_script_backend,
)
from .engine.verifying import (
    Step,
    VerifyingOracle,
    builtin_profile,
    load_verifying_config,
    verifying_config_from_dict,
)
from .cosheaf.client import CosheafClient, CosheafConfig
from .integration.chat import extract_login, extract_turns, run_chat_reply
from .integration.chat_metadata import (
    answer_with_metadata,
    chat_issue_body,
    chat_reply_metadata,
    parse_chat_metadata,
)
from .integration.repo_oracle import (
    export_cosheaf_source_bundle,
    gather_context,
    load_source_bundle,
    run_repo_oracle,
)
from .integration.review import REVIEW_DECISION_VALUES, ReviewDecision
from .integration.workflows import (
    InfinitePrimesRunOptions,
    default_branch_name,
    run_ask_oracle,
    run_infinite_primes_workflow,
)
from .apps.evals import load_eval_cases, run_eval_cases
from .apps.research_evals import (
    load_research_eval_candidates,
    seed_research_eval_workspace,
    utc_stamp,
)

SUB_BACKEND_CHOICES = ("codex", "fixture", "script")
BACKEND_CHOICES = (*SUB_BACKEND_CHOICES, "verifying")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def truthy(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


def build_client(
    *,
    api_url: str,
    token: str,
    username: str,
    password: str,
    tls_verify: bool = True,
) -> CosheafClient:
    base = CosheafClient(CosheafConfig(api_url=api_url, tls_verify=tls_verify))
    if token:
        return CosheafClient(CosheafConfig(api_url=api_url, token=token, tls_verify=tls_verify))
    if username and password:
        return CosheafClient(CosheafConfig(api_url=api_url, token=base.login(username, password), tls_verify=tls_verify))
    raise SystemExit("provide --token or --username/--password (or matching COSHEAF_* env vars)")


def maybe_build_reviewer_client(args: argparse.Namespace) -> CosheafClient | None:
    if args.review_token or (args.review_username and args.review_password):
        return build_client(
            api_url=args.api_url,
            token=args.review_token,
            username=args.review_username,
            password=args.review_password,
            tls_verify=not args.insecure,
        )
    return None


def build_base_runner(
    args: argparse.Namespace,
    backend_name: str,
    *,
    command: str | None = None,
    model: str | None = None,
    reasoning_effort: str | None = None,
) -> Callable[[str], BackendResult]:
    artifact_root = Path(args.run_dir)
    timeout = args.backend_timeout if args.backend_timeout > 0 else None
    if backend_name == "fixture":
        return lambda prompt: run_fixture_backend(prompt, artifact_root=artifact_root)
    if backend_name == "script":
        cmd = command or args.backend_command
        if not cmd:
            raise SystemExit("--backend-command is required when --backend=script")
        return lambda prompt: run_script_backend(
            prompt,
            command=cmd,
            artifact_root=artifact_root,
            timeout_seconds=timeout,
        )
    if backend_name == "codex":
        if not args.allow_codex_backend:
            raise SystemExit(
                "codex backend is disabled by default because it consumes Codex usage; "
                "set COVERIFY_ALLOW_CODEX_BACKEND=1 or pass --allow-codex-backend"
            )
        return lambda prompt: run_codex_backend(
            prompt,
            artifact_root=artifact_root,
            model=model or args.model,
            reasoning_effort=reasoning_effort or args.reasoning_effort,
            timeout_seconds=timeout,
            codex_bin=args.codex_bin,
            sandbox=args.codex_sandbox,
        )
    raise SystemExit(f"unknown backend: {backend_name}")


def resolve_verifying_config(args: argparse.Namespace):
    if args.verify_config:
        return load_verifying_config(Path(args.verify_config))
    if args.verify_profile and args.verify_profile != "default":
        return builtin_profile(args.verify_profile, max_rounds=args.verify_max_rounds)
    return verifying_config_from_dict({"max_rounds": args.verify_max_rounds})


def build_verifying_oracle(args: argparse.Namespace, config) -> VerifyingOracle:
    def step(step_config) -> Step:
        backend_name = step_config.backend or args.verify_inner_backend
        runner = build_base_runner(
            args,
            backend_name,
            command=step_config.command,
            model=step_config.model,
            reasoning_effort=step_config.reasoning_effort,
        )
        return Step(runner=runner, instructions=step_config.instructions)

    return VerifyingOracle(
        generator=step(config.generator),
        verifiers=[step(v) for v in config.verifiers],
        adjudicator=step(config.adjudicator),
        artifact_root=Path(args.run_dir),
        max_rounds=config.max_rounds,
        retries=args.backend_retries,
        strict=config.strict or args.verify_strict,
        quiet_adjunct=config.quiet_adjunct or args.verify_quiet_adjunct,
        resume_dir=Path(args.verify_resume) if args.verify_resume else None,
    )


def backend_runner(args: argparse.Namespace) -> Callable[[str], BackendResult]:
    if args.backend == "verifying":
        return build_verifying_oracle(args, resolve_verifying_config(args))
    return build_base_runner(args, args.backend)


def verifier_runner(args: argparse.Namespace) -> Callable[[str], BackendResult] | None:
    backend_name = getattr(args, "verifier_backend", "") or ""
    if not backend_name:
        return None
    return build_base_runner(
        args,
        backend_name,
        command=getattr(args, "verifier_command", "") or None,
        model=getattr(args, "verifier_model", "") or None,
        reasoning_effort=getattr(args, "verifier_reasoning_effort", "") or None,
    )


def gatherer_runner(args: argparse.Namespace) -> Callable[[str], BackendResult] | None:
    backend_name = getattr(args, "gatherer_backend", "") or ""
    if not backend_name:
        return None
    return build_base_runner(
        args,
        backend_name,
        command=getattr(args, "gatherer_command", "") or None,
        model=getattr(args, "gatherer_model", "") or None,
        reasoning_effort=getattr(args, "gatherer_reasoning_effort", "") or None,
    )


def cmd_login(args: argparse.Namespace) -> int:
    client = CosheafClient(CosheafConfig(api_url=args.api_url, tls_verify=not args.insecure))
    print(client.login(args.username, args.password))
    return 0


def cmd_create_workspace(args: argparse.Namespace) -> int:
    client = build_client(
        api_url=args.api_url,
        token=args.token,
        username=args.username,
        password=args.password,
        tls_verify=not args.insecure,
    )
    result = client.create_workspace(
        args.workspace,
        args.workspace_name or args.workspace,
        default_md_format=args.default_md_format,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def cmd_set_member(args: argparse.Namespace) -> int:
    return print_json(
        authed_client_from_args(args).set_workspace_member(
            args.workspace,
            args.member,
            args.role,
        ),
    )


def authed_client_from_args(args: argparse.Namespace) -> CosheafClient:
    return build_client(
        api_url=args.api_url,
        token=args.token,
        username=args.username,
        password=args.password,
        tls_verify=not args.insecure,
    )


def print_json(value: object) -> int:
    print(json.dumps(value, indent=2, sort_keys=True))
    return 0


def write_scaffold_file(path: Path, content: str, *, force: bool = False, executable: bool = False) -> bool:
    if path.exists() and not force:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(path.stat().st_mode | 0o755)
    return True


def cmd_scaffold_workdir(args: argparse.Namespace) -> int:
    workspace = args.workspace
    root = Path(args.works_root).expanduser()
    workdir = root / workspace
    coverify_checkout = str(Path(args.coverify_checkout).expanduser())
    qed_root = str(Path(args.qed_root).expanduser())
    force = bool(args.force)
    refresh_tools = bool(args.refresh_tools)

    files: dict[Path, tuple[str, bool]] = {
        workdir / ".gitignore": (
            ".coverify/\n.env.local\nqed_output/\nproblem.tex\n",
            False,
        ),
        workdir / ".env.example": (
            "\n".join(
                [
                    "# Copy to .env.local for shell-local overrides. Do not commit secrets.",
                    "",
                    'export COSHEAF_API_URL="http://localhost:3030/api/v1"',
                    f'export COSHEAF_WORKSPACE="{workspace}"',
                    'export COSHEAF_INSECURE="0"',
                    "",
                    "# Provide one auth method in your shell or .env.local:",
                    "# export COSHEAF_TOKEN=<token>",
                    "# export COSHEAF_USERNAME=<username>",
                    "# export COSHEAF_PASSWORD=<password>",
                    "",
                    f'export COVERIFY_CHECKOUT="{coverify_checkout}"',
                    f'export QED_ROOT="{qed_root}"',
                    f'export QED_CONFIG="{workdir / "config" / "qed-codex-low.yaml"}"',
                    f'export QED_CHATGPT_CONFIG="{workdir / "config" / "qed-chatgpt-oracle.yaml"}"',
                    'export CHATGPT_CLI="chatgpt-cli"',
                    'export COVERIFY_CHATGPT_TIMEOUT_SECONDS="6000"',
                    'export QED_CHATGPT_TIMEOUT_SECONDS="6000"',
                    "",
                ],
            ),
            False,
        ),
        workdir / "bin" / "coverify": (
            "\n".join(
                [
                    "#!/usr/bin/env bash",
                    "set -euo pipefail",
                    "",
                    'WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"',
                    'if [ -f "$WORKDIR/.env.local" ]; then',
                    "  # shellcheck disable=SC1091",
                    '  source "$WORKDIR/.env.local"',
                    "fi",
                    "",
                    'export COSHEAF_API_URL="${COSHEAF_API_URL:-http://localhost:3030/api/v1}"',
                    f'export COSHEAF_WORKSPACE="${{COSHEAF_WORKSPACE:-{workspace}}}"',
                    'export COSHEAF_INSECURE="${COSHEAF_INSECURE:-0}"',
                    f'export COVERIFY_CHECKOUT="${{COVERIFY_CHECKOUT:-{coverify_checkout}}}"',
                    'export COVERIFY_RUN_DIR="${COVERIFY_RUN_DIR:-$WORKDIR/.coverify/runs}"',
                    "",
                    'cd "$WORKDIR"',
                    'exec env PYTHONPATH="$COVERIFY_CHECKOUT/src${PYTHONPATH:+:$PYTHONPATH}" python3 -m coverify "$@"',
                    "",
                ],
            ),
            True,
        ),
        workdir / "bin" / "chatgpt-coverify": (
            "\n".join(
                [
                    "#!/usr/bin/env bash",
                    "set -euo pipefail",
                    "",
                    'WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"',
                    'if [ -f "$WORKDIR/.env.local" ]; then',
                    "  # shellcheck disable=SC1091",
                    '  source "$WORKDIR/.env.local"',
                    "fi",
                    "",
                    f'COVERIFY_CHECKOUT="${{COVERIFY_CHECKOUT:-{coverify_checkout}}}"',
                    'CHATGPT_CLI="${CHATGPT_CLI:-chatgpt-cli}"',
                    'ADAPTER="$COVERIFY_CHECKOUT/scripts/chatgpt_oracle_backend.py"',
                    'CHATGPT_TIMEOUT="${COVERIFY_CHATGPT_TIMEOUT_SECONDS:-6000}"',
                    'BACKEND_TIMEOUT="${COVERIFY_BACKEND_TIMEOUT_SECONDS:-$((CHATGPT_TIMEOUT + 90))}"',
                    "",
                    'if [ ! -x "$ADAPTER" ]; then',
                    '  echo "ChatGPT adapter not executable: $ADAPTER" >&2',
                    "  exit 2",
                    "fi",
                    'if [[ "$CHATGPT_CLI" == */* ]]; then',
                    '  if [ ! -x "$CHATGPT_CLI" ]; then',
                    '    echo "chatgpt-cli not executable: $CHATGPT_CLI" >&2',
                    "    exit 2",
                    "  fi",
                    'elif ! command -v "$CHATGPT_CLI" >/dev/null 2>&1; then',
                    '  echo "chatgpt-cli not found on PATH: $CHATGPT_CLI" >&2',
                    "  exit 2",
                    "fi",
                    "",
                    'BACKEND_COMMAND="CHATGPT_CLI=$CHATGPT_CLI python3 $ADAPTER --chatgpt-cli $CHATGPT_CLI --timeout $CHATGPT_TIMEOUT"',
                    "",
                    'if [ "$#" -gt 0 ]; then',
                    '  exec "$WORKDIR/bin/coverify" ask-oracle \\',
                    "    --backend script \\",
                    '    --backend-timeout "$BACKEND_TIMEOUT" \\',
                    '    --backend-command "$BACKEND_COMMAND" \\',
                    '    --prompt "$*"',
                    "fi",
                    "",
                    'exec "$WORKDIR/bin/coverify" ask-oracle \\',
                    "  --backend script \\",
                    '  --backend-timeout "$BACKEND_TIMEOUT" \\',
                    '  --backend-command "$BACKEND_COMMAND" \\',
                    "  --prompt-file -",
                    "",
                ],
            ),
            True,
        ),
        workdir / "bin" / "qed-coverify": (
            "\n".join(
                [
                    "#!/usr/bin/env bash",
                    "set -euo pipefail",
                    "",
                    'WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"',
                    'if [ -f "$WORKDIR/.env.local" ]; then',
                    "  # shellcheck disable=SC1091",
                    '  source "$WORKDIR/.env.local"',
                    "fi",
                    "",
                    f'COVERIFY_CHECKOUT="${{COVERIFY_CHECKOUT:-{coverify_checkout}}}"',
                    f'QED_ROOT="${{QED_ROOT:-{qed_root}}}"',
                    'QED_CONFIG="${QED_CONFIG:-$WORKDIR/config/qed-codex-low.yaml}"',
                    'ADAPTER="$COVERIFY_CHECKOUT/scripts/qed_backend.py"',
                    'QED_TIMEOUT="${COVERIFY_QED_TIMEOUT_SECONDS:-1800}"',
                    'BACKEND_TIMEOUT="${COVERIFY_BACKEND_TIMEOUT_SECONDS:-2100}"',
                    "",
                    'if [ ! -x "$ADAPTER" ]; then',
                    '  echo "QED adapter not executable: $ADAPTER" >&2',
                    "  exit 2",
                    "fi",
                    'if [ ! -d "$QED_ROOT" ]; then',
                    '  echo "QED checkout not found: $QED_ROOT" >&2',
                    "  exit 2",
                    "fi",
                    'if [ ! -f "$QED_CONFIG" ]; then',
                    '  echo "QED config not found: $QED_CONFIG" >&2',
                    "  exit 2",
                    "fi",
                    "",
                    'BACKEND_COMMAND="PATH=$QED_ROOT/.coverify-bin:\\$PATH python3 $ADAPTER --qed-root $QED_ROOT --config $QED_CONFIG --timeout $QED_TIMEOUT"',
                    "",
                    'if [ "$#" -gt 0 ]; then',
                    '  exec "$WORKDIR/bin/coverify" ask-oracle \\',
                    "    --backend script \\",
                    '    --backend-timeout "$BACKEND_TIMEOUT" \\',
                    '    --backend-command "$BACKEND_COMMAND" \\',
                    '    --prompt "$*"',
                    "fi",
                    "",
                    'exec "$WORKDIR/bin/coverify" ask-oracle \\',
                    "  --backend script \\",
                    '  --backend-timeout "$BACKEND_TIMEOUT" \\',
                    '  --backend-command "$BACKEND_COMMAND" \\',
                    "  --prompt-file -",
                    "",
                ],
            ),
            True,
        ),
        workdir / "bin" / "qed-chatgpt-coverify": (
            "\n".join(
                [
                    "#!/usr/bin/env bash",
                    "set -euo pipefail",
                    "",
                    'WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"',
                    'if [ -f "$WORKDIR/.env.local" ]; then',
                    "  # shellcheck disable=SC1091",
                    '  source "$WORKDIR/.env.local"',
                    "fi",
                    "",
                    f'COVERIFY_CHECKOUT="${{COVERIFY_CHECKOUT:-{coverify_checkout}}}"',
                    f'QED_ROOT="${{QED_ROOT:-{qed_root}}}"',
                    'QED_CONFIG="${QED_CHATGPT_CONFIG:-$WORKDIR/config/qed-chatgpt-oracle.yaml}"',
                    'ADAPTER="$COVERIFY_CHECKOUT/scripts/qed_backend.py"',
                    'QED_TIMEOUT="${COVERIFY_QED_CHATGPT_TIMEOUT_SECONDS:-0}"',
                    'BACKEND_TIMEOUT="${COVERIFY_BACKEND_TIMEOUT_SECONDS:-21600}"',
                    "",
                    'if [ ! -x "$ADAPTER" ]; then',
                    '  echo "QED adapter not executable: $ADAPTER" >&2',
                    "  exit 2",
                    "fi",
                    'if [ ! -d "$QED_ROOT" ]; then',
                    '  echo "QED checkout not found: $QED_ROOT" >&2',
                    "  exit 2",
                    "fi",
                    'if [ ! -f "$QED_CONFIG" ]; then',
                    '  echo "QED ChatGPT config not found: $QED_CONFIG" >&2',
                    "  exit 2",
                    "fi",
                    "",
                    'BACKEND_COMMAND="PATH=$QED_ROOT/.coverify-bin:\\$PATH python3 $ADAPTER --qed-root $QED_ROOT --config $QED_CONFIG --timeout $QED_TIMEOUT"',
                    "",
                    'if [ "$#" -gt 0 ]; then',
                    '  exec "$WORKDIR/bin/coverify" ask-oracle \\',
                    "    --backend script \\",
                    '    --backend-timeout "$BACKEND_TIMEOUT" \\',
                    '    --backend-command "$BACKEND_COMMAND" \\',
                    '    --prompt "$*"',
                    "fi",
                    "",
                    'exec "$WORKDIR/bin/coverify" ask-oracle \\',
                    "  --backend script \\",
                    '  --backend-timeout "$BACKEND_TIMEOUT" \\',
                    '  --backend-command "$BACKEND_COMMAND" \\',
                    "  --prompt-file -",
                    "",
                ],
            ),
            True,
        ),
        workdir / "config" / "qed-chatgpt-oracle.yaml": (
            "\n".join(
                [
                    "claude:",
                    '  cli_path: "claude"',
                    '  permission_mode: "bypassPermissions"',
                    '  provider: "subscription"',
                    "  subscription:",
                    '    model: "sonnet"',
                    "  bedrock:",
                    '    model: "us.anthropic.claude-opus-4-6-v1[1m]"',
                    '    aws_profile: "default"',
                    "  api_key:",
                    '    model: "claude-opus-4-6"',
                    '    key: ""',
                    "",
                    "codex:",
                    '  cli_path: "codex"',
                    '  model: "gpt-5.5"',
                    '  reasoning_effort: "xhigh"',
                    "",
                    "chatgpt:",
                    '  cli_path: "chatgpt-cli"',
                    '  model: "chatgpt-pro-extended"',
                    "  timeout_seconds: 6000",
                    "  process_grace_seconds: 30",
                    "",
                    "gemini:",
                    '  cli_path: "gemini"',
                    '  model: "gemini-3.1-pro-preview"',
                    '  approval_mode: "yolo"',
                    '  thinking_level: "LOW"',
                    '  api_key: ""',
                    "",
                    "prover:",
                    '  mode: "decomposition"',
                    "",
                    "pipeline:",
                    "  literature_survey:",
                    '    provider: "chatgpt"',
                    "  proof_summary:",
                    '    provider: "chatgpt"',
                    "",
                    "decomposition:",
                    "  max_proof_attempts: 1",
                    "  max_revisions: 1",
                    "  max_decompositions: 1",
                    "  models:",
                    "    decomposer:",
                    '      provider: "chatgpt"',
                    "    single_prover:",
                    '      provider: "chatgpt"',
                    "    regulator:",
                    '      provider: "chatgpt"',
                    "    structural_verifier:",
                    '      provider: "chatgpt"',
                    "    detailed_verifier:",
                    '      provider: "chatgpt"',
                    "    verdict:",
                    '      provider: "chatgpt"',
                    "",
                    "standalone_verifier:",
                    "  judge:",
                    '    provider: "chatgpt"',
                    "  structural_verifier:",
                    '    provider: "chatgpt"',
                    "  detailed_verifier:",
                    '    provider: "chatgpt"',
                    "  problem_reviewer:",
                    '    provider: "chatgpt"',
                    "",
                ],
            ),
            False,
        ),
        workdir / "config" / "qed-codex-low.yaml": (
            "\n".join(
                [
                    "claude:",
                    '  cli_path: "claude"',
                    '  permission_mode: "bypassPermissions"',
                    '  provider: "subscription"',
                    "  subscription:",
                    '    model: "sonnet"',
                    "  bedrock:",
                    '    model: "us.anthropic.claude-opus-4-6-v1[1m]"',
                    '    aws_profile: "default"',
                    "  api_key:",
                    '    model: "claude-opus-4-6"',
                    '    key: ""',
                    "",
                    "codex:",
                    '  cli_path: "codex"',
                    '  model: "gpt-5.4-mini"',
                    '  reasoning_effort: "low"',
                    "",
                    "gemini:",
                    '  cli_path: "gemini"',
                    '  model: "gemini-3.1-pro-preview"',
                    '  approval_mode: "yolo"',
                    '  thinking_level: "LOW"',
                    '  api_key: ""',
                    "",
                    "prover:",
                    '  mode: "decomposition"',
                    "",
                    "pipeline:",
                    "  literature_survey:",
                    '    provider: "codex"',
                    '    model: "gpt-5.4-mini"',
                    '    reasoning_effort: "low"',
                    "  proof_summary:",
                    '    provider: "codex"',
                    '    model: "gpt-5.4-mini"',
                    '    reasoning_effort: "low"',
                    "",
                    "decomposition:",
                    "  max_proof_attempts: 1",
                    "  max_revisions: 1",
                    "  max_decompositions: 1",
                    "  models:",
                    "    decomposer:",
                    '      provider: "codex"',
                    '      model: "gpt-5.4-mini"',
                    '      reasoning_effort: "low"',
                    "    single_prover:",
                    '      provider: "codex"',
                    '      model: "gpt-5.4-mini"',
                    '      reasoning_effort: "low"',
                    "    regulator:",
                    '      provider: "codex"',
                    '      model: "gpt-5.4-mini"',
                    '      reasoning_effort: "low"',
                    "    structural_verifier:",
                    '      provider: "codex"',
                    '      model: "gpt-5.4-mini"',
                    '      reasoning_effort: "low"',
                    "    detailed_verifier:",
                    '      provider: "codex"',
                    '      model: "gpt-5.4-mini"',
                    '      reasoning_effort: "low"',
                    "    verdict:",
                    '      provider: "codex"',
                    '      model: "gpt-5.4-mini"',
                    '      reasoning_effort: "low"',
                    "",
                    "standalone_verifier:",
                    "  judge:",
                    '    provider: "codex"',
                    '    model: "gpt-5.4-mini"',
                    '    reasoning_effort: "low"',
                    "  structural_verifier:",
                    '    provider: "codex"',
                    '    model: "gpt-5.4-mini"',
                    '    reasoning_effort: "low"',
                    "  detailed_verifier:",
                    '    provider: "codex"',
                    '    model: "gpt-5.4-mini"',
                    '    reasoning_effort: "low"',
                    "  problem_reviewer:",
                    '    provider: "codex"',
                    '    model: "gpt-5.4-mini"',
                    '    reasoning_effort: "low"',
                    "",
                ],
            ),
            False,
        ),
        workdir / "AGENTS.md": (
            f"# {workspace} Coverify Workspace\n\n"
            f"This directory is a local operating workspace for the Cosheaf workspace `{workspace}`.\n\n"
            "Start day-to-day Codex sessions in this directory. Use Coverify skills for longer\n"
            "runs when they are linked into Codex, and use `bin/coverify` for Cosheaf and\n"
            "oracle operations.\n\n"
            "`bin/coverify` is generated glue around the checkout named by `COVERIFY_CHECKOUT`.\n"
            "If the wrapper template changes, refresh generated tools from this directory with\n"
            "`bin/coverify scaffold-workdir --workspace "
            f"{workspace} --refresh-tools`.\n\n"
            "Use Forgejo/Cosheaf vocabulary directly: issue, branch, PR, review, merge, close.\n"
            "Durable mathematical state lives in Cosheaf, not in this directory.\n\n"
            "`PROJECT.md` should orient agents to the project. Concrete work should live in\n"
            "issues or task pages. If a task needs a checker, score script, or search tool,\n"
            "put that project-specific code in the project repo or a companion repo and\n"
            "reference it from the issue.\n\n"
            "Do not store credentials here. Put local auth in `.env.local` or your shell.\n",
            False,
        ),
        workdir / "README.md": (
            f"# {workspace}\n\n"
            f"Local operating workspace for the Cosheaf project `{workspace}`.\n\n"
            "Start Codex in this directory for project work. The `bin/coverify` wrapper\n"
            "runs the Coverify checkout named by `COVERIFY_CHECKOUT`, so the project can\n"
            "use Coverify commands without being inside the Coverify repo.\n\n"
            "If Coverify changes at the same checkout path, `bin/coverify` uses the new code\n"
            "automatically. If the generated wrappers need to be refreshed, run\n"
            "`bin/coverify scaffold-workdir --refresh-tools` from this directory. If the\n"
            "checkout path changed, update `COVERIFY_CHECKOUT` in `.env.local` first.\n\n"
            "List open issues:\n\n"
            "```bash\nbin/coverify list-issues --state open\n```\n\n"
            "Ask a project-scoped question:\n\n"
            "```bash\nbin/coverify chat ask --issue 1 --backend verifying \\\n"
            "  --message \"Read PROJECT.md and this issue, then propose the next useful step.\"\n"
            "```\n\n"
            "Run QED through Coverify:\n\n"
            "```bash\nbin/qed-coverify \"Prove that there are infinitely many prime numbers.\"\n```\n",
            False,
        ),
    }

    written: list[str] = []
    skipped: list[str] = []
    bin_dir = workdir / "bin"
    for path, (content, executable) in files.items():
        should_force = force or (refresh_tools and path.parent == bin_dir)
        if write_scaffold_file(path, content, force=should_force, executable=executable):
            written.append(str(path))
        else:
            skipped.append(str(path))
    (workdir / "evals").mkdir(parents=True, exist_ok=True)
    (workdir / "notes").mkdir(parents=True, exist_ok=True)

    return print_json(
        {
            "ok": True,
            "workspace": workspace,
            "workdir": str(workdir),
            "written": written,
            "skipped_existing": skipped,
        },
    )


def cmd_tree(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).list_workspace_files(args.workspace, branch=args.branch))


def cmd_search(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).search(args.workspace, args.query))


def cmd_list_issues(args: argparse.Namespace) -> int:
    return print_json(
        authed_client_from_args(args).list_issues(
            args.workspace,
            state=args.state,
            query=args.query or None,
        ),
    )


def cmd_read_issue(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).read_issue(args.workspace, args.issue))


def cmd_read_issue_timeline(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).read_issue_timeline(args.workspace, args.issue))


def cmd_create_issue(args: argparse.Namespace) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    return print_json(
        authed_client_from_args(args).create_issue(
            args.workspace,
            title=args.title,
            body=body,
        ),
    )


def cmd_edit_issue(args: argparse.Namespace) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    return print_json(
        authed_client_from_args(args).edit_issue(
            args.workspace,
            args.issue,
            title=args.title,
            body=body,
        ),
    )


def cmd_comment_issue(args: argparse.Namespace) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    return print_json(authed_client_from_args(args).comment_issue(args.workspace, args.issue, body))


def cmd_chat_reply(args: argparse.Namespace) -> int:
    client = authed_client_from_args(args)
    bot_login = args.bot_user or extract_login(client.me())
    if args.legacy_prompt_only:
        result = run_chat_reply(
            client=client,
            workspace=args.workspace,
            number=args.issue,
            oracle=backend_runner(args),
            bot_login=bot_login,
            oracle_provider=args.backend,
        )
        return print_json(
            {"status": result.status, "posted": result.posted, "reply": result.reply}
        )
    return print_json(
        run_repo_chat_reply(
            client=client,
            workspace=args.workspace,
            issue_number=args.issue,
            bot_login=bot_login,
            answer_backend=backend_runner(args),
            verifier_backend=verifier_runner(args),
            gatherer_backend=gatherer_runner(args),
            branch_override=args.branch or None,
            run_dir=Path(args.run_dir),
            max_context_chars=args.max_context_chars,
        ),
    )


def cmd_close_issue(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).close_issue(args.workspace, args.issue))


def cmd_reopen_issue(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).reopen_issue(args.workspace, args.issue))


def cmd_set_issue_state(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).set_issue_state(args.workspace, args.issue, args.state))


def cmd_read_file(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).read_file(args.workspace, args.path, branch=args.branch))


def cmd_create_branch(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).create_branch(args.workspace, args.branch))


def cmd_write_file(args: argparse.Namespace) -> int:
    if args.content_file == "-":
        content = os.sys.stdin.read()
    else:
        content = Path(args.content_file).read_text(encoding="utf-8")
    return print_json(
        authed_client_from_args(args).write_branch_file(
            args.workspace,
            args.path,
            args.branch,
            content,
        ),
    )


def cmd_delete_file(args: argparse.Namespace) -> int:
    return print_json(
        authed_client_from_args(args).delete_branch_file(
            args.workspace,
            args.path,
            args.branch,
        ),
    )


def cmd_open_pr(args: argparse.Namespace) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    return print_json(
        authed_client_from_args(args).open_pull_request(
            args.workspace,
            head=args.head,
            base=args.base,
            title=args.title,
            body=body,
        ),
    )


def cmd_list_prs(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).list_pull_requests(args.workspace, state=args.state))


def cmd_read_pr(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).read_pull_request(args.workspace, args.pr))


def cmd_read_pr_context(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).read_pull_request_context(args.workspace, args.pr))


def cmd_review_pr(args: argparse.Namespace) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    return print_json(
        authed_client_from_args(args).review_pull_request(
            args.workspace,
            args.pr,
            event=args.event,
            body=body,
        ),
    )


def cmd_merge_pr(args: argparse.Namespace) -> int:
    return print_json(
        authed_client_from_args(args).merge_pull_request(
            args.workspace,
            args.pr,
            method=args.method,
            force=args.force,
        ),
    )


def cmd_close_pr(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).close_pull_request(args.workspace, args.pr))


def cmd_prove_infinite_primes(args: argparse.Namespace) -> int:
    client = build_client(
        api_url=args.api_url,
        token=args.token,
        username=args.username,
        password=args.password,
        tls_verify=not args.insecure,
    )
    reviewer_client = maybe_build_reviewer_client(args)
    options = InfinitePrimesRunOptions(
        workspace=args.workspace,
        workspace_name=args.workspace_name or args.workspace,
        default_md_format=args.default_md_format,
        create_workspace=args.create_workspace,
        allow_existing_workspace=args.allow_existing_workspace,
        branch=args.branch or default_branch_name(),
        path=args.path,
        title=args.title,
        merge=args.merge,
        force_merge=args.force_merge,
    )
    runner = backend_runner(args)
    result = run_infinite_primes_workflow(
        client=client,
        reviewer_client=reviewer_client,
        backend=runner,
        review_backend=runner if reviewer_client is not None else None,
        options=options,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def read_oracle_prompt(args: argparse.Namespace) -> str:
    sources = sum(bool(source) for source in (args.message, args.prompt, args.prompt_file))
    if sources > 1:
        raise SystemExit("provide only one oracle prompt source: message args, --prompt, or --prompt-file")
    if args.prompt_file:
        if args.prompt_file == "-":
            return sys.stdin.read()
        return Path(args.prompt_file).read_text(encoding="utf-8")
    if args.prompt:
        return args.prompt
    if args.message:
        return " ".join(args.message)
    return sys.stdin.read()


def read_message_input(args: argparse.Namespace) -> str:
    sources = sum(
        bool(source)
        for source in (
            getattr(args, "message_text", ""),
            getattr(args, "message_file", ""),
            getattr(args, "message", []),
        )
    )
    if sources > 1:
        raise SystemExit("provide only one message source: message args, --message, or --message-file")
    if getattr(args, "message_file", ""):
        path = args.message_file
        if path == "-":
            return sys.stdin.read()
        return Path(path).read_text(encoding="utf-8")
    if getattr(args, "message_text", ""):
        return args.message_text
    positional = getattr(args, "message", [])
    if positional:
        return " ".join(positional)
    return sys.stdin.read()


def has_message_source(args: argparse.Namespace) -> bool:
    return any(
        bool(source)
        for source in (
            getattr(args, "message_text", ""),
            getattr(args, "message_file", ""),
            getattr(args, "message", []),
        )
    )


def cmd_ask_oracle(args: argparse.Namespace) -> int:
    result = run_ask_oracle(
        prompt=read_oracle_prompt(args),
        backend=backend_runner(args),
        retries=args.backend_retries,
    )
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    answer = str(result["answer"])
    print(answer, end="" if answer.endswith("\n") else "\n")
    return 0


def cmd_repo_oracle_ask(args: argparse.Namespace) -> int:
    question = read_message_input(args)
    thread_context = ""
    if args.thread_file:
        thread_context = sys.stdin.read() if args.thread_file == "-" else Path(args.thread_file).read_text(encoding="utf-8")
    bundle = load_source_bundle(
        Path(args.source_bundle),
        source_id=args.source_id or None,
        max_file_bytes=args.max_file_bytes,
    )
    result = run_repo_oracle(
        bundle=bundle,
        question=question,
        answer_backend=backend_runner(args),
        verifier_backend=verifier_runner(args),
        gatherer_backend=gatherer_runner(args),
        thread_context=thread_context,
        max_context_chars=args.max_context_chars,
    )
    if args.json:
        print(json.dumps(result.to_json(), indent=2, sort_keys=True))
    else:
        print(result.answer, end="" if result.answer.endswith("\n") else "\n")
    return 0


def cmd_repo_oracle_gather(args: argparse.Namespace) -> int:
    question = read_message_input(args)
    thread_context = ""
    if args.thread_file:
        thread_context = sys.stdin.read() if args.thread_file == "-" else Path(args.thread_file).read_text(encoding="utf-8")
    bundle = load_source_bundle(
        Path(args.source_bundle),
        source_id=args.source_id or None,
        max_file_bytes=args.max_file_bytes,
    )
    gathered = gather_context(
        bundle,
        question=question,
        thread_context=thread_context,
        max_context_chars=args.max_context_chars,
        gatherer_backend=gatherer_runner(args),
    )
    return print_gathered_context(bundle, gathered)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parsed = json.loads(stripped)
        if not isinstance(parsed, dict):
            raise SystemExit(f"{path}:{line_number}: case must be a JSON object")
        cases.append(parsed)
    return cases


def gather_requirement_passed(requirement: Any, snippets: list[Any]) -> tuple[bool, str]:
    if isinstance(requirement, str):
        ok = any(snippet.path == requirement for snippet in snippets)
        return ok, requirement
    if not isinstance(requirement, dict):
        return False, repr(requirement)
    path = requirement.get("path")
    text = requirement.get("text")
    label = json.dumps(requirement, sort_keys=True)
    if not isinstance(path, str):
        return False, label
    matching = [snippet for snippet in snippets if snippet.path == path]
    if not matching:
        return False, label
    if text is None:
        return True, label
    if not isinstance(text, str):
        return False, label
    return any(text in snippet.text for snippet in matching), label


def cmd_repo_oracle_eval_gather(args: argparse.Namespace) -> int:
    bundle = load_source_bundle(
        Path(args.source_bundle),
        source_id=args.source_id or None,
        max_file_bytes=args.max_file_bytes,
    )
    case_results = []
    passed_cases = 0
    total_requirements = 0
    passed_requirements = 0
    for case in read_jsonl(Path(args.cases)):
        case_id = str(case.get("id") or f"case-{len(case_results) + 1}")
        question = case.get("question")
        if not isinstance(question, str) or not question.strip():
            raise SystemExit(f"{case_id}: question is required")
        thread_context = case.get("thread_context")
        if thread_context is not None and not isinstance(thread_context, str):
            raise SystemExit(f"{case_id}: thread_context must be a string")
        gathered = gather_context(
            bundle,
            question=question,
            thread_context=thread_context or "",
            max_context_chars=args.max_context_chars,
            gatherer_backend=gatherer_runner(args),
        )
        requirements = case.get("must_include", [])
        if not isinstance(requirements, list):
            raise SystemExit(f"{case_id}: must_include must be a list")
        checks = []
        for requirement in requirements:
            ok, label = gather_requirement_passed(requirement, gathered.snippets)
            checks.append({"ok": ok, "requirement": label})
            total_requirements += 1
            passed_requirements += 1 if ok else 0
        case_ok = all(check["ok"] for check in checks)
        passed_cases += 1 if case_ok else 0
        case_results.append(
            {
                "id": case_id,
                "ok": case_ok,
                "checks": checks,
                "warnings": gathered.warnings,
                "gatherer_provider": gathered.gatherer_provider,
                "sources": [
                    {
                        "path": snippet.path,
                        "line_start": snippet.line_start,
                        "line_end": snippet.line_end,
                        "score": snippet.score,
                    }
                    for snippet in gathered.snippets
                ],
            },
        )
    report = {
        "ok": passed_cases == len(case_results) and passed_requirements == total_requirements,
        "passed_cases": passed_cases,
        "total_cases": len(case_results),
        "passed_requirements": passed_requirements,
        "total_requirements": total_requirements,
        "cases": case_results,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


def print_gathered_context(bundle, gathered) -> int:
    print(
        json.dumps(
            {
                "source_id": bundle.source_id,
                "snapshot": bundle.snapshot,
                "tier": gathered.tier,
                "warnings": gathered.warnings,
                "gatherer_provider": gathered.gatherer_provider,
                "gatherer_call_id": gathered.gatherer_call_id,
                "gatherer_artifact_dir": gathered.gatherer_artifact_dir,
                "gatherer_plan": gathered.gatherer_plan,
                "snippets": [
                    {
                        "path": snippet.path,
                        "line_start": snippet.line_start,
                        "line_end": snippet.line_end,
                        "score": snippet.score,
                        "text": snippet.text,
                    }
                    for snippet in gathered.snippets
                ],
            },
            indent=2,
            sort_keys=True,
        ),
    )
    return 0


def chat_title_from(message: str) -> str:
    for line in message.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:79] + ("..." if len(stripped) > 80 else "")
    return "Chat"


def branch_from_issue_body(issue: object) -> str | None:
    if not isinstance(issue, dict):
        return None
    body = issue.get("body")
    if not isinstance(body, str):
        return None
    branch = parse_chat_metadata(body).get("branch")
    return branch if isinstance(branch, str) and branch.strip() else None


def issue_number_from_create(response: object) -> int:
    number = response.get("number") if isinstance(response, dict) else None
    if not isinstance(number, int):
        raise RuntimeError("created issue did not return an issue number")
    return number


def run_repo_chat_reply(
    *,
    client: CosheafClient,
    workspace: str,
    issue_number: int,
    bot_login: str,
    answer_backend: Callable[[str], BackendResult],
    verifier_backend: Callable[[str], BackendResult] | None,
    gatherer_backend: Callable[[str], BackendResult] | None,
    branch_override: str | None,
    run_dir: Path,
    max_context_chars: int,
) -> dict[str, object]:
    issue = client.read_issue(workspace, issue_number)
    timeline = client.read_issue_timeline(workspace, issue_number)
    turns = extract_turns(issue, timeline, bot_login)
    if not any(turn.role == "user" for turn in turns):
        return {"status": "skipped_no_user", "posted": False, "reply": None}
    if turns[-1].role == "assistant":
        return {"status": "skipped_already_replied", "posted": False, "reply": None}

    issue_branch = branch_from_issue_body(issue)
    branch = issue_branch or branch_override or "main"
    if branch_override and issue_branch and branch_override != issue_branch:
        raise SystemExit(f"chat issue is pinned to branch {issue_branch!r}, not {branch_override!r}")

    source_root = run_dir / "source-bundles"
    source_root.mkdir(parents=True, exist_ok=True)
    bundle = export_cosheaf_source_bundle(
        client,
        workspace=workspace,
        branch=branch,
        root=source_root / f"{workspace}-{issue_number}-{branch.replace('/', '_')}",
    )
    prior = "\n\n".join(
        f"## {'User' if turn.role == 'user' else 'Assistant'}\n{turn.body}"
        for turn in turns[:-1]
    )
    result = run_repo_oracle(
        bundle=bundle,
        question=turns[-1].body,
        answer_backend=answer_backend,
        verifier_backend=verifier_backend,
        gatherer_backend=gatherer_backend,
        thread_context=prior,
        max_context_chars=max_context_chars,
    )
    metadata = chat_reply_metadata(
        branch=branch,
        source_id=result.source_id,
        snapshot=result.snapshot,
        verification=result.verification,
        tier=result.tier,
        sources=result.sources,
        warnings=result.warnings,
        gatherer_provider=result.gatherer_provider,
        gatherer_call_id=result.gatherer_call_id,
    )
    comment_body = answer_with_metadata(result.answer, metadata)
    comment = client.comment_issue(workspace, issue_number, comment_body)
    return {
        **result.to_json(),
        "status": "replied",
        "posted": True,
        "reply": result.answer,
        "workspace": workspace,
        "branch": branch,
        "issue_number": issue_number,
        "comment": comment,
    }


def cmd_chat_ask(args: argparse.Namespace) -> int:
    client = authed_client_from_args(args)
    question = read_message_input(args)
    if not question.strip():
        raise SystemExit("message is required")
    branch = args.branch or "main"
    issue_number = args.issue
    thread_context = ""
    if issue_number is None:
        label_id = client.ensure_label(
            args.workspace,
            name="chat",
            color="8b5cf6",
            description="Coverify chat",
        )
        created = client.create_issue(
            args.workspace,
            title=args.title or chat_title_from(question),
            body=chat_issue_body(question, branch=branch),
            labels=[label_id],
        )
        issue_number = issue_number_from_create(created)
    else:
        issue = client.read_issue(args.workspace, issue_number)
        issue_branch = branch_from_issue_body(issue)
        if issue_branch:
            if args.branch and issue_branch != args.branch:
                raise SystemExit(f"chat issue is pinned to branch {issue_branch!r}, not {args.branch!r}")
            branch = issue_branch
        elif args.branch:
            branch = args.branch
        timeline = client.read_issue_timeline(args.workspace, issue_number)
        turns = extract_turns(issue, timeline, args.bot_user)
        thread_context = "\n\n".join(
            f"## {'User' if turn.role == 'user' else 'Assistant'}\n{turn.body}"
            for turn in turns
        )
        client.comment_issue(args.workspace, issue_number, question)

    source_root = Path(args.run_dir) / "source-bundles"
    source_root.mkdir(parents=True, exist_ok=True)
    bundle = export_cosheaf_source_bundle(
        client=client,
        workspace=args.workspace,
        branch=branch,
        root=source_root / f"{args.workspace}-{issue_number}-{branch.replace('/', '_')}",
    )
    repo_result = run_repo_oracle(
        bundle=bundle,
        question=question,
        answer_backend=backend_runner(args),
        verifier_backend=verifier_runner(args),
        gatherer_backend=gatherer_runner(args),
        thread_context=thread_context,
        max_context_chars=args.max_context_chars,
    )
    metadata = chat_reply_metadata(
        branch=branch,
        source_id=repo_result.source_id,
        snapshot=repo_result.snapshot,
        verification=repo_result.verification,
        tier=repo_result.tier,
        sources=repo_result.sources,
        warnings=repo_result.warnings,
    )
    comment = client.comment_issue(args.workspace, issue_number, answer_with_metadata(repo_result.answer, metadata))
    result = {
        **repo_result.to_json(),
        "status": "replied",
        "posted": True,
        "reply": repo_result.answer,
        "workspace": args.workspace,
        "branch": branch,
        "issue_number": issue_number,
        "comment": comment,
    }
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(str(result.get("reply") or ""), end="" if str(result.get("reply") or "").endswith("\n") else "\n")
    return 0


def cmd_chat_gather(args: argparse.Namespace) -> int:
    client = authed_client_from_args(args)
    branch = args.branch or "main"
    question = read_message_input(args) if has_message_source(args) else ""
    thread_context = ""
    if args.issue is not None:
        issue = client.read_issue(args.workspace, args.issue)
        issue_branch = branch_from_issue_body(issue)
        if issue_branch:
            if args.branch and issue_branch != args.branch:
                raise SystemExit(f"chat issue is pinned to branch {issue_branch!r}, not {args.branch!r}")
            branch = issue_branch
        timeline = client.read_issue_timeline(args.workspace, args.issue)
        turns = extract_turns(issue, timeline, args.bot_user)
        if question.strip():
            thread_context = "\n\n".join(
                f"## {'User' if turn.role == 'user' else 'Assistant'}\n{turn.body}"
                for turn in turns
            )
        else:
            if not turns:
                raise SystemExit("issue has no chat turns; provide a message")
            question = turns[-1].body
            thread_context = "\n\n".join(
                f"## {'User' if turn.role == 'user' else 'Assistant'}\n{turn.body}"
                for turn in turns[:-1]
            )
    if not question.strip():
        raise SystemExit("message is required unless --issue has at least one turn")
    source_root = Path(args.run_dir) / "source-bundles"
    source_root.mkdir(parents=True, exist_ok=True)
    bundle = export_cosheaf_source_bundle(
        client=client,
        workspace=args.workspace,
        branch=branch,
        root=source_root / f"{args.workspace}-gather-{branch.replace('/', '_')}",
    )
    gathered = gather_context(
        bundle,
        question=question,
        thread_context=thread_context,
        max_context_chars=args.max_context_chars,
        gatherer_backend=gatherer_runner(args),
    )
    return print_gathered_context(bundle, gathered)


def cmd_run_eval(args: argparse.Namespace) -> int:
    report = run_eval_cases(
        load_eval_cases(Path(args.cases)),
        backend=backend_runner(args),
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def cmd_seed_research_evals(args: argparse.Namespace) -> int:
    candidates = load_research_eval_candidates(Path(args.candidates))
    client = build_client(
        api_url=args.api_url,
        token=args.token,
        username=args.username,
        password=args.password,
        tls_verify=not args.insecure,
    )
    result = seed_research_eval_workspace(
        client=client,
        workspace=args.workspace,
        workspace_name=args.workspace_name or args.workspace,
        candidates=candidates,
        branch=args.branch or f"research-eval-seed-{utc_stamp()}",
        path_prefix=args.path_prefix,
        create_workspace=args.create_workspace,
        allow_existing_workspace=args.allow_existing_workspace,
        default_md_format=args.default_md_format,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def add_common_auth(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--api-url", default=env("COSHEAF_API_URL", "http://localhost:3030/api/v1"))
    parser.add_argument("--token", default=env("COSHEAF_TOKEN"))
    parser.add_argument("--username", default=env("COSHEAF_USERNAME"))
    parser.add_argument("--password", default=env("COSHEAF_PASSWORD"))
    parser.add_argument("--insecure", action="store_true", default=env("COSHEAF_INSECURE") in {"1", "true", "yes"})


def add_workspace_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", default=env("COSHEAF_WORKSPACE"), required=not bool(env("COSHEAF_WORKSPACE")))


def add_backend_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--backend", choices=BACKEND_CHOICES, default=env("COVERIFY_BACKEND", "codex"))
    parser.add_argument(
        "--verify-inner-backend",
        choices=SUB_BACKEND_CHOICES,
        default=env("COVERIFY_VERIFY_INNER_BACKEND", "codex"),
        help="underlying oracle used for generator/verifier/adjunct when --backend=verifying",
    )
    parser.add_argument(
        "--verify-max-rounds",
        type=int,
        default=int(env("COVERIFY_VERIFY_MAX_ROUNDS", "3") or "3"),
        help="max generate->verify rounds when --backend=verifying",
    )
    parser.add_argument(
        "--verify-profile",
        default=env("COVERIFY_VERIFY_PROFILE", "default"),
        help="built-in verifying profile (default, strict)",
    )
    parser.add_argument(
        "--verify-config",
        default=env("COVERIFY_VERIFY_CONFIG"),
        help="path to a JSON verifying-oracle config (overrides --verify-profile)",
    )
    parser.add_argument(
        "--verify-strict",
        action="store_true",
        default=env("COVERIFY_VERIFY_STRICT") in {"1", "true", "yes"},
        help="refuse to answer if a verifier errors out, instead of returning an unverified final answer",
    )
    parser.add_argument(
        "--verify-quiet-adjunct",
        action="store_true",
        default=env("COVERIFY_VERIFY_QUIET_ADJUNCT") in {"1", "true", "yes"},
        help="adjunct states only verified content, without 'could not verify' notes",
    )
    parser.add_argument(
        "--verify-resume",
        default=None,
        help="resume a verifying run from an existing artifact dir, reusing journaled steps",
    )
    parser.add_argument("--backend-command", default=env("COVERIFY_BACKEND_COMMAND"))
    parser.add_argument("--backend-timeout", type=int, default=int(env("COVERIFY_BACKEND_TIMEOUT_SECONDS", "0") or "0"))
    parser.add_argument("--backend-retries", type=int, default=int(env("COVERIFY_BACKEND_RETRIES", "1") or "0"))
    parser.add_argument("--run-dir", default=env("COVERIFY_RUN_DIR", ".coverify/runs"))
    parser.add_argument("--model", default=env("COVERIFY_CODEX_MODEL", "gpt-5.5"))
    parser.add_argument("--reasoning-effort", default=env("COVERIFY_CODEX_REASONING_EFFORT", "xhigh"))
    parser.add_argument("--codex-bin", default=env("COVERIFY_CODEX_BIN", "codex"))
    parser.add_argument("--codex-sandbox", default=env("COVERIFY_CODEX_SANDBOX", "read-only"))
    parser.add_argument(
        "--allow-codex-backend",
        action="store_true",
        default=truthy(env("COVERIFY_ALLOW_CODEX_BACKEND")),
        help="allow the Codex backend to run; required because it consumes Codex usage",
    )


def add_repo_oracle_args(
    parser: argparse.ArgumentParser,
    *,
    include_message: bool = True,
    include_json: bool = True,
) -> None:
    if include_message:
        parser.add_argument("message", nargs="*", help="question text; stdin is used when omitted")
        parser.add_argument("--message", dest="message_text", default="", help="question text")
        parser.add_argument("--message-file", default="", help="question file, or '-' for stdin")
        parser.add_argument("--thread-file", default="", help="prior thread context file, or '-' for stdin")
    if include_json:
        parser.add_argument("--json", action="store_true", help="print structured result JSON")
    add_source_bundle_args(parser)
    add_repo_verifier_args(parser)
    add_repo_gatherer_args(parser)


def add_source_bundle_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--max-context-chars",
        type=int,
        default=int(env("COVERIFY_REPO_ORACLE_MAX_CONTEXT_CHARS", "60000") or "60000"),
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=int(env("COVERIFY_REPO_ORACLE_MAX_FILE_BYTES", "1000000") or "1000000"),
    )


def add_repo_verifier_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--verifier-backend",
        choices=SUB_BACKEND_CHOICES,
        default=env("COVERIFY_REPO_ORACLE_VERIFIER_BACKEND"),
        help="extra verifier backend required unless --backend=verifying",
    )
    parser.add_argument("--verifier-command", default=env("COVERIFY_REPO_ORACLE_VERIFIER_COMMAND"))
    parser.add_argument("--verifier-model", default=env("COVERIFY_REPO_ORACLE_VERIFIER_MODEL"))
    parser.add_argument(
        "--verifier-reasoning-effort",
        default=env("COVERIFY_REPO_ORACLE_VERIFIER_REASONING_EFFORT"),
    )


def add_repo_gatherer_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--gatherer-backend",
        choices=SUB_BACKEND_CHOICES,
        default=env("COVERIFY_REPO_ORACLE_GATHERER_BACKEND"),
        help="optional LLM/backend planner that selects repo snippets before answering",
    )
    parser.add_argument("--gatherer-command", default=env("COVERIFY_REPO_ORACLE_GATHERER_COMMAND"))
    parser.add_argument("--gatherer-model", default=env("COVERIFY_REPO_ORACLE_GATHERER_MODEL"))
    parser.add_argument(
        "--gatherer-reasoning-effort",
        default=env("COVERIFY_REPO_ORACLE_GATHERER_REASONING_EFFORT"),
    )


def add_gather_eval_args(parser: argparse.ArgumentParser) -> None:
    add_source_bundle_args(parser)
    add_repo_gatherer_args(parser)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="coverify")
    sub = parser.add_subparsers(dest="command", required=True)

    login = sub.add_parser("login", help="exchange Cosheaf username/password for an API token")
    login.add_argument("--api-url", default=env("COSHEAF_API_URL", "http://localhost:3030/api/v1"))
    login.add_argument("--username", default=env("COSHEAF_USERNAME"), required=not bool(env("COSHEAF_USERNAME")))
    login.add_argument("--password", default=env("COSHEAF_PASSWORD"), required=not bool(env("COSHEAF_PASSWORD")))
    login.add_argument("--insecure", action="store_true", default=env("COSHEAF_INSECURE") in {"1", "true", "yes"})
    login.set_defaults(func=cmd_login)

    create = sub.add_parser("create-workspace", help="create a Cosheaf workspace/project")
    add_common_auth(create)
    create.add_argument("--workspace", default=env("COSHEAF_WORKSPACE"), required=not bool(env("COSHEAF_WORKSPACE")))
    create.add_argument("--workspace-name", default="")
    create.add_argument("--default-md-format", choices=("coflat", "forgejo-passthrough"), default="coflat")
    create.set_defaults(func=cmd_create_workspace)

    scaffold = sub.add_parser("scaffold-workdir", help="create a local Coverify work directory for a Cosheaf workspace")
    scaffold.add_argument("--workspace", default=env("COSHEAF_WORKSPACE"), required=not bool(env("COSHEAF_WORKSPACE")))
    scaffold.add_argument("--works-root", default=env("COVERIFY_WORKS_ROOT", str(Path.home() / "playground" / "works")))
    scaffold.add_argument(
        "--coverify-checkout",
        default=env("COVERIFY_CHECKOUT", str(Path(__file__).resolve().parents[2])),
    )
    scaffold.add_argument("--qed-root", default=env("QED_ROOT", str(Path.home() / "playground" / "QED")))
    scaffold.add_argument("--force", action="store_true", help="overwrite existing scaffold files")
    scaffold.add_argument("--refresh-tools", action="store_true", help="overwrite generated bin wrappers only")
    scaffold.set_defaults(func=cmd_scaffold_workdir)

    member = sub.add_parser("set-member", help="set a Cosheaf workspace member role")
    add_common_auth(member)
    add_workspace_arg(member)
    member.add_argument("--member", required=True, help="Cosheaf/Forgejo username")
    member.add_argument("--role", choices=("admin", "write", "read"), required=True)
    member.set_defaults(func=cmd_set_member)

    tree = sub.add_parser("tree", help="list workspace files on a branch")
    add_common_auth(tree)
    add_workspace_arg(tree)
    tree.add_argument("--branch", default="main")
    tree.set_defaults(func=cmd_tree)

    search = sub.add_parser("search", help="search workspace pages")
    add_common_auth(search)
    add_workspace_arg(search)
    search.add_argument("--query", required=True)
    search.set_defaults(func=cmd_search)

    list_issues = sub.add_parser("list-issues", help="list workspace issues")
    add_common_auth(list_issues)
    add_workspace_arg(list_issues)
    list_issues.add_argument("--state", choices=("open", "closed", "all"), default="open")
    list_issues.add_argument("--query", default="")
    list_issues.set_defaults(func=cmd_list_issues)

    read_issue = sub.add_parser("read-issue", help="read one workspace issue")
    add_common_auth(read_issue)
    add_workspace_arg(read_issue)
    read_issue.add_argument("--issue", type=int, required=True)
    read_issue.set_defaults(func=cmd_read_issue)

    read_issue_timeline = sub.add_parser("read-issue-timeline", help="read one workspace issue timeline")
    add_common_auth(read_issue_timeline)
    add_workspace_arg(read_issue_timeline)
    read_issue_timeline.add_argument("--issue", type=int, required=True)
    read_issue_timeline.set_defaults(func=cmd_read_issue_timeline)

    create_issue = sub.add_parser("create-issue", help="create a workspace issue")
    add_common_auth(create_issue)
    add_workspace_arg(create_issue)
    create_issue.add_argument("--title", required=True)
    create_issue.add_argument("--body", default="")
    create_issue.add_argument("--body-file", default="")
    create_issue.set_defaults(func=cmd_create_issue)

    edit_issue = sub.add_parser("edit-issue", help="edit a workspace issue title or body")
    add_common_auth(edit_issue)
    add_workspace_arg(edit_issue)
    edit_issue.add_argument("--issue", type=int, required=True)
    edit_issue.add_argument("--title", default=None)
    edit_issue.add_argument("--body", default=None)
    edit_issue.add_argument("--body-file", default=None)
    edit_issue.set_defaults(func=cmd_edit_issue)

    comment_issue = sub.add_parser("comment-issue", help="add a comment to a workspace issue")
    add_common_auth(comment_issue)
    add_workspace_arg(comment_issue)
    comment_issue.add_argument("--issue", type=int, required=True)
    comment_issue.add_argument("--body", default="")
    comment_issue.add_argument("--body-file", default="")
    comment_issue.set_defaults(func=cmd_comment_issue)

    chat_reply = sub.add_parser(
        "chat-reply",
        help="read an issue thread, run the oracle, and post one reply comment",
    )
    add_common_auth(chat_reply)
    add_workspace_arg(chat_reply)
    add_backend_args(chat_reply)
    chat_reply.add_argument("--issue", type=int, required=True)
    chat_reply.add_argument(
        "--bot-user",
        default=env("COVERIFY_BOT_USER"),
        help="login of the oracle's own account; defaults to the authenticated user",
    )
    chat_reply.add_argument(
        "--branch",
        default="",
        help="branch to use when the issue has no pinned chat metadata",
    )
    chat_reply.add_argument(
        "--legacy-prompt-only",
        action="store_true",
        help="use the old issue-thread-only prompt path instead of repo-snapshot chat",
    )
    add_repo_oracle_args(chat_reply, include_message=False, include_json=False)
    chat_reply.set_defaults(func=cmd_chat_reply)

    close_issue = sub.add_parser("close-issue", help="close a workspace issue")
    add_common_auth(close_issue)
    add_workspace_arg(close_issue)
    close_issue.add_argument("--issue", type=int, required=True)
    close_issue.set_defaults(func=cmd_close_issue)

    reopen_issue = sub.add_parser("reopen-issue", help="reopen a workspace issue")
    add_common_auth(reopen_issue)
    add_workspace_arg(reopen_issue)
    reopen_issue.add_argument("--issue", type=int, required=True)
    reopen_issue.set_defaults(func=cmd_reopen_issue)

    set_issue_state = sub.add_parser("set-issue-state", help="set a workspace issue state")
    add_common_auth(set_issue_state)
    add_workspace_arg(set_issue_state)
    set_issue_state.add_argument("--issue", type=int, required=True)
    set_issue_state.add_argument("--state", choices=("open", "closed"), required=True)
    set_issue_state.set_defaults(func=cmd_set_issue_state)

    read_file = sub.add_parser("read-file", help="read one file from a workspace branch")
    add_common_auth(read_file)
    add_workspace_arg(read_file)
    read_file.add_argument("--path", required=True)
    read_file.add_argument("--branch", default="main")
    read_file.set_defaults(func=cmd_read_file)

    branch = sub.add_parser("create-branch", help="create a branch from main")
    add_common_auth(branch)
    add_workspace_arg(branch)
    branch.add_argument("--branch", required=True)
    branch.set_defaults(func=cmd_create_branch)

    write_file = sub.add_parser("write-file", help="write a markdown file on a branch")
    add_common_auth(write_file)
    add_workspace_arg(write_file)
    write_file.add_argument("--path", required=True)
    write_file.add_argument("--branch", required=True)
    write_file.add_argument("--content-file", required=True, help="file to write, or '-' for stdin")
    write_file.set_defaults(func=cmd_write_file)

    delete_file = sub.add_parser("delete-file", help="delete a markdown file on a branch")
    add_common_auth(delete_file)
    add_workspace_arg(delete_file)
    delete_file.add_argument("--path", required=True)
    delete_file.add_argument("--branch", required=True)
    delete_file.set_defaults(func=cmd_delete_file)

    open_pr = sub.add_parser("open-pr", help="open a pull request")
    add_common_auth(open_pr)
    add_workspace_arg(open_pr)
    open_pr.add_argument("--head", required=True)
    open_pr.add_argument("--base", default="main")
    open_pr.add_argument("--title", required=True)
    open_pr.add_argument("--body", default="")
    open_pr.add_argument("--body-file", default="")
    open_pr.set_defaults(func=cmd_open_pr)

    list_prs = sub.add_parser("list-prs", help="list workspace pull requests")
    add_common_auth(list_prs)
    add_workspace_arg(list_prs)
    list_prs.add_argument("--state", choices=("open", "closed", "all"), default="open")
    list_prs.set_defaults(func=cmd_list_prs)

    read_pr = sub.add_parser("read-pr", help="read one workspace pull request")
    add_common_auth(read_pr)
    add_workspace_arg(read_pr)
    read_pr.add_argument("--pr", type=int, required=True)
    read_pr.set_defaults(func=cmd_read_pr)

    read_pr_context = sub.add_parser("read-pr-context", help="read pull request files and review context")
    add_common_auth(read_pr_context)
    add_workspace_arg(read_pr_context)
    read_pr_context.add_argument("--pr", type=int, required=True)
    read_pr_context.set_defaults(func=cmd_read_pr_context)

    review_pr = sub.add_parser("review-pr", help="submit a pull request review")
    add_common_auth(review_pr)
    add_workspace_arg(review_pr)
    review_pr.add_argument("--pr", type=int, required=True)
    review_pr.add_argument("--event", choices=REVIEW_DECISION_VALUES, required=True)
    review_pr.add_argument("--body", default="")
    review_pr.add_argument("--body-file", default="")
    review_pr.set_defaults(func=cmd_review_pr)

    merge_pr = sub.add_parser("merge-pr", help="merge a pull request")
    add_common_auth(merge_pr)
    add_workspace_arg(merge_pr)
    merge_pr.add_argument("--pr", type=int, required=True)
    merge_pr.add_argument("--method", choices=("squash", "merge", "rebase"), default="squash")
    merge_pr.add_argument("--force", action="store_true")
    merge_pr.set_defaults(func=cmd_merge_pr)

    close_pr = sub.add_parser("close-pr", help="close a pull request without merging")
    add_common_auth(close_pr)
    add_workspace_arg(close_pr)
    close_pr.add_argument("--pr", type=int, required=True)
    close_pr.set_defaults(func=cmd_close_pr)

    ask = sub.add_parser("ask-oracle", help="send one prompt to a backend oracle")
    ask.add_argument("message", nargs="*", help="prompt text; stdin is used when omitted")
    ask.add_argument("--prompt", default="", help="prompt text")
    ask.add_argument("--prompt-file", default="", help="prompt file, or '-' for stdin")
    ask.add_argument("--json", action="store_true", help="print answer plus audit metadata as JSON")
    add_backend_args(ask)
    ask.set_defaults(func=cmd_ask_oracle)

    repo_oracle = sub.add_parser("repo-oracle", help="repo-snapshot oracle commands")
    repo_oracle_sub = repo_oracle.add_subparsers(dest="repo_oracle_command", required=True)
    repo_ask = repo_oracle_sub.add_parser("ask", help="ask against a local source bundle")
    repo_ask.add_argument("--source-bundle", required=True, help="directory containing allowed source files")
    repo_ask.add_argument("--source-id", default="", help="stable source bundle id")
    add_backend_args(repo_ask)
    add_repo_oracle_args(repo_ask)
    repo_ask.set_defaults(func=cmd_repo_oracle_ask)
    repo_gather = repo_oracle_sub.add_parser("gather", help="inspect repo context gathering")
    repo_gather.add_argument("--source-bundle", required=True, help="directory containing allowed source files")
    repo_gather.add_argument("--source-id", default="", help="stable source bundle id")
    add_backend_args(repo_gather)
    add_repo_oracle_args(repo_gather)
    repo_gather.set_defaults(func=cmd_repo_oracle_gather)
    repo_eval_gather = repo_oracle_sub.add_parser("eval-gather", help="run JSONL gather-quality checks")
    repo_eval_gather.add_argument("--source-bundle", required=True, help="directory containing allowed source files")
    repo_eval_gather.add_argument("--source-id", default="", help="stable source bundle id")
    repo_eval_gather.add_argument("--cases", required=True, help="JSONL cases with question and must_include checks")
    add_backend_args(repo_eval_gather)
    add_gather_eval_args(repo_eval_gather)
    repo_eval_gather.set_defaults(func=cmd_repo_oracle_eval_gather)

    chat = sub.add_parser("chat", help="branch-scoped chat commands")
    chat_sub = chat.add_subparsers(dest="chat_command", required=True)
    chat_ask = chat_sub.add_parser("ask", help="create/append a chat issue and answer it")
    add_common_auth(chat_ask)
    add_workspace_arg(chat_ask)
    chat_ask.add_argument("--branch", default="")
    chat_ask.add_argument("--issue", type=int, default=None)
    chat_ask.add_argument("--title", default="")
    chat_ask.add_argument("--bot-user", default=env("COVERIFY_BOT_USER", "coverify"))
    add_backend_args(chat_ask)
    add_repo_oracle_args(chat_ask)
    chat_ask.set_defaults(func=cmd_chat_ask)
    chat_gather = chat_sub.add_parser("gather", help="export a branch and inspect gathered chat context without posting")
    add_common_auth(chat_gather)
    add_workspace_arg(chat_gather)
    chat_gather.add_argument("--branch", default="")
    chat_gather.add_argument("--issue", type=int, default=None)
    chat_gather.add_argument("--bot-user", default=env("COVERIFY_BOT_USER", "coverify"))
    add_backend_args(chat_gather)
    add_repo_oracle_args(chat_gather)
    chat_gather.set_defaults(func=cmd_chat_gather)

    run_eval = sub.add_parser("run-eval", help="run JSONL eval cases against a backend")
    run_eval.add_argument("--cases", required=True, help="JSONL eval case file")
    add_backend_args(run_eval)
    run_eval.set_defaults(func=cmd_run_eval)

    seed_research = sub.add_parser("seed-research-evals", help="seed research-level eval tasks into a Cosheaf workspace")
    add_common_auth(seed_research)
    add_workspace_arg(seed_research)
    seed_research.add_argument("--workspace-name", default="")
    seed_research.add_argument("--default-md-format", choices=("coflat", "forgejo-passthrough"), default="coflat")
    seed_research.add_argument("--create-workspace", action="store_true")
    seed_research.add_argument("--allow-existing-workspace", action="store_true")
    seed_research.add_argument("--candidates", required=True, help="research eval candidate JSONL")
    seed_research.add_argument("--branch", default="")
    seed_research.add_argument("--path-prefix", default="research-evals")
    seed_research.set_defaults(func=cmd_seed_research_evals)

    prove = sub.add_parser("prove-infinite-primes", help="run the infinite-primes proof workflow")
    add_common_auth(prove)
    prove.add_argument("--workspace", default=env("COSHEAF_WORKSPACE"), required=not bool(env("COSHEAF_WORKSPACE")))
    prove.add_argument("--workspace-name", default="")
    prove.add_argument("--default-md-format", choices=("coflat", "forgejo-passthrough"), default="coflat")
    prove.add_argument("--create-workspace", action="store_true")
    prove.add_argument("--allow-existing-workspace", action="store_true")
    prove.add_argument("--branch", default="")
    prove.add_argument("--path", default="infinite-primes.md")
    prove.add_argument("--title", default="Coverify proof: infinitely many primes")
    prove.add_argument("--merge", action="store_true")
    prove.add_argument("--force-merge", action="store_true")
    prove.add_argument("--review-token", default=env("COSHEAF_REVIEW_TOKEN"))
    prove.add_argument("--review-username", default=env("COSHEAF_REVIEW_USERNAME"))
    prove.add_argument("--review-password", default=env("COSHEAF_REVIEW_PASSWORD"))
    add_backend_args(prove)
    prove.set_defaults(func=cmd_prove_infinite_primes)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))

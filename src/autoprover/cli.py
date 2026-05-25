from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Callable

from .backend import (
    BackendResult,
    run_codex_backend,
    run_fixture_backend,
    run_script_backend,
)
from .client import CosheafClient, CosheafConfig
from .workflows import (
    InfinitePrimesRunOptions,
    default_branch_name,
    run_infinite_primes_workflow,
)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


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


def backend_runner(args: argparse.Namespace) -> Callable[[str], BackendResult]:
    artifact_root = Path(args.run_dir)
    timeout = args.backend_timeout if args.backend_timeout > 0 else None
    if args.backend == "fixture":
        return lambda context: run_fixture_backend(context, artifact_root=artifact_root)
    if args.backend == "script":
        if not args.backend_command:
            raise SystemExit("--backend-command is required when --backend=script")
        return lambda context: run_script_backend(
            context,
            command=args.backend_command,
            artifact_root=artifact_root,
            timeout_seconds=timeout,
        )
    if args.backend == "codex":
        return lambda context: run_codex_backend(
            context,
            artifact_root=artifact_root,
            model=args.model,
            reasoning_effort=args.reasoning_effort,
            timeout_seconds=timeout,
            codex_bin=args.codex_bin,
            sandbox=args.codex_sandbox,
        )
    raise SystemExit(f"unknown backend: {args.backend}")


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


def cmd_comment_issue(args: argparse.Namespace) -> int:
    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    return print_json(authed_client_from_args(args).comment_issue(args.workspace, args.issue, body))


def cmd_close_issue(args: argparse.Namespace) -> int:
    return print_json(authed_client_from_args(args).close_issue(args.workspace, args.issue))


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
    result = run_infinite_primes_workflow(
        client=client,
        reviewer_client=reviewer_client,
        backend=backend_runner(args),
        options=options,
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="autoprover")
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

    create_issue = sub.add_parser("create-issue", help="create a workspace issue")
    add_common_auth(create_issue)
    add_workspace_arg(create_issue)
    create_issue.add_argument("--title", required=True)
    create_issue.add_argument("--body", default="")
    create_issue.add_argument("--body-file", default="")
    create_issue.set_defaults(func=cmd_create_issue)

    comment_issue = sub.add_parser("comment-issue", help="add a comment to a workspace issue")
    add_common_auth(comment_issue)
    add_workspace_arg(comment_issue)
    comment_issue.add_argument("--issue", type=int, required=True)
    comment_issue.add_argument("--body", default="")
    comment_issue.add_argument("--body-file", default="")
    comment_issue.set_defaults(func=cmd_comment_issue)

    close_issue = sub.add_parser("close-issue", help="close a workspace issue")
    add_common_auth(close_issue)
    add_workspace_arg(close_issue)
    close_issue.add_argument("--issue", type=int, required=True)
    close_issue.set_defaults(func=cmd_close_issue)

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

    open_pr = sub.add_parser("open-pr", help="open a pull request")
    add_common_auth(open_pr)
    add_workspace_arg(open_pr)
    open_pr.add_argument("--head", required=True)
    open_pr.add_argument("--base", default="main")
    open_pr.add_argument("--title", required=True)
    open_pr.add_argument("--body", default="")
    open_pr.add_argument("--body-file", default="")
    open_pr.set_defaults(func=cmd_open_pr)

    review_pr = sub.add_parser("review-pr", help="submit a pull request review")
    add_common_auth(review_pr)
    add_workspace_arg(review_pr)
    review_pr.add_argument("--pr", type=int, required=True)
    review_pr.add_argument("--event", choices=("APPROVE", "REQUEST_CHANGES", "COMMENT"), required=True)
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

    prove = sub.add_parser("prove-infinite-primes", help="run the v1 infinite-primes proof workflow")
    add_common_auth(prove)
    prove.add_argument("--workspace", default=env("COSHEAF_WORKSPACE"), required=not bool(env("COSHEAF_WORKSPACE")))
    prove.add_argument("--workspace-name", default="")
    prove.add_argument("--default-md-format", choices=("coflat", "forgejo-passthrough"), default="coflat")
    prove.add_argument("--create-workspace", action="store_true")
    prove.add_argument("--allow-existing-workspace", action="store_true")
    prove.add_argument("--branch", default="")
    prove.add_argument("--path", default="infinite-primes.md")
    prove.add_argument("--title", default="Autoprover proof: infinitely many primes")
    prove.add_argument("--merge", action="store_true")
    prove.add_argument("--force-merge", action="store_true")
    prove.add_argument("--review-token", default=env("COSHEAF_REVIEW_TOKEN"))
    prove.add_argument("--review-username", default=env("COSHEAF_REVIEW_USERNAME"))
    prove.add_argument("--review-password", default=env("COSHEAF_REVIEW_PASSWORD"))
    prove.add_argument("--backend", choices=("codex", "fixture", "script"), default=env("AUTOPROVER_BACKEND", "codex"))
    prove.add_argument("--backend-command", default=env("AUTOPROVER_BACKEND_COMMAND"))
    prove.add_argument("--backend-timeout", type=int, default=int(env("AUTOPROVER_BACKEND_TIMEOUT_SECONDS", "0") or "0"))
    prove.add_argument("--run-dir", default=env("AUTOPROVER_RUN_DIR", ".autoprover/runs"))
    prove.add_argument("--model", default=env("AUTOPROVER_CODEX_MODEL", "gpt-5.5"))
    prove.add_argument("--reasoning-effort", default=env("AUTOPROVER_CODEX_REASONING_EFFORT", "xhigh"))
    prove.add_argument("--codex-bin", default=env("AUTOPROVER_CODEX_BIN", "codex"))
    prove.add_argument("--codex-sandbox", default=env("AUTOPROVER_CODEX_SANDBOX", "read-only"))
    prove.set_defaults(func=cmd_prove_infinite_primes)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))

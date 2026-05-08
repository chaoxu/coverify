from __future__ import annotations

import argparse
import sys

from . import store
from . import worker


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="autoprover")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init")
    init.add_argument("store")

    draft = subparsers.add_parser("draft")
    draft.add_argument("store")
    draft.add_argument("id")
    draft.add_argument("--title", required=True)
    draft.add_argument("--type", required=True)
    draft.add_argument("--body", default="")
    draft.add_argument("--body-file", default="")
    draft.add_argument("--source", default="")

    submit = subparsers.add_parser("submit")
    submit.add_argument("store")
    submit.add_argument("id")

    review = subparsers.add_parser("review")
    review.add_argument("store")
    review.add_argument("artifact_id")
    review.add_argument("--verifier", required=True)
    review.add_argument("--verdict", required=True, choices=sorted(store.VALID_VERDICTS))
    review.add_argument("--summary", required=True)
    review.add_argument("--critical-errors", default="")
    review.add_argument("--gaps", default="")
    review.add_argument("--repair-hints", default="")
    review.add_argument("--reusable", default="")

    status = subparsers.add_parser("status")
    status.add_argument("store")
    status.add_argument("artifact_id")

    search = subparsers.add_parser("search")
    search.add_argument("store")
    search.add_argument("query")
    search.add_argument("--mode", choices=["exploration", "golden", "mixed"], default="exploration")

    benchmark = subparsers.add_parser("benchmark")
    benchmark.add_argument("name", choices=["coin-fpt"])
    benchmark.add_argument("store")

    codex_explore = subparsers.add_parser("codex-explore")
    codex_explore.add_argument("store")
    codex_explore.add_argument("id")
    codex_explore.add_argument("--prompt", required=True)
    codex_explore.add_argument("--title", required=True)
    codex_explore.add_argument("--type", required=True)
    codex_explore.add_argument("--model", default="")

    codex_verify = subparsers.add_parser("codex-verify")
    codex_verify.add_argument("store")
    codex_verify.add_argument("artifact_id")
    codex_verify.add_argument("--verifier", default="codex-verifier")
    codex_verify.add_argument("--model", default="")

    worker_explore = subparsers.add_parser("worker-explore")
    worker_explore.add_argument("store")
    worker_explore.add_argument("id")
    worker_explore.add_argument("--backend", required=True, choices=sorted(worker.BACKENDS))
    worker_explore.add_argument("--prompt", required=True)
    worker_explore.add_argument("--title", required=True)
    worker_explore.add_argument("--type", required=True)
    worker_explore.add_argument("--model", default="")

    worker_verify = subparsers.add_parser("worker-verify")
    worker_verify.add_argument("store")
    worker_verify.add_argument("artifact_id")
    worker_verify.add_argument("--backend", required=True, choices=sorted(worker.BACKENDS))
    worker_verify.add_argument("--verifier", default="worker-verifier")
    worker_verify.add_argument("--model", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            path = store.init_store(args.store)
            print(path)
        elif args.command == "draft":
            body = args.body
            if args.body_file:
                with open(args.body_file, encoding="utf-8") as handle:
                    body = handle.read()
            path = store.create_draft(args.store, args.id, args.title, args.type, body, args.source)
            print(path)
        elif args.command == "submit":
            path = store.submit_artifact(args.store, args.id)
            print(path)
        elif args.command == "review":
            path = store.create_review(
                args.store,
                args.artifact_id,
                args.verifier,
                args.verdict,
                args.summary,
                args.critical_errors,
                args.gaps,
                args.repair_hints,
                args.reusable,
            )
            print(path)
        elif args.command == "status":
            print(store.trust_status(args.store, args.artifact_id))
        elif args.command == "search":
            print(store.format_results(store.search(args.store, args.query, args.mode)))
        elif args.command == "benchmark":
            created = store.create_coin_benchmark(args.store)
            print(f"coin-fpt benchmark ready ({len(created)} files created)")
        elif args.command == "codex-explore":
            path = worker.run_explorer(
                args.store,
                args.id,
                args.title,
                args.type,
                args.prompt,
                backend_name="codex",
                model=args.model,
            )
            print(path)
        elif args.command == "codex-verify":
            path = worker.run_verifier(
                args.store,
                args.artifact_id,
                verifier=args.verifier,
                backend_name="codex",
                model=args.model,
            )
            print(path)
        elif args.command == "worker-explore":
            path = worker.run_explorer(
                args.store,
                args.id,
                args.title,
                args.type,
                args.prompt,
                backend_name=args.backend,
                model=args.model,
            )
            print(path)
        elif args.command == "worker-verify":
            path = worker.run_verifier(
                args.store,
                args.artifact_id,
                verifier=args.verifier,
                backend_name=args.backend,
                model=args.model,
            )
            print(path)
        else:
            parser.error(f"unknown command: {args.command}")
    except store.StoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0

from __future__ import annotations

import argparse
from typing import Any, Protocol

from .agents import parse_review_result, run_agent
from .context import context_from_doc, load_context
from .prompts import (
    ContextDoc,
    build_explore_prompt,
    build_proposal_prompt,
    build_repair_prompt,
    build_review_prompt,
    slugify,
)
from .traces import append_trace, make_trace


class Client(Protocol):
    def search(self, query: str) -> list[dict[str, Any]]: ...
    def queue(self) -> list[dict[str, Any]]: ...
    def put_note(self, path: str, content: str) -> dict[str, Any]: ...
    def submit(self, doc_id: str) -> dict[str, Any]: ...
    def create_proposal(self, target_id: str, body: str) -> dict[str, Any]: ...
    def create_review(self, target_id: str, body: str) -> dict[str, Any]: ...
    def approvals(self, doc_id: str) -> list[dict[str, Any]]: ...
    def decide(
        self,
        target_id: str,
        decision: str,
        comment: str | None = None,
        review_doc_id: str | None = None,
    ) -> dict[str, Any]: ...


def print_table(rows: list[dict[str, Any]], fields: list[str]) -> None:
    for row in rows:
        print("\t".join(str(row.get(field, "")) for field in fields))


def default_explore_path(direction: str) -> str:
    return f"explorations/{slugify(direction)}.md"


def default_task_path(direction: str) -> str:
    return f"tasks/{slugify(direction)}.md"


def command_search(client: Client, args: argparse.Namespace) -> int:
    print_table(client.search(args.query), ["doc_id", "path", "title", "rank"])
    return 0


def command_queue(client: Client, _args: argparse.Namespace) -> int:
    print_table(client.queue(), ["id", "path", "title", "type", "approvals", "rejections"])
    return 0


def command_task(client: Client, args: argparse.Namespace) -> int:
    title = args.direction.strip().splitlines()[0][:100]
    body = "\n".join(
        [
            f"# Exploration Task: {title}",
            "",
            '::: {.problem title="Exploration direction"}',
            args.direction.strip(),
            ":::",
            "",
            "## Operating Notes",
            "",
            "- Explorers may create new pages or proposals from this task.",
            "- Verifiers should review submitted documents through Cosheaf.",
            "- Failed attempts should remain discoverable as mathematical memory.",
        ]
    )
    path = args.path or default_task_path(args.direction)
    result = client.put_note(path, body)
    meta = result["meta"]
    if args.submit:
        client.submit(str(meta["id"]))
        meta["status"] = "unreviewed"
    print(f"{path}\t{meta['id']}\t{meta['status']}")
    return 0


def create_exploration(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    query = args.context_query or args.direction
    context = load_context(client, query, args.limit)
    prompt = build_explore_prompt(args.direction, context)
    body = run_agent(prompt, args.agent_cmd)
    path = args.path or default_explore_path(args.direction)
    result = client.put_note(path, body)
    meta = result["meta"]
    if args.submit:
        client.submit(str(meta["id"]))
        meta["status"] = "unreviewed"
    if not args.no_trace:
        append_trace(
            make_trace(
                "explore",
                args.direction,
                [doc.doc_id for doc in context],
                prompt,
                body,
                {"path": path, "meta": meta},
            )
        )
    return {"path": path, "meta": meta}


def command_explore(client: Client, args: argparse.Namespace) -> int:
    created = create_exploration(client, args)
    path = created["path"]
    meta = created["meta"]
    print(f"{path}\t{meta['id']}\t{meta['status']}")
    return 0


def command_propose(client: Client, args: argparse.Namespace) -> int:
    target = context_from_doc(client, args.target_id)
    query = args.context_query or args.direction
    context = [doc for doc in load_context(client, query, args.limit) if doc.doc_id != args.target_id]
    prompt = build_proposal_prompt(args.direction, target, context)
    body = run_agent(prompt, args.agent_cmd)
    result = client.create_proposal(args.target_id, body)
    meta = result["meta"]
    if args.submit:
        client.submit(str(meta["id"]))
        meta["status"] = "unreviewed"
    if not args.no_trace:
        append_trace(
            make_trace(
                "propose",
                args.direction,
                [target.doc_id, *[doc.doc_id for doc in context]],
                prompt,
                body,
                {"path": result["path"], "meta": meta},
            )
        )
    print(f"{result['path']}\t{meta['id']}\t{meta['status']}")
    return 0


def review_contexts(client: Client, target_id: str) -> list[ContextDoc]:
    out: list[ContextDoc] = []
    for approval in client.approvals(target_id):
        review_id = approval.get("review_doc_id")
        if not review_id:
            continue
        try:
            out.append(context_from_doc(client, str(review_id)))
        except Exception:
            continue
    return out


def command_repair(client: Client, args: argparse.Namespace) -> int:
    target = context_from_doc(client, args.target_id)
    reviews = review_contexts(client, args.target_id)
    direction = args.direction or "Repair the rejected document using the verifier reviews."
    prompt = build_repair_prompt(direction, target, reviews)
    body = run_agent(prompt, args.agent_cmd)
    result = client.create_proposal(args.target_id, body)
    meta = result["meta"]
    if args.submit:
        client.submit(str(meta["id"]))
        meta["status"] = "unreviewed"
    if not args.no_trace:
        append_trace(
            make_trace(
                "repair",
                direction,
                [target.doc_id, *[doc.doc_id for doc in reviews]],
                prompt,
                body,
                {"path": result["path"], "meta": meta},
            )
        )
    print(f"{result['path']}\t{meta['id']}\t{meta['status']}")
    return 0


def command_review(client: Client, args: argparse.Namespace) -> int:
    target = context_from_doc(client, args.target_id)
    prompt = build_review_prompt(target)
    raw = run_agent(prompt, args.agent_cmd)
    review = parse_review_result(raw)
    created = client.create_review(args.target_id, review.body)
    review_id = str(created["meta"]["id"])
    decided = client.decide(
        args.target_id,
        review.decision,
        comment=review.comment or None,
        review_doc_id=review_id,
    )
    if not args.no_trace:
        append_trace(
            make_trace(
                "review",
                f"review {args.target_id}",
                [target.doc_id],
                prompt,
                raw,
                {"created": created, "decision": decided},
            )
        )
    print(
        "\t".join(
            [
                review.decision,
                str(decided["doc_status"]),
                str(decided["approvals"]),
                str(decided["rejections"]),
                str(created["path"]),
                review_id,
            ]
        )
    )
    return 0


def command_review_queue(client: Client, args: argparse.Namespace) -> int:
    reviewed = 0
    for entry in client.queue()[: max(0, args.limit)]:
        child = argparse.Namespace(
            target_id=str(entry["id"]),
            agent_cmd=args.agent_cmd,
            no_trace=args.no_trace,
        )
        command_review(client, child)
        reviewed += 1
    if reviewed == 0:
        print("queue empty")
    return 0


def command_cycle(client: Client, args: argparse.Namespace) -> int:
    explore_args = argparse.Namespace(
        direction=args.direction,
        path=args.path,
        context_query=args.context_query,
        limit=args.limit,
        agent_cmd=args.agent_cmd,
        submit=True,
        no_trace=args.no_trace,
    )
    created = create_exploration(client, explore_args)
    meta = created["meta"]
    print(f"{created['path']}\t{meta['id']}\t{meta['status']}")
    review_args = argparse.Namespace(
        target_id=str(meta["id"]),
        agent_cmd=args.agent_cmd,
        no_trace=args.no_trace,
    )
    return command_review(client, review_args)


def command_workstream_start(client: Client, args: argparse.Namespace) -> int:
    return command_task(client, args)


def command_workstream_step(client: Client, args: argparse.Namespace) -> int:
    task = context_from_doc(client, args.task_id)
    direction = args.direction or f"Continue the exploration task {task.title}."
    explore_args = argparse.Namespace(
        direction=direction,
        path=args.path or f"explorations/{args.task_id}-{slugify(direction)}.md",
        context_query=args.context_query or task.title,
        limit=args.limit,
        agent_cmd=args.agent_cmd,
        submit=args.submit,
        no_trace=args.no_trace,
    )
    return command_explore(client, explore_args)

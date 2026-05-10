from __future__ import annotations

import argparse
import sys

from .agents import AgentError
from .commands import (
    command_cycle,
    command_explore,
    command_propose,
    command_queue,
    command_repair,
    command_review,
    command_review_queue,
    command_search,
    command_task,
    command_workstream_start,
    command_workstream_step,
)
from .cosheaf import CosheafClient, CosheafConfig, CosheafError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="autoprover")
    parser.add_argument("--url", default=None, help="Cosheaf URL, default COSHEAF_URL")
    parser.add_argument("--workspace", default=None, help="Cosheaf workspace, default COSHEAF_WORKSPACE")
    parser.add_argument("--token", default=None, help="Cosheaf API token, default COSHEAF_TOKEN")
    sub = parser.add_subparsers(dest="command", required=True)

    search = sub.add_parser("search", help="Search Cosheaf")
    search.add_argument("query")

    sub.add_parser("queue", help="Show Cosheaf review queue")

    task = sub.add_parser("task", help="Create a Cosheaf exploration task page")
    task.add_argument("--direction", required=True)
    task.add_argument("--path", default="", help="Target .md path; defaults under tasks/")
    task.add_argument("--submit", action="store_true")

    explore = sub.add_parser("explore", help="Run an explorer and create a page")
    explore.add_argument("--direction", required=True)
    explore.add_argument("--path", default="", help="Target .md path; defaults under explorations/")
    explore.add_argument("--context-query", default="", help="Search query for context; defaults to direction")
    explore.add_argument("--limit", type=int, default=5)
    explore.add_argument("--agent-cmd", default=None)
    explore.add_argument("--submit", action="store_true")
    explore.add_argument("--no-trace", action="store_true")

    propose = sub.add_parser("propose", help="Run an explorer and create a proposal for a page")
    propose.add_argument("target_id")
    propose.add_argument("--direction", required=True)
    propose.add_argument("--context-query", default="")
    propose.add_argument("--limit", type=int, default=5)
    propose.add_argument("--agent-cmd", default=None)
    propose.add_argument("--submit", action="store_true")
    propose.add_argument("--no-trace", action="store_true")

    repair = sub.add_parser("repair", help="Create a repair proposal from a rejected document")
    repair.add_argument("target_id")
    repair.add_argument("--direction", default="")
    repair.add_argument("--agent-cmd", default=None)
    repair.add_argument("--submit", action="store_true")
    repair.add_argument("--no-trace", action="store_true")

    review = sub.add_parser("review", help="Run a verifier and attach a review decision")
    review.add_argument("target_id")
    review.add_argument("--agent-cmd", default=None)
    review.add_argument("--no-trace", action="store_true")

    review_queue = sub.add_parser("review-queue", help="Review unreviewed Cosheaf documents")
    review_queue.add_argument("--limit", type=int, default=1)
    review_queue.add_argument("--agent-cmd", default=None)
    review_queue.add_argument("--no-trace", action="store_true")

    cycle = sub.add_parser("cycle", help="Run explore, submit, then review the generated document")
    cycle.add_argument("--direction", required=True)
    cycle.add_argument("--path", default="")
    cycle.add_argument("--context-query", default="")
    cycle.add_argument("--limit", type=int, default=5)
    cycle.add_argument("--agent-cmd", default=None)
    cycle.add_argument("--no-trace", action="store_true")

    workstream = sub.add_parser("workstream", help="Manage lightweight exploration workstreams")
    workstream_sub = workstream.add_subparsers(dest="workstream_command", required=True)
    ws_start = workstream_sub.add_parser("start", help="Create an exploration task document")
    ws_start.add_argument("--direction", required=True)
    ws_start.add_argument("--path", default="", help="Target .md path; defaults under tasks/")
    ws_start.add_argument("--submit", action="store_true")
    ws_step = workstream_sub.add_parser("step", help="Run one explorer step for a task")
    ws_step.add_argument("task_id")
    ws_step.add_argument("--direction", default="")
    ws_step.add_argument("--path", default="")
    ws_step.add_argument("--context-query", default="")
    ws_step.add_argument("--limit", type=int, default=5)
    ws_step.add_argument("--agent-cmd", default=None)
    ws_step.add_argument("--submit", action="store_true")
    ws_step.add_argument("--no-trace", action="store_true")

    return parser


def make_client(args: argparse.Namespace) -> CosheafClient:
    return CosheafClient(CosheafConfig.from_env(args.url, args.workspace, args.token))


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        client = make_client(args)
        if args.command == "search":
            return command_search(client, args)
        if args.command == "queue":
            return command_queue(client, args)
        if args.command == "task":
            return command_task(client, args)
        if args.command == "explore":
            return command_explore(client, args)
        if args.command == "propose":
            return command_propose(client, args)
        if args.command == "repair":
            return command_repair(client, args)
        if args.command == "review":
            return command_review(client, args)
        if args.command == "review-queue":
            return command_review_queue(client, args)
        if args.command == "cycle":
            return command_cycle(client, args)
        if args.command == "workstream":
            if args.workstream_command == "start":
                return command_workstream_start(client, args)
            if args.workstream_command == "step":
                return command_workstream_step(client, args)
        parser.error(f"unknown command: {args.command}")
    except (CosheafError, AgentError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0

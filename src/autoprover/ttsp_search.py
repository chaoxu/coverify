from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable, Literal


TerminalScope = Literal["internal", "all"]


@dataclass(frozen=True)
class TtspExpression:
    op: Literal["edge", "series", "parallel"]
    children: tuple["TtspExpression", ...] = ()

    @property
    def edge_count(self) -> int:
        if self.op == "edge":
            return 1
        return sum(child.edge_count for child in self.children)

    def key(self) -> str:
        if self.op == "edge":
            return "E"
        prefix = "S" if self.op == "series" else "P"
        return f"{prefix}({','.join(child.key() for child in self.children)})"

    def to_json(self) -> dict[str, Any]:
        if self.op == "edge":
            return {"op": "edge"}
        return {
            "op": self.op,
            "children": [child.to_json() for child in self.children],
        }


EDGE = TtspExpression("edge")


def make_series(children: Iterable[TtspExpression]) -> TtspExpression:
    flat: list[TtspExpression] = []
    for child in children:
        if child.op == "series":
            flat.extend(child.children)
        else:
            flat.append(child)
    if not flat:
        raise ValueError("series composition needs at least one child")
    if len(flat) == 1:
        return flat[0]
    return TtspExpression("series", tuple(flat))


def make_parallel(children: Iterable[TtspExpression]) -> TtspExpression:
    flat: list[TtspExpression] = []
    for child in children:
        if child.op == "parallel":
            flat.extend(child.children)
        else:
            flat.append(child)
    if not flat:
        raise ValueError("parallel composition needs at least one child")
    if len(flat) == 1:
        return flat[0]
    return TtspExpression("parallel", tuple(sorted(flat, key=lambda expr: expr.key())))


def generate_ttsp_expressions(max_edges: int, *, min_edges: int = 1) -> list[TtspExpression]:
    if max_edges < 1:
        raise ValueError("max_edges must be at least 1")
    if min_edges < 1:
        raise ValueError("min_edges must be at least 1")
    if min_edges > max_edges:
        raise ValueError("min_edges cannot exceed max_edges")

    by_count: dict[int, dict[str, TtspExpression]] = {1: {EDGE.key(): EDGE}}
    for edge_count in range(2, max_edges + 1):
        expressions: dict[str, TtspExpression] = {}
        for left_count in range(1, edge_count):
            right_count = edge_count - left_count
            for left in by_count[left_count].values():
                for right in by_count[right_count].values():
                    for expression in (
                        make_series((left, right)),
                        make_parallel((left, right)),
                    ):
                        expressions[expression.key()] = expression
        by_count[edge_count] = expressions

    out: list[TtspExpression] = []
    for edge_count in range(min_edges, max_edges + 1):
        out.extend(sorted(by_count[edge_count].values(), key=lambda expr: expr.key()))
    return out


@dataclass(frozen=True)
class Edge:
    id: str
    tail: str
    head: str

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "tail": self.tail, "head": self.head}


@dataclass(frozen=True)
class DirectedTtspGraph:
    expression: TtspExpression
    source: str
    sink: str
    vertices: tuple[str, ...]
    edges: tuple[Edge, ...]


class _GraphBuilder:
    def __init__(self) -> None:
        self._next_vertex = 0
        self._next_edge = 0
        self.vertices: list[str] = []
        self.edges: list[Edge] = []

    def new_vertex(self) -> str:
        vertex = f"v{self._next_vertex}"
        self._next_vertex += 1
        self.vertices.append(vertex)
        return vertex

    def add_edge(self, tail: str, head: str) -> None:
        edge = Edge(f"e{self._next_edge}", tail, head)
        self._next_edge += 1
        self.edges.append(edge)

    def build_between(self, expression: TtspExpression, source: str, sink: str) -> None:
        if expression.op == "edge":
            self.add_edge(source, sink)
            return

        if expression.op == "parallel":
            for child in expression.children:
                self.build_between(child, source, sink)
            return

        if expression.op == "series":
            current = source
            for index, child in enumerate(expression.children):
                child_sink = sink if index == len(expression.children) - 1 else self.new_vertex()
                self.build_between(child, current, child_sink)
                current = child_sink
            return

        raise ValueError(f"unknown expression op: {expression.op}")


def instantiate_expression(expression: TtspExpression) -> DirectedTtspGraph:
    builder = _GraphBuilder()
    source = builder.new_vertex()
    sink = builder.new_vertex()
    builder.build_between(expression, source, sink)
    return DirectedTtspGraph(
        expression=expression,
        source=source,
        sink=sink,
        vertices=tuple(builder.vertices),
        edges=tuple(builder.edges),
    )


def _numeric_suffix_key(label: str) -> tuple[str, int]:
    prefix = label.rstrip("0123456789")
    suffix = label[len(prefix) :]
    return prefix, int(suffix or "0")


def simple_directed_paths(
    graph: DirectedTtspGraph,
    source: str,
    sink: str,
    *,
    max_paths: int | None = None,
) -> list[tuple[str, ...]]:
    if source not in graph.vertices:
        raise ValueError(f"unknown source vertex: {source}")
    if sink not in graph.vertices:
        raise ValueError(f"unknown sink vertex: {sink}")
    if source == sink:
        return []

    adjacency: dict[str, list[Edge]] = defaultdict(list)
    for edge in graph.edges:
        adjacency[edge.tail].append(edge)
    for edges in adjacency.values():
        edges.sort(key=lambda edge: _numeric_suffix_key(edge.id))

    paths: list[tuple[str, ...]] = []

    def dfs(vertex: str, seen: set[str], prefix: tuple[str, ...]) -> None:
        if max_paths is not None and len(paths) >= max_paths:
            return
        if vertex == sink:
            paths.append(prefix)
            return
        for edge in adjacency.get(vertex, ()):
            if edge.head in seen:
                continue
            dfs(edge.head, seen | {edge.head}, prefix + (edge.id,))

    dfs(source, {source}, ())
    return paths


def path_edge_vector(path: Iterable[str]) -> dict[str, int]:
    vector: dict[str, int] = {}
    for edge_id in path:
        vector[edge_id] = vector.get(edge_id, 0) + 1
    return vector


def terminal_pair_records(
    graph: DirectedTtspGraph,
    *,
    scope: TerminalScope = "internal",
    max_paths_per_pair: int | None = None,
) -> list[dict[str, Any]]:
    if scope not in {"internal", "all"}:
        raise ValueError("terminal scope must be 'internal' or 'all'")

    records: list[dict[str, Any]] = []
    vertices = sorted(graph.vertices, key=_numeric_suffix_key)
    for source in vertices:
        for sink in vertices:
            if source == sink:
                continue
            is_global = source == graph.source and sink == graph.sink
            if scope == "internal" and is_global:
                continue
            paths = simple_directed_paths(graph, source, sink, max_paths=max_paths_per_pair)
            if not paths:
                continue
            pair_id = f"tp{len(records)}"
            records.append(
                {
                    "id": pair_id,
                    "source": source,
                    "sink": sink,
                    "is_global_pair": is_global,
                    "path_count": len(paths),
                    "paths": [
                        {
                            "id": f"{pair_id}-path{path_index}",
                            "edges": list(path),
                            "edge_vector": path_edge_vector(path),
                        }
                        for path_index, path in enumerate(paths)
                    ],
                },
            )
    return records


@dataclass(frozen=True)
class SearchConfig:
    max_edges: int
    min_edges: int = 1
    players: int = 4
    terminal_scope: TerminalScope = "internal"
    max_paths_per_pair: int | None = None
    limit_graphs: int | None = None


def graph_record(
    graph_id: str,
    graph: DirectedTtspGraph,
    *,
    terminal_scope: TerminalScope,
    max_paths_per_pair: int | None,
) -> dict[str, Any]:
    pairs = terminal_pair_records(
        graph,
        scope=terminal_scope,
        max_paths_per_pair=max_paths_per_pair,
    )
    return {
        "id": graph_id,
        "edge_count": graph.expression.edge_count,
        "expression": graph.expression.key(),
        "expression_tree": graph.expression.to_json(),
        "source": graph.source,
        "sink": graph.sink,
        "vertices": list(graph.vertices),
        "edges": [edge.to_json() for edge in graph.edges],
        "terminal_pair_count": len(pairs),
        "path_count": sum(pair["path_count"] for pair in pairs),
        "terminal_pairs": pairs,
    }


def build_search_payload(config: SearchConfig) -> dict[str, Any]:
    if config.players < 1:
        raise ValueError("players must be positive")
    if config.limit_graphs is not None and config.limit_graphs < 1:
        raise ValueError("limit_graphs must be positive when provided")
    if config.max_paths_per_pair is not None and config.max_paths_per_pair < 1:
        raise ValueError("max_paths_per_pair must be positive when provided")

    expressions = generate_ttsp_expressions(config.max_edges, min_edges=config.min_edges)
    if config.limit_graphs is not None:
        expressions = expressions[: config.limit_graphs]

    graphs = [
        graph_record(
            f"ttsp-{index}",
            instantiate_expression(expression),
            terminal_scope=config.terminal_scope,
            max_paths_per_pair=config.max_paths_per_pair,
        )
        for index, expression in enumerate(expressions)
    ]
    return {
        "schema_version": 1,
        "kind": "directed_ttsp_bounded_search",
        "description": "Directed TTSP graphs with reachable terminal pairs and simple directed paths for downstream LP checks.",
        "parameters": {
            "min_edges": config.min_edges,
            "max_edges": config.max_edges,
            "players": config.players,
            "terminal_scope": config.terminal_scope,
            "max_paths_per_pair": config.max_paths_per_pair,
            "limit_graphs": config.limit_graphs,
        },
        "runner_hints": {
            "template": "n_player_path_system",
            "candidate_use": (
                "For each player, choose a terminal-pair record and two path ids "
                "from that record as the Nash and optimum paths. Sum edge_vector "
                "values across chosen paths before adding LP constraints."
            ),
        },
        "graph_count": len(graphs),
        "graphs": graphs,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m autoprover.ttsp_search",
        description="Emit bounded directed-TTSP search data as structured JSON.",
    )
    parser.add_argument("--max-edges", type=int, default=4)
    parser.add_argument("--min-edges", type=int, default=1)
    parser.add_argument("--players", type=int, default=4)
    parser.add_argument("--terminal-scope", choices=("internal", "all"), default="internal")
    parser.add_argument("--max-paths-per-pair", type=int, default=0)
    parser.add_argument("--limit-graphs", type=int, default=0)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = SearchConfig(
        max_edges=args.max_edges,
        min_edges=args.min_edges,
        players=args.players,
        terminal_scope=args.terminal_scope,
        max_paths_per_pair=args.max_paths_per_pair or None,
        limit_graphs=args.limit_graphs or None,
    )
    payload = build_search_payload(config)
    json.dump(payload, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

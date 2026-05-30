from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

from coverify.ttsp_search import (
    EDGE,
    QueueConfig,
    SearchConfig,
    build_queue_payload,
    build_search_payload,
    generate_ttsp_expressions,
    instantiate_expression,
    main,
    make_parallel,
    make_series,
    simple_directed_paths,
    terminal_pair_records,
)


class TtspSearchTests(unittest.TestCase):
    def test_generates_canonical_directed_ttsp_expressions(self) -> None:
        expressions = generate_ttsp_expressions(3)
        keys_by_edge_count: dict[int, set[str]] = {}
        for expression in expressions:
            keys_by_edge_count.setdefault(expression.edge_count, set()).add(expression.key())

        self.assertEqual(keys_by_edge_count[1], {"E"})
        self.assertEqual(keys_by_edge_count[2], {"P(E,E)", "S(E,E)"})
        self.assertEqual(
            keys_by_edge_count[3],
            {
                "P(E,E,E)",
                "P(E,S(E,E))",
                "S(E,E,E)",
                "S(E,P(E,E))",
                "S(P(E,E),E)",
            },
        )

    def test_instantiates_graph_and_enumerates_internal_terminal_paths(self) -> None:
        expression = make_series((make_parallel((EDGE, EDGE)), EDGE))
        graph = instantiate_expression(expression)

        self.assertEqual(graph.source, "v0")
        self.assertEqual(graph.sink, "v1")
        self.assertEqual(
            [(edge.id, edge.tail, edge.head) for edge in graph.edges],
            [
                ("e0", "v0", "v2"),
                ("e1", "v0", "v2"),
                ("e2", "v2", "v1"),
            ],
        )
        self.assertEqual(
            simple_directed_paths(graph, graph.source, graph.sink),
            [("e0", "e2"), ("e1", "e2")],
        )

        records = terminal_pair_records(graph, scope="internal")
        by_endpoints = {(record["source"], record["sink"]): record for record in records}

        self.assertEqual(set(by_endpoints), {("v0", "v2"), ("v2", "v1")})
        self.assertEqual(
            [path["edges"] for path in by_endpoints[("v0", "v2")]["paths"]],
            [["e0"], ["e1"]],
        )
        self.assertEqual(by_endpoints[("v2", "v1")]["paths"][0]["edge_vector"], {"e2": 1})

    def test_search_payload_contains_runner_json(self) -> None:
        payload = build_search_payload(
            SearchConfig(
                min_edges=2,
                max_edges=2,
                players=4,
                terminal_scope="all",
            ),
        )

        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["kind"], "directed_ttsp_bounded_search")
        self.assertEqual(payload["parameters"]["players"], 4)
        self.assertEqual(payload["graph_count"], 2)

        series_graph = next(graph for graph in payload["graphs"] if graph["expression"] == "S(E,E)")
        global_pair = next(pair for pair in series_graph["terminal_pairs"] if pair["is_global_pair"])
        self.assertEqual(global_pair["source"], series_graph["source"])
        self.assertEqual(global_pair["sink"], series_graph["sink"])
        self.assertEqual(global_pair["paths"][0]["edge_vector"], {"e0": 1, "e1": 1})

    def test_queue_payload_selects_four_terminal_pair_cases(self) -> None:
        search_payload = build_search_payload(
            SearchConfig(
                min_edges=8,
                max_edges=8,
                players=4,
                terminal_scope="internal",
                limit_graphs=1005,
            ),
        )

        queue_payload = build_queue_payload(
            search_payload,
            QueueConfig(min_edges=8, players=4, quad_limit=2, queue_limit=3),
        )

        self.assertEqual(queue_payload["kind"], "directed_ttsp_bounded_queue")
        self.assertGreater(queue_payload["queued_graph_count_returned"], 0)
        self.assertLessEqual(queue_payload["queued_graph_count_returned"], 3)
        for graph in queue_payload["queued_graphs"]:
            self.assertGreaterEqual(graph["multi_path_terminal_pair_count"], 4)
            self.assertLessEqual(len(graph["best_terminal_quads"]), 2)
            for quad in graph["best_terminal_quads"]:
                self.assertEqual(len(quad["terminal_pair_ids"]), 4)
                self.assertGreaterEqual(quad["candidate_option_count"], 16)

    def test_module_cli_emits_json(self) -> None:
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            self.assertEqual(
                main(
                    [
                        "--min-edges",
                        "2",
                        "--max-edges",
                        "2",
                        "--terminal-scope",
                        "all",
                        "--limit-graphs",
                        "1",
                    ],
                ),
                0,
            )

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["graph_count"], 1)
        self.assertEqual(payload["parameters"]["limit_graphs"], 1)
        self.assertIn("graphs", payload)

    def test_module_cli_can_emit_queue_json(self) -> None:
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            self.assertEqual(
                main(
                    [
                        "--min-edges",
                        "8",
                        "--max-edges",
                        "8",
                        "--queue",
                        "--queue-min-edges",
                        "8",
                        "--queue-limit",
                        "1",
                    ],
                ),
                0,
            )

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["kind"], "directed_ttsp_bounded_queue")
        self.assertEqual(payload["queue_parameters"]["queue_limit"], 1)
        self.assertGreater(payload["queued_graph_count_returned"], 0)

    def test_module_cli_queue_uses_player_count_as_width(self) -> None:
        stdout = io.StringIO()
        with patch("sys.stdout", stdout):
            self.assertEqual(
                main(
                    [
                        "--players",
                        "3",
                        "--min-edges",
                        "8",
                        "--max-edges",
                        "8",
                        "--queue",
                        "--queue-min-edges",
                        "8",
                        "--queue-limit",
                        "1",
                    ],
                ),
                0,
            )

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["source_parameters"]["players"], 3)
        self.assertEqual(payload["queue_parameters"]["players"], 3)
        self.assertEqual(len(payload["queued_graphs"][0]["best_terminal_quads"][0]["terminal_pair_ids"]), 3)

    def test_queue_payload_excludes_global_pairs_even_when_search_payload_has_them(self) -> None:
        search_payload = build_search_payload(
            SearchConfig(
                min_edges=8,
                max_edges=8,
                players=4,
                terminal_scope="all",
                limit_graphs=1005,
            ),
        )

        queue_payload = build_queue_payload(
            search_payload,
            QueueConfig(min_edges=8, players=4, quad_limit=2, queue_limit=3),
        )
        by_id = {
            graph["id"]: {pair["id"]: pair for pair in graph["terminal_pairs"]}
            for graph in search_payload["graphs"]
        }
        self.assertGreater(queue_payload["queued_graph_count_returned"], 0)
        for graph in queue_payload["queued_graphs"]:
            for quad in graph["best_terminal_quads"]:
                for pair_id in quad["terminal_pair_ids"]:
                    self.assertFalse(by_id[graph["id"]][pair_id]["is_global_pair"])

    def test_queue_payload_can_derive_width_from_players(self) -> None:
        search_payload = build_search_payload(
            SearchConfig(
                min_edges=8,
                max_edges=8,
                players=3,
                terminal_scope="internal",
                limit_graphs=1005,
            ),
        )

        queue_payload = build_queue_payload(
            search_payload,
            QueueConfig(min_edges=8, players=3, quad_limit=1, queue_limit=1),
        )

        self.assertEqual(queue_payload["queue_parameters"]["players"], 3)
        self.assertGreater(queue_payload["queued_graph_count_returned"], 0)
        self.assertEqual(len(queue_payload["queued_graphs"][0]["best_terminal_quads"][0]["terminal_pair_ids"]), 3)


if __name__ == "__main__":
    unittest.main()

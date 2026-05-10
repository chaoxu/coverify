# Gap Against AI Co-Mathematician

Autoprover intentionally starts as a small Cosheaf worker harness. It borrows
the paper's workspace-first shape, but does not yet implement the full
co-mathematician system.

Already present:

- persistent mathematical workspace through Cosheaf
- native Coflat Markdown artifacts
- separate explorer and verifier commands
- asynchronous review queue compatibility
- rejected documents and verifier reviews preserved in Cosheaf
- JSONL traces for future learning experiments

Missing or deliberately minimal:

- no long-running daemon that subscribes to Cosheaf events
- no coordinator that allocates budget across multiple exploration threads
- no project-level planner that refines user intent into subgoals
- no debate, tournament, or cross-agent critique loop beyond Cosheaf review
- no hypothesis database beyond rejected documents and review records
- no retrieval beyond Cosheaf full-text search and simple status/type sorting
- no learned ranking, prioritization, or reinforcement-learning policy
- no formal-verification backend such as Lean
- no benchmark harness for comparing exploration quality against Rethlas or
  other systems

The next architectural step should be a small worker daemon that watches
Cosheaf tasks and queue entries, because that preserves the current boundary:
Cosheaf remains the knowledge base and approval system, while autoprover owns
agent scheduling and proof-writing behavior.

# Benchmark Issues

Benchmark work should start with verifier reliability before measuring full
exploration quality. Bad approval is the highest-risk failure mode because it
turns incorrect mathematics into golden Cosheaf knowledge.

Initial tracker:

- #1 Benchmark OPC verifier against human proof labels
- #2 Add BrokenMath safety benchmark for false-proof rejection
- #3 Create benchmark CLI and result schema
- #4 Evaluate explorer plus verifier loop on proof-generation tasks
- #5 Plan Lean benchmark adapter for MiniF2F and PutnamBench
- #6 Track research-level benchmark options

Recommended order:

1. Implement the shared benchmark CLI and JSONL result schema.
2. Add OPC as the first verifier benchmark.
3. Add BrokenMath as the false-approval safety benchmark.
4. Evaluate the explorer plus verifier loop.
5. Add Lean-backed benchmarks only after a formal-proof adapter exists.

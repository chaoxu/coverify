# Benchmark Issues

Benchmark work should start with verifier reliability before measuring full
exploration quality. Bad approval is the highest-risk failure mode because it
turns incorrect mathematics into golden Cosheaf knowledge.

Initial tracker:

- #1 Benchmark OPC verifier against human proof labels: implemented by
  `autoprover benchmark opc --mode review`
- #2 Add BrokenMath safety benchmark for false-proof rejection: implemented by
  `autoprover benchmark brokenmath --mode review`
- #3 Create benchmark CLI and result schema: implemented by `autoprover
  benchmark ... --output results.jsonl`
- #4 Evaluate explorer plus verifier loop on proof-generation tasks:
  implemented by `--mode generate`
- #5 Plan Lean benchmark adapter for MiniF2F and PutnamBench: deferred
- #6 Track research-level benchmark options: deferred

Dataset inputs:

The benchmark harness accepts JSON, JSONL, and CSV exports. It does not require
Cosheaf credentials. `scripts/prepare-benchmarks` converts public source data
into runnable JSONL.

`scripts/prepare-benchmarks` prepares the currently runnable public data:

- `.autoprover/benchmarks/datasets/brokenmath.jsonl`: runnable BrokenMath
  sample data.
- `.autoprover/benchmarks/datasets/opc-*.jsonl`: runnable OPC Hugging Face
  proof-body data for all available splits.
- `.autoprover/benchmarks/datasets/opc-pass-at-n.jsonl`: OPC aggregate
  repository metadata.

OPC is distributed as Parquet. If `pyarrow` is not already installed, the prep
script re-runs itself through `uv --with pyarrow` without adding a project
dependency.

Useful sources:

- OPC dataset: https://huggingface.co/datasets/INSAIT-Institute/OPC
- OPC repository: https://github.com/insait-institute/open-proof-corpus
- BrokenMath repository: https://github.com/insait-institute/broken-math
- BrokenMath dataset: https://huggingface.co/datasets/INSAIT-Institute/BrokenMath

Result records:

Each output line is JSON with benchmark name, item id, mode, expected decision,
verifier decision, pass/fail, elapsed time, explorer/verifier commands, prompt
hash, prompt versions, generated proof when applicable, reviewer comment, and
error text.

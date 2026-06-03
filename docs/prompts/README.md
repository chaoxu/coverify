# Prompt Templates

Coverify's operational interface is the repo-owned skill set under
[`../../skills`](../../skills). Prompt files in this directory are compatibility
shims for older docs and PRs; they should not duplicate the skill procedures.

Current prompt references:

- [Exploration Planner](exploration-planner.md) -> `coverify-exploration-planner`
- [Mathematical Resolution](proof-attempt-oracle.md) -> `coverify-proof-attempt`
- [Correctness Review](proof-review.md) -> `coverify-proof-review`
- [Knowledge-Base Writer](knowledge-base-writer.md) -> `coverify-kb-writer`
- [Knowledge-Base Manager](knowledge-base-manager.md) -> `coverify-kb-manager`

The prompt contract is:

- exploration may answer, route-find, call tools, or package resolution targets;
- mathematical resolution handles one exact hard target and returns one
  resolution artifact from the canonical vocabulary in
  `src/coverify/math_contract.py`;
- review/verifier prompts gate truth and status labels before anything is
  published or written as durable knowledge.

See [Reference Prompt Collection](reference/README.md) for paper-derived
patterns from QED, Rethlas, and future external systems. Reference patterns may
inspire skills or code later, but they are not workflow state by themselves.

When adapting these prompts, keep judgment in agentic preparation or oracle
calls. Move behavior into Python only for stable mechanics such as schema
validation, range extraction, citation normalization, audit recording, and
verifier gates.

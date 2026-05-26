# Prompt Templates

Autoprover's operational interface is the repo-owned skill set under
[`../../skills`](../../skills). Prompt files in this directory are compatibility
shims for older docs and PRs; they should not duplicate the skill procedures.

Current prompt references:

- [Exploration Planner](exploration-planner.md) -> `autoprover-exploration-planner`
- [Proof Attempt Oracle](proof-attempt-oracle.md) -> `autoprover-proof-attempt`
- [Correctness Review](proof-review.md) -> `autoprover-proof-review`
- [Knowledge-Base Writer](knowledge-base-writer.md) -> `autoprover-kb-writer`
- [Knowledge-Base Manager](knowledge-base-manager.md) -> `autoprover-kb-manager`

See [Reference Prompt Collection](reference/README.md) for paper-derived
patterns from QED, Rethlas, and future external systems. Reference patterns may
inspire skills or code later, but they are not workflow state by themselves.

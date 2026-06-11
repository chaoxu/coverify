# References

This is the compact index of external systems that influence Coverify. It records what we are using each reference for, not a full paper summary. For the detailed paper-by-paper account, see [Research-Agent Deep Dives](reference-deep-dives.md).

## Reading Rule

Every reference should answer one question:

```text
What should change in our prompts, tools, review gates, evals, or knowledge format?
```

Do not copy a system's surface complexity into Coverify by default. Judgment-heavy behavior should first become skill guidance, project documents, prompt patterns, or eval spikes. Python should get only stable mechanical checks: source-bundle export, backend calls, audit recording, path/range/citation validation, schemas, hashes, and verifier gates.

## Reference Map

| Reference | What It Shows | Coverify Lesson |
| --- | --- | --- |
| QED, An et al., 2026 | Multi-stage natural-language proof generation for open problems, with separate prover, structural verifier, detailed verifier, regulator, and expert review. | Copy problem-integrity checks, source/citation checking, hard-step expansion, and proposer/verifier separation; do not copy the full fixed pipeline unless evals justify it. |
| AI co-mathematician, Zheng et al., 2026 | Human-facing mathematical workbench with coordinator, workstreams, persistent state, reports, reviewers, and failed-route memory. | Cosheaf should be the durable workbench memory; failed routes and partial results matter when they prevent repeated work. |
| STAR-PólyaMath, Wu et al., 2026 | Reasoning-free orchestrator with visible state files, Reasoner, Verifier, Meta-Strategist, challenge loops, and replanning. | Visible attempt state and meta-strategy may help eval runs, but should start as skill/project guidance rather than default Coverify orchestration. |
| Goedel-Architect, Chung et al., 2026 | Blueprint graph of definitions and lemmas, node-level proof/refinement, and Lean-based acceptance. | Natural-language blueprint graphs are worth spiking as review aids, but without Lean they are not a trust gate. |
| AlphaProof Nexus, Tsoukalas et al., 2026 | Lean proof search with independent subagents, optional AlphaProof calls, evolutionary sketch population, and strict final validation. | Accepted claims need a hard gate. Do not import evolutionary machinery before simpler attempts lose under a fixed eval. |
| Rethlas / Archon, Ju et al., 2026 | Informal proof discovery with generator/verifier/tactics followed by Lean formalization through Archon. | Treat tactic inventories as reference patterns. The stronger lesson is proposer/reviewer/hard-verifier separation. |
| Gilbert-Pollak LLM system, Ke et al., 2026 | LLM proposes constrained geometric lemmas while symbolic/computational verification functions certify progress on a domain-specific lower-bound problem. | The best score loops are project-specific certificate loops: LLM proposes, local checker verifies, failures localize the next attempt. |

## Standing Design Lessons

- **Verification is the design center.** A fluent proof-shaped answer is not enough; publication needs source support, target fidelity, and an appropriate gate.
- **State should be visible.** Useful plans, failed routes, verifier objections, and candidate artifacts should become Cosheaf issues, PRs, reviews, comments, or pages.
- **Negative knowledge is valuable.** A failed route is progress when it says what failed, why, and what would make a retry materially different.
- **Source links are part of correctness.** Citations must identify the exact local statement or source range, not merely a plausible filename.
- **Complexity needs evals.** Multi-agent loops, blueprint graphs, meta-strategy, evolutionary search, and score loops should first be tested against simpler baselines.
- **Project-specific checkers belong with the project.** Coverify should expose generic backend, audit, source, and verifier surfaces; the golden repo should own domain-specific certificate languages and score rules.

## Where Lessons Land

- Architecture and contracts: [Design](design.md).
- Current project decisions: [Project Summary](project-summary.md).
- Failure taxonomy: [LLM Math Failure Modes](llm-math-failure-modes.md).
- Evaluation plan: [Experiments](experiments.md) and [Eval Problem Selection](eval-problem-selection.md).
- Detailed readings and reported evidence: [Research-Agent Deep Dives](reference-deep-dives.md).

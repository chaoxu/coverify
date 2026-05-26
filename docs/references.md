# References And Future Notes

This document records papers and external ideas that influence the design. It
is not a benchmark leaderboard and not a commitment to copy any system
architecture.

## Doc Map

- [README](../README.md) is the repository entry point.
- [Autoprover Design](design.md) is the canonical contract these references
  feed into.
- [Experiments](experiments.md) turns these design lessons into measurable
  comparisons.
- [Correctness Review Prompt](prompts/proof-review.md) applies the review-gate
  lessons to concrete mathematical knowledge review.
- [Proof Attempt Oracle Prompt](prompts/proof-attempt-oracle.md) records the
  clean standalone proof/disproof oracle template.
- [Exploration Planner Prompt](prompts/exploration-planner.md) records the
  prompt for turning current workspace state into issue-ready approaches.
- [Knowledge-Base Writer Prompt](prompts/knowledge-base-writer.md) records the
  artifact-writing prompt that turns useful source material into Coflat PR
  content without doing new mathematical reasoning.
- [Knowledge-Base Manager Prompt](prompts/knowledge-base-manager.md) records
  the maintenance prompt for consolidating, indexing, and reducing accepted
  workspace documents.
- [Prompt Templates](prompts/README.md) records the core prompt taxonomy.
- [Reference Prompt Collection](prompts/reference/README.md) indexes external
  prompt systems and their reusable patterns.
- [Coflat Context Primer](coflat-primer.md) is the local page-format guide for
  any design lesson that affects mathematical document structure.

The standing filter for each reference is:

```text
What should change in our prompts, tools, review gates, or knowledge format?
```

## QED

**QED: An Open-Source Multi-Agent System for Generating Mathematical Proofs on
Open Problems**, An et al., arXiv:2604.24021, 2026.

Links:

- Paper: https://arxiv.org/pdf/2604.24021
- Code: https://github.com/proofQED/QED

What matters:

- Research-level proving failures are often system-design failures, not only
  model-quality failures.
- The relevant failure modes are context contamination, citation
  hallucination, hand-waving on key steps, unstable proof plans, unfocused
  verification, problem modification, and single-model bottlenecks.
- Proving and verification should not share private context.
- Verification benefits from structural checks before detailed line-by-line
  checks.
- The prover should identify and expand the hardest original step.
- Problem-statement integrity is a hard check: the proof must solve the
  original problem, not a silently modified version.

Design lessons:

- Review templates should include problem integrity, citation grounding,
  key-step detail, and local logical correctness.
- A reviewer that cannot decide should request changes that make the PR
  decidable.
- For hard proof tasks, Codex can ask for a proof plan before a proof, but the
  plan should become text in PR context, not a private workflow graph.
- Retry feedback should distinguish execution errors, plan errors, and
  strategy errors.
- Do not copy QED's fixed multi-agent pipeline into v1.
- Treat QED's structural review, detailed review, and regulator prompts as
  reference checklists that can enrich the single review prompt or runner
  policy, not as mandatory separate workflow stages.

## AI Co-Mathematician

**AI co-mathematician: Accelerating mathematicians with agentic AI**, Zheng et
al., arXiv:2605.06651, 2026.

Link: https://arxiv.org/abs/2605.06651

What matters:

- Mathematical AI is framed as a workbench for exploratory research, not only
  as a prover that emits final answers.
- The workspace model matches Cosheaf's role: uncertainty, failed hypotheses,
  partial artifacts, and native mathematical outputs need durable places to
  live.
- Human mathematicians currently move by hand between informal reasoning,
  literature, computation, and proof checking.
- Negative knowledge matters. Failed routes, rejected lemmas, and
  problem-statement clarifications should be preserved when they prevent
  repeated work.
- Strong models are useful collaborators, but their outputs still need local
  grounding and correctness review.

Design lessons:

- Cosheaf should be the workbench memory; do not build a second hidden
  workspace.
- Context packs should preserve the original problem, accepted background,
  relevant failed attempts, and exact requested output shape.
- Oracle calls are the default path for mathematical reasoning once an agent
  gathers and filters context. The runner should not substitute its own proof
  judgment when a strong oracle call is available.
- Review should reward refusal and precise obstruction reports as real
  progress, not only completed proofs.
- Do not add a scheduler, learned prioritizer, or multi-agent allocator until
  the single-runner issue/PR loop is proven.

## Rethlas

**Rethlas**, FrenzyMath, 2026.

Links:

- Code: https://github.com/frenzymath/Rethlas
- Writeup: https://frenzymath.com/blog/conjecture

What matters:

- Rethlas uses a generation agent and a verification agent, with the generator
  repairing proof blueprints until verification passes.
- Its control loop is adaptive: search, toy examples, counterexamples,
  subgoal plans, direct proving, recursive proving, key-failure synthesis, and
  proof verification are chosen based on current state.
- It persists typed intermediate memory: conclusions, examples,
  counterexamples, subgoals, proof steps, failed paths, verification reports,
  and branch states.
- It treats failed paths as mandatory reusable memory.
- It treats search as support for reasoning, not a substitute for reasoning.

Design lessons:

- Keep the useful habit of preserving failed paths and counterexamples.
- Do not copy the full skill taxonomy into v1. Most Rethlas skills are tactics
  a runner can choose inside the three canonical prompts: explore, attempt,
  and review.
- If a tactic becomes repetitive and brittle, add a thin wrapper later. Until
  then, keep it as prompt guidance or a reference pattern.
- Map Rethlas-style typed memory to Cosheaf artifacts instead of creating a
  private memory store.

## Aletheia And Open-Problem Agents

**Towards Autonomous Mathematics Research**, Feng et al., 2026.

Notes surfaced from google-deepmind/superhuman and related Aletheia material:

- Review quality is a bottleneck.
- A system should be rewarded for refusing bad proofs rather than fabricating.
- Long-running mathematical work needs durable memory and resumability.
- External expert review remains expensive and should be protected by strong
  internal review filters.

Specific design ideas:

- **Grader as object**: reviewer or oracle calibration should be measurable.
  Reference solutions, grading guidelines, and calibration results should be
  Cosheaf artifacts, not private harness state.
- **Correctness and significance are separate**: if the harness records grades,
  keep significance separate from correctness. Prefer Cosheaf labels such as
  `sig:*` and `grade:*` before inventing a scoring table.
- **External grounding belongs in context packs**: retrieval should provide
  cited pages, related issues, PR history, reviews, and curated corpus excerpts
  explicitly.
- **Abstention is useful**: if review cannot decide, request changes; if the
  boundary is human, record `needs-human`.
- **Specification drift is a real risk**: context packs should preserve the
  original issue or problem statement separately from any proposed restatement.

## Future Learning

Learning and evaluation are not v1 requirements. The design should only avoid
closing them off.

If future implementation records traces, they should be derived from or linked
to Cosheaf artifacts:

- triggering issue, branch, PR, review, page, or comment
- context pack sent to Codex or a backend
- backend name and invocation metadata
- raw backend answer or Codex output
- knowledge PR, review, issue comment, or page update created after the run
- whether the related PR merged, changed, closed, or stayed open
- labels such as `grade:*`, `sig:*`, or `needs-human`
- follow-up issue/PR/review ids created from the run

Possible future uses:

- compare context-pack strategies
- decide when to call a stronger backend
- predict which branches or PRs are worth continuing
- calibrate reviewers or oracle backends
- study failed attempts preserved in Cosheaf

Non-goals for the design phase:

- no RL policy
- no learned scheduler
- no hidden long-term model memory
- no trace schema that becomes a second source of truth

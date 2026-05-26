# Prompt Templates

Autoprover v1 keeps the prompt surface deliberately small. Many named
activities from QED or Rethlas, such as counterexample construction, toy
examples, decomposition, recursive proving, regulator decisions, and document
tightening, are useful tactics for a runner. They are not separate core
workflow primitives.

The canonical prompt families are:

1. [Exploration Planner](exploration-planner.md): inspect current Cosheaf
   knowledge and propose issue-ready directions.
2. [Proof Attempt Oracle](proof-attempt-oracle.md): take one clean
   proof/disproof problem and produce the strongest mathematical attempt.
3. [Correctness Review](proof-review.md): decide whether proposed mathematical
   knowledge can pass the PR correctness gate. This applies to proofs, proof
   sketches, examples, obstructions, literature notes, and status summaries.

All three prompts must preserve trust class. Established mathematical context,
frontier hypotheses, process notes, raw oracle output, and retired evidence are
different channels. A context pack or prompt that flattens them into one
"knowledge" block can reproduce false progress by letting unreviewed or stale
material look accepted.

There is also one artifact-writing prompt:

- [Knowledge-Base Writer](knowledge-base-writer.md): convert useful source
  material, such as oracle output or checked calculations, into concise Coflat
  Markdown for a PR. This is not a mathematical oracle and not a review gate;
  it owns formatting, theorem/proof environments, stable block ids, trust
  labels, and reviewer checklists.

There is also one maintenance prompt:

- [Knowledge-Base Manager](knowledge-base-manager.md): improve the accepted
  Cosheaf workspace by consolidating notes, deleting superseded documents,
  creating a reader-facing index, removing duplication, and repairing scope
  drift. This can produce large PRs or complete rewrites when the user asks for
  a cleanup pass, but it is not a new mathematical proof role and
  correctness-relevant changes still go through review.

Reference prompts may still be collected later when they capture a useful
style or checklist. Reference prompts should not imply new mandatory skills,
queues, or workflow states unless repeated use proves they need code support.

See [Reference Prompt Collection](reference/README.md) for digests of QED,
Rethlas, and future external prompt systems.

# Rethlas Prompt Reference

Source: https://github.com/frenzymath/Rethlas

Writeup: https://frenzymath.com/blog/conjecture

Rethlas is a natural-language mathematical reasoning system built around a
generation agent and a verification agent. The generation agent writes and
repairs proof blueprints. The verification agent checks those blueprints and
returns structured feedback.

The 2026 Rethlas/Archon paper should be read as a two-level system, not just a
prompt collection:

- **Rethlas** is the informal discovery loop. It uses a generation agent,
  model-based verification agent, theorem retrieval, web/reference lookup,
  working memory, and tactic prompts such as examples, counterexamples,
  decomposition, direct proving, recursive proving, and failure synthesis.
- **Archon** is the formalization loop. It takes informal proof material and
  builds a Lean 4 project, using a Plan Agent plus one or more Lean Agents,
  LeanSearch, Lean diagnostics, informal-agent calls when stuck, and final
  checks for compilation with no `sorry`, no added axioms, and no escape
  hatches.
- The Rethlas verifier is not the final correctness guarantee. It is a
  model-based reviewer used to improve candidate informal proofs. The durable
  guarantee in the paper comes from Archon/Lean.
- The reported success therefore should not be interpreted as evidence that a
  large prompt taxonomy alone is enough. The stronger lesson is the separation
  between proposer, reviewer/planner, and a hard acceptance gate.

No license file was visible at the repository root when this digest was
created, so this file records links and design notes rather than copying full
upstream prompts.

## Core Control Prompt

Source:
https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/AGENTS.md

Important patterns:

- Start by resolving a problem markdown file inside the workspace.
- Read problem-specific references before external search.
- Initialize memory before reasoning.
- Persist intermediate artifacts in typed append-only channels.
- Choose tactics adaptively rather than following a fixed sequence.
- Treat search as support for reasoning, not a substitute for reasoning.
- Use verifier feedback to repair, backtrack, or change strategy.
- Stop only after a verified proof blueprint exists.

Coverify should reuse these as agentic tactic prompts and review checks, not as
a mandate to implement a local deterministic control loop.

## Skill Inventory

Upstream skill links:

- Obtain immediate conclusions:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/obtain-immediate-conclusions/SKILL.md
- Search math results:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/search-math-results/SKILL.md
- Construct toy examples:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/construct-toy-examples/SKILL.md
- Construct counterexamples:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/construct-counterexamples/SKILL.md
- Propose subgoal decomposition plans:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/propose-subgoal-decomposition-plans/SKILL.md
- Direct proving:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/direct-proving/SKILL.md
- Recursive proving:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/recursive-proving/SKILL.md
- Identify key failures:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/identify-key-failures/SKILL.md
- Query memory:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/query-memory/SKILL.md
- Verify proof:
  https://raw.githubusercontent.com/frenzymath/Rethlas/main/agents/generation/.agents/skills/verify-proof/SKILL.md

## Useful Patterns

### Typed Memory

Rethlas stores intermediate state in channels such as immediate conclusions,
toy examples, counterexamples, big decisions, subgoals, proof steps, failed
paths, verification reports, branch states, and events.

Coverify use: map these to Cosheaf artifacts. Examples:

- immediate conclusions -> issue comment or planning page
- counterexamples -> accepted obstruction page or PR comment
- subgoals -> issues
- proof steps -> branch commits and PR body
- failed paths -> closed PR, closed issue, or obstruction page
- verification reports -> PR review

### Adaptive Tactics

Rethlas chooses tactics based on current state. This is the main idea worth
keeping. The tactics themselves do not need to become Coverify skills.

Coverify use: an exploratory-response prompt can ask the runner to consider
these tactics while producing issue-ready approaches. A mathematical-resolution
target can ask for examples, counterexamples, decomposition, or literature
checks only when relevant to the exact target.

### Counterexample Discipline

Counterexample construction is treated as first-class. If a candidate
counterexample refutes a branch, Rethlas records its assumptions, failed
conclusion, and impact.

Coverify use: when a mathematical-resolution output disproves a claim or kills
a direction, turn it into a reviewable obstruction artifact rather than losing
it in logs.

### Verification Repair

Rethlas treats verifier `wrong`, critical errors, or gaps as failure. It then
repairs the proof, changes strategy, or records failed paths.

Coverify use: PR review is the gate. If review requests changes, the runner
repairs the branch or records the obstruction in Cosheaf.

## What Not To Copy

- Do not copy all Rethlas skills as mandatory Coverify skills.
- Do not create a separate local memory hierarchy as durable project state.
- Do not require recursive proving or parallel subagents in the default loop.
- Do not treat search results as accepted knowledge before review.
- Do not implement Rethlas-style tactic selection as Python planner code unless
  a narrow tactic has become a stable mechanical operation.
- Do not treat Rethlas's model-based verification loop as equivalent to a
  formal or trusted verifier. If Coverify replaces Lean with a natural
  verifier, that verifier needs an explicit pass/fail contract and calibration
  evals before it can promote claims to accepted knowledge.

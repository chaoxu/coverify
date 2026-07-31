# Retrospective: Coverify 1.0 vs the math-proof-search skill

Coverify 1.0 (2026-05 to 2026-07) was a Python CLI harness over Cosheaf.
The `math-proof-search` skill (canonical in
`~/kb/notes/agents/skills/math-proof-search/`, contract in
`~/kb/notes/agents/prompts/prompt-math-proof-search-launcher.md`) is a prose
contract that runs entire proof campaigns inside a frontier agent harness.
The skill, with far less machinery, produced the behavior 1.0 was built to
produce. This document records why, and what 2.0 keeps from each. The full
1.0 tree is in git history before the 2.0 rewrite commit.

## What 1.0 got right

These survived contact with real use and carry into 2.0:

- **Two contracts.** Exploratory response vs mathematical resolution — one
  flexible mode, one strict mode with an exact frozen statement, exact
  hypotheses, allowed context, and one requested artifact from a canonical
  vocabulary (proof, construction, counterexample, certificate, bound,
  obstruction, computation, gap report). The skill's frozen-target discipline
  is the same idea. This is the core intellectual asset.
- **Verification at the boundary.** Nothing reaches the user or durable state
  unverified. Pessimistic aggregation (every referee must pass), cross-family
  referees, blind checks by verifiers that never saw the drafting. `coverify
  ask` proved this valuable daily.
- **Audit trails and durable state.** Every backend call recorded
  prompt/answer/metadata; progress written somewhere that survives the
  session. The instinct was right; the storage was wrong (see below).
- **The stated architecture principle** — "agency lives in agents, mechanical
  validation lives in code; do not rebuild a planner in Python." 1.0 wrote
  this in AGENTS.md and then violated it structurally (see below).
- **The bitter-lesson stance.** Keep what appreciates with model capability
  (durable state, boundary verification, audit, budgets, computational ground
  truth); keep orchestration soft. Correct, and 2.0's design test.

## What 1.0 got wrong

- **Cosheaf coupling.** A Forgejo-based platform — workspaces, issues, PRs,
  bot tokens, an autodeploy timer, a systemd worker on jupiter with SELinux
  and venv-drift gotchas — to store markdown. The skill demonstrates that
  durable campaign state is plain files in a folder: statement, frontier,
  ledgers, attempt artifacts. Review gates don't need a review *platform*;
  they need a verifier with a contract. The operational surface consumed most
  of the project's maintenance budget and produced zero mathematical value.
- **Wrapping CLIs instead of owning the loop.** Backends were `codex` /
  `claude -p` subprocesses with a prompt-in/answer-out contract. That throws
  away the agency of the wrapped model — no tools, no iteration, no
  minimal-context subagents. The eval verdict was blunt: Coverify+Codex
  equaled raw Codex (5/10 vs 5/10, ResearchMath sample-10;
  `coverify_strictly_improved_over_direct_codex: false`). A harness that
  adds process but not structure adds nothing.
- **Command proliferation.** ~20 subcommands, an attempt/promote lifecycle,
  workspace scaffolding, skills that existed to teach agents the CLI that
  existed to serve the skills. Ceremony grew where mathematics didn't. The
  skill has one entry point: an exact statement in, a campaign out.
- **Agency in the wrong place.** 1.0 kept drifting toward deterministic
  Python deciding what context matters and what happens next. The skill puts
  route choice, struggle detection, and promotion judgment in the model, and
  is explicit about *when code-like rules apply* (interrupt only on
  observable evidence, never on wall-clock).
- **Build order.** Golden repo first, exploration loop second, verified
  answers last — the reverse of value order.

## What the skill has that 1.0 lacked

The skill is a *campaign structure*, and structure is what the evals said 1.0
was missing:

- a persistent goal with durable statement/frontier/ledger files and
  checkpointed resume (trust the ledgers, reread minimally, relaunch);
- waves of minimal-context subagents (`fork_turns="none"` — each worker gets
  only the exact task, constraints, promoted premises, nearest failed-route
  boundary, assigned artifact);
- an idea gate: a fresh critic must PASS a mechanism's first nontrivial
  implication before a wave is invested in it;
- blind verification: never let a worker that saw the candidate check it;
- a failure-route registry with a compact selector index (mechanism
  fingerprint × missing implication) so later waves don't repeat registered
  dead mechanisms;
- the non-circular reduction gate: renaming the problem is not progress;
- finite mathematical deliverables per packet, never wall-clock quotas.

## What the skill lacks that pi supplies

The skill is prose interpreted by a coordinator model inside someone else's
harness (Claude Code / Codex semantics, `fork_turns`, goal tools). Three
consequences:

- **Drift.** Cadence, gates, and ledger discipline are obligations the
  coordinator may honor imperfectly, and nothing mechanical catches it.
- **Harness dependence.** The campaign can only run where the host harness
  runs, with the host's subagent and persistence semantics.
- **No programmable boundary.** Budgets, verifier fan-out, pessimistic
  aggregation, schema checks on ledger entries — all enforceable in 30 lines
  of code each — are instead paragraphs.

pi (`@earendil-works/pi-agent-core`) inverts this: the agent loop, tools,
context assembly, and subagent spawning are ordinary TypeScript. The campaign
*skeleton* — state layout, wave dispatch, idea gate, blind verifier fan-out,
ledger schemas, budget stops — becomes code that cannot drift, while route
choice, proof work, and judgment stay in the model. That is finally the
boundary AGENTS.md 1.0 asked for: agentic preparation, mechanical validation.

## The 2.0 thesis

Compile the launcher contract into a small pi program.

- A project is a folder. Durable state is files in that folder. No Cosheaf,
  no server, no worker, no deploy pipeline.
- One CLI (`coverify`), runnable standalone or invoked as a tool from any
  harness — a Codex or Claude Code session can call `coverify prove` the way
  1.0's skills called `bin/coverify`.
- Own the loop with pi instead of wrapping CLIs: workers are fresh in-process
  `Agent` instances with minimal context, not subprocess prompts.
- Keep only what appreciates with model capability; every orchestration rule
  in code needs a written reason it must be mechanical (a gate, a budget, a
  schema) rather than a prompt.

See `docs/design.md` for the mapping from the launcher contract to the pi
runtime.

---
name: coverify-run-loop
description: Run the lightweight Coverify orchestration loop end to end. Use when Codex should make durable mathematical progress in Cosheaf by building context, planning or attempting, writing useful knowledge, requesting review, and recording what changed.
---

# Coverify Run Loop

## Purpose

Keep the system simple: the orchestrator chooses the next useful action, skills
nudge that choice, and review or verification checks the result.

Prefer agentic preparation over more workflow code. If the next step requires
judgment, ask an agent or oracle to inspect the allowed context and produce a
bounded artifact; use Python only for stable tool calls, audit recording, and
mechanical validation.

Use two output contracts:

- Exploratory response for normal chat, source-grounded answers, route
  exploration, issue triage, status summaries, and packaging resolution targets.
- Mathematical resolution only for one exact theorem, conjecture,
  counterexample search, construction, witness, bound, certificate, obstruction,
  reduction, or key step.

A broad issue starts as exploratory response unless it already contains a clean
resolution target. A normal chat answer is exploratory response with a
direct-answer target.

## Loop

1. **Refresh state**: read the issue/task, topic pages, open PRs, and relevant
   recent history.
2. **Build context**: use `$coverify-context-builder`.
3. **Choose the output contract**:
   - use exploratory response by default,
   - use mathematical resolution only after packaging one exact target.
4. **Choose one action**:
   - use `$coverify-exploration-planner` for direct source-grounded answers,
     unclear routes, issue triage, or obligation packaging,
   - use `$coverify-proof-attempt` for one clean mathematical question under
     the mathematical-resolution contract,
     defaulting to text-in/text-out rather than code,
   - use `$coverify-kb-writer` when useful material should become a PR,
   - use `$coverify-kb-manager` for cleanup or consolidation,
   - use `$coverify-proof-review` for correctness-relevant PR review.
   Run computation only when the chosen action names a finite yes/no check and
   the small witness, certificate, or table it should produce.
   If the target requires a specific theorem, route, construction shape, or
   proof method, include that as a forced constraint and verify compliance.
5. **Write durable state**: issue, branch, PR, review, comment, or merged page.
6. **Verify**: run tests, exact checks, live Cosheaf inspection, or review as
   appropriate.
7. **Audit residue**: before stopping or switching tasks, decide what happens
   to exploratory scripts, branches, logs, and generated artifacts. Keep code
   only if it reproduces a named accepted claim or active issue check with a
   compact command and output; otherwise distill the result and delete it or
   leave it off main.
8. **Measure completeness**: record what changed and what still blocks the
   goal.

## Stop Rule

Do not stop because a subcase worked, a raw search ran, or an oracle answered.
Stop when there is durable state change, a reviewed rejection, a precise
"things tried" note, or a real blocker that future work can inspect.

## Run Summary

```text
TASK:
OUTPUT_CONTRACT:
CONTEXT_USED:
ACTION_TAKEN:
PRIOR_ROUTE_CHECK:
DURABLE_STATE_CHANGED:
VERIFICATION:
THINGS_TRIED_UPDATED:
SCRIPT_RETENTION_DECISION:
NEXT_BLOCKER_OR_ROUTE:
COMPLETENESS:
```

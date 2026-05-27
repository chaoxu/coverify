---
name: autoprover-run-loop
description: Run the lightweight Autoprover orchestration loop end to end. Use when Codex should make durable mathematical progress in Cosheaf by building context, planning or attempting, writing useful knowledge, requesting review, and recording what changed.
---

# Autoprover Run Loop

## Purpose

Keep the system simple: the orchestrator chooses the next useful action, skills
nudge that choice, and review or verification checks the result.

## Loop

1. **Refresh state**: read the issue/task, topic pages, open PRs, and relevant
   recent history.
2. **Build context**: use `$autoprover-context-builder`.
3. **Choose one action**:
   - use `$autoprover-exploration-planner` when the next route is unclear,
   - use `$autoprover-proof-attempt` for one clean mathematical question,
     defaulting to text-in/text-out rather than code,
   - use `$autoprover-kb-writer` when useful material should become a PR,
   - use `$autoprover-kb-manager` for cleanup or consolidation,
   - use `$autoprover-proof-review` for correctness-relevant PR review.
   Run computation only when the chosen action names a finite yes/no check and
   the small witness, certificate, or table it should produce.
4. **Write durable state**: issue, branch, PR, review, comment, or merged page.
5. **Verify**: run tests, exact checks, live Cosheaf inspection, or review as
   appropriate.
6. **Audit residue**: before stopping or switching tasks, decide what happens
   to exploratory scripts, branches, logs, and generated artifacts. Keep code
   only if it reproduces a named accepted claim or active issue check with a
   compact command and output; otherwise distill the result and delete it or
   leave it off main.
7. **Measure completeness**: record what changed and what still blocks the
   goal.

## Stop Rule

Do not stop because a subcase worked, a raw search ran, or an oracle answered.
Stop when there is durable state change, a reviewed rejection, a precise
"things tried" note, or a real blocker that future work can inspect.

## Run Summary

```text
TASK:
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

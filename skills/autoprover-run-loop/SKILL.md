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
   - use `$autoprover-kb-writer` when useful material should become a PR,
   - use `$autoprover-kb-manager` for cleanup or consolidation,
   - use `$autoprover-proof-review` for correctness-relevant PR review.
4. **Write durable state**: issue, branch, PR, review, comment, or merged page.
5. **Verify**: run tests, exact checks, live Cosheaf inspection, or review as
   appropriate.
6. **Measure completeness**: record what changed and what still blocks the
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
NEXT_BLOCKER_OR_ROUTE:
COMPLETENESS:
```

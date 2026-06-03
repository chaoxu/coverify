---
name: coverify-exploration-planner
description: Plan Coverify mathematical exploration from current Cosheaf knowledge, live issues, PRs, and tried routes. Use when deciding whether to answer directly, compare routes, package resolution targets, call an oracle, or draft issues without repeating failed work.
---

# Coverify Exploration Planner

## Purpose

Use the exploratory-response contract. Turn the current workspace state into a
source-grounded answer, status summary, route comparison, packaged
mathematical-resolution target, or small set of issue-ready approaches.
Exploration is not proof. It should identify what the
sources support, what remains speculative, which routes are worth trying, which
routes to avoid, and which exact resolution targets are ready for strict
mathematical resolution.

Planning should remain agentic. Do not turn route choice, context selection, or
"what evidence matters" into new deterministic Python code unless the behavior
is already stable and mechanical. Coverify may validate paths, line ranges,
schemas, citations, and verifier verdicts; the planner should make the adaptive
choice.

## Workflow

1. Use `$coverify-context-builder` first unless a fresh context summary is
   already present.
2. Separate accepted knowledge from live coordination, frontier ideas, and raw
   output.
3. Inspect "things tried" notes and relevant issue/PR history before proposing
   routes.
4. If the request is a direct source question, answer it directly with source
   grounding and honest uncertainty instead of inventing extra workflow.
5. Propose only bounded routes whose success or failure would create durable knowledge.
   Prefer text oracle/prover calls when the finite structure can be stated
   clearly without code.
6. For each route, state the first step, expected artifact, likely failure
   mode, closest prior tried route, and whether any code produced by the route
   would be kept, deleted, or left off main after distillation.
7. Package resolution targets only when the statement, hypotheses, allowed
   context, forced method or route constraints, and failed-route warnings are
   specific enough for mathematical resolution.
8. Draft issues only for routes that a later runner can start without guessing.

## Output

```text
CURRENT_STATE:

DIRECT_RESPONSE:

APPROACHES:
- Title:
  Idea:
  Why plausible:
  First step:
  Expected artifact:
  Prior route check:
  Oracle or computation:
  Script retention:
  Issue draft:

PACKAGED_RESOLUTION_TARGETS:
- Statement:
  Hypotheses:
  Allowed context:
  Forced method / constraints:
  Things tried / Do not retry:
  Output target:

DUPLICATES_OR_REJECTED:

FAILED_ROUTE_PROMOTION:

RECOMMENDED_ORDER:

MISSING_CONTEXT:
```

## Issue Quality Bar

An issue-ready route names the exact mathematical subproblem, first artifacts
to inspect, what counts as progress, which dead ends to avoid, and whether the
task should call a text oracle, run computation, or stay agentic. Computation is
justified only for a named finite yes/no check whose output should be a small
witness, certificate, or table that survives after exploratory code is deleted
or kept off main.

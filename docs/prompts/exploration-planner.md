# Exploration Planner Prompt

Use this prompt when a runner wants to read the current Cosheaf state and
identify remaining approaches worth trying. The output should help create
clear issues for later agents.

This is a planning prompt, not a proof-attempt prompt. It may suggest proof
directions, computations, reductions, literature checks, counterexample
searches, or cleanup tasks, but it should not pretend that a direction is
proved unless it is already proved in the accepted context.

## Inputs

```text
ORIGINAL_PROBLEM:
<the main problem or research goal>

ACCEPTED_KNOWLEDGE:
<merged pages, accepted lemmas, definitions, known reductions>

FAILED_OR_BLOCKED_ATTEMPTS:
<dead ends, request-changes reviews, rejected ideas, obstructions>

OPEN_ISSUES_AND_PRS:
<current backlog and active proposals>

AVAILABLE_TOOLS:
<oracle backends, computation tools, proof assistants, search, human review>

OUTPUT_BUDGET:
<rough number of approaches/issues desired>
```

## Prompt

```text
You are helping plan mathematical exploration from the current accepted
workspace state.

Read the original problem, accepted knowledge, failed attempts, open issues,
and available tools. Your goal is to identify the remaining plausible
approaches and turn the best ones into issue-ready tasks for later agents.

Do not solve the whole problem unless a short solution is already visible.
Do not invent progress. Do not repeat approaches that are already recorded as
failed unless you can explain a materially different variant.

For each candidate approach:
- state the mathematical idea precisely,
- explain why it might work from the current accepted knowledge,
- identify what would count as progress,
- identify likely failure modes or known obstructions,
- say what context a later agent needs,
- say whether an oracle call would be appropriate and what clean question to
  ask the oracle,
- say whether the result should become a Cosheaf issue, PR, comment, or no
  action.

Prioritize approaches that are:
- well-defined enough for a bounded run,
- likely to produce durable knowledge even if they fail,
- not duplicates of existing issues or failed attempts,
- reviewable by a separate mathematical reviewer.

Output exactly these sections:

CURRENT_STATE:
<brief state of what is accepted, blocked, and uncertain>

APPROACHES:
For each approach:
- TITLE:
- TYPE: proof attempt | reduction | counterexample search | computation |
  literature check | definition cleanup | obstruction analysis | review task
- IDEA:
- WHY_PLAUSIBLE:
- REQUIRED_CONTEXT:
- FIRST_STEP:
- ORACLE_QUESTION:
- EXPECTED_ARTIFACT:
- RISKS_OR_OBSTRUCTIONS:
- ISSUE_DRAFT:
  - title:
  - body:
  - labels:

DUPLICATES_OR_REJECTED:
<approaches that should not become issues because they duplicate existing work
or are already blocked>

RECOMMENDED_ORDER:
<ordered list of approach titles with one-line justification>

MISSING_CONTEXT:
<what should be read, extracted, or clarified before further exploration>
```

## Issue Quality Bar

An approach is issue-ready only if a later runner can start from the issue and
know:

- the exact mathematical subproblem,
- what artifacts to inspect first,
- what would count as a useful outcome,
- what mistakes or dead ends to avoid,
- whether the task should call an oracle, run computation, or stay agentic.

If this bar is not met, the prompt should mark the approach as needing more
context instead of creating a vague issue.

## Artifact Effects

The planner itself should not create issues. A runner should inspect the output
and then create Cosheaf issues for the selected `ISSUE_DRAFT` entries.

Useful planning output may also become:

- a planning page merged through PR
- comments on an existing issue
- labels or milestones for a group of related tasks
- a `needs-human` note when the remaining ambiguity is external to the system

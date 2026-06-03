---
name: coverify-proof-attempt
description: Prepare and evaluate one exact Coverify mathematical-resolution target, usually through a text-in/text-out prover/oracle, after context has been built.
---

# Coverify Proof Attempt

## Purpose

Use the mathematical-resolution contract. Prepare one clean reasoning task for
an oracle or focused prover/resolver call. The runner owns context and artifact
handling; the oracle owns mathematical reasoning when available.

This is not exploratory chat. Use it only for one exact theorem, conjecture,
or other exact mathematical target. The expected result is one resolution
artifact from the canonical vocabulary in `src/coverify/math_contract.py`. The
skill keeps the conventional "proof attempt" name because people often call the
strong mathematical resolver a prover.

Preparation can be agentic over the allowed context. Do not add Python code to
choose proof routes or relevant lemmas unless the behavior is a stable
mechanical check.

## Workflow

1. Use `$coverify-context-builder` to gather the exact problem, accepted
   context, and relevant tried routes.
2. State the problem without changing scope or adding hidden hypotheses.
3. Include only accepted context, explicitly allowed frontier assumptions, and
   a short "Things tried / Do not retry" note when repetition is possible.
4. Include forced facts, theorems, constructions, methods, or route constraints
   when the target requires them.
5. Default to a text-in/text-out oracle/prover call. Do not
   create repo code for an ordinary oracle question. Use pseudocode or small
   tables in the prompt when they communicate the finite structure.
6. Ask for one canonical resolution artifact. Do not ask for broad route
   brainstorming inside this call.
7. Require the answer to distinguish the requested resolution artifact from
   incomplete progress, unresolved gaps, and merely plausible strategy.
8. Quarantine raw output. If useful, pass it through `$coverify-kb-writer`
   and then `$coverify-proof-review` before treating it as accepted.

## Computation Boundary

A mathematical-resolution call is not a license to write scripts. Switch to a
computation route only when the question names a finite certificate,
counterexample, LP, or other check that cannot be represented clearly in the
text prompt. In that case, define the yes/no question, smallest expected witness
or certificate, and script retention decision before writing code.

## Oracle Prompt Shape

```text
Problem:

Allowed context:

Forced method / constraints:
<required theorem, route, construction shape, proof style, or "none">

Things tried / Do not retry:
<closest prior failed route, why this attempt is different, or "no close prior route found">

Output target:
<one canonical resolution artifact from src/coverify/math_contract.py>

Requirements:
- Do not search the internet.
- Use only the problem statement and allowed context.
- Do not change the problem.
- Follow the forced method or constraints exactly. If they cannot be followed,
  explain the precise obstruction instead of switching methods silently.
- Do not brainstorm beyond the packaged target.
- Do not propose multiple routes unless reporting why mathematical resolution
  failed.
- Do not write code or rely on unprovided computation.
- Do not retry a listed failed route unless the prompt states what is
  materially new.
- Give a complete argument when possible.
- If incomplete, state the gap and strongest justified partial progress.
```

## Useful Output Shape

```text
CLAIM:
CONTRACT:
RESOLUTION_ARTIFACT_TYPE:
RESOLUTION_ARTIFACT:
COMPLETENESS_STATUS:
KEY_IDEA:
NONTRIVIAL_DEPENDENCIES:
UNRESOLVED_GAPS:
PRIOR_ROUTE_CHECK:
CHECKS_FOR_REVIEWER:
```

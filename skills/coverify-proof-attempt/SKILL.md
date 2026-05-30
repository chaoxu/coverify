---
name: coverify-proof-attempt
description: Prepare and evaluate a clean Coverify proof or disproof attempt, usually through a text-in/text-out oracle. Use for one well-defined mathematical problem, obstruction, counterexample, reduction, or key proof step after context has been built.
---

# Coverify Proof Attempt

## Purpose

Prepare one clean reasoning task for an oracle or focused proof attempt. The
runner owns context and artifact handling; the oracle owns mathematical
reasoning when available.

## Workflow

1. Use `$coverify-context-builder` to gather the exact problem, accepted
   context, and relevant tried routes.
2. State the problem without changing scope or adding hidden hypotheses.
3. Include only accepted context, explicitly allowed frontier assumptions, and
   a short "Things tried / Do not retry" note when repetition is possible.
4. Default to a text-in/text-out oracle call or agentic proof attempt. Do not
   create repo code for an ordinary oracle question. Use pseudocode or small
   tables in the prompt when they communicate the finite structure.
5. Ask for a proof, disproof, obstruction, or strongest justified partial
   progress.
6. Require the answer to distinguish proved claims, plausible strategies, and
   unverified ideas.
7. Quarantine raw output. If useful, pass it through `$coverify-kb-writer`
   and then `$coverify-proof-review` before treating it as accepted.

## Computation Boundary

A proof attempt is not a license to write scripts. Switch to a computation
route only when the question names a finite certificate, counterexample, LP, or
other check that cannot be represented clearly in the text prompt. In that
case, define the yes/no question, smallest expected witness or certificate, and
script retention decision before writing code.

## Oracle Prompt Shape

```text
Problem:

Allowed context:

Things tried / Do not retry:
<closest prior failed route, why this attempt is different, or "no close prior route found">

Output target:
<proof | disproof | obstruction | either proof/disproof | key step>

Requirements:
- Do not search the internet.
- Use only the problem statement and allowed context.
- Do not change the problem.
- Do not write code or rely on unprovided computation.
- Do not retry a listed failed route unless the prompt states what is
  materially new.
- Give a complete argument when possible.
- If incomplete, state the gap and strongest justified partial progress.
```

## Useful Output Shape

```text
CLAIM:
PROOF_OR_DISPROOF:
KEY_IDEA:
NONTRIVIAL_DEPENDENCIES:
UNRESOLVED_GAPS:
PRIOR_ROUTE_CHECK:
CHECKS_FOR_REVIEWER:
```

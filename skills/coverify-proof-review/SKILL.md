---
name: coverify-proof-review
description: Review Coverify mathematical PRs for correctness before merge. Use when a Cosheaf PR proposes proofs, examples, computations, obstructions, literature notes, source-backed claims, status summaries, or any correctness-relevant knowledge-base change.
---

# Coverify Proof Review

## Purpose

Gate correctness-relevant knowledge before merge. Review is about whether the
submitted PR is safe to accept, not about improving the proof or exploring new
routes.

Review judgment belongs to the reviewer/oracle. Use code for mechanical checks
such as path existence, cited ranges, schema shape, and reproducible
computations; do not turn correctness review into deterministic planner code.

## Workflow

1. Build review context: original problem or task, PR diff, full submitted
   changed text, accepted KB statements used or cited by the change, cited
   external evidence, and relevant issue/PR history.
2. Check problem integrity first: the PR must address the stated task without
   silently changing the model, hypotheses, graph class, objective, terminals,
   or player assumptions.
3. Review logical steps, definitions, quantifiers, dependencies, citations,
   examples, computations, and status wording. Do not review a diff in
   isolation when the proof depends on accepted KB theorems, definitions, or
   source notes.
4. Treat raw oracle output, local scratch, process history, and issue comments
   as non-evidence unless distilled into reviewed knowledge.
5. Findings lead. Approve only when there is no logical gap and remaining
   issues are exposition-only.
6. Map the decision to a Cosheaf PR review. Do not merge from this skill.

## Decision Rules

- `APPROVE`: no logical gap; task satisfied; references and computations check.
- `REQUEST_CHANGES`: fatal gap, fixable correctness omission, notation problem
  affecting correctness, unsupported citation, or undecidable claim.
- `COMMENT`: non-blocking notes only.

## Output

```text
DECISION: APPROVE | REQUEST_CHANGES | COMMENT

FINDINGS:
PROBLEM_INTEGRITY:
NONTRIVIAL_DEPENDENCIES:
ACCEPTED_KB_DEPENDENCIES:
REFERENCE_CHECK:
COMPUTATION_OR_EXAMPLE_CHECK:
MINOR_ISSUES:
BLOCKING_CHANGES:
VERDICT:
```

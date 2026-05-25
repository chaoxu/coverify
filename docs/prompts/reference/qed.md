# QED Prompt Reference

Source: https://github.com/proofQED/QED

License: MIT License, copyright 2026 proofQED.

Paper: https://arxiv.org/abs/2604.24021

QED is a fixed multi-stage proof pipeline. It is useful as a reference for
prompt checklists, but Autoprover v1 should not copy its full workflow shape.
QED stages should map into our three canonical prompt families:

| QED component | Autoprover interpretation |
| --- | --- |
| Literature survey | Explore tactic |
| Decomposition prover | Attempt tactic or issue decomposition |
| Single prover | Attempt prompt |
| Structural verification | Review checklist |
| Detailed verification | Review checklist |
| Regulator | Runner policy after review feedback |
| Proof-effort summary | Durable progress/report artifact |

## Prompt Inventory

Upstream prompt links:

- Literature survey:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/literature_survey.md
- Decomposition:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/decomposition-prover/decomposition.md
- Single prover:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/decomposition-prover/single_prover.md
- Structural verification:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/decomposition-prover/proof_verify_structural.md
- Detailed verification:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/decomposition-prover/proof_verify_detailed.md
- Regulator:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/decomposition-prover/regulator.md
- Verdict:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/decomposition-prover/verdict_proof.md
- Proof effort summary:
  https://raw.githubusercontent.com/proofQED/QED/main/prompts/proof_effort_summary.md

## Useful Patterns

### Literature Survey

QED starts by classifying the problem as Easy, Medium, or Hard. Easy problems
can be solved directly. Medium/Hard problems trigger an aggressive literature
survey. The survey prompt asks for directly applicable theorems, related
papers, useful lemmas/inequalities, counterexamples, pitfalls, and a
self-verification pass for citations.

Autoprover use: enrich the Explore prompt when a problem likely needs external
mathematical background.

### Decomposition

QED's decomposer asks for a structured proof plan whose intermediate steps are
rigorous quantitative mathematical statements. It explicitly rejects vague
descriptions. It marks key steps, lists source nodes, records dependencies, and
self-critiques plausibility, contradictions, and difficulty.

Autoprover use: when Explore produces issues, issue bodies should be precise
enough to be attempted. When Attempt uses a plan, each proposed subclaim should
be a real mathematical statement, not only a strategy label.

### Single Prover

QED's prover focuses effort on the hard key steps, forbids changing the
problem, requires exact use of the decomposition's step IDs, and asks for
explicit citations when external mathematical results are used.

Autoprover use: strengthen Attempt prompt variants for hard problems. The
runner may ask the oracle to identify and expand the hardest step instead of
only producing a polished final proof.

### Structural Verification

QED separates cheap/fatal structural review from expensive local correctness
checking. Structural checks include problem-statement integrity, completeness,
genuine proof work, citation verification, and decomposition-plan adherence.

Autoprover use: the Review prompt should check problem integrity first. A PR
that proves a modified problem should request changes without spending effort
on detailed line-by-line proof checking.

### Detailed Verification

QED's detailed verifier checks each proof step, dependencies, key steps,
coverage, boundary cases, notation consistency, transition validity, and
computational checks where feasible.

Autoprover use: detailed verification is part of the Review prompt or a future
review mode. It should not become a separate durable workflow object unless we
need separate reviewer identities or staged cost controls.

### Regulator

QED's regulator decides whether a failure is execution error, plan defect, or
whole-strategy failure. It chooses among revise-proof, revise-plan, and rewrite.

Autoprover use: this is runner policy after a PR receives request-changes. In
Cosheaf terms, the result may be branch repair, a new issue, a closed PR with
obstruction, or a new exploration issue.

### Proof Effort Summary

QED summarizes final proof status, attempt-by-attempt history, approaches
tried, key insights, and resource usage.

Autoprover use: this maps to a durable Cosheaf page or issue comment after a
long run. The summary should be reviewable and searchable.

## What Not To Copy

- Do not require every task to run through the full QED stage sequence.
- Do not make decomposition YAML a durable state model.
- Do not create an autoprover-owned attempt tree separate from Cosheaf.
- Do not use QED's regulator as a hidden workflow authority. Runner decisions
  should leave Cosheaf artifacts.

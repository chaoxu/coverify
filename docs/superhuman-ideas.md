# External Research Ideas

Notes on ideas surfaced in google-deepmind/superhuman (AlphaGeometry, IMO-Bench,
Aletheia) that are not addressed by mainstream AI4Math work and may be worth
folding into a future workflow.

This document is design input only. It must not override
[`prover-design.md`](prover-design.md). The project is currently a generic
Cosheaf tool-harness design, not a proof-specific verifier/explorer system.

## Grader as a first-class, measurable object

IMO-GradingBench (arXiv:2511.01846) benchmarks the *grader*, not the prover:
1000 human-graded solutions on a 0–7 scale plus a 4-class label
(Correct/Almost/Partial/Incorrect), evaluated by MAE and class accuracy. Their
autograder conditions a model on problem + reference solution + grading
guidelines and reaches Pearson 0.93–0.96 vs experts.

Compatible design note: if we later build a review workflow, reviewer or oracle
calibration should be measurable. Reference solutions, grading guidelines, and
calibration results should be Cosheaf artifacts, not private harness state.

## Dual-axis grading: correctness × significance

Aletheia ("Towards Autonomous Mathematics Research", Feng et al., 2026) grades
results on two axes: autonomy (Level H–A) and significance (Level 0–4, routine
exercise → breakthrough). Most accuracy numbers collapse the two and reward
trivially-true restatements.

Compatible design note: if the harness records grades, keep significance
separate from correctness. Use Cosheaf labels such as `sig:*` and `grade:*`
before inventing a local scoring table.

## Decoupled natural-language verification with external grounding

Aletheia runs Generator → Verifier → Reviser as separate steps, and the
Verifier uses Google Search / web browsing to ground claimed lemmas and
citations against real literature. This is distinct from chain-of-thought
self-critique (no separation) and from Lean (no natural-language reasoning).

Compatible design note: retrieval should be a context-packing concern. A
backend should receive cited pages, related issues, PR history, review
comments, and any curated corpus excerpts as an explicit context pack.

## Explicit, rewarded abstention

On FirstProof's 10 open problems, Aletheia returned "No solution found" on 4
rather than fabricating. DeepMind treats this as a primary design goal:
"reliability as the primary bottleneck to scaling up AI assistance."

Compatible design note: if a review workflow cannot decide, it should record
that as a Cosheaf review/comment/label such as `needs-human` or `abstain`, not
as hidden local state.

## Specification-gaming on ambiguous statements

Aletheia's authors flag that when problem wording is loose, the model
reinterprets the question in the easiest-to-answer direction. Rarely named
explicitly in proving papers.

Compatible design note: context packs should preserve the original issue or
problem statement separately from any proposed restatement, so later review can
detect specification drift.

## Out of scope / well-covered elsewhere

DSL + symbolic engine coupling (AlphaGeometry), RL self-play on proofs, and
LLM-guided proof search are extensively covered in other work and are not
gaps specific to this repo.

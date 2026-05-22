# Ideas From DeepMind Superhuman Repo

Notes on ideas surfaced in google-deepmind/superhuman (AlphaGeometry, IMO-Bench,
Aletheia) that are not addressed by mainstream AI4Math work and may be worth
folding into autoprover.

## Grader as a first-class, measurable object

IMO-GradingBench (arXiv:2511.01846) benchmarks the *grader*, not the prover:
1000 human-graded solutions on a 0–7 scale plus a 4-class label
(Correct/Almost/Partial/Incorrect), evaluated by MAE and class accuracy. Their
autograder conditions a model on problem + reference solution + grading
guidelines and reaches Pearson 0.93–0.96 vs experts.

For autoprover: the verifier in the Cosheaf review loop is currently
unevaluated. Borrow the format — store reference solutions and grading
guidelines alongside problems, and treat verifier calibration as a measurable
quantity rather than an assumed property.

## Dual-axis grading: correctness × significance

Aletheia ("Towards Autonomous Mathematics Research", Feng et al., 2026) grades
results on two axes: autonomy (Level H–A) and significance (Level 0–4, routine
exercise → breakthrough). Most accuracy numbers collapse the two and reward
trivially-true restatements.

For autoprover: when trace schema is extended, log significance separately from
correctness so ranking/learning signals do not collapse them.

## Decoupled natural-language verification with external grounding

Aletheia runs Generator → Verifier → Reviser as separate steps, and the
Verifier uses Google Search / web browsing to ground claimed lemmas and
citations against real literature. This is distinct from chain-of-thought
self-critique (no separation) and from Lean (no natural-language reasoning).

For autoprover: the current verifier reads only the workspace. A retrieval
hook that lets the verifier look up cited lemmas — even just against Cosheaf
review history or a curated corpus — would match this pattern without
requiring a formal backend.

## Explicit, rewarded abstention

On FirstProof's 10 open problems, Aletheia returned "No solution found" on 4
rather than fabricating. DeepMind treats this as a primary design goal:
"reliability as the primary bottleneck to scaling up AI assistance."

For autoprover: the verifier should be able to emit an abstain decision
distinct from reject, and traces should record it so a future policy can learn
to prefer abstention over hallucinated proofs.

## Specification-gaming on ambiguous statements

Aletheia's authors flag that when problem wording is loose, the model
reinterprets the question in the easiest-to-answer direction. Rarely named
explicitly in proving papers.

For autoprover: worth a check in the explorer/verifier prompts — if the
problem is restated in the solution, the verifier should compare the restated
form to the original, not only check internal consistency of the proof.

## Out of scope / well-covered elsewhere

DSL + symbolic engine coupling (AlphaGeometry), RL self-play on proofs, and
LLM-guided proof search are extensively covered in other work and are not
gaps specific to this repo.

# Experiments

This document defines the first evaluation plan for Coverify. The question is
not just whether the system can emit a proof. The question is whether a
Cosheaf-backed runner produces more durable, reviewable mathematical progress
than a fixed proof pipeline, a one-shot oracle, or QED-style multi-agent
generation under the same budget.

## Doc Map

- [README](../README.md) is the repository entry point.
- [Project Summary](project-summary.md) gives the concise current design and
  decision list.
- [Coverify Design](design.md) defines the tool-harness contract.
- [Eval Problem Selection](eval-problem-selection.md) defines the candidate
  promotion rule and Coflat/Cosheaf task shape.
- [References](references.md) records the external systems
  that inspire the experiment design.

## Claim To Test

Coverify should be better at long-horizon mathematical work because every
important action leaves a Cosheaf artifact: issue, page, branch, PR, review,
comment, label, or merge.

The core hypotheses:

- A reviewed knowledge base reduces repeated failed attempts.
- PR review gates reduce false-positive proof acceptance.
- Context packs built from accepted artifacts outperform private run history.
- Agentic context preparation over allowed source bundles should outperform
  hard-coded gather/planning heuristics, while mechanical validation should
  keep paths, ranges, citations, and verifier gates trustworthy.
- A runner can improve over multiple bounded sessions because useful output is
  merged back into the workspace.
- External systems such as QED can be used as strategies without becoming the
  state model.

## Baselines

Use the same problem set, model budget, wall-clock budget, and reviewer policy
for all baselines.

1. **One-shot oracle**: one prompt string in, one answer string out, no durable
   intermediate artifacts.
2. **Codex-only operator**: Codex uses primitive Cosheaf tools without a
   separate oracle backend.
3. **Fixed multi-agent pipeline**: a QED-style prover/verifier/summarizer flow
   with fixed stages.
4. **QED as backend**: QED receives a clean context pack and returns output;
   Coverify writes useful output as a PR and sends it through the normal
   review gate.
5. **STAR-style stateful run**: the same Coverify tools, but with an explicit
   visible attempt state: prepared prompt, current plan, step reports, verifier
   objections, replans, failed-route notes, and final artifact.
6. **Natural-language blueprint run**: a Goedel-Architect-inspired spike where
   the attempt produces a visible lemma dependency graph with explicit
   hypotheses, allowed dependencies, per-lemma proof attempts, verifier
   objections, typed failure diagnoses, and final assembly.
7. **Coverify full loop**: Codex operator, context packs, optional oracle
   calls, PR review, repair, and merged knowledge.

QED should be treated as a strategy provider, not as a competitor that must be
kept outside the system. If QED produces a useful proof plan, obstruction, or
partial proof, the right Coverify behavior is to preserve and review it.

When an experiment exposes missing judgment, first try an agentic preparation
or oracle call that can inspect the allowed materials. Add deterministic
harness code only when the behavior is stable, replayable, and mechanical.

## Task Sets

Seed candidates live in `evals/problem-candidates.jsonl`. They are deliberately
not final benchmark items yet; first run one-shot and reviewed-repair probes to
measure whether they have the right difficulty profile.

Start with tasks where correctness can be judged without pretending to solve
unknown mathematics.

- **T0 smoke tasks**: small known theorems, counterexamples, and proof repairs.
  Purpose: exercise issue, branch, PR, review, merge, and context-pack paths.
- **T1 planted-error review tasks**: flawed proofs, incorrect examples, and
  misleading literature notes with known defects.
  Purpose: measure false approval and reviewer usefulness across all
  knowledge-changing PR types.
- **T2 known hard proofs**: olympiad, graduate, or paper-level statements with
  hidden reference solutions.
  Purpose: test proof construction and repair under realistic difficulty.
- **T3 research-style tasks with known resolution**: historically hard
  statements, equivalent reformulations, or extracted lemmas from papers.
  Purpose: test literature grounding, problem integrity, and long-horizon
  progress while still allowing post-hoc judging.
- **T4 genuinely open tasks**: only after T0-T3 are stable.
  Purpose: measure useful progress, not solved/unsolved status.
- **T5 bounded trials with local measures**: subproblems with a fixed checker
  or meaningful scalar score, such as improving a certified bound or shrinking
  an uncovered case set.
  Purpose: test AutoResearch-style keep/discard loops without adding a new
  Coverify mode or domain-specific Coverify code.
- **T6 STAR-style known-answer challenge set**: fixed competition-style or
  extracted proof tasks where a final answer or proof can be judged after the
  run.
  Purpose: test whether prepared prompts, visible state, verifier challenge,
  and meta-strategy guidance improve solved-rate or useful-failure rate under
  a fixed model and budget.
- **T7 blueprint-spike tasks**: proof tasks with reference solutions that can
  be decomposed into named lemmas.
  Purpose: test whether a structured natural-language lemma graph saves human
  review time and reduces target drift compared with one-shot proof prose.

## Metrics

Primary metrics:

- **Accepted progress per budget**: merged useful pages or closed issues per
  dollar and per hour.
- **Correctness gate quality**: false approval rate, false rejection rate, and
  reviewer requests that lead to successful repair.
- **Problem integrity**: rate at which attempts silently modify the original
  statement or assumptions.
- **Resumability**: improvement from run `n` to run `n+1` using only Cosheaf
  artifacts from prior runs.
- **Duplication avoidance**: repeated dead ends per task after an obstruction
  has been recorded.

Secondary metrics:

- Time to first useful PR.
- Number of review cycles before merge or abandonment.
- Context-pack size and citation coverage.
- Cost split between operator, oracle, and reviewer calls.
- Fraction of useful oracle or QED output that becomes reviewed knowledge.
- Ablation delta: how much each added harness element changes success, false
  positives, repeated-route rate, and useful-failure production compared with
  the simplest direct call under the same budget.
- Accepted-node precision: among blueprint nodes that the harness marks as
  accepted, how many survive human or stronger-review inspection.
- Human review compression: how much of the final artifact a human had to read
  closely before finding the first substantive issue.

Avoid using final-proof success as the only score. On hard mathematics, a
correct obstruction, sharpened lemma, or rejected false path is real progress.
For score-driven tasks, the score counts only when it is produced by a fixed
checker, verifier, computation, or review gate that the agent is not allowed to
change during the trial.

## Protocol

Each task starts as a Cosheaf issue with:

- original problem statement
- allowed background
- forbidden assumptions
- budget
- review rubric
- expected output contract: exploratory response or mathematical resolution
- for mathematical resolution, expected resolution artifact type from
  `src/coverify/math_contract.py`
- for bounded trials, any local checker, scalar score, keep/discard rule, and
  verifier-certified improvement criterion that the task actually has

For T5 tasks, the golden Cosheaf repo should own the needed guidance as
ordinary knowledge-base content: project orientation, issues or task pages,
checker instructions when a checker exists, accepted/rejected trial notes, and
project-specific checker code when the task eventually needs it. Coverify should
not grow a special Gilbert-Pollak command, AutoResearch command, or per-domain
loop.

For T7 blueprint spikes, do not pretend a natural-language verifier replaces
Lean. The artifact should make the proof reviewable by splitting it into named
nodes, but a node counts as accepted only after the chosen review gate approves
it. Unknown or disputed nodes should remain `gap`, `too_hard`, `needs_human`,
or `counterexample_suspected`, not silently become theorem-like facts.

Each run must leave at least one durable artifact:

- PR with proposed knowledge
- review with concrete request-changes
- issue comment explaining a dead end
- label such as `needs-human`
- decomposition into clearer subissues
- trial note with candidate, local measure or score when relevant,
  keep/discard/crash status, checker output, and smallest failing case or
  uncovered region when available

For fair comparison:

- Keep prover and reviewer contexts separated.
- Use the same original problem statement for all systems.
- Use blinded reviewers when possible.
- Route mathematical attempts and correctness decisions through oracle calls
  whenever possible; runner-only reasoning should be measured as a degraded
  fallback, not the intended system behavior.
- Keep adaptive context selection agentic. The harness may validate prepared
  paths, line ranges, citations, schemas, audit records, and verifier verdicts,
  but it should not accumulate planner code to guess what an agent can read.
- Store raw outputs only as audit/provenance evidence, not as support for
  mathematical claims.
- Require PR approval before counting a proof as accepted.
- Count request-changes as progress only when the feedback is specific enough
  to guide repair.

## First Experiments

Run the local smoke eval before using budgeted backends:

```bash
PYTHONPATH=src python3 -m coverify run-eval \
  --backend fixture \
  --cases evals/smoke.jsonl
```

1. **Primitive tool smoke**
   - Run 10 T0 tasks end to end.
   - Require branch, PR, review, merge, path readback, and Cosheaf search
     discoverability for the merged artifact with the expected status/trust
     metadata.
   - Goal: prove the harness is reliable before measuring intelligence.

2. **Reviewer calibration**
   - Submit planted flawed proofs, valid short proofs, incorrect example
     computations, valid examples, misleading literature notes, and accurate
     literature notes.
   - Compare reviewer identities and prompt templates.
   - Goal: choose a default reviewer policy before harder experiments.

3. **QED as backend**
   - Wrap QED behind the same stdin/stdout backend contract.
   - Feed it context packs for T1-T2 tasks.
   - Store each useful result as a PR.
   - Goal: test whether QED improves the Coverify loop as one strategy.
   - Initial adapter: `scripts/qed_backend.py` writes `problem.tex`, runs
     `QED_ROOT/run.sh problem.tex qed_output config.yaml`, and returns a
     compact digest of `proof.md`, `proof_effort_summary.md`, or failure
     analysis artifacts. Pass the adapter as an absolute path when using
     `--backend script`, because script backends run inside the audit artifact
     directory.

4. **State ablation**
   - Run matched tasks with and without prior Cosheaf knowledge included in
     context packs.
   - Goal: measure whether durable memory reduces repeated mistakes.

5. **Repair loop comparison**
   - Give each system the same rejected PR feedback.
   - Measure whether it can repair the proof without changing the problem.
   - Goal: test progress after reviewer intervention.

6. **STAR-style eval discipline**
   - Pick a small frozen set of known-answer math tasks before tuning prompts.
   - Run direct strong model, `prepare-llm` plus strong model, verifying
     backend, visible state trace, and visible state plus a Meta-Strategist
     prompt under the same budget.
   - For each task, keep the source bundle, prepared prompt, current plan,
     step reports, verifier objections, replans, code/checker artifacts when
     used, final answer, and judge/reviewer decision.
   - Score final correctness, verifier false positives, target drift,
     repeated failed routes, useful obstruction reports, and cost.
   - Goal: learn whether any STAR-inspired harness element helps Coverify
     before turning it into default workflow machinery.

7. **Natural-language blueprint spike**
   - Choose 5-10 proof tasks with hidden reference solutions and enough
     internal structure to decompose into lemmas.
   - Compare direct proof prose, proof-plan-then-proof, and blueprint graph
     outputs under the same budget.
   - Require each blueprint node to state hypotheses, allowed dependencies,
     proof attempt, status, verifier objections, and typed failure diagnosis.
   - Score accepted-node precision, target drift, repeated-route reduction,
     useful gap localization, final correctness, and human review compression.
   - Goal: learn whether a "natural-language Lean" artifact saves human time
     before adding any deterministic blueprint engine to Coverify.

## Experiment Artifacts

Use Cosheaf as the experiment ledger:

- One milestone per experiment.
- One issue per task.
- One branch per attempt.
- One PR per proposed durable update.
- One review per correctness decision.
- One reviewed or merged page per result, obstruction, or calibration lesson,
  with explicit trust wording. Reserve accepted mathematical pages for reviewed
  mathematical claims.

Local files may store temporary logs and backend outputs during a run. If a log
matters for later interpretation, link it from a Cosheaf comment or distill it
into a reviewed page.

## Minimum Before T2

Do not start hard comparisons until these exist:

- `coverify-context-builder` linked and passing completeness checks
- `coverify-proof-attempt` linked and passing completeness checks
- `coverify-proof-review` linked and passing completeness checks
- CLI support for PR review context, including PR files/diff plus accepted KB
  dependencies gathered by the runner
- reviewer calibration set
- QED/script backend wrapper
- smoke harness that verifies Cosheaf artifacts after each run
- report generator that reads Cosheaf state and computes the metrics above

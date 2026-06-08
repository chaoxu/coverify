# Eval Problem Selection

Coverify evals should become Coflat/Cosheaf tasks, not standalone prompts.
The prompt-only `run-eval` command is just the first hardness probe.

## Promotion Rule

Promote a candidate only when it passes all three checks:

- A one-shot backend attempt is incomplete, wrong, or fragile in a specific
  reviewable way.
- A reviewer can identify the gap without relying on private run history.
- A second attempt can plausibly repair the gap using issue comments, accepted
  pages, or PR review feedback.

If a problem is solved cleanly in one shot, keep it as smoke or calibration. If
the reviewer cannot give actionable feedback, reject it for now.

Eval design should test agentic preparation, not reward extra harness code.
When a candidate needs judgment about relevant context, let the preparer or
oracle inspect the allowed material and return a bounded artifact. The harness
should validate paths, ranges, citations, schemas, and verdicts mechanically.

For STAR-style harness comparisons, freeze the problem set before changing the
prompt or workflow. The point is to measure whether prepared prompts, visible
state, verifier challenge, or meta-strategy guidance improve outcomes under the
same budget; do not keep swapping tasks until a heavier workflow looks good.

## Coflat Shape

Each promoted eval should create:

- one issue with statement, allowed background, budget, and rubric
- one Coflat problem page with definitions and trusted context
- one hidden reference note used only by the judge/reviewer
- one branch and PR per attempt
- one review that approves, requests changes, or records a dead end

The score should count reviewed progress: solved proof, repaired proof,
correct rejection, useful obstruction, and avoidance of repeated failed routes.

A STAR-style candidate should also have a clear final judge: known numeric
answer, hidden reference proof, finite checker, or reviewer rubric. It should
be hard enough that a one-shot call is fragile, but not so open-ended that the
experiment can only measure vibes.

## QED Strategy Probe

QED can be used as a backend strategy before a candidate is promoted to a full
Cosheaf eval. The Coverify operator should still choose when to call QED,
prepare the problem/context as LaTeX, and interpret QED's output before writing
anything durable.

Do not add a deterministic planner just to prepare QED inputs unless the
preparation rule is stable and mechanical. Prefer an agentic preparation step
that reads the allowed problem material, then validate the generated files and
citations before invoking the backend.

Use `scripts/qed_backend.py` through `--backend script`, passing the adapter as
an absolute path because script backends run from their audit artifact
directory. A failed QED run is still useful if it leaves a proof-effort summary
or failure analysis that can be reviewed and converted into a Coflat
obstruction note.

## Current Candidate Pool

The compact candidate list lives in `evals/problem-candidates.jsonl`. Start
with the `calibration-medium` cases to validate the harness, then try
`hard-candidate` cases for the one-shot versus reviewed-repair split.

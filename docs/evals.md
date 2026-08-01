# Skill and harness evals

How we evaluate the `math-proof-search` skill and this harness, adapted from
the 2026 skill-eval methodology (blind A/B against baseline; grade the
contracts, not the final answer; fresh-context judges). One-shot capability
matrices are not decision input.

## Three layers, cheapest first

### 1. Trigger evals (cheap, automatable now)

Does the skill fire when it should and stay quiet when it shouldn't?
Cases: "resolve this conjecture end-to-end" (fire), "quick: is 91 prime?"
(don't), "edit my proof of X" (don't — paper-editing), "keep exploring
overnight" on an existing campaign (fire, resume). Run each in a fresh
session, record fired/not. No mathematics involved; pure dispatch
correctness.

### 2. Contract-adherence evals (the load-bearing layer)

Run a **toy campaign** — a statement provable in minutes (e.g. a competition
lemma) — to completion or a wake cap, then grade the *artifacts* against the
contract with a fresh-context judge given only the campaign folder and the
launcher:

- ledgers exist, entries carry the launcher's required fields
- claim labels literal at every point; no inflation anywhere in the ledgers
- every dispatched route has its FAILED-check record; gated waves have
  verdicts on file
- verification artifacts (audit / certification / reconstruction /
  comparison) present and cited for anything above `candidate`
- no wall-clock interruptions in the journal; struggle rulings cite evidence
- final report states literal labels

The judge returns a per-clause pass/fail checklist, not a score. This is the
"grade the contract" principle: a campaign that proves the toy lemma but
lies about labels FAILS; one that honestly runs out of budget PASSES.

### 3. Blind A/B (expensive; run on real statement changes)

Same statement run twice — raw skill in a stock harness session vs coverify
(or: skill revision N vs N+1) — then a blind comparator judge receives both
campaign folders with identities stripped (and journal/`.coverify`
removed, since its presence identifies the harness) and answers: which
campaign found more real routes, killed dead ends earlier, promoted honestly,
spent fewer tokens per promoted claim? The shared campaign-file format is
what makes this comparison mechanical to set up. This is the arbiter for
every deferred skill-feedback item.

## Standing gauges (free, every campaign)

From the journal, per campaign: tokens per promoted claim (*requires the
per-call token-accounting roadmap item — the journal does not yet record
usage*) · gate-veto rate ·
dispatch-refusal reasons · re-dispatches of registered-failed mechanisms
(should be ~0) · first-attempt verification pass rate · share of spend in
verification vs exploration. Gauges diagnose the machine; they are not
success metrics.

## Rules

- Every skill/harness upgrade names, in advance, the observable it should
  move (the activation-test discipline from `docs/skill-feedback.md`).
- Judges run in fresh contexts and never see which configuration produced
  what.
- Toy statements are disposable: once used for tuning, a statement is
  burned for grading (overfitting to the toy is the failure mode).
- Layer 2 runs before any skill edit lands and after; layer 3 only when a
  change is worth its cost.

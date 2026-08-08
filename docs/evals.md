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

From the journal, per campaign: tokens per promoted claim (*measurable for
API-shaped providers and for claude-cli/codex-cli, which parse usage from
their JSON output; only chatgpt-cli and env-overridden CLI templates without
JSON output report none and are gaps in the gauge*) · gate-veto rate ·
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

## Token-controlled A/B (the arbiter, Chao's metric 2026-08-08)

The goal is controlled token usage: obtain the result using as few tokens
as possible. So the raw-skill comparison is budget-matched, not time- or
wake-matched, and the primary metric is verified-true output per token.

Protocol:

1. **Same frozen statement**, byte-identical, in two arms: (a) coverify
   campaign; (b) a plain Codex session running the canonical
   `math-proof-search` skill from `~/kb`, no harness.
2. **One shared budget B** of billable tokens: fresh input + output +
   reasoning, summed over every model call the arm makes. Cache reads are
   metered separately and reported, not charged (they are the mechanism,
   not the spend). Coverify's meter is the journal's per-call usage
   records; the raw arm's is codex's JSONL turn usage.
3. **Stop each arm at B.** Coverify: watch the journal cumulative and
   pause. Raw: end the session when its rollout usage crosses B.
4. **Grade blind, outside the budget.** Every claim either arm labels
   proved/promoted is run through a fresh verification cadence by a grader
   who has not seen either transcript. Score: verified-true claims on the
   statement's dependency path (+), claims that fail verification (−,
   reported loudly — shipping a false theorem is worse than shipping
   nothing), unresolved (0).
5. **Report per arm**: budget consumed, cache reads, verified/failed/
   unverified claim counts, and tokens per verified claim. Resolution of
   the statement inside B trumps everything.

The verification-cadence spend of the coverify arm counts INSIDE its
budget (the discipline's cost is real and must be paid on the meter); the
grader's post-hoc verification of the raw arm counts outside (it is the
judge, not the method).

## Measured baselines (retrospective, 2026-08-08 — no new tokens spent)

Raw-launcher corpus (`~/playground/research/explore/`, 12 campaigns,
Jul 25–Aug 2, plain Codex sessions, usage from codex rollout JSONL;
billable = input − cached + output): **~3.29B billable tokens, 291 PROVED
entries, 4–5/12 problems resolved** → ~11.3M billable per self-labeled
PROVED entry; resolved-easy campaigns 1.6M–39M each; hard-unresolved ones
119M–2.3B each. Known ledger defects: one explicit retraction
(bounded-hedge-cut, loop-counting), one audit-forced correction
(ttp2-hardness), one whole-campaign novelty misclassification (67M billable
on re-derived prior art). No systematic re-verification of the 291 entries
exists, so the per-verified-TRUE-claim cost is higher by an unknown factor.

Coverify arm (lin-3-cut campaign 3, full accounting): 30.7M billable /
0 promotions before the candidate-scope discipline; **33.6M / 4 promotions
(≈8.4M per verified theorem) after**, verification ≈35% of spend.
Campaign 2 partial accounting: ≈1.2M per (lemma-scale) promotion,
undercounted.

External prompt-family system (Danus directed-cut-union, design.md):
618M input / 74 facts, 85% off the answer's dependency path → ≈56M per
on-path fact, no resolution.

2026-06 proof-evals matrix (jupiter /srv/proof-evals, 10 problems, 3h,
one-shot): ChatGPT Pro 6/10, direct Codex 5/10, coverify-1.0+Codex 5/10 —
the old wrapper added nothing; and self-attested artifact scores (9/10)
collapsed to 2–6/10 under verified grading.

Reading: token cost per claimed result is at PARITY between coverify and
the raw skill (8.4M vs ~11.3M) — the cadence's ~35% share is offset by
gate-killed retreads — while coverify's claims carry enforced (not
instructed) blindness and hash binding. Problem difficulty, not harness
choice, dominates total cost (raw corpus spans three orders of magnitude
per campaign). The single biggest measured economy lever is candidate
scope discipline, worth 30M+ tokens on one campaign — a skill lesson, not
a harness feature.

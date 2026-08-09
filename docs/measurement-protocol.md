# Measurement Protocol

How to measure a campaign's cost so the number means something. Written after
the 2026-08-09 three-system study (raw skill / Danus / coverify), which got
several things wrong before it got them right. Each rule below exists because
that study tripped over it.

The governing goal is in `AGENTS.md`: verified output per token. This file is
about the denominator — how to compute it without fooling yourself. The
arbiter protocol itself stays in `design.md` ("Token-controlled A/B").

## 1. Fix the units before summing anything

Three separate conventions collided in one study:

- **Is `cached` inside `input`, or beside it?** Codex rollouts nest them:
  `input_tokens` **includes** `cached_input_tokens` (verified over 50,152
  records — zero have cached > input, and `total = input + output` in every
  case). Coverify is worse than either convention: **it uses both at once.**
  The pi lane subtracts cached out (`input: max(0, input_tokens − cached −
  cacheWrite)`), so coordinator/reasoner/technician records are disjoint; the
  `codex-cli` lane (gate-critic, certifier, reconstructor, comparator) copies
  `input_tokens` through unmodified, so those records are nested. Treating the
  whole journal as disjoint overstated fresh input by **30%** (253.0M → 177.5M).

  The diagnostic that catches this in seconds: count records where
  `cacheRead > input`. It is impossible under the nested convention and common
  under the disjoint one. Measured: 0 of 925 codex-cli records, versus 45/53
  coordinator, 596/657 reasoner, 193/193 auditor. **Check per role, never per
  system.**
- **Is `reasoning` inside `output`?** Yes. The field is
  `reasoning_output_tokens` (`src/backends.ts`), and measured
  `reasoning ÷ output` lands in 0.45–0.92 across every role and every system,
  never above 1. `design.md`'s billable formula `input + output + reasoning`
  therefore double-counts. Visible output is `output − reasoning`.
- **Are there umbrella records?** Coverify's `completion id=vNNN` entries
  restate the sum of their four verification stages. Counting both inflated the
  total by 80.4M tokens (27%). Before aggregating any event log, check whether
  any record is a roll-up of others — compare one parent against its children
  by hand.

## 2. Cumulative records need reset detection

Coordinator usage is cumulative per session, not per call. A resident session
that rebuilds starts a new cumulative series. Sum the **peak of each monotonic
run**, treating a decrease as an epoch boundary. Taking the last record loses
every prior epoch; summing all records multiplies them.

Verify the choice: cross-check with an independent estimator (below).

## 3. Cross-checks must be independent of the DATA, not just of each other

The study computed every total three ways — final cumulative per session, sum
of per-turn deltas, reset-aware sum of monotonic-run peaks — and got agreement
to 0.05%. **All three were wrong by 27×**, because all three read the same
duplicated records. Agreement between estimators that share an input is not
evidence; it only tests your arithmetic.

A real cross-check comes from a **different source**: the durable session
transcripts against the journal, one provider's accounting against another's,
a count of API calls against a count of log records. When coverify's coordinator
figures were checked that way (journal peaks vs `.coverify/sessions/` trees)
they agreed to 0.2% on presented, output and reasoning — and disagreed 41% on
fresh input, which located a real defect. That is what a cross-check is for.

Reproducing a previously recorded figure is only reassuring if it was computed
from different data. The raw corpus's 3,323.9M "confirmed" `design.md`'s prior
"~3.29B" — and both were the same mistake, made twice.

## 3b. One session can own many log files, and they replay each other

The single largest error in the study, and it took three attempts to
characterize — the first two diagnoses were both wrong, which is itself the
lesson.

What is actually true of the codex rollout corpus:

- **Counters are not inherited.** Every file's cumulative starts near zero
  (~25k, the system prompt) whether it is a root or a subagent. The first
  hypothesis — that subagent forks continue a parent's counter — is false.
- **But 64 session ids own 635 of the 1,708 files**, up to 109 files for a
  single id. Files sharing an id replay a common prefix: one probed file
  emitted 5,476 `token_count` events all stamped at the same instant, then a
  handful of genuinely new turns.
- **Replay rewrites timestamps**, so de-duplicating events by
  `(timestamp, payload)` finds 0% overlap and silently does nothing. Content-
  keyed de-duplication is required.

Three defensible methods on the same corpus give **150,503M / 15,779M /
5,560M** presented input — a 27× spread. That corpus's true consumption is not
recoverable from its logs, and the honest outcome is to **exclude the arm**
rather than pick the flattering estimate.

Before trusting any session-log corpus:

1. Count distinct `session_meta.id`, not files. If files-per-id > 1 anywhere,
   stop and characterize the relationship before summing.
2. Check whether a file's first cumulative starts near zero (independent) or
   high (inherited).
3. Check whether many events share one timestamp — the signature of replay.
4. Reconcile per-session deltas against that session's own final cumulative.

Danus passed all four (411 files, 411 distinct ids, no replay), which is why
its estimators agreeing *was* meaningful. The raw corpus failed all four, and
its agreeing estimators meant nothing.

## 4. Price before concluding

**Tokens are not a currency.** On the GPT-5.6 Sol rate card, output bills at
**6× input and 60× cached input**; cached input is exactly 1/10 of input. A
conclusion drawn on raw token counts can invert once priced:

| reasoning share | raw skill | danus | coverify |
|---|---|---|---|
| of all tokens | 0.17% | 0.26% | 1.3% |
| of billed tokens | 7.8% | 4.0% | 8.3% |
| of credits | 7.6% | 8.3% | 21.8% |

Billed-token accounting made coverify and the raw skill look equivalent (8.3%
vs 7.8%); priced, the gap is 2.9×. Report both meters when they disagree, and
name which one corresponds to the resource that actually binds.

Corollary: "how much did it use" has no single answer. The raw corpus exceeded
coverify by **78× in tokens, 11× in billed tokens, 30× in credits**.

### Credits are a unit of account, not a bill

Codex credits are a **purchasable overage currency**: included plan usage is
drawn down first, and the credit balance decrements only after that is
exhausted. On a Pro plan with headroom, a campaign that "costs 84,853 credits"
consumes **zero credits**. Never write that a run spent credits, or that
credits were the resource that ran out.

What the rate card is legitimately good for is a **provider-blessed,
token-type-weighted scalar** — far better than raw tokens, which would weight a
cached input token the same as an output token and be wrong by 60×. Convert to
USD for portability, since that is the unit every provider denominates in
(Sol: $5.00/M input ÷ 125 credits/M = **$0.04/credit**):

| | credits | notional API cost |
|---|---|---|
| raw skill | 2,564,468 | ~$102,600 |
| coverify | 84,853 | ~$3,400 |
| Danus | 14,456 | ~$580 |

Label it "notional API cost" every time. It is what reproducing the workload on
an API key would cost, not what anyone paid.

### Rate-limit pressure is a third meter, and credits do not measure it

Dollar prices are not proportional to limit consumption, and the weighting
OpenAI applies to its 5-hour and weekly windows is not published. If the
question is "why did this run die", credits cannot answer it — that needs
window occupancy and throttle events, recorded directly. The Danus quota
trajectory (55% → 100% in 3h52m) came from `rate_limits.primary.used_percent`
in the rollouts, which is the right instrument; use it.

## 5. Never call cached tokens free

They are discounted, not free, and the discount is 90% against a volume that is
often 10–100× larger. Cache reads were 72% of the raw corpus's notional cost
and 50% of Danus's. Any claim that a redundancy is "nearly free" must be stated
in a unit that weights token types, not in billable tokens.

Two things about caching that the study got wrong and that must not be repeated:

- **Whether cached tokens count toward plan rate limits is an inference, not a
  documented fact.** It follows from the rate card's structure and third-party
  descriptions, but no verbatim OpenAI statement was found, and the help-center
  rate-card page refuses automated fetch. Mark it as an inference wherever it
  is load-bearing.
- **Cache WRITES are measured on some lanes and not others — check per lane.**
  An earlier version of this file claimed the harness records `cacheWrite: 0`
  *everywhere*. That is false, and the error is instructive: `cacheWrite > 0`
  on 204/204 `claude-cli` audit records (median 35–57k) and on every
  `claude-cli`-routed reasoner call. It is zero only on the codex/Sol lanes,
  where it is a genuine upstream defect (`cache_write_input_tokens` is 0 in
  99/99 rollout events, not merely in coverify's parse; codex #32479, pi #6469).

  So the quantity is **unmeasured on one lane and in hand on another** — and
  the lane that has it supplies the bound. Measured write/read ratio on the
  audit lane is 0.25–2.5 depending on campaign; use it to bracket the codex
  lanes rather than treating writes as unbounded.

  Pricing note: the 1.25× cache-write rate is an **API-lane** rule. The Codex
  credit card publishes only input / cached input / output, so on the
  subscription lane there may be no write charge at all (primary card returns
  403 to automated fetch — verify in a browser before relying on it).

## 6. Watch for collinearity before inferring a mechanism

The study tried to derive empirically whether quota counts cached tokens, by
regressing quota points against token deltas. It failed, and the failure is
instructive: cached stayed 91–98% of presented across every window, so cached
and presented were collinear and both hypotheses fit. Compounding it, the quota
window is 7-day rolling, so points expire as well as accrue and interval deltas
do not measure accrual.

When a ratio barely varies in the observed data, it cannot be identified from
that data. Go to the documented source instead of fitting noise, and say which
you did.

## 7. Cost-side metrics are non-diagnostic of research output

The strongest transferable result of the study, and it constrains every other
finding in it. Danus placed first or second on cache hit rate, cost per claim,
and total spend — and last on the only thing that matters, resolving nothing.

So: none of the numbers in a cost study say whether spending less improves or
degrades mathematical output. Compaction discards live reasoning; a fresh
reasoner lacking prior failed attempts may re-derive, repeat mistakes, or
produce locally-valid claims that don't compose. Coverify's 76 promotions
against 1 resolution is exactly the signature that pattern would produce, and
it is testable and untested.

State this boundary explicitly rather than let efficiency findings read as
quality findings. In particular, **do not call any lever "dominant"** unless
levers were actually varied against each other — this study varied none, and
its only outcome measure (resolution rate) leans against the lever it was
tempted to crown.

Where an outcome signal is cheap to instrument, instrument it. The only direct
measure of work relevance anywhere in the study was Danus's "85% off the
dependency path", it exists for exactly one of the three systems, and it is the
only variable that plausibly explains a zero. Porting it to the other two would
yield more decision-relevant information than further token accounting.

## 8. Never report cost per claim across systems

Stronger than "be careful": the metric is refuted in-sample. Danus is the
cheapest system in the study at **195 credits per claim** — 5.7× better than
coverify — and it resolved **nothing**, with 85% of its facts off the answer's
dependency path. A metric that ranks a null result first is not repaired by a
caveat.

The defect is structural, not just unit mismatch. Coverify's denominator counts
only what survived verification while its numerator pays for that verification;
the raw skill's denominator is unfiltered. The ratio mixes a cost difference
with a definitional one and cannot separate them.

Report instead:

- **cost per campaign** — raw ~214k credits, coverify ~12.1k, Danus 14.5k.
- **cost per resolved problem** — raw ~570–641k, coverify ~85k, Danus undefined.
- **resolution rate, always beside it** — raw 4–5/12 (33–42%), coverify 1/7
  (14%). These two point in opposite directions and both must be shown.

All of it rests on an unestablished assumption: that the problem sets are of
comparable difficulty. **Whether the raw skill's 12 problems and coverify's 7
overlap is the single highest-value missing datum in the study.** If they
differ in difficulty, no per-problem figure is interpretable.

To make a per-claim comparison legitimate, sample the raw corpus's 291
self-attested claims, run them through the same four-stage cadence, and report
the survival rate with an interval. Until that experiment exists, no
cross-system per-claim number should be published.

## 9. Attribute sessions before trusting a corpus

Codex rollouts are attributed by the `cwd` of their first `turn_context`. That
is a weak key: sessions may change directory, a campaign's sessions may run
from a parent directory, and unrelated work in the same tree is
indistinguishable. State the filter used, report how many sessions it matched,
and sanity-check the match against an independently known figure before
building on it.

## 10. Record measurement gaps as gaps

A missing field and a measured zero are different records — coverify already
enforces this (`design.md`'s Observability section), and the study needed it:
the `claude-cli` auditor lane reports neither input nor reasoning across all
193 of its calls, making coverify's fresh-input and reasoning figures **floors,
not values**. The same principle condemns the `cacheWrite: 0` above.

**A mixed-provider workload cannot be priced in one provider's currency.** The
auditor runs Claude Opus on an Anthropic subscription; pricing its 4.7M output
tokens at Sol's 750 credits/M booked ~3,940 credits where Opus 5's $25/MTok
gives $117.50 — a ~20% overstatement, ~0.8% of the total. Numerically small,
categorically wrong: that lane draws on a *different* rate limit, and folding
it into one Codex total implies the two pools substitute for each other. They
do not. Convert each lane at its own provider's card, report USD, and always
show the per-provider split beside the total.

## 11. State the design ceiling

The 2026-08-09 study had: three architectures, three observations, every
covariate perfectly confounded with architecture (harness era, prompt
authorship, campaign count and duration, problem identity, possibly reasoning
effort), one truncated run, and unverified problem-set overlap. Zero residual
degrees of freedom.

That dataset can support **descriptive statements about where credits go inside
each system**. It cannot support any comparative causal claim between systems,
and no amount of careful wording changes that — only a matched-problem-set
experiment does. Write the ceiling down next to the findings, because a reader
three months later will not reconstruct it.

Design the next one to beat this ceiling: same frozen statements in both arms,
same model and effort settings, problem sets fixed and disclosed, and one
variable moved at a time.

## What this study did support, after correction

Three reviewers ran against the first draft. Two of its headline claims did not
survive, and the corrections are the most useful part of the record.

Three reviewers ran against the first draft; independent re-verification then
corrected one of the reviewers too. Of the study's three arms, **two survive
and one does not.**

**Coverify — trustworthy.** Per-lane convention applied, coordinator cumulative
peaks summed, umbrella records excluded, cross-checked against the durable
session trees (agreeing to 0.2% on presented, output and reasoning).

| | value |
|---|---|
| calls | 1,947 |
| presented | 1,884.7M = 1,702.9M cached + 181.9M fresh (90.4% hit) |
| output | 45.17M, of which 25.42M reasoning |
| credits | **77,900** (~$3,120 notional) |
| composition | cached 27.3% · fresh 29.2% · reasoning 24.5% · visible 19.0% |
| by role | reasoner 49.4% · coordinator 34.3% · auditor 5.3% · gate-critic 4.4% · reconstructor 3.9% |
| verification cadence | 8,265 credits = **10.6%** of spend |
| per verified promotion | 1,025 credits |

**Danus — trustworthy.** 411 files, 411 distinct session ids, no replay,
three estimators agreeing to 0.2%. 14,456 credits (~$580); cached 50.3%,
fresh 31.5%, reasoning 8.3%.

**Raw skill — WITHDRAWN.** Its accounting is not recoverable from its logs
(rule 3b): three defensible methods span 27×. Every cross-system claim that
used it is withdrawn, including "30× more expensive" and "8× cheaper per
claim". `design.md`'s recorded baseline ("~3.29B billable, ~11.3M per PROVED
entry") rests on the same corpus and the same naive method, and should be
marked unreliable until the corpus is re-derived.

**What died in re-verification, beyond the raw arm:**

- *"The reconstructor is a quarter of billed input, the biggest
  harness-controlled stream."* Artifact of the lane-convention bug. Its fresh
  input is 5.4M, not 64.4M; it is **3.9% of credits**. Do not build a
  payload-trimming program on it.
- *"Verification is 25.8% of spend."* It is **10.6%**.
- *"Cache hit 86.6%."* It is **90.4%**.

**What survived every round:**

- **Re-presentation dominates cost**: 50.3% of Danus's credits, 27.3% of
  coverify's, and cached+fresh input is 56.5% of coverify's total.
- **Reasoning share separates the two surviving arms**: 24.5% vs 8.3%.
- **Verification is cheap** — 10.6% of coverify's own spend, ~$330 notional
  across 7 campaigns for 76 verified promotions.
- **Cost-side metrics are non-diagnostic of output** (rule 7), strengthened by
  every correction.
- **The two-lane convention bug is a live harness defect**, not just a
  measurement artifact: `spend.ts` and any consumer of raw journal `input`
  fields will misreport until the codex-cli lane subtracts `cacheRead`.

## 12. Concurrency is set by the rate limit, and that is all

The plan allowance is a rolling-window **rate**, not a stock — unspent
allowance expires. So concurrency has a simple rule: **if you are not
saturating the window, add agents; if you are hitting it, use fewer.** There is
no optimization problem here.

Measured 2026-08-09: coverify at `--agent-limit 6` runs 12.7–20.1M presented
tokens/hour, needing 67–100 hours of continuous operation to consume a 168-hour
weekly allowance. It is under the limit, so more agents are free. Danus ran 7
always-on workers, burned a weekly allowance in 3h52m, and died at the wall
mid-consolidation. Over the limit, so fewer.

`--agent-limit` is therefore a rate control, and its value follows from the
window rather than from taste. Record `used_percent` (#35) and the setting
follows from measurement instead of guesswork.

**Do not over-read the multi-agent literature.** The "swarm tax" results
(single-agent matching multi-agent at equal thinking-token budget; 4–220x
reported overheads) compare *redundant decomposition* — N agents splitting one
task. Coverify fans out across *distinct mechanisms* and already forbids the
redundant case: the idea-gate requires `IDEA PASS` on file before a second
concurrent worker on the same mechanism. That literature condemns something
this harness already prevents. Whether **diverse** fan-out beats serial
exploration of the same routes at equal budget is untested and is not what
those papers measured.

## 13. What must be recorded

Derived by working backwards from the questions the 2026-08-09 study could not
answer. Each row is a question, the field that answers it, and whether the
journal answers it today.

| question | needs | today |
|---|---|---|
| is this record's `input` disjoint from `cacheRead`? | `meter` on every usage | **no** — inferred from lane + commit date |
| which run does this cumulative series belong to? | `runId` on `runStart` + every usage | **no** — inferred from a decreasing counter |
| which wake ordered this spend? | `wake` on usage *and dispatch* | coordinator only |
| is this usage a roll-up of other records? | `rollup: true` | **no** — cost 80.4M in double-counting |
| what model, at what effort? | run-config `roleSpecs` | **yes**, except where a lane varies within a run (reasoner consults) |
| what model actually served it? | `servedModel` per call | verification stages only; gate lane discards it |
| how many provider requests did this record span? | `requests` / `attempts` | **no** — one record spans a whole tool loop |
| when did the call start? | `durationMs` on every completion | verdict roles and coordinator only |
| did this run hit the rate limit? | `providerSessionId` + `backendCwd` | **no** — the rollouts hold it, unjoined |
| why did the run stop? | terminating-condition enum | **no** |
| what did a compaction cost? | compaction event with usage | **no** — folded into the cumulative |
| was this work on the answer's path? | premise-closure query | **derivable**, never computed |

The generalisable lesson is not the list. It is that **every field above was
write-only for the project's whole history**, because there was no reader
(`providers.ts:346`: "nothing reads this except the journal"). Write-only
fields are untested fields, and the first real read found defects in most of
them at once.

So: **ship the reader with the fields.** A recorder with no consumer is a
speculative field; a recorder with a consumer is an instrument. And where a
rule can be enforced at the type level rather than documented — mixing meters
should be a compile error, not a paragraph in this file — enforce it, in
keeping with this repo's preference for gates over prose.

## Standing gauges

Cheap to compute from records already kept, worth reporting every campaign:

- **reasoning share of credits** — a *cost diagnostic*, not an efficiency or
  quality metric, and no target value should be set for it. A very low value
  reliably signals that spend is going to re-presentation rather than
  generation. But it has no outcome term; it is maximized by reasoning hard on
  thin context (the natural failure mode of fresh-role architectures); and it
  is not price-invariant — a vendor reprice moves it with no behavioral change.
  Measured 21.8% coverify, 8.3% Danus, 7.6% raw skill.
- **input tokens per reasoning token** — the price-invariant companion to the
  above. Prefer it for anything compared across time.
- **re-presentation volume** — input tokens re-presented per output token
  generated. This is the quantity that actually varies across architectures;
  cache hit rate and reasoning share are both views of it.
- **cache hit rate per role** — diagnostic only, and **not a defect**. Given a
  fixed re-presentation policy, cache hits are a 90% discount and should be
  maximized: coverify takes only 24.1% of its credits at the cached rate, so
  prefix-stable prompt construction is an unexploited pure-win cost cut. What
  deserves scrutiny is the re-presentation volume the caching is applied to,
  not the hit rate.
- **credits per resolved problem, reported beside resolution rate** — the only
  outcome-anchored cost figures available. Never report a per-*claim* cost
  across systems (rule 8).
- **fresh input by role** — locates the controllable spend. Three streams
  (reasoner, reconstructor, coordinator) were 86% of coverify's billed input.

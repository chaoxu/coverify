# Journal shape

What the journal must record so a cost number means something. These three
rules gate code in this repository -- `src/telemetry/spend.ts`,
`outcomes.ts`, `providers.ts` and `cadence.ts` all cite them by number, and
`scripts/conformance-check.ts` enforces the structural half.

They were extracted from a longer document written after a 2026-08-09
three-system measurement study. The rest of that study -- credit pricing,
collinearity, corpus attribution, the comparison-design habits -- constrains a
person writing a cost report rather than a line of this harness, and is kept
outside the repository. Rule numbers are unchanged from that document, so the
code comments citing them still resolve; the gaps in the numbering are the
rules that stayed behind.


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

## 13. Record leaves, and every edge of the tree

**One writer per billed call.** A payment is recorded once; every other record
that references it carries the join key alone and no tokens. Two writers for
one call is not a redundancy, it is a 2x error that no cross-check catches,
because both sides agree about the payment they are each counting. In this
harness the switch is `spendLeafed()`: with a telemetry sink installed the span
leaf is the writer, without one the referencing record is.
`tests/spend-invariant.test.ts` asserts the two configurations total
identically, which is the only form of this rule that survives a refactor.

**Known gap, stated rather than implied.** That equality holds for worker
dispatches and gate critics, which is what the invariant test drives. It does
NOT hold for the verification cadence: a stage record deliberately carries no
tokens (`cadence.ts`), so with no sink installed a cadence's four calls are
recorded as four provider calls that reported no usage. Sink-less runs
therefore lose verification spend, not merely its per-stage breakdown. Live
campaigns always install the sink (`cli.ts`), so this bites only a harness with
`src/telemetry/` removed. Extending the invariant test to a cadence is what
would turn this paragraph back into a passing assertion.

A campaign is a tree: **campaign → run → wake → dispatch → stage record →
provider request.** Spend happens at exactly one level — the provider request —
but every level above it has a natural reason to state a cost, because whoever
reads that record wants to know what it cost. That is how the same tokens end
up recorded three times.

The rule that follows: **record at the leaves, and record every parent edge.**
Given the edges, any aggregate is a `GROUP BY`; without them, a stored
aggregate is the only way to answer a question, and stored aggregates in an
append-only log double-count. This is not specific to tokens — a log cannot
tell a fact from a summary of facts, so the discipline has to come from the
shape of what you write.

Leaf-only is necessary but **not sufficient**: an aggregate is only derivable
if the edge it groups on is on file. Measured on a pre-2026-08-09 campaign,
`dispatch` records carried `id` and nothing else, so the majority of spend —
dispatched workers, the reasoner lane alone being ~49% — could not be
attributed to the wake that ordered it. Every edge below is now stamped:

| edge | carried by |
|---|---|
| campaign → run | `runId` on every record (GateStore) |
| run → wake | `wake` on the coordinator usage event |
| wake → dispatch | `wake` on every dispatch record |
| dispatch → stage | `dispatchId` on audit, bundle-cert, reconstruction, comparison, gate-verdict, role-call |
| dispatch → completion | the handle `id` (see the cancel caveat below) |
| stage → provider request | `attempts` + `requests` on whichever record carries the payment |
| unmeasurable spend | `role-call` with `unmetered: <lane>` — a record, not a silence |

**A cancelled dispatch is the one place `id` does not identify a single
record.** Cancelling does not stop the provider: the cancel path writes a
usage-bearing completion and drops the handle, and the work keeps running until
it settles and writes another. `declare_campaign_state` cancels every live
worker, so this is the ordinary pause, not an edge case. Both records carry the
same session's *cumulative* total, so summing them counts the worker twice.
The writer now records usage only while the handle is live, but every journal
written before that carries the duplicate — a reader must keep the LAST
usage-bearing completion per `id`, which is the complete total and of which the
earlier is a strict prefix. `src/telemetry/spend.ts` does, and says so in `excluded`.

**`attempts` is the one count that cannot be derived after the fact.** A retry
re-presents the whole context and is billed again while leaving no message
behind, so a transcript cannot tell a 500k-token turn from three 170k attempts.
`requests` is derived from the transcript where one exists, rather than stamped
twice — a stored duplicate of derivable state is a second source that can drift
from the first.

**Spend that cannot be measured is recorded as a gap, never omitted.** Omitting
it would read as "this cost nothing", so each such call appends a `role-call`
carrying `unmetered: <lane>`, and `coverify spend` reports those under their own
heading — separate from `excluded`, which is records a reader must SKIP rather
than spend nobody can count.

Before declaring a lane unmeasurable, check whether it is. The librarian was in
this list until 2026-08-10 on the strength of a comment; `agy --output-format
json` in fact returns a usage block, and a single librarian call turned out to
carry over 22,000 input tokens. It is now a measured lane. What remains
genuinely unmeasurable is `chatgpt-cli`, whose daemon emits nothing, and the
`agy` ORACLE lane, which still runs `--output-format text` and could be
converted the same way.

The tree is complete. Any aggregate — per campaign, run, wake, dispatch, stage,
lane, role or model — is a `GROUP BY` over leaves; no level stores a summary of
the level below it; and every path that spends tokens either records them or
records that it cannot.

## 13b. What must be recorded

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
| what did a compaction cost? | compaction event with usage | **yes** — `role-call` leaf, `compaction: true`, carrying the usage delta and contextTokensBefore/After |
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

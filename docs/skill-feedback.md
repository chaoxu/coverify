# Skill feedback ledger

Candidate improvements to the canonical `math-proof-search` skill
(`~/kb/notes/agents/skills/math-proof-search/` + the launcher contract).
**Policy: correctness fixes land immediately (four rounds already have:
2026-07-31 — PROCESS_LESSONS rename; adapter/launcher consolidation; stage-2
certification/comparison rewrite; anti-verdict-shopping; 2026-08-01 —
theorem-class/check-class verification split, below). Performance-shaped
changes wait here for live campaign evidence.**

## Landed 2026-08-01: theorem-class vs check-class content (launcher + charges)

Evidence: five same-day comparison FAILs split into substantive catches
(quantifier/hypothesis strength — all correct) and a bookkeeping class
(w020, r035: stage 2 penalized witness-specific finite facts that the
stage-1 auditor had already hand-verified and that a blind reconstructor
*structurally cannot* confirm, since it proves existential theorems via its
own witness). Comparators were inconsistent about it (obstructions.r2's
called a vertex count "an incidental witness parameter"; w020's failed on
exact values). Fix landed in the launcher's verification-cadence section
plus reasoner/auditor/comparator charges: candidate revisions contain only
promotable content (notes go in ordinary evidence artifacts); unboundedly
quantified claims must be stated as explicit theorems (prose-only assertion
is a stage-1 defect); reconstruction owes exactly theorem-class claims
(different witness = PASS for existentials); finite directly checkable
content is verified outright at stage 1 or by computation, never by
reconstruction. Neither class is exempt — the split assigns each claim to
the only channel able to verify it.

Rejected on the way (recorded so the reasoning survives): a
declared-conclusion-contract that *scopes* verification — under file-level
promotion it lets an author under-declare and ship unverified theorems
inside a promoted file; the completeness check needed to plug that hole
re-creates the whole-file obligation anyway (Chao's objection, 2026-08-01). Each deferred entry states
its activation test; the arbiter is the shared-format comparison — same
statement run under the raw skill in Codex and under coverify, campaign
folders read side by side.

## Evidence from campaign 1 (2026-07-31, linear-3-cut equivalence)

First live campaign (`~/research/linear-3-cut/campaigns/2026-07-31-equiv-3scc-linear-3-cut`,
resolved affirmatively, 3 promotions, 6 wakes, 2 audit-bounced revisions).
Its PROCESS_LESSONS marks two lessons "graduate"; filed here as candidates:

1. **Packet discipline for toolless workers** (from lesson L1). The launcher
   assumes workers can be given tools; CLI-oracle workers have none, and a
   packet written for a tooled worker burned a dispatch (w001). Candidate
   launcher touch: "compose each packet against the worker's actual tool
   surface — when workers are toolless, the coordinator retrieves sources,
   runs computations, and inlines the results; a packet instructing a
   toolless worker to fetch or verify anything is a defect."
2. **Flag, never repair, defects in the frozen statement** (from lesson L5).
   The statement misattributed Problem B's definition (right definition,
   wrong author set); the coordinator flagged it and left STATEMENT
   untouched, preserving the evidence that the definitional audit worked.
   The launcher's amendment rule already implies this; candidate edit makes
   it explicit: "inaccuracies discovered in the frozen statement (wrong
   citation, misattribution) are reported to the user, never edited."

Also evidenced, not yet a launcher edit: pinning a literature definition
inside the statement with a "verify against the source; flag mismatches
rather than silently adapting" clause paid off (caught the misattribution
via L3's LaTeX-source retrieval). Worth standardizing as a statement-drafting
convention if it recurs.

Activation-test status for the deferred items below, after campaign 1:
tiered verification — no evidence either way; all three promotions were
load-bearing or final, so full cadence was justified, and the journal
records no token usage, so the spend half of the test was unmeasurable at
the time; per-call token accounting has since landed (design.md roadmap). Idea generation — no
evidence; one mechanism family sufficed at this statement size. Both stay
deferred.

## Evidence from campaign 2 (2026-08-01, lin-3-cut complexity, in progress)

Second live campaign (`~/research/linear-3-cut/campaigns/2026-07-31-complexity-s-star-t-lin3cut`,
7 promotions in 7 wakes at time of writing; survived a host reboot mid-rebuild
losslessly; coordinator/worker models switched Opus→Sol at wake 8 with no
observed state discontinuity).

1. **Restart-rule re-orientation cost is the binding constraint, not ledger
   size.** The resume bundle (statement + frontier + registry + lessons) was
   only ~11k tokens, but the freshly rebuilt coordinator burned to ~143k
   context (journal `usage` entries) on evidence re-reads and gate transcripts
   before its first dispatch — against a 150k cap, i.e. near-thrash. Feeds
   deferred item 3 (compaction-boundary context discipline): the candidate
   skill lesson is a **frontier-sufficiency clause** — CURRENT_FRONTIER should
   be written so a session rebuilt from the ledgers alone can choose its next
   dispatch without broad EVIDENCE re-reading. Harness mitigation applied
   meanwhile: cap raised via `COVERIFY_COORDINATOR_CONTEXT_TOKENS`.
2. **Stage-2 blind reconstruction + comparison demonstrably earns its keep.**
   Four comparison FAILs (obstructions.r2, escapes.r1, escapes.r2,
   middle-structure.r3), each a legitimate precision catch after stage-1 audit
   PASS: a witness established only with parallel arcs where the candidate
   claimed a simple digraph; a witness-fixed algorithmic claim established
   only at OPT level; a whole tightness proposition absent from the
   reconstruction. All four forced revisions that then passed. Relevant to
   tiered verification's activation test: this argues for keeping the full
   cadence *at promotion* exactly as drafted there (the tier proposal already
   preserves it); it is evidence against ever weakening the promotion gate
   itself.
3. **Gate critic filters hard post-model-switch: 1 of 8 mechanisms passed in
   the first Sol-coordinator wakes** (two IDEA REPAIR, five IDEA FAIL, one
   PASS that dispatched two workers), vs. routine passes under Opus.
   Confounded (model change vs. genuine lane exhaustion at wake 8+); watch
   before drawing a lesson.
4. **Graduate lessons from the campaign's PROCESS_LESSONS (L25–L27),
   candidates for the launcher's allocation guidance:**
   - *L25 — adversarially solve a promised source before building hardness
     on it.* The only gate-passed hardness map died because nobody had
     checked whether its promised source class was itself polynomial (it
     was: the promise deleted exactly the cycles carrying hardness). One
     algorithm gate on the source would have saved a three-worker wave.
   - *L26 — close the demand/promise Cartesian product before gadgetising a
     multicut source.* Demands + promises together formed a complete S×T
     product = one ordinary cut; a max-flow check beats any reduction
     design.
   - *L27 — an NP-hard constrained base case is a hardness lead, not a
     lift.* Gate the unchanged-instance lift on a tiny source instance
     before amplification; free optimization reliably escapes through what
     the constraint suppressed.
5. **Hostile audit caught a false counterexample (w019)** — a wrong
   refutation that would have permanently closed a live algorithmic route
   in FAILED.md: the auditor exhibited an optimal tie-break-minimal
   partition on the candidate's own instance satisfying the allegedly
   refuted conditions. Verification pays in both directions: against false
   theorems and against false give-ups.
6. **Async verification handles (harness 045d36f) removed the wake-loop
   serialization** that cost ~27 idle coordinator minutes per blind
   reconstruction under the synchronous design. Also observed: two
   transient provider failures journaled as ordinary completions with
   empty 0-byte reports — fixed 2026-08-01: completions now carry a
   `failed` reason flag (same shape as `cancelled`), write no phantom
   artifact, and are excluded from the wake's `newReports` count.

## Evidence from campaign 3 (2026-08-01, lin-3-cut complexity, fresh restart)

Third campaign (`~/research/linear-3-cut/campaigns/2026-08-01-complexity-s-star-t-lin3cut-fresh`,
21 wakes, 46 dispatches, 0 promotions, paused 2026-08-02 mid-wave with v039
in flight).

1. **All 5 comparisons FAILed, every one substantive — and every one the
   same shape: the candidate bundles several theorem-class conclusions and
   the blind reconstruction establishes only a subset.** Read together
   (r002.r2, r004.r2, r012.r1, r022.r1): a reconstruction proved the
   pair-union identities but not the existential FC4 counterexample; proved
   the unsigned obstruction but not the signed all-distinct-pairs theorem;
   proved nested cuts but not the universal bilateral-exchange claim;
   proved the qualitative obstruction but not the unbounded profile,
   the exact primal/dual values, or the two-instance separation. The Aug 1
   theorem-class/check-class split worked as intended — none of these is a
   witness-bookkeeping FAIL (and the #14 delta-auditor trigger therefore
   did **not** fire; re-measured per its "re-measure before sizing" note).
   What remains is a scope problem: a revision's promotability is
   all-or-nothing over every theorem-class conclusion it states, so each
   extra theorem multiplies the chance the whole revision fails.
   **Candidate launcher lesson (deferred, performance-shaped): candidate
   scope discipline** — one promotable theorem (or one tightly coupled
   cluster) per revision; supporting results a reasoner wants on record go
   in separate revisions verified separately, not as riders. Activation
   test: a campaign where multi-theorem revisions again convert ≥1
   would-have-passed conclusion into a whole-revision FAIL, measured from
   its trace against a comparable single-theorem baseline.
2. **Restart-lost verification stages re-paid** (v033: audit PASS +
   bundle-cert PASS stranded by a process death, v035: no verdict at all;
   fresh v039 re-ran everything on the byte-identical candidate). Harness
   gap, not a skill gap — fixed in coverify (restart-lost stage reuse,
   design.md roadmap): a stage PASS now carries forward to a re-run whose
   every input hash matches. No launcher edit needed; the contract already
   sanctioned byte-identical re-run reuse.

## Deferred: tiered verification (drafted, ready to land on evidence)

Two launcher edits:

1. **New claim label `audited`** between `self-audited` and
   `verifier-backed`: "the exact revision passed one audit by a fresh
   hostile auditor that is not its author or producing context." Inheritance
   and retraction rules apply unchanged.
2. **Verification-timing paragraph** in the cadence section: the full
   cadence is mandatory only for promotion and at completion (the final
   self-contained artifact always gets it, plus the different-family audit).
   Below that, a single fresh hostile audit is the working standard for
   retained lemmas, labeled `audited`. Promote early when a result becomes
   load-bearing — a second route wants to cite it — or when reporting to the
   user above `candidate`.

Rationale: verification cost should scale with citation fan-in and user
visibility, not production volume; the completion gate already re-verifies
the assembled whole, making per-lemma full cadence redundant for soundness.
Deferral is already label-legal; this edit makes the default explicit so a
conservative coordinator doesn't over-verify.

**Activation test:** first campaign's journal shows verification calls
dominating token spend, or full-suite runs on lemmas that nothing else ever
cites.

Harness ripple when landed: `depth: "audit" | "full"` parameter on
`request_verification` (stage 1 already runs first and short-circuits);
mechanical fan-in flag ("this premise is now cited by a second route —
consider promotion") in the wake digest.

## Landed 2026-08-02: idea generation as delegable labor

Both drafted launcher touches landed (kb 30f0dd9): the exploration-agent
deliverable list now includes gate-ready mechanism proposals, and scouts at
any point may propose (first-wave restriction dropped; selection stays with
the coordinator; every proposal still faces the gate). Activation evidence
from campaign 3 (fresh lin-3-cut, 2026-08-02): the fresh coordinator
hand-wrote 13 mechanisms and serialized them through gates in its own
context (~35 min, 0 IDEA PASS, 7 FAIL / 6 REPAIR — every sampled verdict
mathematically sound, with 4–5-vertex counterexamples), then independently
invented a 7-reasoner mechanism-scout wave — the exact pattern the edit
formalizes. Harness ripple landed the same day: dispatch_gate_critic is
now an async handle (verdict at a later wake, gates run concurrently) with
an importedPremises field, closing the G1b gap where a toolless critic
correctly refused premises the coordinator forgot to inline.

## Deferred: imports provisioning — ledger file vs knowledge-manager role

Cross-campaign imports revealed a general provisioning problem: every role
is deliberately context-starved, so each call needs its premise bundle
assembled, and the assembler (coordinator) forgets (G1: inlined correctly;
G1b: empty packet → correct-but-avoidable FAIL). Two candidate shapes:

1. **IMPORTS.md ledger** (mechanical): one campaign file where each
   imported theorem is recorded once — verbatim statement, source path,
   revision identity, hypotheses-verified note — and every packet cites or
   inlines from it. One provisioning act, many uses; no new role.
2. **Knowledge-manager role** (MechMath-style): an agent that assembles
   "what is known relevant to X" per packet. Rejected for now: premise
   *selection* is judgment that re-creates the same omission risk one
   level down, adds a second authority over what is known, and its output
   feeding blind roles would need its own certification. Revisit only if a
   campaign's promoted-premise count grows past what a flat ledger file
   serves (≳50 entries).

**Activation test for (1):** recurrent premise-omission gate FAILs after
the importedPremises field exists, or per-call premise re-inlining
becoming a visible share of coordinator output tokens.

## Deferred: derive the frontier's verdict-state from the ledgers (knowledge/operations separation)

Source: comparison against qmd-prover (2026-08-02, single-author QMD
dependency-graph checker). Its design keeps knowledge (statements, proofs)
strictly separate from operations, with every operational view *derived*:
global verified/blocked/open status is a deterministic fold over recorded
local verdicts, and "where must work happen" is a computed dependency
frontier — so the operational view cannot drift from the knowledge it
summarizes. Its one status write-back into knowledge documents is
display-only and excluded from all hashes.

`CURRENT_FRONTIER.md` is our mixed artifact: it records both what is known
and what to do next, as coordinator-maintained prose, so it *can* drift
from REGISTRY.md/gate-record truth (which revisions are promoted, which
audits stand, which routes died in FAILED.md). Candidate launcher touch:
split the frontier's content classes — the verdict-state portion (claim
labels, standing verdicts, open obligations) must be *reproducible from
the ledgers* and is restated, never freshly asserted, in the frontier;
frontier prose is reserved for what no ledger can express (route
priorities, why a direction was chosen or abandoned, next-dispatch
intent). Complements campaign 2's frontier-sufficiency clause (item 1
there) and deferred item 3: a rebuilt or compacted coordinator re-orients
from ledgers + judgment prose, not from prose restatements of ledger
facts that may be stale.

**Activation test:** any campaign where CURRENT_FRONTIER.md is caught
contradicting the gate records or REGISTRY.md (a claim listed at the wrong
label, a dead route still shown live), or a post-rebuild coordinator
misdirects a dispatch on stale frontier prose.

Harness note (no code change now): the harness already treats the gate
ledger as the sole verdict authority out of agent reach; if the launcher
edit lands, a mechanical drift check (frontier labels vs. gate records) in
the wake digest would be the enforcement hook, per repo rule "prefer
enforcing a rule in gates.ts over restating it in a prompt".

## Deferred (earlier entries)

1. **Interop note** — one sentence in SKILL.md that a conformant harness
   exists and campaign dirs are interchangeable. Blocked on: demonstrating a
   campaign resumed in both directions.
2. **Ambient status instead of polling** — add to the adapter if live skill
   runs show coordinators polling workers.
3. **Compaction-boundary context discipline** — the harness now runs a
   resident coordinator compacted in place at a context cap (restart-rule
   rebuild as fallback); if
   live *skill* runs show coordinator bloat between compactions, generalize
   the restart rule to a per-checkpoint discipline in the launcher.
4. **Gate-verdict location** — the launcher now requires recording every
   gate packet/verdict (2026-07-31) but still doesn't name where; name
   REGISTRY.md if skill sessions scatter them.
5. **Verification-retry semantics for `audited`** — if tiered verification
   lands, decide whether a tier-1 audit FAIL has the same stands/rebuttal
   semantics as full-cadence FAILs (presumably yes; confirm wording).

## Evidence from 2026-08-01 (harness hardening + conformance audit)

A campaign's detached search jobs kernel-panicked the host, which forced a
rebuild of everything that executes code and a line-by-line audit of the
harness against the contract. Three divergences are the skill's to decide,
not the harness's:

6. **"Scheduler front door" assumes infrastructure that may not exist.**
   The computation clause says to use "the workspace's established scheduler
   front door or a committed workload-owned scheduler spec" and warns
   against building "a second submission, reconciliation, locking,
   monitoring, or certification layer". On a single-host campaign there is
   no scheduler, and the honest reading forced a supervised in-harness
   runner (argv-only, own process group, shared wall and RSS caps,
   whole-tree kill, reaper on harness exit). That is exactly the "second
   monitoring layer" the clause discourages, and it is also the only thing
   that would have prevented the panic. Candidate wording: require
   *supervision properties* (bounded, cancellable, reaped, logged, no
   detached compute) and name the scheduler as the preferred implementation
   where one exists, rather than requiring the scheduler itself.
   *Activation test:* a campaign on a host with no scheduler — already met.

7. **Computation is a role, not just a job.** The contract says "every
   exploration agent must return a proved lemma, explicit construction,
   counterexample/certificate, or a precise failing implication" and
   separately that "a job emits raw evidence only". The harness materializes
   computation as a dispatched *technician* — an agent that writes and runs
   code but whose deliverable is raw output plus an encoding description,
   never a proof. It is consistent with both clauses only because the
   technician is a job wearing an agent's clothes. Worth one sentence in the
   contract acknowledging that the executor may be an agent, so a reader
   does not apply the exploration-agent deliverable rule to it.
   *Activation test:* a skill-only session that dispatches a compute worker
   and is told its raw table is not an acceptable deliverable.

8. **Delegated literature search has no clause.** The sources rule bounds
   *what* may be searched ("ordinary background and standard named theorems
   only") but assumes the searching agent is the campaign agent. The harness
   delegates to an external librarian CLI and archives its report as
   evidence, which changes provenance: the citation is secondhand and
   self-attested, and the scope limit must be carried into the librarian's
   own charge (now done). Candidate: state that a delegated searcher
   inherits the scope limit and that its report is evidence of a search, not
   of a theorem — promotion-grade use still requires checking the source's
   exact hypotheses.
   *Activation test:* any campaign that cites a librarian report in a
   promoted dependency.

Conformance fixes made on the harness side instead of here (no skill change
needed): pause/stop now interrupts live agents and cancels their
computations per the reporting clause; a technician dispatch returns the
`REGISTRY.md` launch record (workload, limits, output paths, cancellation)
the computation clause requires; the librarian charge carries the
public-search scope limit verbatim.

## Landed 2026-08-09: stall consult + reasoning-only + the three adapter divergences (launcher edits)

With Chao's go-ahead ('make these so it matches living system'), five launcher
edits landed in ~/kb: the different-family/stronger-backend stall consult
(advice-never-fact, gated entry only); the user-may-close-the-computation-
channel sentence; supervision-properties-not-scheduler wording; technician-
as-agent; delegated-searcher scope inheritance. Items 6-8 below and the
Danus consult item are therefore LANDED; their entries remain as evidence
records.

## Evidence from the Danus comparison study (2026-08-07)

Source: measured analysis of a real frenzymath-Danus campaign
(`directed-cut-union`, 2026-07-22 on jupiter: 7 self-directed workers, 74
verified facts, ~618M input tokens, terminated by quota exhaustion
mid-consolidation) side by side with the lin3cut campaigns, via five
independent adoption evaluations. Harness-side outcomes (four rejections,
two issues) are recorded in design.md's review record; two candidates are
launcher-shaped and wait here:

1. **Stalled-route dichotomy at checkpoints.** Danus's strategy loop forces
   every stalled line to be classified *method failure* or *evidence
   against the target statement*; the launcher's checkpoint discipline
   records obstructions but never forces the second reading — which is the
   mechanism that turns a failing proof campaign into a counterexample
   hunt. Candidate launcher touch (checkpoint section): "classify every
   stalled route as method failure or as evidence against the statement;
   recurring evidence-against classifications must move the frontier's
   working hypothesis."
   *Activation test:* a campaign whose FAILED.md accumulates ≥3
   same-mechanism closures with no recorded update to the frontier's
   working hypothesis (campaign 2 already shows the shape: 28 closed
   routes, hypothesis unchanged across 12 wakes).

2. **Stall-triggered strategy consult (different family or strictly
   stronger; advice-never-fact).** Evidence for: campaign 2 circled — the
   per-gadget-selector mechanism class closed in FAILED.md with retries
   failing the materially-new bar, and after 12 wakes the frontier held
   neither an algorithm candidate nor a hardness candidate; in the Danus
   run, a single 28-second gpt-5.6-pro consult converted the main agent's
   seed into the complete prioritized plan whose dispatch produced the
   answer within an hour, while the subsequent 618M-token swarm added no
   further ideas. Evidence bounding it: the consult did not *originate*
   the key idea (the consult prompt already contained the seed), and
   Danus's second consult — same model family as its workers — produced
   zero new mathematics: value requires a genuinely different-family or
   strictly stronger backend (the `chatgpt-cli` reasoner backend already
   reaches gpt-5.6-pro). Candidate launcher touch (stall handling): "when
   a mechanism class is closed in FAILED.md and further retries fail the
   materially-new bar, the coordinator may dispatch one consult to a
   different-family or strictly stronger backend, prompt = frozen
   statement + failed-mechanism digest; the reply is logged verbatim as a
   tagged guidance artifact, and ideas taken from it enter only as
   ordinarily gated packets, never citable as evidence." No mandated
   cadence — the evidence justifies availability, not a schedule.
   *Activation test:* the next stalled campaign; measure whether a
   consult-derived packet opens a route the campaign had not proposed.

## Deferred: periodic bundle distillation (2026-08-07)

The resume bundle's growing halves (REGISTRY.md, PROCESS_LESSONS.md) have no
curation prompt: FAILED.md is append-only by contract, CURRENT_FRONTIER.md is
rewritten every checkpoint, but nothing ever tells the coordinator to merge
redundant lessons or retire superseded registry rows — the rewrite authority
exists and sits unused. Candidate launcher touch (checkpoint section): "when
the registry or lessons have grown redundant, distill them — merge duplicate
lessons, collapse superseded route rows into their outcome — preserving every
exact statement, obstruction, and retry bar." Deferred because measured sizes
are nowhere near hurting (campaign 2 after 43 dispatches: REGISTRY 7.4KB,
LESSONS 6.1KB, bundle ≈5k tokens ≈ 2% of the coordinator's peak context).
*Activation test:* a campaign whose resume bundle exceeds ~10% of the
coordinator context cap, or whose PROCESS_LESSONS carries visibly duplicated
rules (two entries a reader would merge on sight).

## Rejected candidates

- Numeric thresholds for "substantial wave" — prose judgment is the right
  form for a model-interpreted contract; the harness's concrete trigger
  (second concurrent worker) is documented as an implementation choice.
- Harness-side git of campaign folders — second versioning system; git
  remains a user convention.
- A mandatory ideation stage per wave — generators are an option the
  coordinator may dispatch, never a pipeline stage.

## 2026-08-09: single-bridge serialization leaves worker slots idle

Observed (lin3cut wake 195; BET same night, milder): once a route compresses
to one named bridge, the coordinator tends to serialize — one live gate, zero
live workers, five slots idle while the gate thinks. Mathematically the
compression is progress; operationally it converts gate latency into idle
capacity, and when the bridge FAILs the alternative mechanisms it then
launches could have been running in parallel all along. User policy issued
live via `coverify say` (Chao, 2026-08-09): prefer a diversified live
portfolio — independent mechanisms plus the opposite disjunct — over serial
focus, up to the agent limit; mechanism choice stays with the coordinator.
Candidate skill improvement: the launcher's allocation guidance could state
that a pending gate/verification on the selected route is not a reason to
leave worker capacity idle; hedging routes (including the other disjunct)
should run concurrently unless the user restricted capacity. Watch whether
the steered campaigns' subsequent wakes actually rebalance before proposing
the canonical edit.

## 2026-08-09: reasoning-only as a verifiability regularizer (hypothesis)

One-night observation, confounded: P3 (P3|prec,p=1|Cmax, --no-computation,
hardest statement in the fleet) promoted 10 results in ~6h — all small
finite certificates (enumerations, infeasibility certificates, barrier
theorems) carried by hand. Flushing-coin (computation allowed, friendlier
statement) promoted 0 in the same window; its candidates claimed more per
artifact and died at comparison. Plausible mechanism: forbidding
computation forces candidates to hand-checkable granularity, which is
exactly what survives blind reconstruction. Confounds: different problems,
different prior-route maturity, different coordinators' drafting styles.
Candidate skill change IF replicated: recommend reasoning-only mode for
theory campaigns unless a computation is declared load-bearing up front.
Test: next paired launch, run one theory campaign each way.

## 2026-08-09: monitors must surface rebuttal records

Operator-side lesson from the retracted issue #23: a journal view showing
comparison verdicts but not kind:rebuttal records makes the contract's
legitimate FAIL->rebuttal->fresh-attempt lane look like verdict shopping.
Any status/trace/monitor surface that prints verdicts should print the
permission records (rebuttals, reconciliations) beside them.

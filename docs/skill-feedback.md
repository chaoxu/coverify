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
records no token usage, so the spend half of the test is unmeasurable until
per-call token accounting lands (design.md roadmap). Idea generation — no
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

## Deferred (earlier entries)

1. **Interop note** — one sentence in SKILL.md that a conformant harness
   exists and campaign dirs are interchangeable. Blocked on: demonstrating a
   campaign resumed in both directions.
2. **Ambient status instead of polling** — add to the adapter if live skill
   runs show coordinators polling workers.
3. **Compaction-boundary context discipline** — the harness now runs a
   resident coordinator rebuilt at a context cap via the restart rule; if
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

## Rejected candidates

- Numeric thresholds for "substantial wave" — prose judgment is the right
  form for a model-interpreted contract; the harness's concrete trigger
  (second concurrent worker) is documented as an implementation choice.
- Harness-side git of campaign folders — second versioning system; git
  remains a user convention.
- A mandatory ideation stage per wave — generators are an option the
  coordinator may dispatch, never a pipeline stage.

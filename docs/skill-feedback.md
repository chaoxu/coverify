# Skill feedback ledger

Candidate improvements to the canonical `math-proof-search` skill
(`~/kb/notes/agents/skills/math-proof-search/` + the launcher contract).
**Policy: correctness fixes land immediately (three rounds already have:
2026-07-31 — PROCESS_LESSONS rename; adapter/launcher consolidation; stage-2
certification/comparison rewrite; anti-verdict-shopping). Performance-shaped
changes wait here for live campaign evidence.** Each deferred entry states
its activation test; the arbiter is the shared-format comparison — same
statement run under the raw skill in Codex and under coverify, campaign
folders read side by side.

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
conservative coordinator doesn't Danus itself.

**Activation test:** first campaign's journal shows verification calls
dominating token spend, or full-suite runs on lemmas that nothing else ever
cites.

Harness ripple when landed: `depth: "audit" | "full"` parameter on
`request_verification` (stage 1 already runs first and short-circuits);
mechanical fan-in flag ("this premise is now cited by a second route —
consider promotion") in the wake digest.

## Deferred: idea generation as delegable labor (drafted)

Two launcher touches:

1. Extend the worker-deliverable list with: "or a set of gated-ready
   mechanism proposals, each with its claimed first nontrivial implication."
2. Drop the accidental first-wave restriction on proposal packets ("
   Independent first-wave scouts may propose…" → scouts at any point may
   propose; every proposed mechanism still faces the gate before a wave).

Rationale: generation is creative labor, not judgment — it benefits from
fresh eyes (a resident coordinator sampling its own posterior yields
correlated ideas), deep reading the coordinator cannot afford, and
per-packet model-family diversity. Selection remains the coordinator's.
No new role: a generator is a worker packet.

**Activation test:** first campaign shows poor mechanism diversity (routes
clustering on one family), or the coordinator's context filling with
ideation instead of portfolio work.

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

## Rejected candidates

- Numeric thresholds for "substantial wave" — prose judgment is the right
  form for a model-interpreted contract; the harness's concrete trigger
  (second concurrent worker) is documented as an implementation choice.
- Harness-side git of campaign folders — second versioning system; git
  remains a user convention.
- A mandatory ideation stage per wave — generators are an option the
  coordinator may dispatch, never a pipeline stage.

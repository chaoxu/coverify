# Coverify 2.0 Design

Coverify 2.0 is a mechanical referee for the `math-proof-search` skill. The
skill's launcher contract
(`~/kb/notes/agents/prompts/prompt-math-proof-search-launcher.md`) is the
spec; this harness adds **zero mathematical policy of its own**. A perfectly
obedient harness-agent session running the skill and a coverify run should be
semantically interchangeable — coverify's edge is that the rules which matter
cannot be skipped, forgotten after compaction, or drifted away from.

Three implementation rules follow:

1. **Every enforcement traces to a launcher clause** (conformance table
   below). Role prompts embed the launcher's fenced contract verbatim — never
   a paraphrase. The launcher is read at runtime from `~/kb` (override:
   `COVERIFY_LAUNCHER_PATH`); if it is missing, coverify says so and stops —
   no silent fallback to a remembered version, mirroring SKILL.md.
2. **Unmapped code is semantics-invisible mechanics** (scheduler, handle
   table, wake building, cache policy, journal). Any such mechanism must be
   removable without changing campaign behavior; the harness may reset a
   cached coordinator at random as a discipline check.
3. **No invented policy defaults.** No agent-count ceiling (launcher forbids
   one); budget gates enforce only limits the user actually set; no
   wall-clock timeouts on proof work, ever.

## Campaign state — the skill's own format

A project is a folder. The campaign directory uses the launcher's exact file
set, so a Claude Code/Codex session running the skill can resume a coverify
campaign and vice versa:

```
STATEMENT.md          verbatim statement, conventions, constraints; revisioned
CURRENT_FRONTIER.md   derived operational summary; rewritten last at checkpoints
REGISTRY.md           canonical route + claim-label index (mechanism × terminal gap)
FAILED.md             append-only closed routes with obstructions + retry-novelty bar
PROVED.md             append-only promotions with dependencies + audit provenance
LESSONS.md            process lessons only
EVIDENCE/             append-only, revision-suffixed artifacts; identity = filename
.coverify/journal.jsonl   harness-generated audit metadata (allowed by the launcher)
```

## Runtime shape

```
cli.ts       prove / resume / status
campaign.ts  state layer: init, revisions, append-only evidence, resume bundle
launcher.ts  load + extract the fenced launcher contract (no fallback)
roles.ts     prompt assembly (launcher verbatim + role charge); pi Agent runner
gates.ts     dispatch gate, idea-gate ledger, two-stage verification, promotion
harness.ts   handle table, event loop, wakes; the only persistent process
```

- **Coordinator**: ephemeral per wake; verbs `dispatch`/`cancel`/`steer` plus
  ledger edits. Sole ledger writer.
- **Workers**: fresh `Agent` instances; packet in, finite deliverable out;
  write access only to assigned `EVIDENCE/` paths.
- **Verifiers**: stage-1 hostile auditor and stage-2 reconstructor are fresh
  instances whose input bundles are built by the harness — blindness is
  platform-enforced by construction, and the journal records supplied inputs,
  visibility, and model family per audit.
- **Dispatch is the primitive**: workers, critics, auditors, reconstructors,
  and supervised computations are all handles in one table. No polling —
  completions wake the coordinator with a rebuilt minimal bundle.

## Conformance table

| Mechanical enforcement (code) | Launcher clause |
| --- | --- |
| `STATEMENT.md` written once; new revision only via explicit user amendment; completion evidence invalidated | "Fix its revision before search; only an explicit user amendment may replace it…" |
| Campaign file set + `EVIDENCE/` append-only, revision-suffixed, no in-place edits | "Durable campaign state" bullets |
| Workers get no ledger-write capability; only assigned evidence paths | "The coordinator is the sole ledger writer; workers… write only assigned evidence artifacts" |
| Resume bundle = launcher + STATEMENT + FRONTIER + actionable lessons + registry index (never the whole campaign) | "After restart or context compaction, reread…" |
| Claim labels are a closed enum; derived claims inherit the weakest premise label | "Claim labels — literal, never inflated" |
| Dispatch schema requires the FAILED.md check field (`no close prior route` / `closest is X; differs because…`) | "Before every route, materially changed retry, or variant, check `FAILED.md`…" |
| Worker packet requires a finite mathematical deliverable; report schema is deliverable-or-precise-gap | "Every exploration agent must return a proved lemma, explicit construction, counterexample/certificate, or a precise failing implication" |
| No harness timeouts on proof/audit/reconstruction work; struggle evidence collected mechanically, ruled on by the coordinator | "Do not impose a coordinator-created elapsed-time limit…"; "Treat struggle as observable repeated failure…" |
| Wave gate: recursive fan-out or a multi-worker wave on a mechanism requires `IDEA PASS` on file; single first-wave scouts exempt; packet+verdict recorded at selection | "Do not allow recursive subagent fan-out or a large route wave before the parent mechanism receives `IDEA PASS`…" |
| Verification = stage 1 (fresh hostile audit: candidate revision + statement + declared deps) then stage 2 (fresh no-context reconstruction from statement + key ideas + allowed sources + promoted premises only, plus preserved comparison) | "Verification cadence" 1–2 |
| Load-bearing change ⇒ both stages invalidated, fresh verifiers (never one that influenced the repair); non-load-bearing ⇒ delta audit + recorded carry-forward; uncertain ⇒ load-bearing | Revision-impact rules |
| Promotion path writes `PROVED.md` only when both stage records exist for the exact revision, with dependency identities and audit provenance | "Promotion records the revision and dependency identities plus every audit…" |
| Completion gate: self-contained final artifact re-passes both stages; independent different-family audit sought; otherwise delivery opens with the literal `Status: promoted only; …` line | "Before completion, assemble one self-contained final artifact…" |
| Retraction flow: registry relabel, FAILED append, PROVED marked historical, dependents demoted before reuse | "If a promoted revision later fails…" |
| Checkpoint ordering: dispatch stopped, harvest, reconcile, lessons, conservative clean, `CURRENT_FRONTIER.md` rewritten **last**; running workers carried forward, not interrupted | "Checkpoint and learning loop" 1–5 |
| Campaign loop persists across restarts until user stop or completion; pause = cease dispatch, interrupt agents, checkpoint | "The initial resolution request remains authorization…" |
| Compute dispatch requires the REGISTRY.md preregistration record (source, command/scheduler job, limits, outputs, cancellation); raw stdout/stderr preserved; goes through the scheduler front door; no detached compute | "Reporting, computation, and sources" compute paragraphs |
| Journal records each audit's supplied inputs, visibility, model family, and instructed-vs-platform-enforced restrictions | "Every audit records the supplied inputs, workspace/tool visibility, model-family provenance…" |
| No agent-count ceiling; budget gate enforces only user/workspace/runtime limits | "Do not impose a fixed agent-count ceiling… scaling to available concurrency and any explicit user, workspace, or runtime limits" |

Judgment stays with models: route selection, packet composition, gate and
audit verdicts, struggle rulings, promotion decisions, lesson content.
Mechanics-only (rule 2): handle table, event-driven wakes with ambient status
digests, review-wake alarm, TTL/size-aware coordinator cache reuse, journal.

## Efficiency (the anti-Danus commitments)

Verify at trust boundaries (promotions, resolution claims), not per
micro-fact; gate before the wave; finite deliverables, never clocks; the
FAILED/REGISTRY indexes stop re-funding dead routes; budgets enforced at
dispatch; workers are warm cached sessions while fresh cold instances are
reserved for the two places they buy trust (critics, verifiers).

## Skill feedback

Candidate improvements to the skill discovered during this design are
tracked in `docs/skill-feedback.md`. Policy: do not edit the canonical skill
until this harness has run a real campaign; the only planned zero-risk edit
is a note that a conformant harness exists and campaign directories are
interchangeable.

## Status / roadmap

- [x] Launcher loading with no-fallback rule
- [x] Campaign state layer in the skill's format; append-only evidence
- [x] Role prompts embedding the launcher verbatim
- [x] Dispatch gate (FAILED-check field, wave gate, user budgets) in code
- [x] Two-stage verification runner with constructed-bundle blindness
- [ ] Promotion/retraction bookkeeping helpers (PROVED/REGISTRY writers)
- [ ] Checkpoint enforcement (frontier-last ordering, dispatch stop)
- [ ] Compute handles via the fleet scheduler front door (Nomad)
- [ ] Independent different-family audit path (fable-review integration)
- [ ] TTL/size-aware coordinator cache reuse + random-reset discipline check
- [ ] First live campaign; then revisit `docs/skill-feedback.md`

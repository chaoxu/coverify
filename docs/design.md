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
   table, wake building, journal). Any such mechanism must be removable
   without changing campaign behavior.
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
.coverify/journal.jsonl   harness audit metadata (write-only mirror; gates never read it)
```

Gate-authoritative state lives OUTSIDE the campaign directory
(`~/.local/state/coverify/<campaign-id>/gates.jsonl`), so no role's bash can
forge or erase gate records; the in-tree journal is an audit mirror. Audit,
reconstruction, and comparison records are content-hash-bound (sha256 of the
candidate and of `STATEMENT.md` at verification time) — a file edited after
its PASS is no longer verifier-backed, and a statement edit without
`coverify amend` hard-stops the next run.

## Write confinement

Role bash is OS-sandboxed on macOS (`sandbox-exec`, deny-default writes;
reads unrestricted): workers may write only their assigned `EVIDENCE/<id>/`
directory (+ system temp), the coordinator may write the campaign dir
*except* `.coverify/`, `STATEMENT.md`, and `PROVED.md`. `PROVED.md` is
appendable only through the `record_promotion` tool, which re-checks both
verification stages and the content hashes before writing. On non-darwin
platforms confinement is currently instructed-only — say so honestly; do not
claim platform enforcement there. (A campaign placed under the system temp
tree is inside the sandbox's blanket temp allowance — keep campaigns in real
project directories.)

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
| No harness timeouts on proof/audit/reconstruction work (a per-shell-command cap is surfaced in the tool description and env-tunable) | "Do not impose a coordinator-created elapsed-time limit…" |
| Wave gate: a second **concurrent** worker on a mechanism requires `IDEA PASS` on file; sequential retries get an advisory reminder, not a refusal (that judgment is the coordinator's); single first-wave scouts exempt | "Do not allow recursive subagent fan-out or a large route wave before the parent mechanism receives `IDEA PASS`…" |
| Verification = stage 1 (fresh hostile audit: candidate + statement + PROVED.md + declared deps) then stage 2a (fresh blind reconstruction from statement + key ideas + allowed sources + promoted premises — no verdict) then stage 2b (fresh comparison mapping the reconstruction to the candidate's conclusions and dependencies — this verdict is stage 2's PASS); all three outputs saved as citable EVIDENCE artifacts | "Verification cadence" 1–2: "…Preserve a comparison that maps the reconstruction to every conclusion and declared dependency of the candidate" |
| Load-bearing change ⇒ both stages invalidated, fresh verifiers (never one that influenced the repair); non-load-bearing ⇒ delta audit + recorded carry-forward; uncertain ⇒ load-bearing | Revision-impact rules |
| `record_promotion` is the sole writer of `PROVED.md` (direct writes OS-denied); legal only when both stage records exist for the exact revision with matching content hashes; entry carries dependency identities and audit-artifact citations | "Promotion records the revision and dependency identities plus every audit…" |
| Campaign ends only by explicit `declare_campaign_state`; "complete" refused with zero promotions on record; an idle wake gets a nudge, and 3 consecutive no-op wakes trigger an operational *pause* (never a completion) as spend protection | "Do not mark it complete until the final result passes the full cadence…"; "Failed attempts… are not permission to return"; "Pause is operational state" |
| Retraction flow: registry relabel, FAILED append, PROVED marked historical, dependents demoted before reuse | "If a promoted revision later fails…" |
| Checkpoint ordering: dispatch stopped, harvest, reconcile, lessons, conservative clean, `CURRENT_FRONTIER.md` rewritten **last**; running workers carried forward, not interrupted | "Checkpoint and learning loop" 1–5 |
| Campaign loop persists across restarts until user stop or completion; pause = cease dispatch, interrupt agents, checkpoint | "The initial resolution request remains authorization…" |
| Compute dispatch requires the REGISTRY.md preregistration record (source, command/scheduler job, limits, outputs, cancellation); raw stdout/stderr preserved; goes through the scheduler front door; no detached compute | "Reporting, computation, and sources" compute paragraphs |
| Journal records each audit's supplied inputs, visibility, model family, and instructed-vs-platform-enforced restrictions | "Every audit records the supplied inputs, workspace/tool visibility, model-family provenance…" |
| No agent-count ceiling; budget gate enforces only user/workspace/runtime limits | "Do not impose a fixed agent-count ceiling… scaling to available concurrency and any explicit user, workspace, or runtime limits" |

Judgment stays with models: route selection, packet composition, inline
derivations when the coordinator judges them cheaper than a packet, gate and
audit verdicts, struggle rulings, promotion decisions, lesson content, and
whether a sequential retry constitutes a "follow-up wave" needing the gate.
Mechanics-only (rule 2): handle table, event-driven wakes with ambient status
digests, journal, out-of-tree gate store, write sandbox, verdict-line parsing,
version stamps.

**Honesty ledger** (launcher: record instructed-vs-platform-enforced): the
candidate withheld from the reconstructor and all write confinement are
platform-enforced (macOS); `keyIdeas`/`declaredDependencies` are
coordinator-authored free text — paraphrase and mis-declaration risk is
instructed-only and the journal says so per audit. Non-darwin platforms:
write confinement instructed-only.

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

## Review record

Before the first campaign, the design and code were adversarially reviewed by
two independent strong agents (2026-07-31): an over-constraint audit (found:
invented wave-gate threshold, invented exit condition, invented "no inline
proof work" rule, stage-2 verdict predicate error, reconstructor starved of
allowed sources — all fixed) and an under-hardening audit (found: gate state
forgeable via role bash, promotion advisory-only, evidence/statement TOCTOU,
spoofable verdict regex, missing comparison step, resume id collisions — all
fixed except items noted "acceptable for now" in the audits: key-idea
paraphrase risk and idea-gate mechanism-string keying remain model judgment,
recorded honestly). Git auto-commit of campaigns was reviewed and **rejected**
as a second versioning system; git remains a user convention. Mechanical
checkpoint-ordering enforcement and coordinator-cache machinery were struck
from the roadmap as over-constraint waiting to happen.

## Status / roadmap

- [x] Launcher loading with no-fallback rule; conformance token check (`bun run check`)
- [x] Campaign state layer in the skill's format; append-only evidence
- [x] Role prompts embedding the launcher verbatim
- [x] Dispatch gate (FAILED-check field, concurrent wave gate, user limits)
- [x] Three-call verification cadence (audit / blind reconstruction / comparison), hash-bound, artifacts in EVIDENCE
- [x] `record_promotion` as sole PROVED.md writer; OS write sandbox (macOS)
- [x] Out-of-tree gate store; statement freeze + `coverify amend`; run version stamps
- [ ] Retraction bookkeeping helper (registry relabel + dependent demotion)
- [ ] Non-load-bearing delta-audit carry-forward path (currently always full re-verification — stricter than the contract, acceptable)
- [ ] Compute handles via the fleet scheduler front door (Nomad)
- [ ] Independent different-family audit path (fable-review integration)
- [ ] Linux write-sandbox backend (bubblewrap/sandbox equivalent)
- [ ] First live campaign; then revisit `docs/skill-feedback.md`

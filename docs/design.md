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
PROCESS_LESSONS.md    process lessons only — the name itself carries the rule
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
cli.ts       prove / resume / status / amend
campaign.ts  state layer: init, revisions, append-only evidence, resume bundle
launcher.ts  load + extract the fenced launcher contract (no fallback)
roles.ts     prompt assembly (launcher verbatim + role charge); pi Agent runner
gates.ts     dispatch gate, idea-gate ledger, two-stage verification, promotion
harness.ts   handle table, event loop, wakes; the only persistent process
```

- **Coordinator**: resident across wakes — matching how the skill runs in a
  live Codex/Claude Code session — until a context cap
  (`COVERIFY_COORDINATOR_CONTEXT_TOKENS`, default ~150k), which is the
  compaction analog: the session is rebuilt via the launcher's restart rule.
  Continuing wakes receive only new reports + status digest; the full resume
  bundle is sent on (re)build. Sole ledger writer. Decisions must still be
  externalized to the ledgers every wake — residency is continuity of soft
  context, never a substitute for durable state.
- **Workers**: fresh `Agent` instances; packet in, finite deliverable out;
  write access only to assigned `EVIDENCE/` paths.
- **Verifiers**: the stage-1 hostile auditor, bundle certifier, stage-2
  blind reconstructor, and comparator are fresh instances; the harness
  withholds the candidate from the reconstructor (platform-enforced), while
  the keyIdeas/allowedSources bundle is coordinator-authored and gated by
  certification (see honesty ledger). The journal records supplied inputs,
  visibility, and model family per call.
- **Workers are the async primitive**: worker dispatches are handles in one
  table; completions wake the coordinator — no polling. Gate critics and the
  verification chain run synchronously inside the coordinator's tool call.
  (Supervised computation handles: roadmap.)

## Conformance table

| Mechanical enforcement (code) | Launcher clause |
| --- | --- |
| `STATEMENT.md` written once; new revision only via explicit user amendment; completion evidence invalidated | "Fix its revision before search; only an explicit user amendment may replace it…" |
| Campaign file set + `EVIDENCE/` append-only, revision-suffixed, no in-place edits | "Durable campaign state" bullets |
| Workers get no ledger-write capability; only assigned evidence paths | "The coordinator is the sole ledger writer; workers… write only assigned evidence artifacts" |
| Resume bundle = STATEMENT + FRONTIER + full REGISTRY.md + full PROCESS_LESSONS.md, launcher embedded verbatim in the system prompt (never FAILED.md, PROVED.md, or EVIDENCE/ wholesale) | "After restart or context compaction, reread…" |
| Claim-label vocabulary quoted verbatim into the ledger templates at init; label discipline and weakest-premise inheritance are contract-instructed model judgment | "Claim labels — literal, never inflated" |
| Dispatch schema requires the FAILED.md check field (`no close prior route` / `closest is X; differs because…`) | "Before every route, materially changed retry, or variant, check `FAILED.md`…" |
| Worker packet schema requires a finite mathematical deliverable; the deliverable-or-precise-gap report form is charged in the role prompt, not parsed | "Every exploration agent must return a proved lemma, explicit construction, counterexample/certificate, or a precise failing implication" |
| No harness timeouts on proof/audit/reconstruction work (a per-shell-command cap is surfaced in the tool description and env-tunable) | "Do not impose a coordinator-created elapsed-time limit…" |
| Wave gate: a second **concurrent** worker on a mechanism requires `IDEA PASS` on file; sequential retries get an advisory reminder, not a refusal (that judgment is the coordinator's); single first-wave scouts exempt | "Do not allow recursive subagent fan-out or a large route wave before the parent mechanism receives `IDEA PASS`…" |
| Verification = stage 1 (fresh hostile audit) then stage 2: bundle certification (fresh agent sees candidate + bundle; leaky bundle refused, same-bundle retry hash-blocked) → blind reconstruction (no verdict) → fresh comparison carrying stage 2's verdict with the contract's match semantics; all outputs saved as citable EVIDENCE artifacts, hash-bound | "Verification cadence" 1–2 (2026-07-31 revision): bundle certification, "a fresh comparison agent…", explicit PASS/mismatch semantics |
| Anti-verdict-shopping: a substantive audit/comparison FAIL on the exact revision contents blocks re-verification unless a recorded rebuttal artifact is supplied; every attempt stays on record | "A substantive FAIL from any stage stands… Do not rerun a failed stage on an unchanged revision in search of a PASS" |
| Any content change ⇒ both stages invalidated (verdicts hash-bound to candidate + STATEMENT.md; every verifier call is a fresh instance). The non-load-bearing delta-audit carry-forward is not implemented — every change gets full re-verification, stricter than the contract (see roadmap) | Revision-impact rules |
| `record_promotion` is the sole writer of `PROVED.md` (direct writes OS-denied); legal only when both stage records exist for the exact revision with matching content hashes; entry carries dependency identities and audit-artifact citations | "Promotion records the revision and dependency identities plus every audit…" |
| Campaign ends only by explicit `declare_campaign_state`; "complete" refused with zero promotions on record; an idle wake gets a nudge, and 3 consecutive no-op wakes trigger an operational *pause* (never a completion) as spend protection | "Do not mark it complete until the final result passes the full cadence…"; "Failed attempts… are not permission to return"; "Pause is operational state" (pause stops further wakes; running workers are not force-aborted — use cancel_worker) |
| Harvest before judgment: worker reports are saved to EVIDENCE/ and completion-recorded before any model sees them; checkpoint ordering itself is contract-instructed, not enforced (struck as over-constraint — see review record) | "Checkpoint and learning loop" |
| Campaign loop persists across restarts until user stop or completion; pause = cease dispatch, interrupt agents, checkpoint | "The initial resolution request remains authorization…" |
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
platform-enforced (macOS); the bundle (`keyIdeas`/`allowedSources`) is
coordinator-authored but now passes a mandatory certification by a fresh
agent before stage 2 runs (contract-required; the certification itself is
model judgment, recorded as such); `declaredDependencies` remains
instructed-only, mitigated by giving the stage-1 auditor PROVED.md.
Non-darwin platforms: write confinement instructed-only. `claude-cli/*`
verdict roles run as `claude -p` subprocesses: fresh process per call, run
in an empty temp directory, but the CLI carries its own tools (file read,
web search) — their isolation is instructed-only, and the journal's
modelFamily field discloses the backend per call.

## Efficiency (the anti-Danus commitments)

Verify at trust boundaries (promotions, resolution claims), not per
micro-fact; gate before the wave; finite deliverables, never clocks; the
FAILED/REGISTRY indexes stop re-funding dead routes; budgets enforced at
dispatch; every role instance is fresh — workers get one packet each, and
fresh instances are mandatory where they buy trust (critics, verifiers).

## Skill feedback

Candidate improvements to the skill discovered during this design are
tracked in `docs/skill-feedback.md`. Policy: do not edit the canonical skill
until this harness has run a real campaign; the only planned zero-risk edit
is a note that a conformant harness exists and campaign directories are
interchangeable.

**Correction to the review record (2026-07-31):** the over-constraint audit's
F2 struck "no inline proof work" from the coordinator charge as invented
policy, but it had read only the launcher — the delegation rule lived in
SKILL.md's thin-coordinator adapter. A subsequent spec audit (third
adversarial review, 2026-07-31) folded that rule and the non-circular
reduction gate natively into the launcher, rewrote verification stage 2
(bundle certification → blind reconstruction → named comparison agent with
explicit match semantics), added the anti-verdict-shopping rules, and
slimmed both SKILL.md adapters to runtime-specific mechanics. The charge now
cites the launcher directly. With a resident coordinator the delegation
rationale is structural: inline proof work pollutes the long-lived judgment
context and accelerates compaction.

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

## Planned capability: CLI coding agents (design reserved, not built)

Workers will be able to run coding experiments through the subscription
harnesses directly — `claude -p` / `codex exec` — via a harness-provided
`run_coding_agent` tool. Shape decided in advance so nothing has to move:

- The harness spawns the CLI as a supervised child process (never through the
  worker's sandboxed bash, which would block the CLI's own state writes),
  cwd'd to an experiment directory inside the worker's `EVIDENCE/<id>/`;
  output is saved as an evidence artifact; the journal records the model
  family and that provenance is self-attested — the exact pattern
  `fable-review` already uses.
- Base commands are configurable (`COVERIFY_CLAUDE_CMD` / `COVERIFY_CODEX_CMD`)
  so flag drift in the CLIs never requires a harness release — the lesson
  from 1.0's Danus adapter.
- Bonus this unlocks: `codex` is a demonstrably different model family, so
  the launcher's independent different-family audit can run on subscription
  rather than API pricing; `fable-review` (file-path interface: CANDIDATE
  STATEMENT DEPENDENCIES EVIDENCE_DIR) plugs into the EVIDENCE layout as-is
  for the Anthropic-side outside review.

## Status / roadmap

- [x] Launcher loading with no-fallback rule; conformance token check (`bun run check`)
- [x] Campaign state layer in the skill's format; append-only evidence
- [x] Role prompts embedding the launcher verbatim
- [x] Dispatch gate (FAILED-check field, concurrent wave gate, user limits)
- [x] Four-call verification cadence (audit / bundle certification / blind reconstruction / comparison), hash-bound, artifacts in EVIDENCE
- [x] `record_promotion` as sole PROVED.md writer; OS write sandbox (macOS)
- [x] Out-of-tree gate store; statement freeze + `coverify amend`; run version stamps
- [ ] Retraction bookkeeping helper (registry relabel + dependent demotion)
- [ ] Non-load-bearing delta-audit carry-forward path (currently always full re-verification — stricter than the contract, acceptable)
- [ ] Compute handles via the fleet scheduler front door (Nomad)
- [ ] `run_coding_agent` worker tool (claude/codex CLI, design above)
- [ ] Independent different-family audit path (fable-review for the Anthropic
      side; codex CLI as the different-family reviewer)
- [ ] Citation lint (mechanics: cited evidence paths exist; never parses content)
- [ ] Per-call token accounting in the journal (from pi usage events) —
      prerequisite for the evals token gauges and per-role model routing
- [x] Per-role model specs (`provider/model[@thinking]`; providers:
      anthropic, openai, openai-codex (subscription OAuth), claude-cli
      (`claude -p`, subscription-allowance billed). Defaults: workers
      `openai/gpt-5.6-sol@xhigh`; verdict roles `claude-cli/opus`;
      coordinator `anthropic/claude-opus-5@high` — user decisions 2026-07-31)
- [ ] Per-wake model routing and eval-driven per-role tuning (cheap wakes vs
      promotion wakes; cheap critics) — decided by eval evidence
- [ ] Linux write-sandbox backend (bubblewrap/sandbox equivalent)
- [ ] Trigger + contract-adherence evals per `docs/evals.md` (toy campaign
      + fresh-context contract judge); blind A/B reserved for real changes
- [ ] First live campaign; then revisit `docs/skill-feedback.md`

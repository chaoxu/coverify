# Coverify Design

Coverify is a mechanical referee for the `math-proof-search` skill. The
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
EVIDENCE/             revision-suffixed artifacts; identity = filename (harness-written
                      artifacts are append-only; role scratch edits are instructed)
.coverify/journal.jsonl   harness audit metadata (write-only mirror; gates never read it)
```

Gate-authoritative state lives OUTSIDE the campaign directory
(`~/.local/state/coverify/<campaign-id>/gates.jsonl`), so no role's workspace tools can
forge or erase gate records. The campaign id is stored in
`.coverify/campaign-id` (role-write-denied) rather than derived from the
directory's path: identity has to survive a rename, a restore to another
path, or a different mount, because a campaign with intact ledgers and no
gate history would otherwise re-arm the statement freeze on whatever
`STATEMENT.md` now says and lose every recorded FAIL. A campaign that has run
before but whose gate history is missing is refused rather than adopted
(`COVERIFY_ADOPT=1` accepts a new baseline deliberately); the in-tree journal is an audit mirror. Audit,
reconstruction, and comparison records are content-hash-bound (sha256 of the
candidate and of `STATEMENT.md` at verification time) — a file edited after
its PASS is no longer verifier-backed, and a statement edit without
`coverify amend` hard-stops the next run.

## Threat model

Roles are **careless, not adversarial**, and the host is expected to be a
sandbox. Confinement exists to stop the accidents that actually happened or
would silently corrupt a campaign:

1. **Runaway compute** — unsupervised or uncapped search that eats the host
   (a campaign's detached search jobs kernel-panicked saturn on 2026-08-01).
2. **Accidental destruction of campaign state** — a rewrite that erases
   closed-route history, a cited artifact edited in place, a promotion
   recorded without its verification.
3. **Silent contamination of verification** — anything that lets the blind
   reconstruction see the candidate, or a verdict be attributed to work that
   did not happen.

A role deliberately evading these mechanisms is **out of scope**: it holds
model weights and a filesystem, and no in-process check is a security
boundary against it. So findings are ranked by whether a reasonable role
doing its job could trip them, not by whether an attacker could. Where a
mechanism has a known evasion (a survivor that leaves its session and
`exec`s an unrelated binary; a symlink raced between check and use), it is
stated rather than claimed away.

## Workspace tools and confinement

Roles have no general shell. The workspace surface is pi's `read`, `ls`, and
`grep` (read-only) plus pi's `write` wrapped with an in-process scope check.
Code is a gated role, not a default: a `dispatch_technician` packet's `computation` declaration (launcher: "Use computation only for a
preregistered finite domain and stopping rule…") dispatches a *computation technician* — a distinct role whose mathematics is confined to
faithfully encoding the preregistered statement into code; it advances no
proofs and iterates only within the declared domain. Only the technician
gets `run_script` — the sole way any role executes code — and the right to
write non-prose files; reasoners and the coordinator write
`.md`/`.txt` only and never execute anything. Because dispatches are already
async handles, a technician dispatch IS the async computation: no separate
computation-handle machinery is needed for local runs. The dispatch gate
refuses a `computation` field with no concrete bounds and refuses a
technician dispatch on a tool-less CLI oracle backend. Dispatched agents' scope
is their assigned `EVIDENCE/<id>/` directory; the coordinator's is the
campaign dir *except* `.coverify/`, `STATEMENT.md`, and `PROVED.md` (deny
wins). `PROVED.md` is appendable only through the `record_promotion` tool,
which re-checks both verification stages and the content hashes before
writing. Scope checks resolve the *final* path component, so a symlink a
role plants inside its own directory is judged by its target — without that,
a deny-list entry (or the script-path confinement below) is only a naming
convention.

Web access is likewise a gated grant, and it is delegated: a reasoner whose
packet carries a `literature` question gets `literature_search`, which
spawns an external librarian CLI agent (`COVERIFY_LITERATURE_CMD`, default
`agy` print-mode with live web search) through the *same* supervision as
`run_script` — shared wall limit, RSS cap, whole-tree kill, exit reaper,
abort signal — and archives the full compiled report as `literature-<n>.md`
evidence (self-attested provenance, like `fable-review`). That name is
harness-owned: no role may author or edit a `literature-<n>.md`, so a
citation always corresponds to a search that actually ran. The librarian runs under the role's write
sandbox plus a narrow allowance for its own state directories
(`COVERIFY_LITERATURE_STATE_DIRS`, default the `agy`/Gemini dirs) — never
`~/.claude`, `~/.codex`, or `~/.config`, which hold settings and hook files
that execute later and coverify's own OAuth store. No campaign role ever
touches the network itself; `literature` exists only on reasoner packets and `computation` only on
technician packets, so the role that reads the web structurally holds no
code tools; the coordinator and all
verification-cadence roles have neither grant, keeping blind reconstruction
uncontaminated.

`run_script` runs a batch of 1–8 script files (`.py` under python3, or
executables) concurrently by argv — no shell, so detach primitives
(setsid/nohup/disown, tmux -d, screen -dm) are not even expressible. Each script
must additionally resolve inside the role's own write scope, so a host
interpreter (`/bin/sh -c …`, `python3 -c …`) cannot be named as the script
and hand the shell back. Each run is its own process group; the whole batch
shares one time limit and one combined RSS cap (`COVERIFY_RUN_MEM_MB`,
default 4096). At batch end (or when a cap trips) the harness kills the
groups and then sweeps `ps` for survivors — processes still descended from
the batch, sharing its groups, or still running one of its script paths —
because a child that calls `setpgrp()` and is reparented to pid 1 is
invisible to a group kill alone. The sweep matches whole argv tokens naming the batch's own script paths, plus
its working directory when that directory belongs exclusively to the batch (a
dispatched agent's evidence directory) — which is what catches a helper
launched in a new session running a different file there. On a shared
directory (vanilla pi through the extension) the directory is not matched:
killing by it would reap other agents' and tools' processes, so that recall is
given up deliberately. A survivor that
leaves its session *and* `exec`s a binary naming nothing in the workspace
would evade it; the technician is a supervised role, not an adversary, so
that residual is stated rather than claimed away. If `ps` itself fails, the batch is killed and the failure
reported — the cap never silently disappears. The harness also reaps live
batches on `exit`/SIGINT/SIGTERM/SIGHUP and on `cancel_agent`'s abort
signal, so operator Ctrl-C or a crash takes the compute with it instead of
leaving detached groups with no watchdog. The batch is intra-turn concurrency for one
technician; harness-level async computation handles remain the roadmap item.
The scoped write tool additionally enforces ledger integrity: `FAILED.md`
rewrites must preserve the existing content as an unchanged prefix
(launcher: append-only), and `literature-<n>.md` librarian reports are
immutable. Enforcement tests live in `tests/` and run in `bun run check`. Script writes are OS-sandboxed on macOS (`sandbox-exec`,
deny-default writes; reads unrestricted) to the same scope. On non-darwin
platforms the same scope is enforced via `@landstrip/landstrip`
(Landlock + seccomp, deny-default writes and networking); only if the
landstrip binary is missing does confinement degrade to instructed-only,
announced loudly at run start. (A campaign placed under the system
temp tree is inside the sandbox's blanket temp allowance — keep campaigns in
real project directories.) Long or parallel computation goes through the
scheduler front door, per the launcher.

## Runtime shape

```
cli.ts           prove / resume / status / amend / trace
campaign.ts      state layer: init, revisions, append-only evidence, resume bundle
launcher.ts      load + extract the fenced launcher contract (no fallback)
roles.ts         prompt assembly (launcher verbatim + role charge); pi Agent runner
claude-bridge.ts pi-claude-bridge as a pi-ai provider (subscription tool loop)
gates.ts         dispatch gate, idea-gate ledger, two-stage verification, promotion
harness.ts       handle table, event loop, wakes; the only persistent process
trace.ts         journal -> self-contained HTML timeline (read-only observability)
trace-page.ts    that page's markup, styles, and view code
pi-extension.ts  interactive-pi boundary layer: supervised run_script in
                 place of raw bash (phase 3; never writes trusted state)
```

Observability layering (redesign phases 1–3): the **pi session JSONL trees**
under `.coverify/sessions/` are the authoritative per-agent transcripts
(full content, branchable, crash-survivable) and the single transcript
store — per-turn telemetry (sizes/usage/gaps/stopReason) is a pure
function of the stored messages, derived on demand by `coverify turns`
(src/turns.ts, read-only) rather than maintained as a sidecar; the
journal remains the event index. A campaign directory is now openable in
three harnesses: coverify headless, the raw skill in Codex, and interactive
pi with `src/pi-extension.ts` loaded.

- **Coordinator**: resident across wakes — matching how the skill runs in a
  live Codex/Claude Code session — as a durable pi AgentHarness session
  (JSONL tree under `.coverify/sessions/`). At the context cap
  (`COVERIFY_COORDINATOR_CONTEXT_TOKENS`, default ~300k) it **compacts in
  place** — the launcher's anticipated "context compaction", with the
  summary explicitly subordinated to the ledgers and the restart-rule
  reread instruction delivered in the next wake message (kill-and-rebuild
  remains the fallback for non-compactable sessions). Continuing wakes
  receive only new reports + status digest; the full resume bundle is sent
  on (re)build. Sole ledger writer. Decisions must still be externalized to
  the ledgers every wake — residency is continuity of soft context, never a
  substitute for durable state.
- **Reasoners and technicians**: fresh AgentHarness sessions (durable JSONL
  transcripts, session id = handle id = prompt_cache_key); packet in, finite deliverable out;
  write access only to assigned `EVIDENCE/` paths.
- **Verifiers**: the stage-1 hostile auditor, bundle certifier, stage-2
  blind reconstructor, and comparator are fresh instances; the harness
  withholds the candidate from the reconstructor (platform-enforced), while
  the keyIdeas/allowedSources bundle is coordinator-authored and gated by
  certification (see honesty ledger). The journal records supplied inputs,
  visibility, and model family per call.
- **Durability is at settle, not at harvest**: when a dispatch's promise
  settles, its report is written to `EVIDENCE/<id>/report.rN.md` and its
  completion journaled immediately; the settled queue then carries only a
  pointer for delivery to the coordinator. Three defects (pause, the
  wake-limit exit, the declaration return) each lost finished work because an
  exit path skipped a harvest step — with the write at settle time, no exit
  path can lose a report. A report that arrives after `cancel_agent` is still
  written, journaled as a late artifact rather than a second completion.
- **Handles are the async primitive**: worker/technician dispatches and
  verification cadences are handles in one table; completions wake the
  coordinator — no polling. Gate critics run synchronously inside the
  coordinator's tool call (single-shot verdicts, short).

## Conformance table

| Mechanical enforcement (code) | Launcher clause |
| --- | --- |
| `STATEMENT.md` written once; new revision only via explicit user amendment; completion evidence invalidated | "Fix its revision before search; only an explicit user amendment may replace it…" |
| Campaign file set; harness-written evidence is revision-suffixed (`newEvidencePath`), and `FAILED.md` prefix-append plus `literature-*.md` immutability are enforced. Other in-place edits under `EVIDENCE/` are contract-instructed, not blocked — a role can still overwrite its own scratch artifact | "Durable campaign state" bullets |
| Dispatched agents get no ledger-write capability; only assigned evidence paths | "The coordinator is the sole ledger writer; workers… write only assigned evidence artifacts" |
| Resume bundle = STATEMENT + FRONTIER + full REGISTRY.md + full PROCESS_LESSONS.md, launcher embedded verbatim in the system prompt (never FAILED.md, PROVED.md, or EVIDENCE/ wholesale) — supplied on every coordinator (re)build **and re-supplied on the wake after every in-place compaction**, so both halves of the clause are enforced, not instructed | "After restart or context compaction, reread…" |
| Claim-label vocabulary quoted verbatim into the ledger templates at init; label discipline and weakest-premise inheritance are contract-instructed model judgment | "Claim labels — literal, never inflated" |
| Dispatch schema requires the FAILED.md check field (`no close prior route` / `closest is X; differs because…`) | "Before every route, materially changed retry, or variant, check `FAILED.md`…" |
| Worker packet schema requires a finite mathematical deliverable; the deliverable-or-precise-gap report form is charged in the role prompt, not parsed | "Every exploration agent must return a proved lemma, explicit construction, counterexample/certificate, or a precise failing implication" |
| No harness timeouts on proof/audit/reconstruction work (the per-run_script batch cap is surfaced in the tool description and env-tunable) | "Do not impose a coordinator-created elapsed-time limit…" |
| Code tools (`run_script` + non-prose writes) exist only on a technician dispatched with a computation declaration with concrete bounds; dispatch gate refuses thin declarations; coordinator is prose-only; the dispatch returns the REGISTRY.md launch record (workload, limits, output paths, cancellation) | "Use computation only for a preregistered finite domain and stopping rule yielding a small witness, certificate, or table." / "Never run unsupervised detached compute." |
| Wave gate: a second **concurrent** worker on a mechanism requires `IDEA PASS` on file; sequential retries get an advisory reminder, not a refusal (that judgment is the coordinator's); single first-wave scouts exempt | "Do not allow recursive subagent fan-out or a large route wave before the parent mechanism receives `IDEA PASS`…" |
| Verification = stage 1 (fresh hostile audit) then stage 2: bundle certification (fresh agent sees candidate + bundle; leaky bundle refused, same-bundle retry hash-blocked) → blind reconstruction (no verdict) → fresh comparison carrying stage 2's verdict with the contract's match semantics; all outputs saved as citable EVIDENCE artifacts, hash-bound; a reusable reconstruction is bound to the candidate hash as well as its own artifact hash, so a repaired candidate always gets a fresh one | "Verification cadence" 1–2 (2026-07-31 revision): bundle certification, "a fresh comparison agent…", explicit PASS/mismatch semantics |
| Anti-verdict-shopping: a substantive audit/comparison FAIL blocks re-verification of that content — matched by candidate hash, so copying the bytes to a new filename inherits the FAIL — unless a recorded rebuttal artifact is supplied; every attempt stays on record | "A substantive FAIL from any stage stands… Do not rerun a failed stage on an unchanged revision in search of a PASS" |
| Any content change ⇒ every stage reruns, reconstruction included: the contract says a load-bearing repair must "rerun a fresh hostile audit and then a fresh reconstruction. Never reuse a verifier response that influenced the repair", and the comparator's FAIL is quoted into the wake that prompts the repair. Reuse is limited to a re-run on the byte-identical candidate (a protocol or infrastructure failure). Carrying stages forward for a certified non-load-bearing diff is legal but needs a fresh delta auditor's PASS, which is not built (roadmap) | Revision-impact rules |
| `record_promotion` is the sole writer of `PROVED.md` (direct writes OS-denied); legal only when both stage records exist for the exact revision with matching content hashes; entry carries dependency identities, audit-artifact citations, and the verified candidate's content hash. The promoted statement text itself is coordinator-authored and not machine-checked against the candidate — see the honesty ledger | "Promotion records the revision and dependency identities plus every audit…" |
| Campaign ends only by explicit `declare_campaign_state`; "complete" refused with zero promotions on record; an idle wake gets a nudge, and 3 consecutive no-op wakes trigger an operational *pause* (never a completion) as spend protection | "Do not mark it complete until the final result passes the full cadence…"; "Failed attempts… are not permission to return"; "Pause is operational state" (pause stops further wakes; live agents are not force-aborted — use cancel_agent) |
| Harvest before judgment: worker reports are saved to EVIDENCE/ and completion-recorded before any model sees them; checkpoint ordering itself is contract-instructed, not enforced (struck as over-constraint — see review record) | "Checkpoint and learning loop" |
| Campaign loop persists across restarts until user stop or completion; `declare_campaign_state` interrupts live agents and cancels their computations unless `continueSupervised` is set (the contract's "explicitly authorized to continue under supervision"), then stops after the wake | "The initial resolution request remains authorization…" |
| Journal records each audit's supplied inputs, visibility, model family, and instructed-vs-platform-enforced restrictions | "Every audit records the supplied inputs, workspace/tool visibility, model-family provenance…" |
| No agent-count ceiling; budget gate enforces only user/workspace/runtime limits | "Do not impose a fixed agent-count ceiling… scaling to available concurrency and any explicit user, workspace, or runtime limits" |

Judgment stays with models: route selection, packet composition, inline
derivations when the coordinator judges them cheaper than a packet, gate and
audit verdicts, struggle rulings, promotion decisions, lesson content, and
whether a sequential retry constitutes a "follow-up wave" needing the gate.
Mechanics-only (rule 2): handle table, event-driven wakes with ambient status
digests, journal, out-of-tree gate store, write sandbox, verdict-line parsing,
version stamps, and the user message inbox (`coverify say` →
`.coverify/inbox.jsonl`): verbatim transport of user guidance — steered
into the coordinator's running turn (a ~1s inbox watcher over session
`steer`), else delivered at the next wake; the headless analog of typing
to an interactive skill session. The inbox lives under `.coverify/`, which
every role's write scope denies, so a role cannot forge user guidance;
delivery is journaled and at-least-once (a message steered into a turn
that then fails redelivers at the next wake), and a statement change still
requires `coverify amend` (the delivered block says so).

**Honesty ledger** (launcher: record instructed-vs-platform-enforced): the
candidate withheld from the reconstructor and all write confinement are
platform-enforced (macOS); the bundle (`keyIdeas`/`allowedSources`) is
coordinator-authored but now passes a mandatory certification by a fresh
agent before stage 2 runs (contract-required; the certification itself is
model judgment, recorded as such); `declaredDependencies` remains
instructed-only, mitigated by giving the stage-1 auditor PROVED.md. The
promoted statement text in `record_promotion` is likewise coordinator-
authored and unverifiable by the harness — nothing mechanically checks that
it is what the candidate proves, so PROVED.md entries carry the verified
revision and its content hash and an over-claim is auditable against that
exact artifact, not prevented. Re-verification after a substantive FAIL
requires a rebuttal artifact to exist, but its content is never read or
shown to a verifier; the anti-shopping property is that every attempt stays
on record and the latest verdict per stage decides, not that a determined
coordinator cannot resample.
Non-darwin platforms: write confinement OS-enforced via landstrip
(Landlock + seccomp), degrading loudly to instructed-only when the binary
is absent. `claude-cli/*`
verdict roles run as `claude -p` subprocesses: fresh process per call, run
in an empty temp directory, but the CLI carries its own tools (file read,
web search) — their isolation is instructed-only, and the journal's
modelFamily field discloses the backend per call. A `claude-bridge`
coordinator runs its tool loop through the Claude Agent SDK
(pi-claude-bridge): the bridge starts Claude Code with built-in tools
disabled and strict MCP config, so the model's whole tool surface is
coverify's own (workspace + gate tools) — confinement is unchanged,
though tool-disablement there is SDK-flag-enforced rather than
OS-enforced. Concurrent bridge sessions cross-contaminate (observed in
testing), so claude-bridge is coordinator-only, refused at preflight for
every other role.

## Efficiency commitments

Verify at trust boundaries (promotions, resolution claims), not per
micro-fact; gate before the wave; finite deliverables, never clocks; the
FAILED/REGISTRY indexes stop re-funding dead routes; budgets enforced at
dispatch; every role instance is fresh — workers get one packet each, and
fresh instances are mandatory where they buy trust (critics, verifiers).

## Observability

`coverify trace [--dir campaign] [--out file.html]` renders the campaign
journal as a self-contained HTML timeline: agent lifetimes as ranges,
verification and gate verdicts as points, coordinator wakes as bands, plus
summary tiles and a table view. The widget is vis-timeline, vendored and
inlined at render time, so a trace opens offline and under a strict CSP.
Clicking any bar or mark opens an inspector showing the whole record: the
packet the agent was given (task, deliverable, context, FAILED.md check, and
the computation or literature declaration), its model, evidence directory,
and its report inlined. A trace can only show what the journal recorded, so
dispatches now journal the full packet; fields a campaign predates are
labelled "not recorded by the harness revision that ran this campaign"
rather than rendered blank.

The page leads with its own view — summary tiles, the timeline, the table —
because that is the monitoring read: campaign-shaped, instant, offline. A
Perfetto deep-dive surface (embedded ui.perfetto.dev + `--format perfetto`
export) existed briefly and was removed 2026-08-02: campaign traces are
dozens of events at minute granularity, and the offline timeline answers
them. The trace is not a second state system: it is a projection of the
journal.

Both are read-only by construction — they consume harness audit metadata and
write one file under `.coverify/`, never campaign state, so they cannot
change campaign semantics (rule 2). They also work on a live campaign;
in-flight dispatches simply show as "no completion recorded".

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

**Honesty notes from the 2026-08-02 runtime-migration review:** (1) the
compaction summary is produced by pi's generic summarizer
(`SUMMARIZATION_SYSTEM_PROMPT`), a distinct stateless utility call outside
the contract; it enters the coordinator's context as soft user-role text
with a fixed ~20k-token verbatim tail, is billed at the coordinator's model
and thinking level, its spend is counted into the usage journal via the
compaction entry, and the ledgers remain authoritative (re-supplied in the
next wake). (2) Session JSONL trees under `.coverify/sessions/` are full
transcripts on disk; reads are unrestricted by design, so any role could in
principle read another's transcript (threat-model item 3 class; same
exposure class as world-readable EVIDENCE/, blind roles remain toolless).
(3) Prompt purity of harness sessions is by construction — AgentHarness
uses the `systemPrompt` string verbatim with no hooks registered and empty
resources — verified against pi source at 0.83.0; re-verify on pi upgrades.

## Review record

Before the first campaign, the design and code were adversarially reviewed by
two independent strong agents (2026-07-31): an over-constraint audit (found:
invented wave-gate threshold, invented exit condition, invented "no inline
proof work" rule, stage-2 verdict predicate error, reconstructor starved of
allowed sources — all fixed) and an under-hardening audit (found: gate state
forgeable via role workspace tools, promotion advisory-only, evidence/statement TOCTOU,
spoofable verdict regex, missing comparison step, resume id collisions — all
fixed except items noted "acceptable for now" in the audits: key-idea
paraphrase risk and idea-gate mechanism-string keying remain model judgment,
recorded honestly). Git auto-commit of campaigns was reviewed and **rejected**
as a second versioning system; git remains a user convention. Mechanical
checkpoint-ordering enforcement and coordinator-cache machinery were struck
from the roadmap as over-constraint waiting to happen.

**Uniformity review (2026-08-02, three independent agents: altitude,
conformance, implementation-shape).** A proposed "role-call descriptor +
uniform runner" framework for the six single-shot roles was **rejected**: the
three roles outside `verdictStage` differ in control flow and record schema,
not parameters (gate: no artifact, 3-token contract, async handle, `gate:`
mechanism prefix; reconstructor: no verdict by repaired design, content-bound
carry-forward; CLI oracle: worker-journaled), so discriminators would exceed
the ~50 duplicated lines; the implementation review catalogued 16 hidden
couplings, the worst being that the `bundle` string's bytes key both the
leaky-bundle refusal and reconstruction carry-forward. Unified verdict-token
vocabularies were rejected (merging would let `IDEA PASS` satisfy a cadence
stage). **Adopted in narrowed form:** (1) cadence prompts and their
`suppliedInputs` derive from one section list (they can no longer drift;
`blindness` stays hand-authored — it carries enforcement-modality and
content-provenance claims a section list cannot express, and the
carry-forward record keeps its hand-written provenance since no prompt
exists); (2) an unparseable verdict reply is recorded `UNPARSEABLE`, never
`FAIL` — a protocol failure must not arm anti-verdict-shopping nor
permanently hash-block a legitimate bundle (previously a garbled certifier
reply was a permanent trap); (3) a `toolVisibility` journal field on
verification records (the launcher's previously-unrecorded honesty limb —
CLI backends may expose their own tools, instructed-only); (4) reconstruction
blindness is platform-enforced: `assertCandidateWithheld` refuses a rendered
reconstructor prompt containing the candidate text (tests/blindness.test.ts),
upgrading the journal's "(enforced)" from testimony to checked fact; (5) the
user `--agent-limit` counts workers (r*/t*) only — judge handles (g*/v*)
no longer consume the workers' budget.

## Planned capability: CLI coding agents (design reserved, not built)

Workers will be able to run coding experiments through the subscription
harnesses directly — `claude -p` / `codex exec` — via a harness-provided
`run_coding_agent` tool. Shape decided in advance so nothing has to move:

- The harness spawns the CLI as a supervised child process (never through the
  worker's sandboxed tools, which would block the CLI's own state writes),
  cwd'd to an experiment directory inside the worker's `EVIDENCE/<id>/`;
  output is saved as an evidence artifact; the journal records the model
  family and that provenance is self-attested — the exact pattern
  `fable-review` already uses.
- Base commands are configurable (`COVERIFY_CLAUDE_CMD` / `COVERIFY_CODEX_CMD`)
  so flag drift in the CLIs never requires a harness release.
- Bonus this unlocks: `codex` is a demonstrably different model family, so
  the launcher's independent different-family audit can run on subscription
  rather than API pricing; `fable-review` (file-path interface: CANDIDATE
  STATEMENT DEPENDENCIES EVIDENCE_DIR) plugs into the EVIDENCE layout as-is
  for the Anthropic-side outside review.

**Schema-forced role returns** (omp's typed subagent yields) were considered
2026-08-02 and **rejected on measurement**. The parsing they would replace is
`parseFirstLineVerdict`: 11 lines, two call sites, and an
UNPARSEABLE-not-FAIL failure mode that already recovers by re-running. Across
the first long campaign it misfired zero times in ~109 verdicts (73 artifacts,
every verdict line exact; the journal records no UNPARSEABLE). Forcing schemas
means a submit-tool per role, `RoleResult` becoming a union through every
dispatch site, and a retry-exhaustion policy — while the CLI-oracle roles
(critic, certifier, reconstructor, comparator, hostile auditor) have no tool
loop, so the parser stays anyway and we maintain two verdict paths. Revisit on
evidence: a single UNPARSEABLE in a journal, or a campaign where the
coordinator repeatedly bounces workers for status-report output. The second is
currently unmeasurable — coordinator rejections are not journaled — which is
the cheaper thing to fix first.

## Status / roadmap

- [x] Launcher loading with no-fallback rule; conformance token check (`bun run check`)
- [x] Campaign state layer in the skill's format; append-only evidence
- [x] Role prompts embedding the launcher verbatim
- [x] Dispatch gate (FAILED-check field, concurrent wave gate, user limits)
- [x] Four-call verification cadence (audit / bundle certification / blind reconstruction / comparison), hash-bound, artifacts in EVIDENCE
- [x] `record_promotion` as sole PROVED.md writer; OS write sandbox (macOS)
- [x] Out-of-tree gate store; statement freeze + `coverify amend`; run version stamps
- [ ] Retraction bookkeeping helper (registry relabel + dependent demotion)
- [x] Verification runs async as a handle (was: synchronous inside the
      coordinator's tool call, blocking all gating/dispatch for the length of
      a blind reconstruction — observed 27 min in a live campaign)
- [x] Reconstruction carry-forward: when statement + bundle + promoted
      premises are byte-identical to a prior run's inputs, the blind
      reconstruction is reused (it never sees the candidate, so a candidate
      repair cannot invalidate it); audit, bundle-cert, and comparison always
      rerun since they see the candidate. Cuts clerical-repair re-cadence
      cost by the reconstruction (the dominant step)
- [x] No unsupervised detached compute (launcher: "Never run unsupervised
      detached compute."): roles have no shell at all — file work goes
      through read/ls/grep/scoped-write, execution only through
      `run_script` (argv-only, process-group kill on exit/timeout, RSS cap)
      — added 2026-08-01 after detached `setsid nohup python3` search jobs
      from a live campaign memory-exhausted saturn into a kernel panic
- [ ] Compute handles via the fleet scheduler front door (Nomad)
- [ ] `run_coding_agent` worker tool (claude/codex CLI, design above)
- [ ] Independent different-family audit path (fable-review for the Anthropic
      side; codex CLI as the different-family reviewer)
- [ ] Citation lint (mechanics: cited evidence paths exist; never parses content)
- [x] Per-call token accounting in the journal (provider-reported usage on
      completions, verification records, gate verdicts; cumulative per-wake
      coordinator entry; claude-cli/codex-cli parse usage from JSON output,
      only chatgpt-cli and env-overridden templates without JSON output
      report none) — unblocks the evals
      token gauges
- [x] Per-role model specs (`provider/model[@thinking]`; providers:
      anthropic, openai, openai-codex (subscription OAuth), google,
      claude-bridge (Agent SDK tool loop, coordinator-only), claude-cli
      (`claude -p`), codex-cli, chatgpt-cli. Defaults all subscription
      billed: coordinator and workers `openai-codex/gpt-5.6-sol@max`
      (tooled Sol agents, ChatGPT-subscription OAuth); verdict roles
      `codex-cli/gpt-5.6-sol` except the hostile auditor on
      `claude-cli/opus` — user decision 2026-08-01; the audit stage is
      still cross-family out of the box)
- [ ] Per-wake model routing and eval-driven per-role tuning (cheap wakes vs
      promotion wakes; cheap critics) — decided by eval evidence
- [x] Linux write-sandbox backend: @landstrip/landstrip (Landlock+seccomp;
      deny-default network for scripts on all platforms' landstrip path;
      loud instructed-only fallback when the binary is absent — pending
      first-run validation on a Linux fleet host)
- [ ] Trigger + contract-adherence evals per `docs/evals.md` (toy campaign
      + fresh-context contract judge); blind A/B reserved for real changes
- [ ] First live campaign; then revisit `docs/skill-feedback.md`

# Redesign proposal: pi harness below the waterline

Status: accepted 2026-08-02 (Chao: "reimplement everything using what
you've learned"); layer amended same day after an exact API-mapping pass —
**`AgentHarness` + `JsonlSessionRepo` (pi-agent-core), not
`createAgentSession` (pi-coding-agent)**. The SDK layer cannot produce a
byte-exact system prompt (buildSystemPrompt unconditionally appends a cwd
line; purity needs an inline-extension hook), requires re-deriving model
routing inside a private-constructor ModelRuntime, and needs
AgentTool→ToolDefinition conversion via a non-exported adapter — while
AgentHarness takes systemPrompt verbatim, `models: Models` (our
createModels({credentials}) instance) directly, plain AgentTool[]s, and
performs zero disk/env discovery. Trade: manual compaction policy
(~30 lines over pi's exported shouldCompact/estimateContextTokens/
prepareCompaction) and our own retry orchestration (pi-ai's
retryAssistantCall). prompt_cache_key auto-threads from the session id.
Evidence base: the 2026-08-01/02 live-campaign findings and the two-agent pi
review (source inventory + ecosystem survey); see design.md review record.

## The decision in one line

Coverify's per-agent runtime becomes pi's (`createAgentSession` /
`AgentHarness`); coverify keeps everything above the session boundary —
fleet event loop, gates authority, verification cadence, ledgers, CLI
verdict backends — and ships its tools in pi's extension format at the
boundary.

## Why (the argument from two days of operations)

Hand-rolling the runtime layer cost us, concretely: an unused cache
identity pi already supported (~3× billed input for two days, measured 0%
→ 79% hit rate on fixing), four scouts dead to an upstream-documented
failure mode (~2.6M tokens to relearn a tracker entry), an over-counting
context estimator firing the coordinator cap early, and a redundant
stream wrapper built the same morning its native equivalent sat unused.
Best practices accumulate in a maintained runtime at the rate of its
community's pain; in a bespoke runtime at the rate of ours. The zone where
this bites is exactly the zone pi covers: context, caching, retries,
sessions, provider quirks. The zone pi cannot cover — trust machinery —
has no upstream to fall behind.

## Why the SDK layer and not the extension layer

Running coverify as an extension *inside* the pi coding agent fails one
non-negotiable: prompt purity. Role prompts must be exactly
launcher-contract + charge (design.md rule 1); the coding agent's own
prompt frame would leak into every role. The SDK inverts ownership:
coverify keeps `main()` and the prompts; pi supplies the machinery.

Verified enablers (pi-coding-agent 0.83.0, in our lockfile today):

- `DefaultResourceLoader({ systemPrompt })` / `systemPromptOverride:
  (base) => string` — full system-prompt replacement, base ignorable.
- `createAgentSession({ noTools: "all", customTools })` — empty default
  tool surface; only our tools exist.
- `sessionManager` pluggable → session trees under `.coverify/sessions/`.
- `modelRuntime` pluggable → our credential store and per-role routing
  stay authoritative (not `~/.pi/agent/auth.json`).
- `AgentHarness` hooks: `before_provider_request` (stream-option patching),
  `tool_call` (blockable — central write-confinement choke point),
  `after_provider_response`, retry policies, compaction with
  turn-boundary cut points and retained tail.

## What moves, what stays

| Current (ours) | Target |
| --- | --- |
| `createRoleSession` (Agent + wrapper) | `createAgentSession` per agent; prompts via resourceLoader |
| Cap-kill coordinator rebuild | pi compaction + a compaction-boundary message enforcing the launcher's reread rule ("after restart or context compaction, reread…") — contract-anticipated, arguably more faithful than cap-kill |
| turns sidecars (`.coverify/turns/`) | derived view over pi session JSONL (full transcripts, branchable, resumable); keep the extractor for CLI single-shots |
| in-memory coordinator state | durable session tree; crash-survivable mid-conversation |
| ad-hoc error handling in salvage path | `retryAssistantCall` + `isContextOverflow` + `followUp()` |
| 50k char output slice | `truncateTail` (structured, line-safe) |

| Stays ours, unchanged | Why |
| --- | --- |
| Fleet event loop, handle table, wakes, no-op pause | pi is single-agent; this is the application |
| gates.jsonl out-of-tree authority; statement freeze; append-only evidence | trust machinery, no upstream exists |
| Verification cadence, anti-verdict-shopping, blindness assertion | same |
| CLI verdict backends (claude-cli / codex-cli / chatgpt-cli) | subprocess single-shots; AgentHarness irrelevant |
| sandbox-exec write confinement + process-group supervisor with RSS caps | strictly stronger than pi's bash; inject via tool impl (or pi bash `prepare` + a standalone supervisor shim) |
| Charges, launcher embedding, conformance checks | rule 1 |

## Phases (each independently shippable, tested against a live campaign)

1. **Workers on the SDK.** Reasoners/technicians become `createAgentSession`
   instances (noTools:"all" + our tools, our prompts, sessions on disk).
   Acceptance: a campaign runs end-to-end; session files replace worker
   turns sidecars; conformance suite green; a runtime assertion checks
   `session.systemPrompt === contract+charge` (prompt purity as a test,
   not a hope).
2. **Coordinator on the SDK with compaction.** Configure compaction
   settings; inject the reread-rule message at the compaction boundary;
   retire `COORDINATOR_CONTEXT_TOKENS` cap-kill (keep as env fallback one
   release). Acceptance: a forced-compaction campaign segment shows the
   coordinator re-orienting from ledgers per contract; crash + resume
   restores the session mid-conversation.
3. **Boundary packaging.** Publish the supervisor + campaign tools in pi
   extension format (Pi Packages), so (a) interactive pi can open a
   campaign dir with a coverify extension for manual inspection, and
   (b) the community hardens our supervisor instead of it aging alone.

## Risks and their controls

- **pi version drift / breaking changes** — pin exact versions; adopt the
  faux provider for deterministic loop tests; monthly upstream review
  (release notes + issue tracker — today's survey harvested five
  applicable findings in one pass; institutionalize it).
- **Coding-agent defaults leaking** (settings, skills discovery,
  tool-prompt snippets) — phase-1 runtime assertion on the exact system
  prompt; `noTools:"all"`; explicit settings/resource loaders, never
  defaults.
- **Compaction vs "files are memory"** — the summarization prompt must
  subordinate itself to the ledgers ("the ledgers are authoritative; this
  summary is soft context"); the reread rule fires at every boundary.
  If live behavior shows summary-trusting drift, fall back to cap-kill
  (both remain contract-conformant compaction analogs).
- **Session transcripts on disk** — full content, readable by
  unrestricted role reads. Assessment: candidates/ledgers are already
  readable; blind roles are toolless; keep sessions under `.coverify/`
  (coordinator write-denied) and note in the honesty ledger.
- **cacheWrite is hardcoded 0 upstream (#6469)** — never use it in cost
  math; costUSD comes from pi pricing which accounts for this.

## Explicitly rejected alternatives

- Coverify as a pi coding-agent extension (prompt purity; lifecycle
  ownership).
- Continuing to grow the bespoke runtime (the two-day evidence above; and
  the 2026-08-02 uniformity review already rejected framework-izing it).
- A hard fork of pi (oh-my-pi-style): maximum control, zero upstream flow
  — the exact failure mode this proposal exists to end.

## Follow-ups once decided

- Monthly pi-upstream review routine (release notes, issues touching
  Responses/caching/reasoning; file findings to skill-feedback/design.md).
- Check pinned pi for GPT-5.6 `prompt_cache_options {ttl:"30m"}` support
  (#6529) — tailor-made for slow reasoning turns.
- Verify claude-bridge forwards `cacheRetention`/`sessionId` if the
  coordinator ever returns to it; `cacheRetention:"long"` for any role on
  the plain anthropic provider.

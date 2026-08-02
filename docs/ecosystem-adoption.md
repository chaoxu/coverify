# Ecosystem adoption ledger

Buy-over-build decisions, source-verified (six deep-dive reviews,
2026-08-02; packages inspected from published tarballs, never installed).
Standing rule: before writing anything ourselves, this ledger must show the
named alternative was evaluated and why it lost. Re-check entries at the
monthly upstream review.

## Adopt / borrow — ordered by value

| What | From | Decision | Status |
| --- | --- | --- | --- |
| **Linux write sandbox + network deny-default** | `@landstrip/landstrip` (standalone Rust CLI; Landlock+seccomp on Linux, Seatbelt on macOS, policy JSON ≈ our WriteScope verbatim; access-time glob denies cover the not-yet-existing-file case) | **Adopt the core binary** as the non-darwin backend inside `sandboxedArgv`, and gain script-network confinement on both platforms. Do NOT adopt the `pi-landstrip` extension (TUI-coupled; no wall/RSS caps, no survivor sweep, 1s settle — our supervision stays on top). Rollout gate: `landstrip doctor` on mars/aegir/tylos; fail-loud to instructed-only. Closes the design.md Linux-sandbox roadmap item. | roadmap (next implementation slot) |
| **Tee-before-truncate in run_script** | hypa's pattern (`@hypabolic/pi-hypa` itself ignored — .NET dep) | Full output saved to the role's dir before slicing; marker names the file. Our one silent-loss point. | **landed 2026-08-02** |
| **Quota-pause with reset-hint + capped auto-resume** | `@quintinshaw/pi-dynamic-workflows` `usage-limit-scheduler.ts` (routing/tier machinery ignored) | New operational pause cause: provider quota error → pause with the verbatim reset hint journaled → scheduler resumes after parsed delay (floor 1m, ceiling 6h, attempt cap). Fits "pause is operational state"; replaces the human model-swap scramble. | roadmap |
| **Crash-resume discipline** | `@vigolium/piolium` (package ignored — fixed security-audit phases) | The pattern: idempotent re-entry, each step self-skips on recorded-status ∧ artifact-gate ∧ input-hash — no event replay. Plus verbatim tricks: corrupt-state rename-aside; in_progress outranks failed on resume choice. Composes with our hash-bound records; resolves the deferred two-transcript/crash-resume question in favor of landing resume. | roadmap (deferred item, now with a design) |
| **`coverify search` subcommand** | borrow from `pi-hermes-memory` (package inseparable from a memory product we contractually refuse; drops toolResult/thinking — the content we need most) | FTS5 external-content schema + trigger sync, FTS→NL→LIKE degradation ladder, size/mtime incremental backfill, anchor search returning path:line-ranges, `SECRET_PATTERNS` seed. ~200–300 lines over our own session format via `bun:sqlite`; we index what hermes can't (toolResults, thinking, tool inputs, branch/worker ids). | roadmap |
| **OTel emitter (optional)** | schema + Grafana dashboard from `pi-otel-telemetry` (package stale, old-namespace, extension-coupled); subscriber pattern proven by `@raindrop-ai/pi-agent` | ~150 lines: `AgentHarness.subscribe` → OTLP → Tempo/Grafana on jupiter. Lab-internal, no SaaS. Composes with trace/turns, replaces nothing. | optional |
| **Evals methodology** | omp.sh `snapcompact` (recall-vs-billed-tokens eval method); `metaharness` (experiment→run→trace store template); Braintrust (the only real experiments/datasets product) | Borrow the methods into the campaign-evals design. Braintrust is the candidate iff a hosted evals workbench is ever wanted (~300-line ExtensionAPI shim; self-hosting enterprise-gated). Core arbiter stays ours: fresh-context judges over campaign folders — no trace platform can be the judge, and all pi-side tracers are blind to CLI-backed verdict roles. | design input |
| **Librarian re-platform candidate** | `pi-web-access` (tools are plain AgentTool-shaped; headless `workflow:"none"`; OpenAI search rides the Codex OAuth we already hold — no new keys) | Would upgrade provenance (per-call search/fetch journaling vs agy's single self-attested report) at the cost of vendoring a fast-moving 7k-line surface and re-auditing its network paths (incl. a GitHub-clone-to-disk path) under our sandbox. Decide by live A/B against `agy`. | hold — A/B when convenient |
| **Attempt-linked promotions** | `@danypops/papyrus` "evidence-bearing tasks" (architecture ignored — a daemon graph store is the second proof-state system we refuse) | Marginal borrow: an `attemptId` tying a promotion record to the exact verification attempts that justified it. The journal nearly has this. | nice-to-have |

## Ignore — with the disqualifier on record

| Package | Why not |
| --- | --- |
| omp.sh / oh-my-pi (the fork runtime) | Hard fork at v17 vs upstream 0.83; same-named packages, diverged formats; adopting forfeits upstream tracking — the exact failure mode the redesign ended. Mine it (snapcompact/omp-stats/pi-iso ideas), never merge it. |
| `pi-landstrip` (the extension) | TUI/interactive-escalation model wrong for a headless contract harness; supervision far weaker than ours. |
| `context-mode` | MCP-coupled; its core technique (code-against-data) is already our technician role in stronger, preregistered form. |
| `pi-rtk-optimizer` | Lossy by design (own README: full output not preserved) — disqualifying where an auditor must outright-check content. The anti-pattern to remember. |
| `@tangle-network/tcloud-agent` | Headline cap is wall-clock — forbidden on proof work; USD accounting weaker than our journal. |
| `pi-memory`, `open-zk-kb`, `pi-mnemopi` | Agent-memory products; the launcher's ledgers are our memory. A second memory store is a second proof-state system. |
| Subagent orchestrators (`pi-subagents` ×2, `pi-crew`, `pi-orchestrator`, …) | Our fleet layer is launcher-bound and more specific; vocabulary noted (asyncDependency joins, review gates), machinery redundant. |
| `@gotgenes/pi-permission-system` | In-process permissions; ours is OS-enforced. |
| CoW-clone isolation (omp `pi-iso`) | Not a sandbox (reflink/overlayfs clone-and-diff). Recorded as plan B for technician isolation if Landlock proves unavailable somewhere. |

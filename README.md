# Coverify

Coverify 2.0 is a math proof-search campaign engine: the `math-proof-search`
skill's launcher contract, compiled onto pi (`@earendil-works/pi-agent-core`).
The skill is the spec; coverify is a mechanical referee for it. It adds no
mathematical policy of its own — its edge over running the skill in a frontier
harness is that the rules that matter are enforced in code and cannot drift.

A project is a folder. There is no server, no worker daemon, no deploy
pipeline, and no Cosheaf. The campaign directory uses the launcher's exact
file layout (`STATEMENT.md`, `CURRENT_FRONTIER.md`, `REGISTRY.md`,
`FAILED.md`, `PROVED.md`, `PROCESS_LESSONS.md`, `EVIDENCE/`), so a Claude Code or
Codex session running the skill can resume a coverify campaign and vice versa.

## Use

```bash
bun install

export ANTHROPIC_API_KEY=...   # fleet: fleet-secret get <app>/<name>
bun run src/cli.ts prove "Exact statement to resolve." --dir campaign
bun run src/cli.ts status --dir campaign
bun run src/cli.ts resume --dir campaign
bun run src/cli.ts amend --dir campaign    # accept an explicit user amendment of STATEMENT.md
```

Optional user limits (the harness imposes none of its own): `--agent-limit N`
(concurrent workers), `--max-wakes N` (pause after N coordinator wakes).

**Models are per-role.** Specs are `provider/model[@thinking]` (providers:
`anthropic`, `openai`, `openai-codex`, `google` — Gemini via
`GEMINI_API_KEY` — `claude-cli`, and `codex-cli` (alias `chatgpt-cli`): the
official `codex exec` CLI, ChatGPT-subscription billed, read-only sandbox,
for verdict roles when the subscription has headroom. Defaults: the coordinator and
workers run `openai/gpt-5.6-sol@xhigh` (GPT-5.6 Sol high-effort "Ultra");
the five single-shot verdict roles (critic, auditor, certifier,
reconstructor, comparator) run `claude-cli/opus` — the official `claude -p`
CLI, the one path that bills the Claude **subscription allowance**. Every
verification is therefore cross-family from both producers (GPT coordinator
and workers vs Claude verifiers). Override globally with
`COVERIFY_MODEL` or per role with
`COVERIFY_MODEL_{COORDINATOR,WORKER,CRITIC,AUDITOR,CERTIFIER,RECONSTRUCTOR,COMPARATOR}`.
`COVERIFY_CLAUDE_CMD` overrides the CLI base command (default `claude -p`).
Auth per provider: env API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`),
the `claude` binary for `claude-cli/*` roles (whatever `claude` is logged in
as), or OAuth via `coverify login anthropic|openai-codex`
(`~/.config/coverify/auth.json`, auto-refresh). **Billing caution:**
third-party OAuth against Anthropic reportedly draws Extra Credits, not the
subscription allowance — only the official `claude` CLI is guaranteed
subscription-billed, which is why the verdict roles default to `claude-cli`.
`prove`/`resume` preflight that every configured role's provider has usable
auth. With three families available, verification diversity is one env var —
the current trial candidate is cheap Gemini flash for
review/reconstruction: `COVERIFY_MODEL_RECONSTRUCTOR=google/gemini-3.6-flash`
(GPT produces, Gemini reconstructs blind, Claude audits and compares);
whether flash-tier is good enough is a layer-2 eval question.
`COVERIFY_CLAUDE_CMD`/`COVERIFY_CODEX_CMD` override the CLI templates
({model}/{out} substituted). A pleasant side effect of the
default split: GPT-produced candidates are verified by Anthropic-family
auditors — stage verification is cross-family out of the box, and the
journal records the family per call.

The launcher contract is read at runtime from
`~/kb/notes/agents/prompts/prompt-math-proof-search-launcher.md`
(`COVERIFY_LAUNCHER_PATH` to override). If it is missing, coverify stops —
it never falls back to a remembered version of the contract.

Invocation from another harness is the same CLI: a Codex or Claude Code
session treats `coverify` as an ordinary tool and reads the campaign files.

## How it works

The harness (TypeScript, the only persistent process) owns the scheduler and
the gates; ephemeral model calls own the judgment:

- **Coordinator** — a resident session across wakes (as when the skill runs
  live in Codex/Claude Code), rebuilt from the campaign files at a context
  cap — the compaction analog; sole ledger writer; tools:
  `dispatch_worker`, `dispatch_gate_critic`, `request_verification`,
  `record_promotion`, `cancel_worker`, `steer_worker`,
  `declare_campaign_state`, plus bash in the campaign dir for ledger edits.
- **Workers** — fresh instances, one packet with one finite mathematical
  deliverable, write access only to their assigned `EVIDENCE/` directory.
- **Verification** — the launcher's two-stage cadence as four fresh calls:
  hostile audit; bundle certification (a fresh agent shown candidate + bundle
  certifies the coordinator-authored key ideas/sources leak nothing; a leaky
  bundle is hash-blocked from retry); blind reconstruction (the harness
  withholds the candidate); then a comparison mapping the reconstruction to
  the candidate's conclusions and dependencies, which carries stage 2's
  verdict. All four outputs are saved as citable EVIDENCE artifacts; verdicts
  are content-hash-bound, and `record_promotion` (the only writer of
  PROVED.md) re-checks everything.
- **Gates in code** — packet schema + FAILED.md check field on every
  dispatch; idea-gate (`IDEA PASS` on file) before a second concurrent worker
  on a mechanism (sequential retries get an advisory — that judgment is the
  coordinator's); user limits at dispatch; no wall-clock timeouts on proof work,
  ever.

## Project layout convention

A research project is a folder containing campaigns (convention only — no
machinery reads this):

```
myproject/                git repo (committing/pushing is your call; the
  PROJECT.md              harness never runs git)
  notes/                  free-form thinking — not campaign state
  tools/                  domain checkers, search scripts (workers reach them via bash)
  campaigns/
    2026-07-31-some-statement/    one frozen statement each, launcher layout
  papers/
```

Cross-campaign citation: a promoted result from another campaign is an
**imported theorem** — cite it by path and verify its exact hypotheses in the
importing campaign, like any external source. There is deliberately no
project-level promoted-results index; that would be a second proof-state
system. Keep campaigns out of the system temp tree (the write sandbox
blanket-allows temp).

See `docs/design.md` for the full conformance table (each enforcement →
launcher clause) and the adversarial review record, `docs/retrospective.md`
for why 1.0 was replaced, and `docs/skill-feedback.md` for the
skill-improvement ledger.

## Checks

```bash
bun run check   # typecheck + launcher-token conformance check
```

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
```

Optional user limits (the harness imposes none of its own): `--agent-limit N`
(concurrent workers), `--max-wakes N` (pause after N coordinator wakes).
Default model: `claude-opus-5` (`COVERIFY_MODEL` to override).

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
  `record_promotion`, `declare_campaign_state`, plus bash in the campaign
  dir for ledger edits.
- **Workers** — fresh instances, one packet with one finite mathematical
  deliverable, write access only to their assigned `EVIDENCE/` directory.
- **Verification** — the launcher's two-stage cadence as three fresh calls:
  hostile audit; blind reconstruction (bundle built by the harness: statement,
  key ideas, allowed sources, promoted premises — never the proof); then a
  comparison mapping the reconstruction to the candidate's conclusions and
  dependencies, which carries stage 2's verdict. All three outputs are saved
  as citable EVIDENCE artifacts; verdicts are content-hash-bound, and
  `record_promotion` (the only writer of PROVED.md) re-checks everything.
- **Gates in code** — packet schema + FAILED.md check field on every
  dispatch; idea-gate (`IDEA PASS` on file) before any follow-up wave on a
  mechanism; user limits at dispatch; no wall-clock timeouts on proof work,
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

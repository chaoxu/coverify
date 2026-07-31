# Coverify

Coverify 2.0 is a math proof-search campaign engine: the `math-proof-search`
skill's launcher contract, compiled onto pi (`@earendil-works/pi-agent-core`).
The skill is the spec; coverify is a mechanical referee for it. It adds no
mathematical policy of its own — its edge over running the skill in a frontier
harness is that the rules that matter are enforced in code and cannot drift.

A project is a folder. There is no server, no worker daemon, no deploy
pipeline, and no Cosheaf. The campaign directory uses the launcher's exact
file layout (`STATEMENT.md`, `CURRENT_FRONTIER.md`, `REGISTRY.md`,
`FAILED.md`, `PROVED.md`, `LESSONS.md`, `EVIDENCE/`), so a Claude Code or
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

- **Coordinator** — fresh instance per wake, built from the campaign files;
  sole ledger writer; verbs: `dispatch_worker`, `dispatch_gate_critic`,
  `request_verification`, plus bash in the campaign dir for ledger edits.
- **Workers** — fresh instances, one packet with one finite mathematical
  deliverable, write access only to their assigned `EVIDENCE/` directory.
- **Verification** — the launcher's two-stage cadence: fresh hostile audit,
  then fresh no-context reconstruction whose bundle (statement, key ideas,
  promoted premises — never the proof) is constructed by the harness, so
  blindness is platform-enforced. Code counts the verdicts; promotion is
  impossible without both stages passing on the exact revision.
- **Gates in code** — packet schema + FAILED.md check field on every
  dispatch; idea-gate (`IDEA PASS` on file) before any follow-up wave on a
  mechanism; user limits at dispatch; no wall-clock timeouts on proof work,
  ever.

See `docs/design.md` for the full conformance table (each enforcement →
launcher clause), `docs/retrospective.md` for why 1.0 was replaced, and
`docs/skill-feedback.md` for the skill-improvement ledger.

## Checks

```bash
bunx tsc --noEmit
```

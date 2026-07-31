# Coverify Agent Guidance

## The skill is the spec

Coverify 2.0 enforces the `math-proof-search` launcher contract
(`~/kb/notes/agents/prompts/prompt-math-proof-search-launcher.md`). Before
changing harness behavior, read that contract. Three rules govern all code
here:

1. Every enforcement must trace to a launcher clause; keep the conformance
   table in `docs/design.md` in sync with the code.
2. Code that doesn't map to a clause must be semantics-invisible mechanics
   (scheduler, wake building, cache policy, journal) — removable without
   changing campaign behavior.
3. No invented policy defaults: no agent-count ceiling, no wall-clock
   timeouts on proof work, budgets only when the user sets them.

Role prompts embed the launcher's fenced block verbatim — never paraphrase
it. If the launcher file is unavailable, fail loudly; never substitute a
remembered version.

## Do not edit the canonical skill casually

Candidate skill improvements go in `docs/skill-feedback.md`, not into
`~/kb/notes/agents/skills/math-proof-search/`. The canonical skill is only
updated after live campaign evidence, and that edit happens in `~/kb` with
its own review.

## Keep campaigns out of this repo

A campaign is a folder elsewhere (the launcher's file layout). This repo is
the harness only. Domain-specific checkers or search tools belong in the
project folder, reached via the worker bash tool — never added to this CLI.

## Style

TypeScript on Bun; keep the tool small. Checks: `bunx tsc --noEmit`. Prefer
enforcing a rule in `gates.ts` over restating it in a prompt, and prefer
prompt text quoted from the launcher over new prose.

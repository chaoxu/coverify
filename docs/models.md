# Model routing and provider auth

Every role can run on a different model. Specs are `provider/model[@thinking]`.

## Defaults

All subscription-billed (user decision 2026-08-01): OpenAI everywhere except
the independent audit, so that every candidate is read by a family that did
not write it.

| role | default | why |
|---|---|---|
| coordinator, reasoners, technicians | `openai-codex/gpt-5.6-sol@max` | full pi agents on the ChatGPT-subscription OAuth (`coverify login openai-codex`) |
| critic, certifier, reconstructor, comparator | `codex-cli/gpt-5.6-sol` | single-shot verdict roles |
| hostile auditor | `claude-cli/opus` | one cross-family audit per candidate |

Override per role with `COVERIFY_MODEL_{COORDINATOR,REASONER,TECHNICIAN,CRITIC,AUDITOR,CERTIFIER,RECONSTRUCTOR,COMPARATOR}`.
Ideation families are the other model selector: `dispatch_reasoner` can route
one reasoner to `fable`, `gemini` or `pro` as a toolless single-shot consult,
overridable with `COVERIFY_FAMILY_FABLE|GEMINI|PRO`. The `gemini` family shells
out to the `agy` binary via `bin/agy-oracle`. The journal records the model
family actually served on every call.

Note that `fable` currently resolves to `claude-cli/opus`, which is also the
default hostile auditor, so a candidate from that family is audited by its own
model. `prove` warns about the collision at startup.

When ChatGPT quota runs out, `COVERIFY_MODEL_REASONER=claude-cli/opus` falls
back to all-Anthropic. `COVERIFY_MODEL_RECONSTRUCTOR=google/gemini-3.6-flash`
stays the cheap third-family trial.

## Providers

**API providers** — `anthropic`, `openai`, `openai-codex`, `google` (Gemini via
`GEMINI_API_KEY`).

**CLI-backed providers**, all riding official-CLI logins:

- `claude-bridge` — a full tool loop through the Claude Agent SDK on the Claude
  subscription. **Coordinator-only**, enforced at preflight: concurrent bridge
  sessions cross-contaminate, which was observed in testing rather than
  theorised. The bridge starts Claude Code with built-in tools disabled and a
  strict MCP config, so the model's entire tool surface is coverify's own.
- `claude-cli` — `claude -p`, Claude-subscription billed. Fresh process per
  call in an empty temp directory, but the CLI carries its own file-read and
  web-search tools, so its isolation is instructed rather than enforced. The
  journal discloses the backend per call.
- `codex-cli` — official `codex exec`, ChatGPT-subscription billed, read-only
  sandbox.
- `chatgpt-cli` — the chatgpt.com daemon CLI (gitea `chaoxu/chatgpt-cli`), the
  only route to ChatGPT-Pro-only models such as `gpt-5-6-pro`. Its daemon picks
  the model, so the spec's modelId is a provenance label, not a request.

A single-shot CLI-backed **reasoner** runs as an oracle: one deep attempt, no
tools, the reply is the deliverable. `COVERIFY_MODEL_REASONER=chatgpt-cli/gpt-5-6-pro`
turns reasoners into GPT-5.6 Pro deep provers. Spell the id exactly as
`FAMILY_SPECS` does (`gpt-5-6-pro`, hyphens): served-model enforcement compares
it verbatim against what the daemon reports, so a dotted spelling has every
reply discarded as a router downgrade. Technicians need tools, so a CLI
oracle backend is refused there.

## Auth

Three routes, by provider: the logged-in `claude` binary for `claude-bridge`
and `claude-cli`; env API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`); or OAuth via `coverify login anthropic|openai-codex`, stored
in `~/.config/coverify/auth.json` and auto-refreshed.

**Billing caution.** Third-party OAuth against Anthropic reportedly draws Extra
Credits rather than the subscription allowance. Only the official `claude` CLI
paths (`claude-bridge`, `claude-cli`) are subscription-billed, which is why
they are the defaults.

`prove` and `resume` preflight that every configured role's provider has usable
auth, so a missing login fails before any tokens are spent rather than at wake
40.

`COVERIFY_CLAUDE_CMD` / `COVERIFY_CODEX_CMD` override the CLI templates
(`{model}` and `{out}` are substituted).

## The launcher contract

Ships at `contract/math-proof-search-launcher.md`; coverify is canonical for
it, and a clean clone runs with no external file.

`COVERIFY_LAUNCHER_PATH` points at an edited contract for testing. It hard-fails
when set but missing, so you can never silently get the shipped text while
believing you are testing yours. If the contract is missing entirely, coverify
stops rather than falling back to a remembered version.

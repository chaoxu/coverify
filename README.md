# Coverify

Coverify is a small command-line harness for mathematical work over a [Cosheaf](https://github.com/chaoxu/cosheaf) knowledge base, with [Coflat](https://github.com/chaoxu/coflat) as the mathematical document format. It prepares bounded source context, calls LLMs or other mathematical tools, records audit artifacts, verifies outputs, and writes durable progress back to Cosheaf.

For the concise project state and decision list, start with [Project Summary](docs/project-summary.md). For the detailed architecture, see [Design](docs/design.md).

## Mental Model

```text
workspace + branch/source bundle + question
  -> prepare relevant context from allowed files
  -> explore, answer, or package one mathematical-resolution target
  -> call a backend/tool when useful
  -> verify the candidate under the matching contract
  -> publish checked output or leave durable state in Cosheaf
```

Coverify keeps two contracts:

- **Exploratory response** for chat, source-grounded answers, route exploration, issue triage, status summaries, conjecture shaping, and packaging exact targets.
- **Mathematical resolution** for one exact hard target that should return one canonical artifact from `src/coverify/math_contract.py`, such as a proof, construction, counterexample, certificate, bound, obstruction, computation, or precise gap report.

Ordinary chat is not a third mode. It is an exploratory response with a direct-answer target.

## What Coverify Does

- exports and reads bounded source bundles from Cosheaf or local directories
- prepares LLM inputs without requiring the operator to paste files by hand
- exposes `prepare-llm` commands that stop before backend calls
- invokes backend tools through a simple prompt-in, answer-out contract
- runs project-owned tools declared in `coverify-tools.json`
- can fetch and invoke the First Proof `improofbench` Author/Critic workflow as an external mathematical workflow
- records backend audit bundles such as `prompt.md`, `answer.md`, `metadata.json`, and `manifest.json`
- supports verifying generator/verifier/adjudicator inspection
- validates paths, line ranges, citations, schemas, hashes, and verifier decisions where possible
- gives Codex skills a stable CLI surface for context building, exploration, proof attempts, KB writing, PR review, cleanup, and run loops

## What Coverify Does Not Do

- prove theorems by itself
- replace formal verification or human mathematical review
- own the Cosheaf UI, wiki, issue tracker, or PR system
- keep hidden long-term project memory outside Cosheaf
- browse the web or read unrelated local files by default
- ship project-specific research tools in the default public CLI

## Install

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
coverify --help
```

From a checkout without installing:

```bash
PYTHONPATH=src python3 -m coverify --help
```

## Common Workflows

Create a Cosheaf workspace and local project workdir:

```bash
PYTHONPATH=src python3 -m coverify create-workspace \
  --workspace chao/my-project \
  --default-md-format coflat

PYTHONPATH=src python3 -m coverify scaffold-workdir \
  --workspace chao/my-project
```

Cosheaf addresses workspaces as Forgejo repositories, so existing workspace
commands use `owner/repo`. Then start day-to-day Codex sessions inside the
generated project workdir, usually under `~/playground/works/chao_my-project`.
The scaffolded `bin/coverify` wrapper points back to this Coverify checkout
through `COVERIFY_CHECKOUT`.

Ask a question and get a cross-checked answer with the verdict attached. The
generator drafts, multiple referees check independently (cross-family plus an
independent same-family sample by default; every verifier must pass --
pessimistic aggregation, because a false PASS is costlier than a retry), and
the adjudicator
writes the final answer asserting only what survived review. The output is
never a bare answer:

```bash
PYTHONPATH=src python3 -m coverify ask \
  --allow-codex-backend --allow-claude-backend \
  "Can the sum of two odd perfect squares be a perfect square?"
# ...final answer...
# verified: yes (rounds: 1, verdicts: PASS)
# roles: generator=codex/gpt-5.5@xhigh verifier=claude/opus+codex/gpt-5.5@xhigh adjudicator=claude/opus
# audit: .coverify/runs/20260611T210956Z-verifying-j68ak0q7
```

Inspect the exact LLM input before running a backend:

```bash
PYTHONPATH=src python3 -m coverify chat prepare-llm \
  --workspace chao/my-project \
  --issue 23 \
  --backend verifying \
  --message "What should the next proof target be?" \
  --json

PYTHONPATH=src python3 -m coverify verifying prepare-llm \
  --resume .coverify/runs/20260603T120000Z-verifying-abc123 \
  --json
```

Ask against a local source bundle:

```bash
PYTHONPATH=src python3 -m coverify repo-oracle ask \
  --source-bundle /path/to/source-bundle \
  --message "What does the current branch establish?" \
  --json
```

Run a project-owned checker or search tool:

```bash
PYTHONPATH=src python3 -m coverify tool list

PYTHONPATH=src python3 -m coverify tool run check-candidate \
  --message-file candidate.json \
  --json
```

Run the First Proof `improofbench` Author/Critic workflow:

```bash
PYTHONPATH=src python3 -m coverify firstproof setup

PYTHONPATH=src python3 -m coverify firstproof run \
  --workflow author_critic_long \
  --message-file problem.tex \
  --json
```

Run a strict mathematical-resolution style call:

```bash
PYTHONPATH=src python3 -m coverify ask-oracle \
  --prompt "Mathematical-resolution target: prove that if n is even, then n+2 is even. Allowed context: definition of even means n=2k for some integer k. Output type: proof. Do not change the target; if incomplete, state the precise gap." \
  --json
```

Run a smoke eval:

```bash
PYTHONPATH=src python3 -m coverify run-eval \
  --backend fixture \
  --cases evals/smoke.jsonl
```

## Main Commands

- `ask`: verified ask; generate -> cross-family verify -> adjudicate, with the verdict, roles, and audit path printed after every answer.
- `ask-oracle`: send one prompt to a configured backend and record an audit bundle.
- `repo-oracle prepare-llm`: prepare the gatherer, answer, or verifying-generator input against a local source bundle without calling a backend.
- `repo-oracle ask`: produce a source-grounded exploratory response against a local source bundle.
- `repo-oracle gather`: inspect which source passages the gatherer selects.
- `repo-oracle eval-gather`: run JSONL checks for context-preparation quality.
- `chat prepare-llm`: authenticate, read Cosheaf, export the branch source bundle, and show the LLM input that `chat ask` would need next without creating issues, comments, or backend calls.
- `chat ask`: create or append to a branch-scoped chat issue and respond under the exploratory-response contract.
- `verifying prepare-llm`: prepare the generator, verifier, or adjudicator input from a verifying prompt and optional resume artifact.
- `tool list` / `tool run`: discover and run project-owned commands from `coverify-tools.json` with normal audit artifacts.
- `firstproof setup` / `firstproof run`: fetch and run the First Proof `improofbench` workflow with Coverify audit artifacts.
- `chat-reply`: read a Cosheaf issue thread, run the oracle, and post a reply.
- `run-eval`: run JSONL eval cases against a fixture, script, or enabled backend.
- `seed-research-evals`: seed selected research eval candidates into a Cosheaf workspace.
- Cosheaf primitives: `tree`, `read-file`, `write-file`, `delete-file`, `create-branch`, issue commands, PR commands, reviews, and merge.

## Backend Configuration

Common environment variables:

```bash
COSHEAF_API_URL=http://localhost:3030/api/v1
COSHEAF_TOKEN=<token>
COSHEAF_USERNAME=<username>
COSHEAF_PASSWORD=<password>
COSHEAF_REVIEW_TOKEN=<review-token>
COVERIFY_BACKEND=codex
COVERIFY_CODEX_MODEL=gpt-5.5
COVERIFY_CODEX_REASONING_EFFORT=xhigh
COVERIFY_CLAUDE_MODEL=opus
COVERIFY_ASK_GENERATOR=codex
COVERIFY_ASK_VERIFIER=claude,codex
COVERIFY_ASK_ADJUDICATOR=claude
CHATGPT_CLI=chatgpt-cli
COVERIFY_CHATGPT_TIMEOUT_SECONDS=6000
```

Backends share the same basic contract: prompt in, response out, with audit metadata recorded locally. Current backend surfaces include fixture, script, Codex, Claude (`claude -p`), ChatGPT CLI adapter, QED adapter, and the composite `verifying` backend. The Codex and Claude backends consume real usage, so each requires an explicit opt-in (`COVERIFY_ALLOW_CODEX_BACKEND=1`, `COVERIFY_ALLOW_CLAUDE_BACKEND=1`); export both once in your shell profile if `ask` is a daily driver.

## Skills

Coverify ships repo-owned Codex skills in [skills](skills). They are the preferred operational interface for longer runs:

- context building
- exploration planning
- mathematical resolution / proof attempts
- KB writing
- PR review
- KB management
- lightweight run loop

Install or verify the skills:

```bash
python3 scripts/link_skills.py
python3 scripts/link_skills.py --check
```

## Documents

- [Project Summary](docs/project-summary.md): concise statement of what Coverify is, what it is not, and the main design decisions.
- [Design](docs/design.md): architecture and workflow contract.
- [Philosophy](docs/philosophy.md): durable-state and knowledge-base principles.
- [Experiments](docs/experiments.md): evaluation strategy.
- [Eval Problem Selection](docs/eval-problem-selection.md): criteria for promoting math tasks into evals.
- [Coflat Primer](docs/coflat-primer.md): local guide to Coflat/Cosheaf mathematical documents.
- [References](docs/references.md): paper-inspired design lessons.
- [Research-Agent Deep Dives](docs/reference-deep-dives.md): detailed summaries of related systems.
- [LLM Math Failure Modes](docs/llm-math-failure-modes.md): prover, verifier, and harness failure taxonomy.
- [Prover-Side Failure Modes](docs/prover-failure-summary.md): prover failure summary and mitigations.

## Jupiter Sync

Project workdirs on `jupiter` usually point their generated `bin/coverify` wrapper at `/home/chaoxu/playground/coverify`. After changing this checkout on another fleet host, sync and verify that lab copy with:

```bash
scripts/jupiter-sync.sh release
```

Use `sync` to copy without verification or `verify` to check the current `jupiter` copy.

## Checks

```bash
python3 scripts/check_skills.py
python3 scripts/link_skills.py --check
PYTHONPATH=src python3 -m coverify --help
PYTHONPATH=src python3 -m unittest discover -s tests
```

GitHub Actions runs the skill manifest check, installed CLI help, Python syntax compile, and the unit test suite.

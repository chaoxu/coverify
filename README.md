# Coverify

This repository is being rebuilt as a CLI-first Codex tool harness for
Cosheaf. The previous proof harness was removed; v1 now contains a small
Cosheaf HTTP client, backend runner wrappers, and one end-to-end proof
workflow.

## Direction

Cosheaf is the durable workspace: pages, branches, pull requests, reviews,
issues, labels, comments, notifications, search, and backlinks. The current
Cosheaf implementation is Forgejo-backed, but Coverify should treat Cosheaf
as the only workspace interface.

The design target:

- durable state lives in Cosheaf artifacts
- local state is only for currently running processes
- Codex uses tools over Cosheaf rather than a separate workflow database
- model backends are pluggable: scripts, CLIs, API wrappers, or remote jobs
- the first oracle backend is a Codex `gpt-5.5` / `xhigh` text-in/text-out
  wrapper, with Claude and Antigravity-style wrappers possible later
- every oracle/backend call records an audit bundle with the exact prompt,
  answer, metadata, manifest, logs, timing, exit status, and content hashes
- backend calls may run as simple scripts with logs and timeout wrappers; add
  job state only when detached or parallel execution exists
- useful backend/oracle/Codex outputs become reviewed knowledge PRs
- each bounded or long-running run leaves durable progress in Cosheaf so later
  runs start from what was learned
- mathematical reasoning and correctness decisions should be delegated to
  oracle calls whenever possible; Codex-as-runner mainly prepares context,
  operates tools, records artifacts, and maps oracle outputs to Cosheaf state

## Documents

- [Skills](skills): durable Coverify operational skills. These are the
  orchestration entry points for context building, exploration planning, proof
  attempts, KB writing, PR review, KB management, and the lightweight run loop.
  [skills/manifest.json](skills/manifest.json) is the completeness source of
  truth checked by `scripts/check_skills.py`.
- [Philosophy](docs/philosophy.md): stable principles behind the tool and
  knowledge-base workflow, such as durable state, topic-shaped knowledge,
  negative knowledge, review, and retry novelty.
- [Design](docs/design.md): canonical tool-harness design, including Cosheaf
  mapping, lightweight context building, review, runs, jobs, progress, and
  build order.
- Cosheaf workspace `poa-network-game-clean`: durable mathematical knowledge
  pages. Local files in this repository are tools, prompts, and scripts, not
  the source of truth for the PoA wiki.
- [Experiments](docs/experiments.md): evaluation plan for comparing the
  Cosheaf-backed loop against one-shot oracles, fixed pipelines, and QED-style
  strategies.
- [Eval Problem Selection](docs/eval-problem-selection.md): criteria for
  promoting prompt-level candidates into Coflat/Cosheaf eval tasks.
- [Prompt Templates](docs/prompts/README.md): compatibility shims for older
  docs and PRs. Use skills first.
- [Reference Prompt Collection](docs/prompts/reference/README.md): local index
  of prompt patterns from QED, Rethlas, and future external systems.
- [Coflat Primer](docs/coflat-primer.md): markdown/document-format context.
- [References And Future Notes](docs/references.md): paper-inspired design
  lessons and future learning notes.

## Current State

The first runnable surface is a Python CLI package under `src/coverify`.
Use `PYTHONPATH=src python3 -m coverify --help` from this checkout.

Install repo-owned skills for Codex discovery:

```bash
python3 scripts/link_skills.py
python3 scripts/link_skills.py --check
```

Implemented commands:

- `login`: exchange Cosheaf username/password for an API token.
- `create-workspace`: create a new Cosheaf workspace/project; defaults to
  `--default-md-format coflat`.
- Primitive Cosheaf operations for Codex-as-operator runs: `set-member`,
  `tree`, `read-file`, `create-branch`, `write-file`, `delete-file`,
  `list-issues`, `read-issue`, `read-issue-timeline`, `create-issue`,
  `edit-issue`, `comment-issue`, `close-issue`, `reopen-issue`,
  `set-issue-state`, `list-prs`, `read-pr`, `read-pr-context`, `open-pr`,
  `close-pr`, `review-pr`, and `merge-pr`.
- `ask-oracle`: send one prompt to the configured backend oracle and record
  the standard prompt/answer/metadata audit bundle. Transient backend failures
  can be retried with `--backend-retries`; the default is one retry.
- `run-eval`: run JSONL eval cases against a fixture, script, or explicitly
  enabled Codex backend and emit a JSON report with grader results and audit
  artifact links.
- `ttsp-search`: emit bounded directed-TTSP graphs, terminal pairs, simple
  paths, and edge vectors as JSON for downstream LP/certificate searches.
- `ttsp-queue`: reduce a bounded directed-TTSP payload to candidate
  internal-terminal search tuples for downstream LP/certificate work.
- `prove-infinite-primes`: build a context pack, call a backend oracle, write
  `infinite-primes.md` through the local KB-writer step, open a PR, optionally
  review and merge it, then verify the proof through Cosheaf.

Common environment variables:

```bash
COSHEAF_API_URL=http://localhost:3030/api/v1
COSHEAF_TOKEN=...
COSHEAF_USERNAME=...
COSHEAF_PASSWORD=...
COSHEAF_REVIEW_TOKEN=...
COVERIFY_BACKEND=codex
COVERIFY_CODEX_MODEL=gpt-5.5
COVERIFY_CODEX_REASONING_EFFORT=xhigh
CHATGPT_CLI=/Users/chaoxu/playground/chatgpt-cli/.venv/bin/chatgpt-cli
COVERIFY_CHATGPT_TIMEOUT_SECONDS=6000
```

Direct oracle call:

```bash
PYTHONPATH=src python3 -m coverify ask-oracle \
  --prompt "Give a concise proof attempt for the current lemma." \
  --json
```

Smoke eval:

```bash
PYTHONPATH=src python3 -m coverify run-eval \
  --backend fixture \
  --cases evals/smoke.jsonl
```

QED backend adapter:

```bash
ADAPTER="$(pwd)/scripts/qed_backend.py"
PYTHONPATH=src python3 -m coverify ask-oracle \
  --backend script \
  --backend-command "python3 $ADAPTER --qed-root /path/to/QED" \
  --prompt "Prove that there are infinitely many prime numbers."
```

For a non-budget smoke of the adapter itself:

```bash
printf 'Prove that there are infinitely many prime numbers.' \
  | python3 scripts/qed_backend.py --dry-run --workdir /tmp/coverify-qed-dry-run
```

ChatGPT Pro/Extended oracle adapter:

```bash
PYTHONPATH=src python3 -m coverify ask-oracle \
  --backend script \
  --backend-timeout 6090 \
  --backend-command "python3 $(pwd)/scripts/chatgpt_oracle_backend.py" \
  --prompt "Give a concise proof attempt for the current lemma."
```

The adapter calls `chatgpt-cli oracle --quiet`, stores the raw ChatGPT JSON in
the script artifact directory, and returns the JSON `text` field as the
Coverify oracle answer.

QED with ChatGPT Pro/Extended as its native `chatgpt` model provider:

```bash
PYTHONPATH=src python3 -m coverify ask-oracle \
  --backend script \
  --backend-timeout 21600 \
  --backend-command "python3 $(pwd)/scripts/qed_backend.py --qed-root /path/to/QED --config /path/to/qed-chatgpt-oracle.yaml --timeout 0" \
  --prompt "Prove that there are infinitely many prime numbers."
```

The QED ChatGPT config should define a top-level `chatgpt:` section pointing
at `chatgpt-cli`, then set the QED roles that should spend the strong oracle
to `provider: "chatgpt"`. Codex roles remain real Codex roles, so mixed
configs can use weaker providers for cheaper stages.

Directed TTSP search payload:

```bash
PYTHONPATH=src python3 -m coverify ttsp-search \
  --min-edges 2 \
  --max-edges 4 \
  --terminal-scope internal \
  --pretty
```

Directed TTSP issue-queue payload:

```bash
PYTHONPATH=src python3 -m coverify ttsp-queue \
  --min-edges 4 \
  --max-edges 8 \
  --queue-min-edges 8 \
  --queue-limit 25 \
  --pretty
```

Issue state preflight:

```bash
PYTHONPATH=src python3 -m coverify read-issue \
  --workspace poa-network-game-clean \
  --issue 23
PYTHONPATH=src python3 -m coverify read-issue-timeline \
  --workspace poa-network-game-clean \
  --issue 23
PYTHONPATH=src python3 -m coverify list-prs \
  --workspace poa-network-game-clean \
  --state open
PYTHONPATH=src python3 -m coverify read-pr-context \
  --workspace poa-network-game-clean \
  --pr 7
```

Real math-run skeleton:

1. Run `python3 scripts/link_skills.py`.
2. Use `$coverify-run-loop` for the task.
3. Refresh issue, PR, and topic-page state with `read-issue`,
   `read-issue-timeline`, `list-prs`, `tree`, `read-file`, and when reviewing,
   `read-pr-context`.
4. Build context with `$coverify-context-builder`, including accepted KB
   dependencies and nearby "things tried" notes.
5. Choose one action: plan, attempt, write KB content, clean the KB, or review
   a PR.
6. Leave durable state: issue, branch, PR, review, comment, or merged page.
7. Record `PRIOR_ROUTE_CHECK`, `THINGS_TRIED_UPDATED`, verification, and
   remaining blocker in the run summary.

Local checks:

```bash
python3 scripts/link_skills.py
python3 scripts/check_skills.py
python3 scripts/link_skills.py --check
PYTHONPATH=src python3 -m unittest discover -s tests
PYTHONPATH=src python3 -m coverify --help
```

# Coverify

Coverify is a command-line exploration system for using LLMs and other
mathematical tools on a knowledge base without losing source grounding,
verification, or durable project state. It is designed to work with
[Cosheaf](https://github.com/chaoxu/cosheaf), and uses
[Coflat](https://github.com/chaoxu/coflat) as the mathematical document format.

In practice, Coverify does four things:

1. Takes a user question plus a bounded source bundle from a Cosheaf workspace
   or local directory.
2. Prepares the relevant context, preferably with an agentic gatherer that can
   inspect the allowed files directly.
3. Calls tools such as reasoners, provers/resolvers, computations, or verifiers
   under the right output contract and records what was asked, what came back,
   and which sources were used.
4. Returns a checked response, or publishes it as a Cosheaf issue comment,
   review, PR artifact, or knowledge-base update.

The useful loop is:

```text
question + thread + source bundle
  -> prepare relevant context
  -> explore, answer, or run one packaged mathematical resolution
  -> verify the candidate under the matching contract
  -> return or publish the checked result
```

## Why This Exists

Some LLMs, theorem tools, and other black-box reasoners are very strong at
mathematics when given a sharply specified target and the right prompt. The
prompt can include the statement to resolve, known facts, source context, failed
routes, and even a required method. If the target says "prove this theorem using
this route" or "construct a witness with this property," the prover/resolver
must follow that instruction; the verifier should reject outputs that solve a
nearby problem or ignore the required method.

Many real problems are not ready for that kind of one-shot call. They need
exploration first: finding the right formulation, collecting the relevant facts,
trying routes, learning from failures, and packaging exact targets. Coverify
exists to make that exploration compound while still using strong
mathematical-resolution tools when a hard target becomes precise enough.

## Two Contracts

Coverify keeps the system simple by separating two contracts, not by adding a
large mode hierarchy.

**Exploratory response** is the normal contract for chat, source-grounded
answers, route exploration, issue triage, status summaries, conjecture shaping,
and packaging resolution targets. It may answer directly, call tools, or say
what should be tried next. It must ground repo-specific claims in the source
bundle and label speculation, gaps, and unsupported claims.

**Mathematical resolution** is the strict contract for one exact hard
mathematical target. The prompt should contain the exact statement, hypotheses,
allowed context, and relevant failed routes. The expected output is proof,
disproof, counterexample, construction/witness, bound/certificate, reduction,
obstruction, or precise gap, followed by independent verification. This is
where Coverify should spend the strongest tool budget. "Prover" is acceptable
shorthand for this tool even when the requested artifact is not literally a
proof.

An ordinary chat answer is not a separate mode; it is an exploratory response
with a direct-answer target. A broad "solve this issue" request usually starts
as exploratory response, then hands one packaged resolution target to the
prover/resolver if the next mathematical target is clear.

Coverify is for workflows such as:

- answering or exploring a branch-scoped chat question using only the current
  project files
- packaging a broad issue into exact mathematical resolution targets
- asking a strong model for one strict prover/resolver attempt while recording
  an audit trail
- verifying whether a proposed argument is source-backed and gap-free enough to
  publish
- turning useful model output into a reviewed Cosheaf PR or comment
- evaluating whether context preparation found the passages a task actually
  needed

Coverify deliberately does not:

- prove theorems by itself
- replace a formal verifier or human mathematical review
- own the wiki, chat UI, issue tracker, or PR system
- keep hidden long-term project memory outside Cosheaf
- browse the web or read unrelated local files by default
- ship project-specific research tools in the public CLI

## Principles

- Durable mathematical state lives in Cosheaf.
- Local files are tools, prompts, tests, and reproducibility scripts.
- Python exposes stable mechanisms: source bundles, backend calls, audit
  bundles, schema checks, path/range validation, and verifier gates.
- Exploration handles judgment: context selection, route choice, tool use,
  mathematical reasoning, and correctness review.
- Deterministic code is added only when the behavior is stable, replayable, and
  simpler than asking an agent to inspect the allowed context.

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

## Main Commands

- `ask-oracle`: send one prompt to a configured backend and record an audit
  bundle. Use it for either contract when the prompt already contains the
  needed context and rules.
- `repo-oracle ask`: produce a source-grounded exploratory response against a
  local source bundle.
- `repo-oracle gather`: inspect which source passages the gatherer selects.
- `repo-oracle eval-gather`: run JSONL checks for context-preparation quality.
- `chat ask`: create or append to a branch-scoped chat issue and respond under
  the exploratory-response contract.
- `chat-reply`: read a Cosheaf issue thread, run the oracle, and post a reply.
- `run-eval`: run JSONL eval cases against a fixture, script, or enabled Codex
  backend.
- `seed-research-evals`: seed selected research eval candidates into a Cosheaf
  workspace.
- Cosheaf primitives: `tree`, `read-file`, `write-file`, `delete-file`,
  `create-branch`, issue commands, PR commands, reviews, and merge.

## Examples

Direct oracle call:

```bash
PYTHONPATH=src python3 -m coverify ask-oracle \
  --prompt "Resolve the current lemma, or state the precise gap." \
  --json
```

Self-verifying fixture smoke:

```bash
PYTHONPATH=src python3 -m coverify ask-oracle \
  --backend verifying \
  --verify-inner-backend fixture \
  --prompt "Prove that there are infinitely many prime numbers." \
  --json
```

Run against a local source bundle:

```bash
PYTHONPATH=src python3 -m coverify repo-oracle ask \
  --source-bundle /path/to/source-bundle \
  --message "What does the current branch establish?" \
  --json
```

Evaluate gather quality:

```bash
PYTHONPATH=src python3 -m coverify repo-oracle eval-gather \
  --source-bundle /path/to/source-bundle \
  --cases evals/gather/sample-math-workspace.jsonl
```

Reply to a Cosheaf issue chat:

```bash
PYTHONPATH=src python3 -m coverify chat-reply \
  --workspace my-workspace \
  --issue 23 \
  --backend verifying
```

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
CHATGPT_CLI=chatgpt-cli
COVERIFY_CHATGPT_TIMEOUT_SECONDS=6000
```

Backends share the same basic contract: prompt in, response out, with audit
metadata recorded locally. The prompt determines whether the call is a flexible
exploratory response or a strict mathematical resolution. The current backend
surfaces include fixture, script, Codex, ChatGPT CLI adapter, QED adapter, and
the composite `verifying` backend.

## Skills

Coverify ships repo-owned Codex skills in [skills](skills). They are the
preferred operational interface for longer runs:

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

- [Design](docs/design.md): canonical architecture and workflow contract.
- [Philosophy](docs/philosophy.md): durable-state and knowledge-base
  principles.
- [Repo-Grounded Chat](docs/chat-knowledge-base-oracle-design.md): focused
  chat/source-bundle design.
- [Experiments](docs/experiments.md): evaluation strategy.
- [Eval Problem Selection](docs/eval-problem-selection.md): criteria for
  promoting math tasks into evals.
- [Coflat Primer](docs/coflat-primer.md): context for
  [Coflat](https://github.com/chaoxu/coflat) documents.
- [References](docs/references.md): paper-inspired design lessons.
- [Research-Agent Deep Dives](docs/reference-deep-dives.md): detailed
  summaries of related systems.
- [LLM Math Failure Modes](docs/llm-math-failure-modes.md): prover, verifier,
  and system failure taxonomy.
- [Prover-Side Failure Modes](docs/prover-failure-summary.md): shareable
  prover failure summary and mitigations.

Prompt files under [docs/prompts](docs/prompts) are compatibility references for
older flows. Prefer the skills for new operational work.

## Checks

```bash
python3 scripts/check_skills.py
python3 scripts/link_skills.py --check
PYTHONPATH=src python3 -m coverify --help
PYTHONPATH=src python3 -m unittest discover -s tests
```

GitHub Actions runs the skill manifest check, installed CLI help, Python syntax
compile, and the unit test suite.

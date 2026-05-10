# autoprover

`autoprover` is the agent harness for Cosheaf.

Cosheaf is the mathematical knowledge base: pages, proposals, reviews,
approvals, search, backlinks, and golden status. Autoprover does not own that
substrate. It connects to Cosheaf over HTTP as an ordinary user, runs local
explorer or verifier commands, and writes the resulting Coflat Markdown back to
Cosheaf.

The first version is intentionally small:

- read/search Cosheaf documents
- run an explorer command to write a new proof/exploration page
- run an explorer command to propose a replacement body for an existing page
- run a verifier command to write a review document and approve/reject the
  target
- keep humans and agents on the same workflow

## Requirements

- Python 3.11+
- A running Cosheaf server
- A Cosheaf API token for the user/agent
- A local command that accepts a prompt on stdin and writes its final answer to
  stdout

## Install

```bash
python3 -m pip install -e .
```

## Configuration

```bash
export COSHEAF_URL=http://localhost:3030/api/v1
export COSHEAF_WORKSPACE=notes
export COSHEAF_TOKEN=cs_...
export AUTOPROVER_AGENT_CMD='./scripts/codex-agent.sh'
```

See [`.env.example`](.env.example) for the full local environment shape.

`COSHEAF_URL` may point either at the API root (`.../api/v1`) or at the server
root (`http://localhost:3030`); autoprover normalizes it.

## Commands

```bash
autoprover search "compactness"
autoprover queue

autoprover explore \
  --direction "Try to prove the main lemma using compactness." \
  --path explorations/main-lemma-compactness.md \
  --submit

autoprover propose TARGET_DOC_ID \
  --direction "Repair the proof using the reviewer comments." \
  --submit

autoprover repair REJECTED_DOC_ID --submit

autoprover review TARGET_DOC_ID

autoprover task \
  --direction "Explore whether this lemma generalizes to finite lattices."

autoprover review-queue --limit 3

autoprover cycle \
  --direction "Write and review a small proof of the sum of odd integers."

autoprover workstream start \
  --direction "Explore whether this lemma generalizes to finite lattices."

autoprover workstream step TASK_DOC_ID --submit
```

The default command is read from `AUTOPROVER_AGENT_CMD`. You can override it
per call with `--agent-cmd`.

The included `scripts/codex-agent.sh` wrapper runs `codex exec` and returns only
Codex's final message, which keeps Cosheaf pages and review documents free of
event-stream noise.

For offline development without Codex calls:

```bash
export AUTOPROVER_AGENT_CMD='./scripts/fake-agent'
```

## Boundary

Autoprover is not a replacement for Cosheaf. It is a worker layer.

Cosheaf remains useful without agents. Autoprover uses the same API a human
uses: it creates pages, proposals, review documents, approvals, and rejections.

## Roadmap Note

The proof-writing harness should eventually produce structured traces that can
be used for reinforcement learning. See [`docs/future-rl.md`](docs/future-rl.md).
Current gaps against the paper are tracked in
[`docs/paper-gap.md`](docs/paper-gap.md).

## Design Reference

Autoprover uses the agentic-workspace lessons from
[`AI Co-Mathematician: Accelerating Mathematicians with Agentic AI`](https://arxiv.org/abs/2605.06651):
persistent workspace state, native mathematical documents, asynchronous
exploration/review, preserved failed attempts, and auditable reviewer reasoning.

## Development

```bash
./scripts/check
./scripts/smoke-cosheaf
```

The Cosheaf endpoints autoprover relies on are listed in
[`docs/cosheaf-api-used.md`](docs/cosheaf-api-used.md).

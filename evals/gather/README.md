# Gather evals

These JSONL files define repo-snapshot preparation-quality checks for
`coverify repo-oracle eval-gather`. The command name is still `eval-gather`,
but the Codex-backed gatherer now acts as an agentic context preparer: it sees
the source-bundle directory, reads files directly, and returns exact passage
ranges for the answer prompt.

Each case has:

- `id`: stable eval id.
- `question`: the user-facing question to gather context for.
- `must_include`: passages that must appear in the prepared context. Entries may
  be a path string, or an object with `path` and required `text`.

Run the PoA knowledge-base checks against an exported source bundle:

```bash
PYTHONPATH=src python3 -m coverify repo-oracle eval-gather \
  --source-bundle /path/to/source-bundle \
  --cases evals/gather/poa-network-game-clean.jsonl \
  --gatherer-backend codex \
  --gatherer-model gpt-5.5 \
  --gatherer-reasoning-effort medium \
  --allow-codex-backend
```

The PoA cases intentionally ask for sections that are far apart in the source
files. They are intended to evaluate the Codex preparation agent; deterministic
fallback retrieval may fail some cases by selecting only the highest-scoring
window.

# Trace Schema

Autoprover writes JSONL traces for proof-harness debugging, benchmark replay,
and future learning experiments. Each line is one `Trace` record.

Current schema version: `1`.

Required fields:

- `schema_version`: integer trace schema version.
- `id`: unique trace id.
- `created_at`: UTC ISO timestamp.
- `kind`: command family such as `explore`, `propose`, `repair`, or `review`.
- `direction`: user direction or command-specific summary.
- `context_ids`: retrieved or target Cosheaf document ids.
- `prompt`: exact prompt sent to the agent.
- `output`: raw agent output stored for backward-compatible readers.
- `cosheaf_result`: Cosheaf write/decision result stored for backward-compatible readers.
- `prompt_version`: prompt template version.
- `coflat_primer_version`: injected Coflat primer version.
- `inputs`: structured input group.
- `outputs`: structured output group.
- `result`: structured external result group.

Version 1 groups:

```json
{
  "inputs": {
    "direction": "...",
    "context_ids": ["..."],
    "prompt": "..."
  },
  "outputs": {
    "raw": "..."
  },
  "result": {
    "cosheaf": {}
  }
}
```

Compatibility:

The top-level `prompt`, `output`, `context_ids`, and `cosheaf_result` fields
remain duplicated in v1 so existing local traces can be read without migration.
New code should prefer the grouped `inputs`, `outputs`, and `result` fields.

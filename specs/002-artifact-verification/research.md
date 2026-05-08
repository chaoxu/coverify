# Research: Artifact Verification

## Decision: Use a plain folder store

**Rationale**: The user wants v1 to be simple enough to change after real exploration runs. Markdown files in folders make every artifact readable, editable before submission, and easy for agents to inspect.

**Alternatives considered**:
- Database: easier queries later, but adds sync and schema cost too early.
- Git/Gitea: useful for backup and collaboration later, but not needed for the product model.

## Decision: Use Markdown front matter for metadata

**Rationale**: It keeps metadata next to the text while staying readable. The v1 parser only needs simple `key: value` pairs.

**Alternatives considered**:
- Separate JSON sidecars: easier parsing, but duplicates document identity.
- Embedded custom blocks only: better Coflat alignment later, but more parser work now.

## Decision: Derive status from review documents

**Rationale**: Status should be inspectable and reproducible. The system reads review documents and derives `submitted`, `approved`, `rejected`, `partial`, or `disputed`.

**Alternatives considered**:
- Store mutable status fields: simpler display, but can drift from reviews.

## Decision: No LLM calls in this feature

**Rationale**: The immediate goal is the harness. LLM explorers and verifiers can use the same commands later.

**Alternatives considered**:
- Direct Codex or API integration: useful soon, but it would blur the first test of the document workflow.

# Reference Prompt Collection

This directory collects prompt patterns from other mathematical-agent systems.
These files are references for humans and runners, not canonical Coverify
workflow definitions.

Coverify has two output contracts plus review and writing gates:

1. Explore current Cosheaf state: answer directly, route-find, call tools, or
   package exact resolution targets.
2. Resolve one exact mathematical target into one canonical resolution artifact
   from `src/coverify/math_contract.py`.

Review, verification, and knowledge-base writing gate what becomes durable
knowledge; they are not a third answer mode.

External systems often split those activities into many named agents or
skills. That can be useful as a checklist, but it should not force us into a
larger workflow model.

When reusing a reference pattern, preserve the boundary: adaptive judgment goes
into agentic preparation or oracle prompts; Python only gets stable mechanical
validation.

## Sources

- [QED](qed.md): fixed multi-stage proof pipeline with literature survey,
  decomposition, proving, structural verification, detailed verification,
  regulation, and proof-effort summary.
- [Rethlas](rethlas.md): adaptive Codex generation agent with local memory
  channels, theorem search, counterexample/testing tactics, and verification
  service.

## Copying Policy

When an upstream prompt collection has a clear permissive license, we may
vendor exact prompt files with attribution and license text. When no license is
present, keep a local digest with links, short notes, and design lessons rather
than copying full prompt text.

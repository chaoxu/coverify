# Reference Prompt Collection

This directory collects prompt patterns from other mathematical-agent systems.
These files are references for humans and runners, not canonical Autoprover v1
workflow definitions.

Autoprover's canonical prompt surface remains:

1. Explore current Cosheaf state and produce issue-ready directions.
2. Attempt one well-defined proof/disproof/obstruction.
3. Review proposed knowledge through the PR gate.

External systems often split those activities into many named agents or
skills. That can be useful as a checklist, but it should not force us into a
larger workflow model.

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

<!--
Sync Impact Report
Version change: 1.0.0 -> 2.0.0
Modified principles:
- I. Golden Knowledge Is Guarded -> I. Golden Truth Is Guarded
- II. Workspace Work Is Separate -> II. Exploration Records Are First-Class
- III. Documents Are Human-Readable -> III. Documents Stay Readable
- IV. Statements Are Indexed Knowledge -> IV. Indexes Are Derived Views
- V. One API For Humans And Agents -> V. One Workflow For Humans And Agents
Added principles:
- VI. Spec Before Behavior
- VII. Simple Testable Loops First
Added sections:
- V1 Product Boundaries
Removed sections:
- Product Boundaries (replaced by V1 Product Boundaries)
Templates requiring updates:
- ✅ .specify/templates/plan-template.md updated to check the new principles
- ✅ .specify/templates/spec-template.md reviewed; generic user-story structure remains usable
- ✅ .specify/templates/tasks-template.md reviewed; story/task structure remains usable
Follow-up TODOs: none
-->

# autoprover Constitution

## Core Principles

### I. Golden Truth Is Guarded

Golden documents MUST contain only accepted knowledge. Content enters golden
storage only through an explicit approval action by an authorized account.
Verifier approval is evidence, not automatic promotion. Automation may propose
content, but automation MUST NOT bypass the same approval path used by people.

### II. Exploration Records Are First-Class

Drafts, attempts, failed paths, unsure results, reviews, repairs, and automation
logs are product data, not disposable scratch. They MUST remain inspectable and
searchable as exploration records. They MUST also remain clearly distinguishable
from golden truth in every user and agent workflow.

### III. Documents Stay Readable

The primary mathematical artifact MUST be a readable Markdown document.
Structured metadata may support indexing, search, review, and automation, but it
MUST NOT replace readable mathematical exposition. Long-form notes are expected
for real exploration runs.

### IV. Indexes Are Derived Views

Statement indexes, DAGs, RAG indexes, dependency graphs, and databases are
derived views over documents and review records. They MAY be added when they
make a real workflow easier, but they MUST remain traceable to source documents
and MUST NOT become the only source of mathematical meaning.

### V. One Workflow For Humans And Agents

Humans, LLM workers, scripts, and future tools MUST use the same conceptual
operations: search, read, write drafts, submit artifacts, review artifacts,
repair artifacts, and inspect status. The system may identify accounts, but it
MUST NOT require separate product semantics for human and AI actors.

### VI. Spec Before Behavior

Any change that affects user or agent behavior MUST be reflected in the active
Spec Kit artifacts before or in the same change as implementation. This includes
new commands, artifact states, trust rules, review fields, storage semantics,
retrieval behavior, and automation-visible workflows. Implementation-only
behavior changes are constitution violations unless they are purely internal
refactors.

### VII. Simple Testable Loops First

V1 MUST optimize for small, observable loops that can be run on real math
problems. New infrastructure is allowed only when it removes a concrete blocker
seen in a run or is required by an active specification. Plans MUST prefer the
least powerful design that can be tested end-to-end.

## V1 Product Boundaries

autoprover is an exploration and verification harness. It owns workspace
artifacts, review documents, trust status, repair links, search visibility, and
the handoff toward golden knowledge.

Golden documents are separate from exploration records. A golden store may be a
plain folder for v1. Git, Gitea, databases, and servers may be used later for
sync, collaboration, or scale, but they are not the v1 product model.

Automation is a client of the same workflow. It may read existing records,
create drafts, submit artifacts, and write reviews through an account. It does
not own truth.

## Development Workflow

Every feature specification MUST identify which bounded context it touches:
workspace artifacts, reviews, trust status, golden handoff, indexing/RAG, search,
or automation client behavior.

Features that affect trust or golden handoff MUST specify the approval path,
retrieval visibility, and observability requirements. Features that create
automation output MUST specify how that output remains separate from golden truth
until approved.

Implementation plans MUST include a Constitution Check that explicitly evaluates
the seven core principles. If a plan adds infrastructure such as a database,
server, Git workflow, or external API, it MUST explain the concrete blocker that
requires it.

## Governance

This constitution supersedes informal design notes when planning implementation.
Amendments require updating this file, explaining the version change in the Sync
Impact Report, and checking active feature specs and templates for conflicts.

Versioning follows semantic versioning:

- MAJOR for principle removals, renames, or materially different governance.
- MINOR for new principles or materially expanded sections.
- PATCH for clarifications that do not change obligations.

All implementation plans MUST pass the Constitution Check before task
generation.

**Version**: 2.0.0 | **Ratified**: 2026-05-06 | **Last Amended**: 2026-05-08

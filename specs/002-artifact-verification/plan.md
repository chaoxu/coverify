# Implementation Plan: Artifact Verification

**Branch**: `002-artifact-verification` | **Date**: 2026-05-08 | **Spec**: `specs/002-artifact-verification/spec.md`
**Input**: Feature specification from `specs/002-artifact-verification/spec.md`

## Summary

Build the smallest useful v1 harness for exploration artifacts and verifier reports. The implementation is a local CLI over a plain folder: drafts, submitted artifacts, review documents, golden documents, a status-aware search command, and CLI worker invocation through Codex, Claude, or Gemini backends. No database, server, or Git workflow is included in this feature.

## Technical Context

**Language/Version**: Python 3.11+
**Primary Dependencies**: Python standard library only; optional `codex`, `claude`, or `gemini` CLI for worker commands
**Storage**: Files in a user-selected folder
**Testing**: `unittest` through `python -m unittest`
**Target Platform**: Local developer machine
**Project Type**: CLI/library
**Performance Goals**: Suitable for v1 exploration folders with hundreds of artifacts
**Constraints**: Keep the workflow inspectable in any text editor; base document workflow must not require a database or API key; worker commands require a configured CLI backend and run in YOLO/non-interactive mode
**Scale/Scope**: One local store, one user command at a time

## Constitution Check

- **Golden Truth Is Guarded**: PASS. Golden docs are separate from exploration artifacts, and verifier approval alone does not promote content.
- **Exploration Records Are First-Class**: PASS. Drafts, submitted artifacts, rejected attempts, unsure attempts, reviews, and repairs are durable files.
- **Documents Stay Readable**: PASS. Artifacts and reviews are Markdown with small front matter.
- **Indexes Are Derived Views**: PASS. This feature does not build statement or RAG indexes; search is a simple derived view over files.
- **One Workflow For Humans And Agents**: PASS. The CLI operations are the same for people and agents, and CLI workers write through the same artifact/review workflow.
- **Spec Before Behavior**: PASS. Behavior changes are reflected in the spec, contracts, tasks, implementation, and tests.
- **Simple Testable Loops First**: PASS. The implementation is a local file-based CLI with no database, server, or Git workflow. CLI worker backends are added only for the concrete blocker that exploration and verification need real worker calls.

## Project Structure

### Documentation

```text
specs/002-artifact-verification/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── cli.md
└── tasks.md
```

### Source Code

```text
src/autoprover/
├── __init__.py
├── __main__.py
├── cli.py
└── store.py

tests/
└── test_store.py
```

**Structure Decision**: Use one small Python package. Keep all store behavior in `store.py` and expose it through `cli.py`.

## Complexity Tracking

No constitution violations. No additional systems are introduced.

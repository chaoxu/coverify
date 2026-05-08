# Tasks: Artifact Verification

## Phase 1: Setup

- [x] T001 Create Python package metadata in `pyproject.toml`
- [x] T002 Create package entry files in `src/autoprover/__init__.py` and `src/autoprover/__main__.py`

## Phase 2: Foundation

- [x] T003 Implement Markdown metadata parsing and writing in `src/autoprover/store.py`
- [x] T004 Implement store initialization and path helpers in `src/autoprover/store.py`

## Phase 3: User Story 1 - Submit Immutable Exploration Artifacts

- [x] T005 [US1] Implement draft creation in `src/autoprover/store.py`
- [x] T006 [US1] Implement immutable submission behavior in `src/autoprover/store.py`
- [x] T007 [US1] Add CLI commands for `init`, `draft`, and `submit` in `src/autoprover/cli.py`
- [x] T008 [US1] Add immutability tests in `tests/test_store.py`

## Phase 4: User Story 2 - Record Verifier Reports As Documents

- [x] T009 [US2] Implement review document creation and validation in `src/autoprover/store.py`
- [x] T010 [US2] Add CLI `review` command in `src/autoprover/cli.py`
- [x] T011 [US2] Add review validation tests in `tests/test_store.py`

## Phase 5: User Story 3 - Retrieve With Trust Status

- [x] T012 [US3] Implement trust-status derivation in `src/autoprover/store.py`
- [x] T013 [US3] Implement exploration and golden search in `src/autoprover/store.py`
- [x] T014 [US3] Add CLI `status` and `search` commands in `src/autoprover/cli.py`
- [x] T015 [US3] Add status-aware retrieval tests in `tests/test_store.py`

## Phase 6: User Story 4 - Repair Through Linked Revisions

- [x] T016 [US4] Support source links when creating draft repairs in `src/autoprover/store.py`
- [x] T017 [US4] Add repair-chain test coverage in `tests/test_store.py`

## Phase 7: Benchmark And Smoke Test

- [x] T018 Add `benchmark coin-fpt` data creation in `src/autoprover/store.py` and `src/autoprover/cli.py`
- [x] T019 Add coin benchmark tests in `tests/test_store.py`
- [x] T020 Run unit tests and the quickstart smoke flow from `specs/002-artifact-verification/quickstart.md`
- [x] T021 Add long Markdown body-file draft workflow to `specs/002-artifact-verification/spec.md`, `specs/002-artifact-verification/contracts/cli.md`, `src/autoprover/cli.py`, and `tests/test_store.py`

## Phase 8: Codex Worker Invocation

- [x] T022 Add Codex worker requirements to `specs/002-artifact-verification/spec.md`, `specs/002-artifact-verification/contracts/cli.md`, and `specs/002-artifact-verification/plan.md`
- [x] T023 Implement Codex CLI invocation helpers in `src/autoprover/codex_worker.py`
- [x] T024 Add `codex-explore` and `codex-verify` commands in `src/autoprover/cli.py`
- [x] T025 Add Codex worker unit tests with a fake runner in `tests/test_codex_worker.py`

## Phase 9: Shared CLI Worker Backends

- [x] T026 Update worker requirements for common CLI backends in `specs/002-artifact-verification/spec.md`, `specs/002-artifact-verification/contracts/cli.md`, and `specs/002-artifact-verification/plan.md`
- [x] T027 Replace Codex-specific worker implementation with shared backend adapters in `src/autoprover/worker.py`
- [x] T028 Add generic `worker-explore` and `worker-verify` commands with Codex compatibility aliases in `src/autoprover/cli.py`
- [x] T029 Add Codex, Claude, and Gemini backend command tests in `tests/test_worker.py`

## Dependencies

Complete phases in order. Each user story is independently testable once the foundation is complete.

## MVP Scope

The MVP is all tasks above, but no server, database, Git workflow, or LLM integration.

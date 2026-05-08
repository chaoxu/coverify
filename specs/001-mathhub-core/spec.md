# Feature Specification: MathHub Core

**Feature Branch**: `001-mathhub-core`
**Created**: 2026-05-06
**Status**: Draft
**Input**: User description: "Build the first MathHub system for maintaining separate golden mathematical knowledge and workspace documents, with shared users, approval, statement indexing, and one workflow/API for humans and agents."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Search Golden Knowledge (Priority: P1)

A user searches accepted mathematical knowledge and reads full article-style
Coflat notes with indexed statements and dependencies.

**Why this priority**: Golden search is the base value of MathHub. Without a
trusted readable repository, workspace and automation have no stable memory.

**Independent Test**: Can be tested by adding accepted notes, indexing them, and
confirming a user can search, open the note, inspect statements, and see `uses`
dependencies.

**Acceptance Scenarios**:

1. **Given** accepted golden notes exist, **When** a user searches for a topic, **Then** matching notes and statements are returned with provenance.
2. **Given** a golden statement uses another statement, **When** a user views the statement, **Then** the used statement is visible as a dependency.

---

### User Story 2 - Create Workspace Material (Priority: P2)

A user or agent creates workspace documents for drafts, proof attempts, failed
paths, or automation output without changing golden knowledge.

**Why this priority**: Workspace material is where exploration happens. It must
be easy to write without weakening the trust boundary around golden knowledge.

**Independent Test**: Can be tested by creating a workspace note and verifying
it is searchable as workspace material but does not appear as accepted golden
knowledge.

**Acceptance Scenarios**:

1. **Given** a user has access to a workspace, **When** they write an attempt note, **Then** the note is stored and labeled as workspace material.
2. **Given** a workspace note contains a statement block, **When** the index runs, **Then** the statement is indexed with workspace provenance.

---

### User Story 3 - Submit And Approve Candidate Notes (Priority: P3)

A user or agent prepares a full article-style candidate note and submits it for
approval into golden knowledge.

**Why this priority**: Candidate approval is the boundary where exploration
becomes accepted knowledge.

**Independent Test**: Can be tested by submitting a candidate note, approving
it as an authorized user, and verifying the note becomes golden and is included
in golden search.

**Acceptance Scenarios**:

1. **Given** a candidate note is submitted, **When** an unauthorized user tries to approve it, **Then** the system refuses the approval.
2. **Given** an authorized user approves a candidate note, **When** golden search is refreshed, **Then** the candidate appears as accepted golden knowledge.

---

### User Story 4 - Shared Human And Agent Operations (Priority: P4)

Humans and automation use the same operations for reading, writing workspace
documents, submitting candidates, and inspecting results.

**Why this priority**: The system is designed for future automation, but the
automation must not receive a separate truth model or hidden workflow.

**Independent Test**: Can be tested by performing the same workspace and
candidate actions through two different users and verifying the same permission
and audit rules apply.

**Acceptance Scenarios**:

1. **Given** two users have the same permissions, **When** each submits a candidate, **Then** both candidates follow the same approval workflow.
2. **Given** a user lacks approval permission, **When** they submit a candidate, **Then** the candidate is accepted for review but not promoted.

### Edge Cases

- A workspace document and a golden document contain statements with the same human-readable ID.
- A candidate note references a statement that is not present in golden knowledge.
- A golden statement changes and existing statements that use it need review.
- A candidate is rejected after being indexed as workspace material.
- A user edits a document in a way that breaks statement block parsing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST maintain a golden repository of accepted Coflat article-style notes.
- **FR-002**: System MUST maintain a separate workspace for drafts, attempts, automation logs, and candidate notes.
- **FR-003**: System MUST prevent workspace material from appearing as golden knowledge until explicitly approved.
- **FR-004**: System MUST allow users to create and edit workspace documents.
- **FR-005**: System MUST allow users to submit a candidate golden note from workspace material or as a new document.
- **FR-006**: System MUST require an authorized approval before a candidate note becomes golden knowledge.
- **FR-007**: System MUST record who approved or rejected each candidate and when the decision occurred.
- **FR-008**: System MUST parse Coflat statement blocks with human-readable IDs.
- **FR-009**: System MUST index statement text, source document, provenance, and `uses` dependencies.
- **FR-010**: System MUST distinguish golden statements from workspace statements in search and display.
- **FR-011**: System MUST provide search over golden notes and statements.
- **FR-012**: System MUST provide search over workspace material with clear workspace labeling.
- **FR-013**: System MUST expose the same user-level operations for humans and automation clients.
- **FR-014**: System MUST support BibTeX references for golden article-style notes.
- **FR-015**: System MUST make indexing errors visible to users instead of silently accepting malformed documents.

### Key Entities *(include if feature involves data)*

- **User**: An actor that can read, write, submit, review, or approve according to permissions. The system does not distinguish human and AI users semantically.
- **Golden Note**: An accepted Coflat article-style note available to golden search and RAG.
- **Workspace Document**: A draft, attempt, failed path, automation log, or candidate note that is not accepted knowledge.
- **Candidate Note**: A full article-style note submitted for approval into golden knowledge.
- **Statement**: A human-readable-ID statement extracted from a Coflat document.
- **Use Edge**: A dependency relation where one statement uses another and may need review if the used statement changes.
- **Approval**: A decision by an authorized user to accept or reject a candidate note.
- **Reference**: Bibliographic metadata used by notes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can add a golden note, index it, and find it through golden search within one end-to-end workflow.
- **SC-002**: A user can create a workspace attempt note without changing golden search results.
- **SC-003**: A candidate note approved by an authorized user appears in golden search after reindexing.
- **SC-004**: A candidate note rejected by an authorized user remains out of golden search.
- **SC-005**: For a note containing at least three statements and two `uses` references, the system displays the extracted statement list and dependency relation back to the user.
- **SC-006**: Human and automation users with equivalent permissions can perform the same create, submit, search, and read operations.

## Assumptions

- Coflat Markdown is the canonical document authoring format.
- Golden notes are full article-style documents, not direct promotion of raw workspace attempts.
- The first version tracks only the `uses` relation between statements.
- Approval applies to candidate notes as a whole for the first version.
- Automation-specific task planning and model execution are outside this feature.

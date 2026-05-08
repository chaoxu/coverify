# Feature Specification: Artifact Verification

**Feature Branch**: `002-artifact-verification`
**Created**: 2026-05-08
**Status**: Draft
**Input**: User description: "Create a spec for exploration and verification where exploration artifacts are immutable once reviewed, verifier outputs are first-class documents, wrong artifacts remain useful but status-labeled, agents can repair by creating new artifacts, and retrieval never presents untrusted artifacts as truth."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Submit Immutable Exploration Artifacts (Priority: P1)

A user or agent submits an exploration artifact for review. Once submitted, the artifact is frozen as the exact text that verifiers will inspect.

**Why this priority**: Verifier output is only meaningful if it is tied to the exact artifact that was reviewed. This prevents drift between a document and the review that claims to check it.

**Independent Test**: Submit an artifact, attempt to change it after review starts, and confirm the submitted version remains unchanged while a new revision can be created separately.

**Acceptance Scenarios**:

1. **Given** a draft artifact exists, **When** a user submits it for review, **Then** the system records an immutable submitted artifact with a stable identity.
2. **Given** a submitted artifact has a review, **When** a user wants to fix it, **Then** the system creates a new artifact linked to the reviewed artifact rather than editing the reviewed artifact.
3. **Given** a submitted artifact has no reviews yet, **When** a user tries to edit it, **Then** the system keeps the submitted artifact unchanged and offers to create a new draft or revision.
4. **Given** a long Markdown exploration note exists outside the store, **When** a user or agent creates a draft from that file, **Then** the draft preserves the file body as the artifact content.

---

### User Story 2 - Record Verifier Reports As Documents (Priority: P2)

A verifier reviews an artifact and writes a structured report that can be read by humans and agents.

**Why this priority**: Exploration is not only about proving final theorems. Verifiers must be able to check reductions, lemmas, failed directions, counterexamples, computations, literature claims, and proof candidates.

**Independent Test**: Review a submitted artifact and confirm the report records the artifact reviewed, verifier identity, verdict, critical errors, gaps, repair hints, and reusable parts.

**Acceptance Scenarios**:

1. **Given** a submitted artifact, **When** a verifier rejects it, **Then** the rejection report is stored as a durable document linked to that artifact.
2. **Given** a submitted artifact, **When** a verifier is uncertain, **Then** the report records `unsure` and explains what would be needed to decide.
3. **Given** an artifact is approved, **When** a user inspects it, **Then** the approval report is visible with the artifact.

---

### User Story 3 - Retrieve With Trust Status (Priority: P3)

A user or agent searches exploration records and sees each artifact together with its current trust status and latest relevant review summary.

**Why this priority**: Wrong artifacts are useful, but dangerous if retrieved as plain knowledge. Agents must see whether a document is approved, rejected, partial, superseded, or still unreviewed.

**Independent Test**: Search for a topic that has both approved and rejected artifacts and confirm every result is labeled before the artifact text is shown.

**Acceptance Scenarios**:

1. **Given** a rejected artifact matches a search query, **When** it is returned, **Then** the result prominently says it must not be used as true and shows the reason.
2. **Given** an approved artifact matches a search query, **When** it is returned, **Then** the result shows the approval status and the verifier reports supporting that status.
3. **Given** a superseded artifact matches a search query, **When** it is returned, **Then** the result points to the newer artifact.
4. **Given** a user searches accepted golden knowledge, **When** rejected or partial artifacts match the query, **Then** they do not appear as accepted golden results unless the user explicitly includes exploration records.

---

### User Story 4 - Repair Through Linked Revisions (Priority: P4)

A user or agent repairs an artifact by creating a new artifact that links back to the review that motivated the repair.

**Why this priority**: Exploration is iterative. The system should preserve the failed attempt, the verifier feedback, and the repair so future agents can learn from the whole chain.

**Independent Test**: Reject an artifact, create a repair, review the repair, and inspect the chain from original artifact to review to repaired artifact.

**Acceptance Scenarios**:

1. **Given** an artifact has a review with repair hints, **When** a user creates a repair, **Then** the new artifact links to both the original artifact and the motivating review.
2. **Given** a repair is approved, **When** the original rejected artifact appears in retrieval, **Then** it remains visible as rejected and points to the approved repair.

---

### User Story 5 - Invoke CLI Workers (Priority: P5)

A user starts a CLI-backed explorer or verifier from the same artifact workflow.

**Why this priority**: The harness is only useful as automation if worker output from Codex, Claude, Gemini, or later backends is written back into the same document and review store used by humans.

**Independent Test**: Run a CLI explorer on a prompt and a CLI verifier on one submitted artifact, then confirm the generated artifact or review is stored like any other user output.

**Acceptance Scenarios**:

1. **Given** exploration records exist, **When** a user invokes a CLI explorer with a prompt and backend, **Then** the system calls that backend in YOLO/non-interactive mode and stores the final response as a new draft artifact.
2. **Given** a submitted artifact exists, **When** a user invokes a CLI verifier with a backend, **Then** the system calls that backend in YOLO/non-interactive mode and stores the verifier result as a review document.
3. **Given** the selected CLI backend is unavailable or fails, **When** a worker invocation is attempted, **Then** the system reports the failure and does not create a misleading approved artifact or review.

### Edge Cases

- A verifier reviews an artifact that has already been superseded.
- Two verifiers disagree on the same artifact.
- A review says a document is mostly wrong but identifies one reusable subclaim.
- A repair fixes one gap but introduces a new error.
- An agent searches for a theorem and the best matching result is a rejected proof attempt.
- A submitted artifact has no reviews yet.
- A verifier report is malformed or missing a required verdict.
- An artifact has both approved and rejected reviews from different verifiers.
- Selected worker CLI is missing, unauthenticated, or returns output that cannot be parsed as a verifier report.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow users and agents to create draft exploration artifacts.
- **FR-002**: System MUST allow a draft artifact to be submitted for review as an immutable artifact.
- **FR-003**: System MUST prevent the text of a submitted artifact from being changed immediately after submission, even before any verifier starts a review.
- **FR-004**: System MUST allow a repair or revision to be created as a new artifact linked to the artifact it repairs.
- **FR-005**: System MUST support artifact types including proof candidate, lemma, reduction, counterexample, failed direction, computation, literature claim, definition, and formulation.
- **FR-006**: System MUST allow a verifier to review any submitted artifact type, not only full proof candidates.
- **FR-007**: System MUST store each verifier output as a durable review document.
- **FR-008**: Each review document MUST identify the reviewed artifact, verifier, verdict, date, summary, critical errors, gaps, repair hints, and reusable parts.
- **FR-009**: Review verdicts MUST include `approve`, `reject`, and `unsure`.
- **FR-010**: System MUST support multiple review documents for the same artifact.
- **FR-011**: System MUST reject malformed review documents from trust-status calculation and make the invalid review visible as a review error.
- **FR-012**: System MUST derive and display an artifact trust status from submitted artifacts and valid review documents.
- **FR-013**: Artifact trust status MUST include at least `draft`, `submitted`, `approved`, `rejected`, `partial`, `unsure`, `disputed`, and `superseded`.
- **FR-014**: System MUST derive `partial` when valid review documents do not approve the whole artifact but identify reusable parts.
- **FR-015**: System MUST derive `disputed` when current valid review documents contain conflicting whole-artifact verdicts.
- **FR-016**: System MUST treat verifier approval as evidence about an artifact, not as automatic promotion into golden knowledge.
- **FR-017**: System MUST require the separate autoprover golden handoff boundary before any artifact becomes accepted golden knowledge.
- **FR-018**: System MUST distinguish artifact correctness from artifact usefulness, so rejected or partial artifacts can still record reusable findings.
- **FR-019**: Exploration retrieval results MUST show trust status and review summary before or alongside artifact content.
- **FR-020**: Retrieval MUST NOT present rejected, partial, unsure, disputed, submitted, or draft artifacts as accepted truth.
- **FR-021**: Retrieval MUST show links between an artifact, its reviews, repairs, and superseding artifacts.
- **FR-022**: Golden search MUST include only accepted golden knowledge by default; exploration records may appear only in an explicitly labeled exploration or mixed search mode.
- **FR-023**: System MUST allow approved artifacts and their supporting review documents to be referenced by accepted knowledge after the separate golden approval boundary is satisfied.
- **FR-024**: System MUST keep rejected and unsure review documents searchable as exploration records.
- **FR-025**: System MUST make verifier disagreement visible rather than collapsing it into a single hidden decision.
- **FR-026**: System MUST include the coin-denomination FPT problem as a benchmark exploration case with current known status: net formulation reusable, generating-function and symbolic carry-DP proof attempts not approved.
- **FR-027**: The coin-denomination FPT benchmark MUST include at minimum one artifact for the reusable net formulation, one artifact for each not-approved proof direction, and review documents explaining the status of each.
- **FR-028**: System MUST allow a draft artifact body to be supplied from an existing Markdown file so long exploration notes can enter the same artifact workflow without inline command text.
- **FR-029**: System MUST provide CLI explorer invocation that sends a bounded prompt to a selected backend and stores the final response as a draft artifact.
- **FR-030**: System MUST provide CLI verifier invocation that sends one submitted artifact to a selected backend and stores the final verdict as a review document.
- **FR-031**: CLI verifier output MUST be parsed into the same review fields used by human reviewers: verifier, verdict, summary, critical errors, gaps, repair hints, and reusable parts.
- **FR-032**: System MUST fail closed when CLI worker invocation fails or verifier output cannot be parsed; failed worker calls MUST NOT create approval records.
- **FR-033**: System MUST support a common worker backend interface with at least Codex CLI, Claude CLI, and Gemini CLI adapters.
- **FR-034**: CLI worker adapters MUST invoke their backend in non-interactive YOLO mode so worker runs do not block on approval prompts.

### Trust Status Rules

- **Draft**: Artifact text is still mutable and has not been submitted for review.
- **Submitted**: Artifact has been frozen for review and has no valid review documents yet.
- **Approved**: The artifact satisfies the configured review policy with valid `approve` verdicts and has no current valid conflicting `reject` or `unsure` verdict from a verifier covered by that policy.
- **Rejected**: At least one current valid review rejects the whole artifact, no current valid review conflict makes it disputed, and no review identifies reusable parts that should make it partial.
- **Partial**: The whole artifact is not approved, but at least one current valid review identifies reusable parts that may safely inform later work.
- **Unsure**: Current valid review documents say the artifact cannot yet be approved or rejected, and there is no current valid conflicting approval or rejection.
- **Disputed**: Current valid review documents contain conflicting whole-artifact verdicts that cannot be summarized as approved, rejected, or partial.
- **Superseded**: A newer artifact explicitly replaces this artifact. Superseded artifacts keep their previous review history, and retrieval must point to the superseding artifact.

### Key Entities *(include if feature involves data)*

- **Artifact**: A unit of exploration work that can be reviewed. It may be a proof candidate, lemma, reduction, counterexample, failed direction, computation, literature claim, definition, or formulation.
- **Draft Artifact**: A mutable artifact before submission for review.
- **Submitted Artifact**: An immutable artifact snapshot that can receive verifier reports.
- **Review Document**: A verifier output document attached to one submitted artifact.
- **Valid Review Document**: A review document that contains all required fields and an allowed verdict; only valid review documents affect trust status.
- **Verifier**: A user account that reviews artifacts. The system does not semantically distinguish human and AI verifiers.
- **Worker Backend**: A CLI adapter that can run a prompt through a supported agent backend and return final text.
- **CLI Worker**: A verifier or explorer account backed by a non-interactive worker backend call.
- **Review Policy**: The configured verifier requirements used to decide whether an artifact has enough valid approval evidence.
- **Verdict**: The verifier decision: `approve`, `reject`, or `unsure`.
- **Trust Status**: The status shown during search and reading: `draft`, `submitted`, `approved`, `rejected`, `partial`, `unsure`, `disputed`, or `superseded`.
- **Repair Artifact**: A new artifact that attempts to fix or improve an earlier artifact and links to the review that motivated it.
- **Artifact Chain**: The linked history of artifact, review, repair, later review, and possible supersession.
- **Reusable Part**: A portion or claim from an artifact that a verifier says may safely inform future work even if the artifact as a whole is not approved.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can submit an artifact for review and later confirm the reviewed text has not changed.
- **SC-002**: A verifier can review an artifact and produce a structured report with verdict, errors, gaps, repair hints, and reusable parts.
- **SC-003**: A rejected artifact appears in search with a visible warning and does not appear as accepted truth.
- **SC-004**: A repair artifact can be traced back to the original artifact and the review that motivated the repair.
- **SC-005**: For a topic with at least one approved artifact and one rejected artifact, search results show the different trust statuses correctly.
- **SC-006**: The coin-denomination FPT benchmark records at least one reusable artifact and at least one rejected or unsure proof direction with verifier rationale.
- **SC-007**: A malformed review document is visible as invalid and does not change an artifact's trust status.
- **SC-008**: A verifier-approved artifact does not appear in golden search until it also passes the separate golden approval boundary.
- **SC-009**: A user can create a draft from an existing Markdown file and the resulting artifact contains the original file body.
- **SC-010**: A CLI explorer invocation creates a draft artifact containing the selected backend's final response.
- **SC-011**: A CLI verifier invocation creates a review document with a parsed verdict and does not create a review when parsing fails.
- **SC-012**: Codex, Claude, and Gemini backend adapters construct non-interactive YOLO commands through one shared worker interface.

## Assumptions

- Coflat Markdown remains the canonical document format for human-readable mathematical artifacts.
- Humans and agents are represented as users; verifier reports record account identity, not whether the account is human or AI.
- Drafts may be edited freely until submitted for review.
- Submitted artifacts are immutable; all repairs are new artifacts.
- Approval of an artifact does not require the entire investigation to be approved.
- Retrieval is status-aware by default for both humans and agents.
- Verifier approval is not the same as golden approval; verifier approval is evidence used by the separate golden approval workflow.
- Golden knowledge may reference approved artifacts together with the review documents that justify their acceptance after the golden approval boundary is satisfied.
- CLI worker accounts are ordinary verifier or explorer accounts; their identity is recorded by account name.

# Tool Harness Design

This project is being restarted conceptually. The old proof-harness code can
be mined for useful pieces, but the new system should be designed as a small
tool harness that lets Codex operate on Cosheaf. Cosheaf/Forgejo is the
durable workspace. Codex is the active operator. Model backends are pluggable
helpers that usually accept one context string and return one answer string.

The core invariant:

> If an agent action matters after the process exits, it must leave a
> Cosheaf/Forgejo artifact.

The harness exists to preserve progress across bounded and long-running model
runs. A single Codex or model-backend run may last tens of minutes, and some
oracle calls may run for more than an hour. Each run should leave behind enough
structured state that the next run starts from what was learned rather than
rediscovering it.

## Roles

- **Cosheaf** stores pages, branches, pull requests, reviews, issues, labels,
  milestones, comments, notifications, and merge state. It is the source of
  truth for both humans and agents.
- **Codex** decides what to do next and uses the harness tools to read and
  mutate Cosheaf.
- **Model backends** are optional helpers. A backend may be Gemini, an API
  call, a CLI, a local script, a remote job, or a future stronger system. The
  simplest backend contract is stdin context in, stdout answer out.
- **Oracle calls** are one use of model backends: ask a strong model for
  reasoning over a prepared context pack, then record the raw answer in
  Cosheaf.
- **The harness** provides context packing, Cosheaf API adapters, backend
  invocation, run logging, timeout/cancellation handling, and checkpoint
  writing. It should not become a second workflow database.

## Durable State

Most state should map directly to Cosheaf/Forgejo primitives:

| Need | Durable primitive |
| --- | --- |
| Accepted knowledge | Markdown pages merged to `main` |
| Active attempt | Branch |
| Proposed change | Pull request |
| Verification decision | Pull request review |
| Localized objection | Pull request line comment |
| Exploration backlog | Issue |
| Subgoal graph | Issue dependencies / blocking links |
| Research program | Milestone |
| State classification | Labels on issues and PRs |
| Agent inbox | Notifications |
| Failed attempt memory | Closed PRs, closed issues, request-changes reviews |
| Backend/oracle result | Issue or PR comment, optionally linked to a branch/PR |
| Run checkpoint | Issue or PR comment with summary and next step |

This is not only storage. It is the interface that lets humans inspect and
edit agent state using the same UI they use for their own work.

## Ephemeral State

An autoprover-side store is allowed only for state about a currently running
process:

- run id
- agent name / role
- current status
- backend command or provider name
- heartbeat or timeout
- cancellation flag
- stdout/stderr/log pointer
- partial output pointer, if the backend streams or writes progress
- linked Cosheaf artifacts, such as issue number, branch name, PR number, or
  review id

When a run ends, the meaningful result must be written back to Cosheaf. If a
piece of state is needed tomorrow, it does not belong only in the ephemeral
store.

Rejected durable stores for v1:

- a separate task queue
- an autoprover-owned issue graph
- a proposal/review table
- a branch or PR mirror
- hidden long-term agent memory
- a learned policy or ranking database

If future work adds durable local state, the design must first explain why the
state cannot be represented as a Cosheaf page, branch, PR, review, issue,
label, milestone, notification, or comment.

## Tool Surface

The first real product surface should be a set of tools that Codex can call.
The names below are design-level, not a frozen CLI or Python API:

- `search_pages`
- `read_page`
- `list_ready_issues`
- `create_issue`
- `comment_on_issue`
- `label_issue`
- `create_branch_for_issue`
- `list_my_branches`
- `read_branch_file`
- `write_branch_file`
- `open_pull_request`
- `list_reviewable_pull_requests`
- `read_pull_request_context`
- `review_pull_request`
- `comment_on_pull_request_line`
- `label_pull_request`
- `merge_pull_request`
- `checkpoint_artifact`
- `run_backend`
- `ask_oracle`

These tools should talk to Cosheaf, not directly to Forgejo. They may expose
Forgejo-shaped concepts because Cosheaf intentionally uses Forgejo concepts:
branches, PR numbers, labels, review states, issue comments, and merge
preconditions.

## Context Packs

Context management is the main hard problem. The harness must build compact,
auditable context packs from Cosheaf state for Codex and for oracle calls.

A context pack should include:

```text
Objective
Current artifacts
Accepted facts
Open hypotheses
Relevant pages
Relevant issues
Relevant PRs and reviews
Failed attempts
Current branch or PR diff
Constraints
Question for this run
Expected output shape
```

The pack should cite artifact ids and paths so the answer can be written back
to the right place. It should prefer summarized history, but preserve links to
raw Cosheaf artifacts when the model needs to drill down.

The pack is not private memory. If a context summary is useful after the run,
write it as a checkpoint comment or markdown page.

## Model Backends

Backends are pluggable. The harness should not bake in Gemini, OpenAI, Codex,
or any one provider. A backend adapter should be small and replaceable.

The minimum backend contract:

```text
stdin:  context pack string
stdout: answer string
exit 0: completed
exit nonzero: failed, with stderr/logs preserved
```

This is enough for a Python script, shell wrapper, API client, Gemini CLI,
OpenAI API wrapper, remote job poller, or future model service. Richer
adapters may support streaming, structured metadata, or cancellation, but the
core workflow should still work with plain text in and plain text out.

Backends may run for a long time. The harness must treat backend invocation as
a job:

- record start time, backend name, and linked Cosheaf artifact
- preserve stdout/stderr or a log file while the job runs
- emit heartbeat/status so a supervisor can tell whether it is still alive
- support timeout and cancellation where the backend allows it
- record failure or timeout as a Cosheaf checkpoint when it affects work
- record successful output as a Cosheaf comment or page before acting on it

Do not assume backend calls are quick request/response operations. A useful
oracle answer may arrive after 80 minutes, and the system should still leave
an inspectable trail.

## Oracle Calls

An oracle call is a model-backend invocation with a specific purpose: ask for
reasoning over the current context. It is normally a stateless text exchange:

```text
context pack string -> backend -> answer string
```

The harness should record every oracle call that affects work:

1. Build the context pack from Cosheaf.
2. Send the pack to the selected backend.
3. Store the raw answer as an issue or PR comment.
4. Have Codex decide how to act on it.
5. Store the decision or follow-up action in Cosheaf.

The selected backend should be asked for stable sections where useful:

```text
JUDGMENT:
USEFUL_OBSERVATIONS:
LIKELY_DEAD_ENDS:
NEXT_STEPS:
CONFIDENCE:
```

The harness should not treat backend output as truth. It is evidence or advice
that Codex can cite, test, reject, or convert into a PR/review/comment.

## Workflow Skills

Repeatable behavior should live as skills or workflow recipes, not hidden
state machines. Initial skills:

- **Explore issue**: read an issue, gather context, create or continue a
  branch, run Codex/backend work, write a checkpoint.
- **Ask oracle**: build a context pack, call the selected backend, store the
  answer, and summarize the actionable result.
- **Review PR**: gather PR diff, related pages, prior reviews, optional oracle
  advice, then submit a review or line comments.
- **Repair PR**: read request-changes reviews, update the same branch, and
  comment with what changed.
- **Checkpoint**: before a run exits, write what was tried, what was learned,
  and the next concrete action.
- **Abandon path**: close or label an issue/PR with evidence that the direction
  is not worth further effort.
- **Continue from artifact**: start from an issue, branch, PR, notification, or
  comment and reconstruct the current context.

Skills should specify which Cosheaf artifacts they read, which artifacts they
may write, and what checkpoint they must leave behind.

## State Transitions

The durable workflow should be native Cosheaf operations:

```text
issue opened
  -> branch created for attempt
  -> commits/files written on branch
  -> PR opened
  -> review submitted
  -> request changes -> same branch repaired -> review again
  -> approved -> merged
  -> issue closed or updated
```

Other paths are also Cosheaf-native:

- oracle says "not worth it" -> issue comment + label or close
- verifier cannot decide -> PR comment/review + `needs-human` or `abstain`
  label
- exploration splits -> child issues + dependency links
- partial result useful -> new page/PR plus remaining issue still open
- run times out -> checkpoint comment with next step

The harness should avoid inventing state names that do not map to one of these
artifacts.

## Build Order

1. Start a minimal new implementation path for branch/PR/issue-native Cosheaf
   tools. Reuse old code only when it cleanly fits the new model.
2. Add the small run-state store for active long-running backend jobs, with
   logs, heartbeat, timeout, cancellation, and Cosheaf artifact links.
3. Rewrite the smoke harness so it validates the current Cosheaf API and
   leaves inspectable issues, branches, PRs, reviews, and pages.
4. Implement context-pack construction for issues and PRs.
5. Add pluggable backend invocation with the stdin/stdout script contract
   first.
6. Add `ask_oracle` as a backend-backed workflow with durable Cosheaf comments.
7. Add checkpoint behavior to every long-running command.
8. Move workflow policy into skills: explore issue, review PR, repair PR,
   abandon path, continue from artifact.
9. Only then reintroduce proof-specific benchmark and verifier improvements on
   top of the tool harness.

## Non-Goals

- No separate durable task database.
- No autoprover-owned review queue.
- No hidden agent memory that humans cannot inspect.
- No provider-specific oracle design in the core. Gemini, APIs, CLIs, and
  scripts are backend adapters.
- No direct Forgejo access from the harness unless Cosheaf lacks a required
  workspace-scoped operation and we have chosen to add it to Cosheaf later.
- No proof-specific architecture in the core tool layer. Proof work is a use
  case built from pages, issues, branches, PRs, reviews, labels, and context
  packs.

# Design & handoff: minimal math harness for repo-grounded chat

> **Status:** strict v1 direction agreed in discussion; first local
> repo-oracle/branch-chat harness implemented with script-backed verification
> and smoke coverage. Strong Pro/uploaded-file backend is still future work.
> **Scope:** Coverify as the math harness, with Cosheaf chat as one activation
> surface. The goal is not to rebuild Codex or Claude Code.
> **Repos:** `coverify` owns the harness and oracle/verifier orchestration.
> `cosheaf` owns repos, branches, issues, PRs, rendered documents, and the chat
> UI. **Prod host:** `jupiter`; `saturn` is dev only.

## 1. Product goal

The user should be able to advance mathematics without manually managing LLM
context.

Today, a mathematician using ChatGPT manually:

- Copies definitions, lemmas, examples, and current notes into a chat.
- Starts another chat to verify or critique an argument.
- Decides what context is relevant and what can be omitted.
- Tracks which answer was based on which documents.
- Later turns useful discussion into durable notes or a PR.

Coverify v1 should automate only the parts that clearly save time:

- Prepare the relevant context from the allowed source files.
- Ask the right kind of reasoner: cheap model, strong one-shot oracle, or agent.
- Run a verifier before returning a substantive answer.
- Record what source bundle and verification profile were used.

If v1 is not noticeably better than "open ChatGPT and paste the files yourself,"
there is no reason to build a broader v2.

## 2. Core idea

Coverify is a **minimal math harness**.

It is not a general coding harness, terminal agent, editor, issue tracker, or
repo UI. It is an orchestration layer that turns a mathematical user request
plus allowed files into a small sequence of role calls:

```text
user goal + source bundle + thread context
  -> gather relevant context
  -> frame the mathematical question
  -> choose a reasoning role
  -> verify the candidate answer
  -> publish the verified result
```

Different activation surfaces can call the same harness:

- Cosheaf chat: a user asks inside a branch-scoped chat issue.
- CLI / Codex skill: a user runs Coverify on a local folder or checkout.
- Issue command: a label or comment asks Coverify to work on a specific task.
- Webhook / cron: unattended runs can check changed or unresolved material.

These are only activation paths. They should not each reimplement math-chat
logic.

## 3. Minimal model

The harness should not require Git, Forgejo, or Cosheaf internally. Those belong
to adapters. The core harness needs only these inputs:

```text
Task
  user_request: text
  thread_context: prior messages from this same run/thread, if any
  policy: what sources may be used and what must be verified

SourceBundle
  source_id: opaque stable id, e.g. "cosheaf:workspace:branch:tree"
  root: directory or uploaded-file set containing allowed files
  manifest: file paths, sizes, hashes, optional titles/headings
  description: human-readable scope, e.g. "branch main at abc123"

PublicationTarget
  where to write the final answer, e.g. stdout, issue comment, chat response
```

That is enough for v1. The harness does not need to know "workspace," "branch,"
"snapshot," "PR," or "issue" as first-class concepts. The Cosheaf adapter maps
workspace + branch + issue thread into a `SourceBundle`, `Task`, and
`PublicationTarget`.

## 4. What to store

Store the minimum needed for trust and replay. Do not create a large run database
unless a later implementation proves it is needed.

Required durable record:

- Final answer.
- Source bundle id or snapshot id.
- Visible concise source list when useful.
- Hidden machine-readable metadata: source id, file hashes or tree hash,
  verifier profile, tier, and tool version.

For Cosheaf chat, store this in Forgejo-backed issue bodies/comments, preferably
using hidden Markdown HTML comments for machine metadata. The chat issue itself
is the durable thread.

Do not store by default:

- Full gathered context dumps.
- Full prompts.
- Temporary scratch files.
- A separate Coverify conversation database.
- Duplicate copies of repo files.

Those can be kept in short-lived logs or debug artifacts while developing, but
they should not become the product model.

## 5. Source policy for v1

Cosheaf chat v1 is strict:

- The user chooses a branch when creating the chat.
- The chat never switches branches.
- Each reply resolves the current tip of that branch and exports a source
  bundle from files currently inside that branch.
- Prior messages in the same chat issue are allowed.
- General mathematical knowledge is allowed.
- New reasoning derived from the files and current chat is allowed.

Forbidden for v1:

- Other issues, PRs, reviews, comments, notifications, or timelines.
- Git history, deleted files, reflogs, or other branches.
- Sibling repos, local notes, Codex memory, user home files, secrets, or web.
- Any source outside the exported source bundle and the current chat issue.

Repo-specific claims must be supported by the source bundle. Prior chat messages
are discussion context, not established repo knowledge unless the source bundle
supports them.

If source files conflict, the system may reason about the conflict, but must
report it as a conflict unless the files themselves resolve it.

Chat never writes repo files. Useful math remains in the issue discussion until a
separate PR-producing agent or human promotes it into the repo.

## 6. Roles

The harness schedules roles. A role can be implemented by Codex, Claude Code, a
ChatGPT project, a one-shot model API, a local script, or a fixture.

### Gatherer

Finds the relevant material in the source bundle and frames the task.

For v1, it should output:

- Relevant excerpts or summaries with file paths.
- Missing-context warnings.
- Conflicts found in the source files.
- A short framed question for the reasoner.
- A tier recommendation: light or strong.

The gatherer can be an agent, but it must be restricted to the source bundle. It
must not have network, Forgejo/Cosheaf API tokens, or filesystem access outside
the bundle. This should be enforced by the runner, not only by prompt text.

### Reasoner

Produces a candidate answer.

Possible implementations:

- Light model for simple explanation or local summarization.
- Strong one-shot reasoning oracle for proof/disproof/substantive math.
- Agentic reasoner when tool use or computation is needed.

One-shot oracles are not inferior agents. They are powerful function calls when
the harness prepares the input correctly.

### Verifier

Checks the candidate answer before publication.

Verification must never be skipped for substantive answers. The verifier should
reject if:

- A repo-specific claim is unsupported by the source bundle.
- The answer uses forbidden sources.
- The proof or reasoning step is invalid.
- The answer hides uncertainty or source conflicts.
- The answer does not answer the user's question.

Verifier implementations have different guarantees:

- Agent verifier: may inspect the same restricted source bundle directly.
- Oracle verifier: can only verify against context injected into its prompt.

The harness must preserve that distinction instead of pretending they are the
same.

## 7. Strong oracle and uploaded files

Some strong math oracles are only usable as one-shot functions:

```text
prepared context + precise question -> answer
```

The harness exists partly because those oracles cannot browse the repo or manage
context themselves.

A ChatGPT project or uploaded-file set may be useful as a strong-oracle backend:
the harness can upload the whole source bundle and ask the oracle to reason over
it without stuffing every file into a single prompt.

Rules for v1:

- Uploaded files must exactly match the source bundle.
- The upload/project must be keyed by `source_id` or tree hash.
- Stale files must not silently mix with a newer source bundle.
- An independent verifier still checks the final answer.

Treat uploaded files as an index/cache for the source bundle, not as persistent
project memory.

## 8. Cosheaf chat adapter

Cosheaf is the interface and knowledge substrate, not the math harness.

For chat activation, Cosheaf should:

- Let the user create a chat issue on a selected branch.
- Store branch metadata in the issue.
- On each user turn, call Coverify with:
  - the current chat issue thread,
  - an exported source bundle for the selected branch tip,
  - a publication target for the bot reply.
- Render the final answer and concise source list.
- Keep hidden machine metadata in Markdown comments.

Coverify should not call unrelated Cosheaf issue/PR APIs in v1. Cosheaf passes
the allowed thread and source bundle in; the harness works inside that boundary.

## 9. Success criteria

The v1 bar is practical, not grand:

- A mathematician can ask a question about current project files without
  manually pasting context.
- The answer cites or records the source bundle it used.
- The system can escalate from light reasoning to a strong oracle when needed.
- A verifier can veto unsupported or invalid answers.
- The answer is useful enough that the user would prefer it over manually
  managing a ChatGPT context window.

## 10. Suggested build order

1. **Core harness interface:** implement a small CLI/API that accepts a task,
   source bundle path, optional thread text, and publication mode.
2. **Source bundle exporter:** in Cosheaf, export the selected branch tip into a
   restricted directory plus a manifest.
3. **Gatherer v1:** simple agent or retrieval pass that outputs excerpts,
   conflicts, missing-context warnings, and a framed question.
4. **Verifier gate:** require a verifier pass before returning substantive
   answers.
5. **Cosheaf chat branch metadata:** add branch selection at chat creation and
   pass the branch source bundle to Coverify.
6. **Strong oracle wiring:** make the ChatGPT/Pro backend invokable for strong
   math turns.
7. **Optional uploaded-file backend:** cache uploaded source bundles per
   snapshot/source id.

Keep each step useful on its own. Do not build a general workflow engine before
showing that automated context gathering plus verification beats manual ChatGPT
use.

## 11. Current implementation pointers

- Cosheaf chat UI: `cosheaf/server/routes/web.ts`.
- Coverify chat reply path: `coverify/src/coverify/integration/chat.py`.
- Repo-snapshot harness: `coverify/src/coverify/integration/repo_oracle.py`.
- Verifying oracle: `coverify/src/coverify/engine/verifying.py`.
- Backend abstraction: `coverify/src/coverify/engine/backend.py`.
- CLI/profile wiring: `coverify/src/coverify/cli.py`.
- Strong backend script path: `coverify/scripts/chatgpt_oracle_backend.py`.
- Prod host for worker/oracles: `jupiter`.

## 12. Operator and Codex usage contract

The internal machinery can be complicated. The operator interface must be boring.
Codex, another harness, a human shell session, and the Cosheaf worker should all
drive the same command/API.

Primary CLI shape:

```sh
coverify chat ask \
  --workspace poa-network-game-clean \
  --branch main \
  --message "Can we prove the reserve-overlap lemma from the current docs?"
```

Implemented local-source shape:

```sh
coverify repo-oracle ask \
  --source-bundle /path/to/exported/source \
  --message "Can we prove the reserve-overlap lemma?" \
  --backend script \
  --backend-command "..." \
  --verifier-backend script \
  --verifier-command "..." \
  --json
```

Automation shape:

```sh
coverify chat ask \
  --workspace poa-network-game-clean \
  --branch main \
  --message-file question.md \
  --json
```

Local-source shape, useful when Codex already has a checkout or a test fixture:

```sh
coverify repo-oracle ask \
  --source-bundle /tmp/coverify-source-bundle \
  --thread-file thread.md \
  --message-file question.md \
  --json
```

The JSON result should be stable enough for other harnesses:

```json
{
  "ok": true,
  "answer": "...",
  "verification": "passed",
  "tier": "light",
  "source_id": "cosheaf:poa-network-game-clean:main:abc123",
  "workspace": "poa-network-game-clean",
  "branch": "main",
  "snapshot": "abc123",
  "issue_number": 42,
  "comment_url": "https://cosheaf.lab/owner/repo/chat/42#comment-99",
  "sources": [
    {
      "path": "notes/foo.md",
      "line_start": 10,
      "line_end": 30
    }
  ],
  "warnings": []
}
```

From Codex, normal use should be:

1. User asks Codex to check or reason about something using Coverify.
2. Codex runs the Coverify command with workspace, branch, and question.
3. Coverify creates or appends to the branch-scoped chat issue, gathers context,
   runs the reasoner and verifier, posts the durable answer, and returns JSON.
4. Codex reads the answer and continues ordinary work.

Codex skills are optional convenience wrappers. A skill may teach Codex when and
how to call `coverify chat ask`, but the skill must not contain the harness
logic. The harness is the CLI/API; Codex is only one caller.

The command must hide:

- source export details,
- gatherer prompts,
- light vs strong profile internals,
- uploaded-file/project management,
- Forgejo metadata comments,
- retry and verifier loop details.

The command must expose:

- final answer,
- verification status,
- source id / snapshot,
- visible source list,
- durable issue/comment location when one exists,
- enough warning text to know whether the answer is partial or refused.

If this interface cannot remain simple, the architecture is too complicated.

## 13. End-to-end acceptance run

Before calling v1 done, run a real demonstration in a live or fixture workspace:

1. Create or choose a workspace with several math documents on a branch.
2. Ask a simple lookup/explanation question from Codex through the CLI.
3. Confirm the answer uses current repo files and returns sources.
4. Ask a proof-oriented question that requires new reasoning.
5. Confirm the strong path can run or intentionally escalates.
6. Seed an unsupported claim or conflicting document pair.
7. Confirm the verifier refuses, reports missing support, or reports the
   conflict instead of smoothing it over.
8. Confirm no issue/PR/history/web/local-home access was used.
9. Confirm Cosheaf chat shows the answer while hiding machine metadata.
10. Confirm the JSON result is enough for Codex or another harness to continue.

The acceptance standard is not "the architecture is elegant." It is:

```text
workspace + branch + question -> verified answer + sources + durable issue record
```

If that loop works from Codex without the user managing context manually, the
first version is useful. If it does not, cut scope until it does.

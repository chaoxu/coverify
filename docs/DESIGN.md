# autoprover v2 design

## Problem Statement

The project should automate proof-repository maintenance without bypassing the
standards of the repository it changes. A useful autoprover is not merely an LLM
answer generator. It is a system that can make a concrete change, verify it with
the same commands a maintainer would run, and publish the result with enough
evidence for review.

## Design Principles

1. Verification is the product. Any solver output that has not been checked by
   the target repository is only a suggestion.
2. Keep forge integration thin. Gitea should be an adapter, not the core domain.
3. Use real workspaces. Solving and reviewing should happen in a checked-out
   repository with normal git operations and normal verification commands.
4. Preserve evidence. Every run should record the issue or PR input, attempted
   patch, commands run, verifier output, and final decision.
5. Be conservative about publishing. Default workflows should support dry-run
   and local-only modes before pushing branches or posting reviews.

## Core Model

`Task`
: A unit of work such as "solve issue #42" or "review PR #7".

`Workspace`
: A local checkout of the target repository at a specific base revision or PR
  head. It owns git operations, patch application, and cleanup.

`ContextBuilder`
: Collects task-relevant files, issue discussion, PR diffs, repository metadata,
  and verification instructions.

`Solver`
: Proposes changes. It may call an LLM, a theorem prover tactic search, a custom
  script, or a combination of tools.

`Verifier`
: Runs repository-specific commands such as `lake build`, `lean`, `pytest`, or a
  project-defined script. It returns structured pass/fail output.

`Publisher`
: Pushes branches, opens PRs, posts reviews, and comments with run evidence.

`RunRecord`
: Durable metadata for a run: inputs, patch, commands, logs, outcome, and
  published URLs.

## Main Workflows

### Solve Issue

1. Fetch issue title, body, labels, and comments from Gitea.
2. Prepare a workspace from the target base branch.
3. Build context from repository files and issue discussion.
4. Ask the solver for a patch, not just prose.
5. Apply the patch in the workspace.
6. Run verification.
7. If verification fails, feed the failure back to the solver and iterate within
   configured limits.
8. If verification passes, commit, push, and open a PR with the verification
   evidence.

### Review PR

1. Fetch PR metadata, diff, and changed file list.
2. Prepare a workspace at the PR head.
3. Run repository verification.
4. Inspect the diff and full changed-file context.
5. Produce a review that distinguishes verified failures from model judgment.
6. Post `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` according to policy.

## CLI Shape

The CLI should eventually move from several script entry points to one command
tree:

```text
autoprover issue list OWNER/REPO
autoprover issue solve OWNER/REPO ISSUE --dry-run
autoprover pr list OWNER/REPO
autoprover pr review OWNER/REPO PR --local-only
autoprover queue run OWNER/REPO
autoprover doctor
```

The existing script names can remain as compatibility wrappers while the v2 CLI
is introduced.

## Package Shape

```text
autoprover/
  cli.py
  config.py
  domain.py
  forge/
    gitea.py
  model/
    chatgpt_cli.py
  workspace/
    git.py
  proof/
    commands.py
  workflows/
    solve_issue.py
    review_pr.py
  records.py
```

## Near-Term Migration Plan

1. Keep the current Gitea and ChatGPT connectivity working.
2. Add missing forge operations and make Gitea API behavior explicit.
3. Introduce domain dataclasses and result objects before adding more workflow
   logic.
4. Add a workspace abstraction that clones/checks out the target repository in a
   temporary location outside this repo.
5. Change solving from "create a markdown answer" to "produce and verify a
   patch".
6. Add a `doctor` command that checks `tea`, `git`, `chatgpt-cli`, and verifier
   command availability.
7. Add tests around URL construction, task parsing, Gitea request payloads, and
   publish/no-publish mode behavior.

## Open Decisions

- Which proof ecosystems are first-class targets: Lean/Lake, Coq, Isabelle, or
  arbitrary command-based projects?
- Should solver output be constrained to unified diff patches, direct file
  edits in a workspace, or both?
- Where should run records live: local cache, Gitea comments, branch artifacts,
  or a small database?
- What policy decides whether a PR review should approve versus comment versus
  request changes?

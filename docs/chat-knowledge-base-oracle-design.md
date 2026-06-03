# Repo-Grounded Chat

This note records the narrow chat contract for Coverify. The broader
architecture lives in [Design](design.md).

## Goal

A user should be able to ask a mathematical question about a selected branch or
source bundle without manually pasting files into a model. Coverify prepares the
allowed context, explores the question, calls tools such as a reasoner,
prover/resolver, computation, or verifier when useful, verifies the result, and
returns a response with source metadata.

The useful loop is:

```text
question + thread + source bundle
  -> agentic context preparation
  -> exploratory response, or mathematical resolution for a packaged target
  -> independent verifier with the matching contract
  -> response/comment with source metadata
```

## Inputs

```text
Task
  user_request
  prior thread text from the same chat, if any
  source policy

SourceBundle
  source_id
  restricted root directory
  manifest with paths, sizes, hashes, and optional headings

PublicationTarget
  stdout, issue comment, or chat response
```

Cosheaf maps workspace, branch, issue, and current tree into these inputs. The
core chat tool should not need to know Forgejo internals.

## Source Policy

Allowed by default:

- files in the exported source bundle
- prior messages in the same chat thread
- general mathematical knowledge
- new reasoning derived from the allowed material

Forbidden by default:

- unrelated issues, PRs, reviews, comments, or timelines
- other branches or old snapshots
- sibling repos and local scratch files
- user home files or secrets
- web search

Repo-specific claims must be supported by the source bundle. Prior chat text is
discussion context, not accepted repo knowledge unless the source bundle also
supports it.

## Context Preparation

The gatherer should be agentic. It receives the allowed source-bundle root,
inspects files directly, and returns:

- exact passages with path and line ranges
- missing-context warnings
- source conflicts
- a framed task for the response or mathematical-resolution call
- a light/strong tier recommendation when useful

Coverify then validates that selected paths and ranges exist. It should not
try to precompute all mathematical relevance in Python.

## Response Contracts And Verification

Normal chat uses the exploratory-response contract. It can answer the question,
summarize source-backed status, compare possible routes, mark gaps, or package
one exact mathematical target for a later prover/resolver. It must not present
speculation as established knowledge.

Mathematical resolution is used only when the task is already one exact hard
target. It asks for one resolution artifact from the canonical vocabulary in
`src/coverify/math_contract.py`, not general brainstorming.

The verifier checks the candidate before publication under the matching
contract.

The verifier rejects if:

- the answer uses forbidden sources
- repo-specific claims lack source support
- cited results do not match local hypotheses
- the claimed resolution artifact skips the key step, changes the target
  statement, or does not justify completion
- exploration is mislabeled as proof
- the answer hides uncertainty or source conflicts

The verifier should report the smallest useful failure so the next attempt can
focus on the real gap.

## Output

The public response should include:

- final answer
- source list or source metadata
- verification status
- warnings or refusal reason, if any
- durable comment URL when published to Cosheaf

The response should not expose raw prompts, full context dumps, backend scratch,
or hidden retry internals by default.

## Current Command Shapes

Local source bundle:

```sh
coverify repo-oracle ask \
  --source-bundle /path/to/exported/source \
  --message "What does this branch prove?" \
  --json
```

Gather inspection:

```sh
coverify repo-oracle gather \
  --source-bundle /path/to/exported/source \
  --message "Which files are relevant?"
```

Branch-scoped chat:

```sh
coverify chat ask \
  --workspace my-workspace \
  --branch main \
  --message "Can we prove the current lemma?"
```

The desired JSON result is stable enough for another tool to consume:

```json
{
  "ok": true,
  "answer": "...",
  "verification": "passed",
  "source_id": "cosheaf:my-workspace:main:abc123",
  "sources": [
    {
      "path": "notes/example.md",
      "line_start": 10,
      "line_end": 30
    }
  ],
  "warnings": []
}
```

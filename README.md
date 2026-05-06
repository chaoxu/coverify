# autoprover

`autoprover` is an automation tool for proof-oriented repositories hosted on
Gitea. The project is being redesigned around one central promise:

> Produce reviewable changes that have been checked by the target repository's
> own verification commands.

The original prototype connected Gitea issues and pull requests to an LLM. The
new direction keeps that integration, but treats LLMs as one part of a larger
loop: fetch context, edit a real checkout, run the verifier, iterate, and only
then publish or review.

## Target Workflows

- Solve an issue by creating a branch, applying a proof/code change, verifying
  it locally, and opening a pull request.
- Review a pull request by checking out the proposed change, running repository
  verification, inspecting the diff, and posting an evidence-based review.
- Run in dry-run or local-only mode so changes can be inspected before they are
  pushed to Gitea.

## Current State

This repository currently contains a small Python prototype:

- `autoprover-issues`: list Gitea issues.
- `autoprover-prs`: list Gitea pull requests or show a PR diff.
- `autoprover-solve`: read an issue and ask `chatgpt-cli` for a response.
- `autoprover-review`: ask `chatgpt-cli` to review a PR diff.

The prototype is useful as a connectivity spike, not yet as a reliable proof
automation system. See `docs/DESIGN.md` for the v2 architecture.

## Requirements

- Python 3.11 or newer.
- A configured `tea` CLI login for Gitea credentials.
- `chatgpt-cli` if using the current ChatGPT-backed solver/verifier.

## Development

Install in editable mode:

```bash
python -m pip install -e .
```

Run a compile check:

```bash
python -m compileall src
```

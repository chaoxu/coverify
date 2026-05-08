# Data Model: Artifact Verification

## Store

Folders:
- `drafts/`: mutable exploration drafts.
- `artifacts/`: submitted immutable artifacts.
- `reviews/`: verifier reports grouped by artifact id.
- `golden/`: accepted golden documents.

## Artifact

Fields:
- `id`: human-readable stable id.
- `title`: readable title.
- `type`: proof candidate, lemma, reduction, counterexample, failed direction, computation, literature claim, definition, or formulation.
- `created`: ISO timestamp.
- `source`: optional previous artifact or review id.
- `body`: Markdown content.

States:
- Draft files are mutable.
- Submitted artifact files are not changed by system commands.
- Repairs are new drafts or submitted artifacts linked to a source.

## Review Document

Fields:
- `id`: stable review id.
- `artifact`: reviewed artifact id.
- `verifier`: user or agent account id.
- `verdict`: `approve`, `reject`, or `unsure`.
- `created`: ISO timestamp.
- `summary`: human-readable summary.
- `critical_errors`: text list or empty.
- `gaps`: text list or empty.
- `repair_hints`: text list or empty.
- `reusable_parts`: text list or empty.

Validation:
- A review missing required fields or using an unknown verdict is invalid.
- Invalid reviews are visible but excluded from trust-status calculation.

## Trust Status

- `submitted`: no valid reviews.
- `approved`: at least one valid approval and no valid reject or unsure.
- `rejected`: valid reject exists, no valid approval conflict, and no reusable parts.
- `partial`: valid review identifies reusable parts while the whole artifact is not approved.
- `unsure`: valid unsure review exists without approval or rejection.
- `disputed`: valid reviews contain conflicting whole-artifact verdicts.

`draft` is represented by draft location, not by review status.

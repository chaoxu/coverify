# Cosheaf API Used By Autoprover

Autoprover talks to Cosheaf only through `/api/v1`.

## Required Configuration

- `COSHEAF_URL`
- `COSHEAF_WORKSPACE`
- `COSHEAF_TOKEN`

The token is sent as:

```text
Authorization: Bearer <token>
```

## Read APIs

```text
GET /w/:slug/search?q=<query>
GET /w/:slug/queue
GET /w/:slug/documents
GET /w/:slug/document/:id
GET /w/:slug/note?path=<path>
GET /w/:slug/document/:id/approvals
```

Autoprover uses these to retrieve context, find queued documents, map document
ids to paths, look up one document directly, read Markdown content, and load linked review documents when
repairing rejected work.

## Write APIs

```text
PUT  /w/:slug/note?path=<path>
POST /w/:slug/document/:id/submit
POST /w/:slug/proposal
POST /w/:slug/review
POST /w/:slug/document/:id/approve
POST /w/:slug/document/:id/reject
```

Autoprover uses these to create task/exploration pages, proposals, review
documents, and verifier decisions.

## Assumptions

- Cosheaf injects and owns YAML frontmatter.
- Autoprover-generated page and proposal bodies should not include frontmatter.
- Review documents are first-class Markdown documents.
- Approval/rejection rows are the tally; review documents hold the reasoning.

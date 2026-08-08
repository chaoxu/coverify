# Canonical analytics queries

Query in place (design.md "Analytics"): DuckDB over the authoritative
out-of-tree JSONL. No sync, no derived store; `meta.json` beside each
`gates.jsonl` names the campaign. All queries take seconds at any
realistic scale.

```sh
duckdb -c "SELECT ..."   # brew install duckdb; nothing else
```

Shared prelude (all campaigns; `filename` is the campaign column):

```sql
CREATE VIEW ev AS SELECT * FROM read_json_auto(
  '~/.local/state/coverify/*/gates.jsonl',
  format='newline_delimited', union_by_name=true, filename=true);
```

Worker outcomes (ok vs infra-failed) per campaign:

```sql
SELECT filename, count(*) FILTER (failed IS NULL) AS ok,
       count(*) FILTER (failed IS NOT NULL) AS failed
FROM ev WHERE kind='completion' AND regexp_matches(id, '^[rt]')
GROUP BY filename;
```

Turn durations (dispatch→completion, minutes):

```sql
SELECT d.id, round(epoch(c.ts::TIMESTAMP - d.ts::TIMESTAMP)/60, 1) AS min
FROM ev d JOIN ev c ON d.id=c.id AND d.filename=c.filename
WHERE d.kind='dispatch' AND c.kind='completion' ORDER BY min DESC LIMIT 20;
```

Billable tokens by verdict stage:

```sql
SELECT kind, sum(usage.input + usage.output + coalesce(usage.reasoning,0)) AS billable
FROM ev WHERE kind IN ('audit','bundle-cert','reconstruction','comparison')
GROUP BY kind;
```

Verification verdict tallies:

```sql
SELECT kind, verdict, count(*) FROM ev
WHERE kind IN ('audit','comparison') GROUP BY kind, verdict;
```

Refused work and follow-ups (see observe.ts refusalsWithoutFollowup for
the authoritative in-harness version surfaced at wakes):

```sql
SELECT ts, refusal, mechanism, revision, reason FROM ev
WHERE refusal IS NOT NULL ORDER BY ts;
```

Ledger-history sequence (frontier/registry evolution; snapshots by hash
under each campaign's .coverify/ledger-history/):

```sql
SELECT ts, ledgerRevision, wake, hash FROM ev
WHERE ledgerRevision IS NOT NULL ORDER BY ts;
```

Run-config stamps (which policy governed which period):

```sql
SELECT ts, harnessRev, gitDirty, roleSpecs, retry, sandbox FROM ev
WHERE runStart = true ORDER BY ts;
```

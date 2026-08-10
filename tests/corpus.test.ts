// docs/measurement-protocol.md rule 3b as a check rather than as prose. The
// rule was written because a corpus can look summable and not be: three
// defensible methods on the raw-skill corpus differed 27×, and the arm had to
// be withdrawn. These pin that the check FAILS on the shapes that caused that,
// and passes on a healthy one.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { corpusChecks, formatCorpusChecks } = await import("../src/view/corpus.ts");

/** A campaign whose session tree contains the given files. */
function corpus(label: string, files: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(`/private/tmp/coverify-corpus-${label}-`);
  const sess = path.join(dir, ".coverify", "sessions", "--camp--");
  fs.mkdirSync(sess, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(sess, name), lines.join("\n") + "\n");
  }
  return dir;
}

const msg = (ts: number, input: number) =>
  `{"type":"message","message":{"role":"assistant","content":"x","timestamp":${ts},` +
  `"usage":{"input":${input},"output":1,"cacheRead":0}}}`;

test("a healthy corpus passes every applicable check", () => {
  const dir = corpus("clean", {
    "2026-08-02T00-00-00_aaa.jsonl": [msg(1000, 10), msg(2000, 20)],
    "2026-08-02T00-00-01_bbb.jsonl": [msg(3000, 30)],
  });
  const checks = corpusChecks(dir);
  expect(checks.filter((c) => !c.ok && !c.notApplicable)).toEqual([]);
  expect(formatCorpusChecks(checks)).toContain("No check failed");
});

test("two files sharing a session id fail check 1", () => {
  // The raw corpus's fatal shape: 64 ids owned 635 files replaying a shared
  // prefix, so summing files counted that prefix 64 times. This also catches
  // the coordinator-session-id collision fixed in #33, where every process
  // re-minted `coordinator-1`.
  const dir = corpus("dupid", {
    "2026-08-02T00-00-00_coordinator-1.jsonl": [msg(1000, 10)],
    "2026-08-02T00-00-01_coordinator-1.jsonl": [msg(2000, 20)],
  });
  const c = corpusChecks(dir).find((c) => c.n === 1)!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("2 files, 1 distinct ids");
  expect(formatCorpusChecks(corpusChecks(dir))).toContain("CHECK(S) FAILED");
});

test("a pile of billed events on one timestamp fails check 3", () => {
  // Replay signature. Counted over BILLED events only — a parallel tool batch
  // legitimately lands several toolResults on one millisecond, and counting
  // those made this check fail on every healthy campaign on disk.
  const dir = corpus("replay", {
    "2026-08-02T00-00-00_rep.jsonl": [msg(5000, 10), msg(5000, 10), msg(5000, 10)],
  });
  expect(corpusChecks(dir).find((c) => c.n === 3)!.ok).toBe(false);
});

test("a parallel tool batch is not mistaken for replay", () => {
  const dir = corpus("toolbatch", {
    "2026-08-02T00-00-00_tb.jsonl": [
      msg(1000, 10),
      ...[0, 1, 2, 3].map(
        () => `{"type":"message","message":{"role":"toolResult","content":"r","timestamp":1000}}`,
      ),
    ],
  });
  expect(corpusChecks(dir).find((c) => c.n === 3)!.ok).toBe(true);
});

test("a compacted session still reconciles, because compaction belongs to no turn", () => {
  // A summarization call's usage lives on the compaction entry, so
  // sum(turn deltas) legitimately differs from the session total. Tolerating
  // that as slop would hide real corruption; it is added back explicitly.
  const dir = corpus("compacted", {
    "2026-08-02T00-00-00_cmp.jsonl": [
      msg(1000, 10),
      '{"type":"compaction","usage":{"input":500,"output":9,"cacheRead":0}}',
      msg(2000, 20),
    ],
  });
  const c = corpusChecks(dir).find((c) => c.n === 4)!;
  expect(c.ok).toBe(true);
  expect(c.detail).toContain("reconcile exactly");
});

test("check 2 declares itself inapplicable rather than answering", () => {
  // pi logs a per-message delta, not a running total, so "does the first
  // cumulative start near zero" has no referent here. Rule 10: a check that
  // cannot apply says so — it does not quietly pass.
  const dir = corpus("na", { "2026-08-02T00-00-00_na.jsonl": [msg(1000, 10)] });
  const c = corpusChecks(dir).find((c) => c.n === 2)!;
  expect(c.notApplicable).toBe(true);
  expect(formatCorpusChecks(corpusChecks(dir))).toContain("n/a");
});

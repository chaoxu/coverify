// The reader that makes the journal's usage fields non-write-only. Every
// assertion here is a refusal purchased with a specific error from the
// 2026-08-09 study (docs/measurement-protocol.md).
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { campaignSpend, formatSpend } = await import("../src/view/spend.ts");
const { GateStore } = await import("../src/gates.ts");

/** A campaign directory with a statement, so GateStore will open it. */
function fixture(records: Record<string, unknown>[]): string {
  const dir = fs.mkdtempSync("/private/tmp/coverify-spend-");
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# STATEMENT\n\nA fixture.\n");
  const store = new GateStore(dir);
  for (const r of records) store.append(r as { kind: "note" } & Record<string, unknown>);
  return dir;
}

test("lanes are reported separately and never summed into one number", () => {
  // `input` is the uncached part on every lane, but the lanes bill against
  // different provider accounts, so a single total across them is not a
  // currency. Mixing them is what overstated fresh input by 30%.
  const dir = fixture([
    { kind: "audit", usage: { input: 10, output: 2, cacheRead: 100, meter: "claude-cli-json" } },
    { kind: "comparison", usage: { input: 5, output: 1, cacheRead: 50, meter: "codex-cli-jsonl" } },
  ]);
  const s = campaignSpend(dir);
  expect(s.byLane).toHaveLength(2);
  expect(s.byLane.map((l) => l.meter).sort()).toEqual(["claude-cli-json", "codex-cli-jsonl"]);
  expect(formatSpend(s)).toContain("No grand total");
});

test("roll-ups are excluded, both flagged and unflagged", () => {
  // A verification completion carries a SUM of its own stage records, which
  // are also on file. Counting both inflated the study by 80.4M tokens (27%).
  // Records written before the roll-up was deleted carry no flag, and EVERY
  // campaign on disk is in that era — so the id-shape rule is not historical
  // housekeeping, it is the only thing standing between a reader and that
  // exact error.
  const dir = fixture([
    { kind: "audit", id: "a1", usage: { input: 10, output: 1, cacheRead: 0, meter: "codex-cli-jsonl" } },
    { kind: "completion", id: "v13", usage: { input: 10, output: 1, cacheRead: 0, meter: "codex-cli-jsonl" } },
    { kind: "completion", id: "r7", usageRollup: true, usage: { input: 999, output: 999, cacheRead: 0 } },
  ]);
  const s = campaignSpend(dir);
  // Only the audit leaf counted: 10 in, not 20 and not 1019.
  expect(s.byLane).toHaveLength(1);
  expect(s.byLane[0].input).toBe(10);
  expect(s.excluded.reduce((n, e) => n + e.records, 0)).toBe(2);
});

test("cumulative snapshots are excluded, not summed", () => {
  // Pre-leaf coordinator records are running totals; summing snapshots
  // multiplies them. They need max() per (runId, sessionId) — a different
  // query, so say so rather than guess.
  const dir = fixture([
    { kind: "usage", role: "coordinator", cumulative: { input: 100, output: 10, cacheRead: 0 } },
    { kind: "usage", role: "coordinator", cumulative: { input: 250, output: 25, cacheRead: 0 } },
  ]);
  const s = campaignSpend(dir);
  expect(s.byLane).toHaveLength(0);
  expect(s.excluded[0].records).toBe(2);
  expect(formatSpend(s)).toContain("cumulative snapshot");
});

test("an unreported field stays absent rather than rendering as a measured zero", () => {
  // A lane whose backend never reports reasoning is not a lane that reasoned
  // zero. The report prints an em dash, not 0.00M.
  const dir = fixture([
    { kind: "audit", usage: { input: 10, output: 2, cacheRead: 0, meter: "claude-cli-json" } },
  ]);
  const s = campaignSpend(dir);
  expect(s.byLane[0].reasoning).toBeUndefined();
  expect(s.byLane[0].cacheWrite).toBeUndefined();
  expect(formatSpend(s)).toContain("—");
});

test("a clamped delta anywhere raises a warning", () => {
  // subUsage clamps a non-monotone delta at zero and marks it. If that ever
  // fires, real spend is missing upstream and the total is quietly short —
  // the reader must not present it as clean.
  const dir = fixture([
    { kind: "usage", role: "coordinator", usage: { input: 0, output: 0, cacheRead: 0, nonMonotone: true } },
  ]);
  const s = campaignSpend(dir);
  expect(s.nonMonotone).toBe(true);
  expect(formatSpend(s)).toContain("WARNING");
});

test("unmetered lanes are reported as spend nobody can count", () => {
  // The librarian is a full external agent with live web search and no
  // machine-readable usage; agy and chatgpt-cli emit no usage payload either.
  // Silence would read as "this cost nothing", which is the one thing rule 10
  // forbids — so the gap is a record, and the report names it separately from
  // `excluded` (records a reader must skip, not spend nobody can count).
  const dir = fixture([
    { kind: "role-call", unmetered: "librarian", detail: "no usage payload" },
    { kind: "role-call", unmetered: "librarian", detail: "no usage payload" },
    { kind: "role-call", unmetered: "chatgpt-cli", detail: "no usage payload" },
  ]);
  const s = campaignSpend(dir);
  expect(s.unmetered).toEqual([
    { lane: "librarian", calls: 2 },
    { lane: "chatgpt-cli", calls: 1 },
  ]);
  const text = formatSpend(s);
  expect(text).toContain("UNMETERED");
  expect(text).toContain("real spend nobody can count");
});

test("--run filters to one harness process", () => {
  // runId is stamped on every record; without a reader that groups on it the
  // edge is write-only, which is the failure mode this reader exists to end.
  const dir = fixture([
    { kind: "audit", runId: "aaaa1111", usage: { input: 10, output: 1, cacheRead: 0, meter: "codex-cli-jsonl" } },
    { kind: "audit", runId: "bbbb2222", usage: { input: 99, output: 9, cacheRead: 0, meter: "codex-cli-jsonl" } },
  ]);
  expect(campaignSpend(dir, "aaaa1111").byLane[0].input).toBe(10);
  expect(campaignSpend(dir, "bbbb2222").byLane[0].input).toBe(99);
  // No filter sees both.
  expect(campaignSpend(dir).byLane[0].input).toBe(109);
});

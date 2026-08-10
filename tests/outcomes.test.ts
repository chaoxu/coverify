// The outcome side of the ledger. Cost numbers alone are non-diagnostic
// (docs/measurement-protocol.md rules 7 and 8), and this reader is what the
// cost tables are supposed to be divided by. Every assertion pins a refusal
// or a join that a hand-rolled query got wrong before.
import { expect, test } from "bun:test";
import { recordFixture } from "./helpers.ts";

const { campaignOutcomes, formatOutcomes } = await import("../src/view/outcomes.ts");
const fixture = (records: Record<string, unknown>[]) => recordFixture("outcomes", records);

test("spend splits by whether the revision ever promoted", () => {
  // The question the cost tables cannot answer on their own: what did the
  // verification budget buy? A revision that consumed four rounds and never
  // promoted is the unit of misdirected work this reader exists to count.
  const u = (input: number) => ({ input, output: 1, cacheRead: 0, meter: "codex-cli-jsonl" });
  const dir = fixture([
    { kind: "audit", revision: "rev-a.md", verdict: "PASS", usage: u(10) },
    { kind: "comparison", revision: "rev-a.md", verdict: "PASS", usage: u(5) },
    { kind: "promotion", revision: "rev-a.md" },
    { kind: "audit", revision: "rev-b.md", verdict: "FAIL", usage: u(100) },
    { kind: "audit", revision: "rev-b.md", verdict: "FAIL", usage: u(200) },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.promoted).toBe(1);
  expect(o.revisions).toHaveLength(2);
  expect(o.promotedSpend[0].input).toBe(15);
  expect(o.unpromotedSpend[0].input).toBe(300);
  // The repair loop's depth is the record count for that revision — two audits
  // of rev-b is two rounds, and two different stages of rev-a is also two.
  expect(o.revisions.find((r) => r.revision === "rev-b.md")).toMatchObject({
    rounds: 2,
    promoted: false,
    verdicts: ["FAIL", "FAIL"],
  });
});

test("revision identity is case-insensitive, like the rest of the codebase", () => {
  // gates.ts sameRevision treats two case spellings as one file. A reader that
  // did not would report one revision as two, and its promoted/unpromoted
  // split would put the same work on both sides.
  const dir = fixture([
    { kind: "audit", revision: "Rev-C.md", verdict: "PASS", usage: { input: 4, output: 1, cacheRead: 0 } },
    { kind: "promotion", revision: "rev-c.md" },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.revisions).toHaveLength(1);
  expect(o.revisions[0].promoted).toBe(true);
  expect(o.promotedWithoutVerification).toEqual([]);
});

test("a promotion no stage record names is reported, not folded in", () => {
  // Silence would read as "verified"; rule 10 forbids presenting a gap as a
  // measurement.
  const dir = fixture([{ kind: "promotion", revision: "unverified.md" }]);
  const o = campaignOutcomes(dir);
  expect(o.promotedWithoutVerification).toEqual(["unverified.md"]);
  expect(formatOutcomes(o)).toContain("NO stage record naming them");
});

test("gate verdicts are counted but never attributed to a revision", () => {
  // gate-verdict records carry `mechanism` and no `revision` (issue #36), so
  // they can be counted by stage and not joined. Guessing the revision from a
  // fuzzy mechanism-string match is exactly the inference this reader refuses.
  const dir = fixture([
    { kind: "gate-verdict", mechanism: "m1", verdict: "IDEA FAIL", usage: { input: 9, output: 1, cacheRead: 0 } },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.stages[0]).toMatchObject({ stage: "gate-verdict", total: 1 });
  expect(o.revisions).toHaveLength(0);
  // Its spend is therefore in neither the promoted nor the unpromoted bucket.
  expect(o.promotedSpend).toEqual([]);
  expect(o.unpromotedSpend).toEqual([]);
});

test("the on-path fraction refuses a graph too sparse to carry it", () => {
  // Premises are optional and were absent on 54 of 64 promotions. A
  // premise-less promotion is its own terminal, so a fraction computed anyway
  // is ~1.0 and means "nothing was recorded" (#38).
  const dir = fixture([
    { kind: "promotion", revision: "a.md" },
    { kind: "promotion", revision: "b.md" },
    { kind: "promotion", revision: "c.md" },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.onPath).toMatchObject({ promotions: 3, withPremises: 0, edges: 0, terminals: 3 });
  expect(o.onPath.fraction).toBeUndefined();
  expect(o.onPath.refusal).toContain("would measure the unrecorded edge");
  expect(formatOutcomes(o)).toContain("REFUSED");
});

test("the on-path fraction is computed once the premise edge exists", () => {
  // c→b→a, plus d→a. Terminals c and d reach everything: 4/4.
  const dir = fixture([
    { kind: "promotion", revision: "a.md" },
    { kind: "promotion", revision: "b.md", premises: ["a.md"] },
    { kind: "promotion", revision: "c.md", premises: ["b.md"] },
    { kind: "promotion", revision: "d.md", premises: ["a.md"] },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.onPath).toMatchObject({ promotions: 4, withPremises: 3, edges: 3, terminals: 2 });
  expect(o.onPath.onPath).toBe(4);
  expect(o.onPath.fraction).toBe(1);
  expect(formatOutcomes(o)).toContain("on path: 4/4 = 100%");
});

test("work off every result's dependency path is counted as off it", () => {
  // A retracted promotion is excluded from the graph, not counted off-path.
  const dir = fixture([
    { kind: "promotion", revision: "root.md" },
    { kind: "promotion", revision: "mid.md", premises: ["root.md"] },
    { kind: "promotion", revision: "top.md", premises: ["mid.md"] },
    // Retracted: not a result, so neither a terminal nor on any path.
    { kind: "audit", revision: "dead.md", verdict: "PASS", candidateHash: "h9" },
    { kind: "promotion", revision: "dead.md", candidateHash: "h9" },
    { kind: "audit", revision: "dead.md", verdict: "FAIL", candidateHash: "h9" },
  ]);
  const o = campaignOutcomes(dir);
  // dead.md is excluded from the graph entirely, not counted as off-path.
  expect(o.onPath.promotions).toBe(3);
  expect(o.retracted).toEqual(["dead.md"]);
  expect(o.onPath.fraction).toBe(1);
});

test("lanes are split by the same inference spend.ts uses, never one bucket", () => {
  // One "unstamped" bucket would add nested `input` (includes cached) to
  // disjoint `input` (excludes it) — rules 1 and 10.
  const dir = fixture([
    // Disjoint: cacheRead > input is impossible under the nested convention.
    { kind: "audit", revision: "a.md", verdict: "PASS", usage: { input: 1, output: 1, cacheRead: 900 } },
    // Nested: no such proof, so it must not share a row with the above.
    { kind: "comparison", revision: "a.md", verdict: "PASS", usage: { input: 500, output: 1, cacheRead: 10 } },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.unpromotedSpend).toHaveLength(2);
  expect(o.unpromotedSpend.map((l) => String(l.meter)).sort()).toEqual([
    "unstamped:auditor (disjoint)",
    "unstamped:comparator (nested?)",
  ]);
});

test("a retracted promotion is not counted as an outcome", () => {
  // A promotion contradicted by a later FAIL is not a result; erring in the
  // flattering direction is the one error an outcome reader must not make.
  const dir = fixture([
    { kind: "audit", revision: "r.md", verdict: "PASS", candidateHash: "h1", usage: { input: 10, output: 1, cacheRead: 0 } },
    { kind: "promotion", revision: "r.md", candidateHash: "h1" },
    { kind: "audit", revision: "r.md", verdict: "FAIL", candidateHash: "h1", usage: { input: 20, output: 1, cacheRead: 0 } },
  ]);
  const o = campaignOutcomes(dir);
  expect(o.promoted).toBe(0);
  expect(o.retracted).toEqual(["r.md"]);
  // Its spend moves to the unpromoted column with it.
  expect(o.promotedSpend).toEqual([]);
  expect(formatOutcomes(o)).toContain("contradicted by a later FAIL");
});

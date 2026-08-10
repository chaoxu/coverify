// Keyed lookup over FAILED.md (issue #28). The launcher requires a prior-route
// check before every route; the only affordance was reading a file that grows
// all campaign, and a read is re-presented on every later turn of the dispatch.
//
// The assertions that matter here are about FORMAT TOLERANCE. The issue's
// design assumed entries look like `## F001 - M1 <title>`; measured 2026-08-10,
// that holds in ONE of seven live campaigns. A parser demanding it would
// return nothing on the other six — silently, and in the direction that makes
// a reasoner assert "no close prior route" when there was one.
import { expect, test } from "bun:test";

const { parseFailedEntries, matchFailedEntries } = await import("../src/failed-index.ts");

/** The three heading formats actually on disk, verbatim in shape. */
const REAL = `# FAILED (append-only)

Preamble that belongs to no entry.

## F001 — M1 freeze all LP-local-vertex blocks
**Obstruction:** the freeze does not survive contraction.
**Retry bar:** a named new invariant.

## CE-MAT-FLAG — exact matroid-basis architectures
**Obstruction:** counterexample at rank 4.

## F-H1-NAIVE-RELAY-01 — same-name precedence does not propagate binary orientation
**Obstruction:** the relay loses orientation across a delimiter.
`;

test("entries are parsed from every heading format on disk, not one id scheme", () => {
  const entries = parseFailedEntries(REAL);
  expect(entries).toHaveLength(3);
  expect(entries.map((e) => e.heading)).toEqual([
    "## F001 — M1 freeze all LP-local-vertex blocks",
    "## CE-MAT-FLAG — exact matroid-basis architectures",
    "## F-H1-NAIVE-RELAY-01 — same-name precedence does not propagate binary orientation",
  ]);
  // The banner and preamble belong to no entry and must not be returned as one.
  expect(entries[0].text).not.toContain("Preamble");
  // An entry carries its body, so a match returns the obstruction verbatim.
  expect(entries[0].text).toContain("does not survive contraction");
});

test("a heading term outranks a body term", () => {
  // "closest prior route is X" is usually a heading question: the mechanism
  // label lives there when a campaign uses one.
  const m = matchFailedEntries(parseFailedEntries(REAL), "matroid");
  expect(m[0].heading).toContain("CE-MAT-FLAG");
  expect(m[0].score).toBe(2);
});

test("a body-only term still matches, so an obstruction is findable", () => {
  const m = matchFailedEntries(parseFailedEntries(REAL), "contraction");
  expect(m).toHaveLength(1);
  expect(m[0].heading).toContain("F001");
  expect(m[0].score).toBe(1);
});

test("no match returns nothing rather than everything", () => {
  // A lookup that degrades to the whole file on a miss would reintroduce the
  // cost it exists to remove. The TOOL answers a miss with the heading index,
  // which is a few hundred bytes; the matcher itself returns nothing.
  expect(matchFailedEntries(parseFailedEntries(REAL), "topology homotopy")).toEqual([]);
  expect(matchFailedEntries(parseFailedEntries(REAL), "")).toEqual([]);
});

test("matching is case-insensitive and ignores punctuation", () => {
  // Mechanism labels are written inconsistently across campaigns — `M1`,
  // `CE-MAT-FLAG`, `F-H1-NAIVE-RELAY-01` — so an exact-token matcher would
  // miss on spelling alone.
  const m = matchFailedEntries(parseFailedEntries(REAL), "ce_mat_flag");
  expect(m[0].heading).toContain("CE-MAT-FLAG");
});

test("an empty or entryless ledger parses to nothing, not to one giant entry", () => {
  expect(parseFailedEntries("")).toEqual([]);
  expect(parseFailedEntries("# FAILED (append-only)\n\nNothing closed yet.\n")).toEqual([]);
});

test("every match is returned; the caller decides how many to show", () => {
  // Truncating inside the matcher would recreate, one layer down, the "you
  // cannot see what you did not fetch" problem the whole issue is about.
  const many = `# FAILED (append-only)\n\n${Array.from(
    { length: 30 },
    (_, i) => `## F${String(i).padStart(3, "0")} — M9 shared mechanism\nbody\n`,
  ).join("\n")}`;
  expect(matchFailedEntries(parseFailedEntries(many), "M9")).toHaveLength(30);
});

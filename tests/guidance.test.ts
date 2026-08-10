// `coverify say` guidance must survive a context rebuild. It lives only in the
// coordinator's conversation otherwise, and silently stops applying at the next
// restart — the failure standingGuidance was added to fix.
import { expect, test } from "bun:test";

const { userDirective } = await import("../src/harness.ts");

// The prefixes are an ON-DISK FORMAT, not an internal name. Every campaign
// journal on disk already contains these exact strings, and harness.ts's
// one-time import reads them back, so they are spelled out literally here
// rather than imported: a test that reused the constants would move with a
// rename and pin nothing.
test("both journaled directive spellings are readable, verbatim as written on disk", () => {
  expect(userDirective("user message: prioritize the algebraic route")).toBe(
    "prioritize the algebraic route",
  );
  expect(userDirective("user message steered mid-turn: drop the LP relaxation")).toBe(
    "drop the LP relaxation",
  );
});

test("a note that is not a directive is not replayed as one", () => {
  // standingGuidance walks EVERY note in the store, so a loose prefix match
  // would replay ordinary campaign bookkeeping to the coordinator as if the
  // user had said it.
  expect(userDirective("compaction failed (timeout); rebuilding via restart rule")).toBeUndefined();
  expect(userDirective("user message")).toBeUndefined();
  expect(userDirective("delivered user message: not the prefix")).toBeUndefined();
  expect(userDirective("")).toBeUndefined();
});

test("an empty directive is a directive, not an absence", () => {
  // Distinguishes "said nothing" from "said something the reader dropped".
  expect(userDirective("user message: ")).toBe("");
});

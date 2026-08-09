// Usage summing must not invent a cost. Every verification-stage role runs on
// a CLI backend, and CLI backends price nothing, so a summed cadence used to
// journal a concrete `costUSD: 0` over millions of tokens — a false provenance
// record, and one that would silently corrupt the issue-#21 analytics reading
// it. Observed on the 2026-08-08 fleet: v039 logged 1,098,503 input tokens and
// costUSD 0.
import { expect, test } from "bun:test";
import type { RoleUsage } from "../src/providers.ts";

const { addUsage } = await import("../src/providers.ts");

const usage = (u: Partial<RoleUsage> & { input: number }): RoleUsage => ({
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...u,
});

test("summing unpriced CLI stages leaves cost absent, not zero", () => {
  const summed = [usage({ input: 1_000_000 }), usage({ input: 98_503 })].reduce(addUsage);
  expect(summed.costUSD).toBeUndefined();
  expect(summed.reasoning).toBeUndefined();
  expect(summed.input).toBe(1_098_503);
  // The journal is JSON: absent must serialize away rather than as a zero.
  expect(JSON.stringify(summed)).not.toContain("costUSD");
});

test("a reported cost survives summing with unpriced stages", () => {
  const summed = [usage({ input: 10, costUSD: 1.5, reasoning: 7 }), usage({ input: 5 })].reduce(addUsage);
  expect(summed.costUSD).toBe(1.5);
  expect(summed.reasoning).toBe(7);
});

test("reported costs add", () => {
  const summed = [usage({ input: 1, costUSD: 0.25 }), usage({ input: 1, costUSD: 0.75 })].reduce(addUsage);
  expect(summed.costUSD).toBe(1);
});

test("a genuine zero cost stays zero", () => {
  // Distinct from absent: a priced backend reporting 0 is a real measurement.
  const summed = [usage({ input: 1, costUSD: 0 }), usage({ input: 1 })].reduce(addUsage);
  expect(summed.costUSD).toBe(0);
});

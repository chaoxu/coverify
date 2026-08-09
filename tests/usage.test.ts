// Usage summing records only what a backend actually reported. `reasoning` is
// the one optional token field, and a measured 0 must stay distinguishable
// from "no backend reported it" — coercing the second into the first is how
// this journal used to claim knowledge it did not have (the removed costUSD
// field did exactly that over millions of tokens before it was dropped).
import { expect, test } from "bun:test";
import type { RoleUsage } from "../src/providers.ts";

const { addUsage } = await import("../src/providers.ts");

const usage = (u: Partial<RoleUsage> & { input: number }): RoleUsage => ({
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...u,
});

test("tokens add and unreported reasoning stays absent", () => {
  const summed = [usage({ input: 1_000_000 }), usage({ input: 98_503 })].reduce(addUsage);
  expect(summed.input).toBe(1_098_503);
  expect(summed.reasoning).toBeUndefined();
  // The journal is JSON: absent must serialize away rather than as a zero.
  expect(JSON.stringify(summed)).not.toContain("reasoning");
});

test("reported reasoning survives summing with addends that omit it", () => {
  const summed = [usage({ input: 10, reasoning: 7 }), usage({ input: 5 })].reduce(addUsage);
  expect(summed.reasoning).toBe(7);
});

test("a genuine zero stays zero", () => {
  // Distinct from absent: a backend reporting 0 is a real measurement.
  expect([usage({ input: 1, reasoning: 0 }), usage({ input: 1 })].reduce(addUsage).reasoning).toBe(0);
});

// The "no dollar figure is recorded" invariant is guarded where it can
// actually fail — at the parsing boundaries, by tests that push real wire
// payloads carrying `cost` / `total_cost_usd` through the parsers
// (tests/turns.test.ts and tests/cli-backend.test.ts). Asserting it here over
// RoleUsage literals would pass by construction and catch nothing.

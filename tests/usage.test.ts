// Usage summing records only what a backend actually reported. `reasoning` is
// the one optional token field, and a measured 0 must stay distinguishable
// from "no backend reported it" — coercing the second into the first is how
// this journal used to claim knowledge it did not have (the removed costUSD
// field did exactly that over millions of tokens before it was dropped).
import { expect, test } from "bun:test";
import type { RoleUsage } from "../src/providers.ts";

const { addUsage, subUsage } = await import("../src/providers.ts");

// cacheWrite is NOT defaulted: it is optional on RoleUsage precisely so that
// absence can mean "the provider never reported it", distinct from a measured
// zero. A helper that injects 0 would hide exactly that distinction.
const usage = (u: Partial<RoleUsage> & { input: number }): RoleUsage => ({
  output: 0,
  cacheRead: 0,
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

test("addUsage never throws on mixed lanes — it drops the provenance", () => {
  // This runs inside persist()'s store.append argument on the settle path. A
  // throw there skips the completion record, orphans a report already on disk,
  // and rejects handle.settled ("resolves, never rejects"), taking the campaign
  // down with every live agent's work. Observability may not end a campaign.
  const pi = usage({ input: 10, meter: "pi-session", reasoning: 4 });
  const claude = usage({ input: 5, meter: "claude-cli-json", cacheWrite: 7 });
  const mixed = addUsage(pi, claude);
  expect(mixed.input).toBe(15);
  // Provenance is not claimed for a sum of two different adapters.
  expect(mixed.meter).toBeUndefined();
  // Gaps need no parallel list: each optional field is present iff some addend
  // measured it. claude reports no reasoning, pi reports no cacheWrite, and the
  // sum carries each real value exactly once.
  expect(mixed.reasoning).toBe(4);
  expect(mixed.cacheWrite).toBe(7);
});

test("an optional field stays absent when no addend reported it", () => {
  // A measured 0 and "no backend reported this" are different records; the
  // journal is JSON, so absence must serialize away rather than as a zero.
  const s = addUsage(usage({ input: 1 }), usage({ input: 2 }));
  expect(s.cacheWrite).toBeUndefined();
  expect(s.reasoning).toBeUndefined();
  expect(JSON.stringify(s)).not.toContain("cacheWrite");
});

test("a known meter is never inherited by a sum with an unknown one", () => {
  // Summing a stamped record with an unstamped one (a pre-2026-08-09 journal
  // line, or usage rebuilt from pi's session JSONL) must leave the meter
  // ABSENT. Claiming the known one would be the convention-guessing this
  // field exists to stop, made by the function meant to stop it.
  const s = addUsage(usage({ input: 3, meter: "pi-session" }), usage({ input: 4 }));
  expect(s.input).toBe(7);
  expect(s.meter).toBeUndefined();
});

test("subUsage turns a cumulative snapshot into the leaf a wake spent", () => {
  // The coordinator's session total is the only derived aggregate the journal
  // used to store, and it is why reading it needed reset-detection — a
  // heuristic that split one campaign into 18 epochs against 15 real sessions.
  // Deltas sum like every other role's records; snapshots must be un-inferred.
  const afterWake1 = usage({ input: 100, output: 40, cacheRead: 900, reasoning: 25 });
  const afterWake2 = usage({ input: 260, output: 90, cacheRead: 2400, reasoning: 60 });
  const wake2 = subUsage(afterWake2, afterWake1);
  expect(wake2.input).toBe(160);
  expect(wake2.output).toBe(50);
  expect(wake2.cacheRead).toBe(1500);
  expect(wake2.reasoning).toBe(35);
});

test("subUsage with no baseline is the first wake of a session", () => {
  const first = usage({ input: 100, meter: "pi-session" });
  expect(subUsage(first, undefined)).toEqual(first);
});

test("subUsage never yields a negative token count", () => {
  // A session total is monotone, so a smaller total than the baseline means
  // the baseline belonged to a different session. Recording a negative would
  // poison every sum downstream; clamping keeps the record merely wrong-by-
  // omission rather than actively corrupting.
  const d = subUsage(usage({ input: 5, output: 1 }), usage({ input: 50, output: 20 }));
  expect(d.input).toBe(0);
  expect(d.output).toBe(0);
});

test("subUsage keeps absent-vs-zero on optional fields", () => {
  const d = subUsage(usage({ input: 10 }), usage({ input: 4 }));
  expect(d.cacheWrite).toBeUndefined();
  expect(d.reasoning).toBeUndefined();
  expect(JSON.stringify(d)).not.toContain("reasoning");
});

test("subUsage marks a non-monotone delta instead of swallowing it", () => {
  // A session total is monotone today, so the clamp should never fire. If pi
  // ever changes and it does, real spend would vanish into a Math.max — which
  // is the failure class this whole branch exists to prevent. Absence must be
  // observable, so the record says so.
  const d = subUsage(usage({ input: 5, output: 1 }), usage({ input: 50, output: 20 }));
  expect(d.input).toBe(0);
  expect(d.nonMonotone).toBe(true);
});

test("subUsage does not manufacture a measured zero from an absent field", () => {
  // Subtracting from "the provider never reported this" must leave it absent.
  const d = subUsage(usage({ input: 10 }), usage({ input: 4, cacheWrite: 3 }));
  expect(d.input).toBe(6);
  expect(d.cacheWrite).toBeUndefined();
  expect(JSON.stringify(d)).not.toContain("cacheWrite");
});

test("subUsage returns a copy, never an alias of its baseline argument", () => {
  // The caller keeps `a` as the next baseline while this result is journalled.
  const a = usage({ input: 10, meter: "pi-session" });
  const d = subUsage(a, undefined);
  expect(d).toEqual(a);
  expect(d).not.toBe(a);
});

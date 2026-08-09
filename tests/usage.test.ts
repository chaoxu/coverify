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

test("addUsage never throws on mixed meters — it marks them", () => {
  // This runs inside persist()'s store.append argument on the settle path. A
  // throw there skips the completion record, orphans a report already on disk,
  // and rejects handle.settled ("resolves, never rejects"), taking the campaign
  // down with every live agent's work. Observability may not end a campaign.
  const pi = usage({ input: 10, meter: "pi-session", unreported: ["cacheWrite"] });
  const claude = usage({ input: 5, meter: "claude-cli-json", unreported: ["reasoning"] });
  const mixed = addUsage(pi, claude);
  expect(mixed.input).toBe(15);
  expect(mixed.meter).toBeUndefined();
  expect(mixed.mixedMeters).toEqual(["claude-cli-json", "pi-session"]);
  // Neither field is fully absent: pi measures reasoning, claude measures
  // cacheWrite. The sum holds a real but INCOMPLETE number for each, which is
  // neither "unreported" nor fully measured. Union here would declare measured
  // codex reasoning unmeasured on every full verification cadence.
  expect(mixed.unreported).toBeUndefined();
  expect([...(mixed.partiallyUnreported ?? [])].sort()).toEqual(["cacheWrite", "reasoning"]);
});

test("a same-meter sum keeps its meter and stays unmarked", () => {
  const a = usage({ input: 10, meter: "codex-cli-jsonl", unreported: ["cacheWrite"] });
  const b = usage({ input: 7, meter: "codex-cli-jsonl", unreported: ["cacheWrite"] });
  const s = addUsage(a, b);
  expect(s.meter).toBe("codex-cli-jsonl");
  expect(s.mixedMeters).toBeUndefined();
  expect(s.unreported).toEqual(["cacheWrite"]);
  expect(JSON.stringify(s)).not.toContain("mixedMeters");
});

test("meterless records still sum — historical journals predate the field", () => {
  const s = addUsage(usage({ input: 3 }), usage({ input: 4 }));
  expect(s.input).toBe(7);
  expect(s.meter).toBeUndefined();
  expect(s.mixedMeters).toBeUndefined();
});

test("a known meter is never inherited by a sum with an unknown one", () => {
  // Summing a stamped record with an unstamped one (a pre-2026-08-09 journal
  // line, or usage rebuilt from pi's session JSONL) must leave the meter
  // ABSENT. Claiming the known one would be the convention-guessing this
  // field exists to stop, made by the function meant to stop it.
  const s = addUsage(usage({ input: 3, meter: "pi-session" }), usage({ input: 4 }));
  expect(s.input).toBe(7);
  expect(s.meter).toBeUndefined();
  expect(s.mixedMeters).toBeUndefined();
});

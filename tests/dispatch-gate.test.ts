// The dispatch gate and the handle lifecycle. Six review rounds concentrated on
// campaign identity and starved this code; the first serious look at it found
// both defects below, neither of which any test could see.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { liveWorkersOnMechanism, normalizeMechanism } = await import("../src/gates.ts");
const { failedSettleRecord } = await import("../src/harness.ts");

afterEach(() => {
  delete process.env.COVERIFY_STATE_DIR;
});

test("retyping a mechanism does not hide a live worker from the wave gate", () => {
  // The launcher gates a SECOND concurrent worker on one mechanism behind an
  // IDEA PASS. Comparing mechanisms raw let a coordinator retype the label and
  // fan out anyway — with the IDEA-PASS lookup normalized, so the retyped
  // dispatch also lost the PASS it had earned. gates.ts's own comment and the
  // design.md conformance table both already claimed this could not happen.
  const live = [{ kind: "worker", mechanism: "Spectral Bound" }];
  expect(liveWorkersOnMechanism(live, "Spectral Bound")).toBe(1);
  expect(liveWorkersOnMechanism(live, "spectral  bound ")).toBe(1);
  expect(liveWorkersOnMechanism(live, "SPECTRAL BOUND")).toBe(1);
  // A genuinely different route is still free to run concurrently.
  expect(liveWorkersOnMechanism(live, "Discharging")).toBe(0);
});

test("gate critics and cadences never occupy a mechanism's worker slot", () => {
  const live = [
    { kind: "gate", mechanism: "Spectral Bound" },
    { kind: "verification", mechanism: "Spectral Bound" },
  ];
  expect(liveWorkersOnMechanism(live, "Spectral Bound")).toBe(0);
});

test("a cancelled agent's empty settle is a note, not an infrastructure failure", () => {
  // cancel_agent aborts the session, which resolves "" — so the settle lands in
  // the FAILED branch as "empty report". Appending a completion there told the
  // coordinator its own deliberate cancellation was an infrastructure failure
  // and that redispatch was legitimate: the opposite of cancel semantics, and a
  // section of wake context every time. declare_campaign_state cancels every
  // live handle, so a pause made each interrupted worker come back that way at
  // the first wake of the next run.
  const cancelled = failedSettleRecord("r001", "empty report (no final text returned)", false);
  expect(cancelled.kind).toBe("note");
  expect(String(cancelled.note)).toContain("after cancellation");

  // A genuine infrastructure failure on a LIVE handle still reports as one:
  // that is the case redispatch is legitimate for.
  const genuine = failedSettleRecord("r001", "stream died at minute 29", true);
  expect(genuine.kind).toBe("completion");
  expect(genuine.failed).toBe("stream died at minute 29");
});

test("a dead handle's failure never carries the `failed` field a redispatch keys on", () => {
  // undeliveredCompletions renders `failed` as "FAILED (infrastructure) …
  // re-dispatching the assignment is legitimate". A cancelled handle must not
  // reach that renderer at all.
  const cancelled = failedSettleRecord("r001", "empty report", false);
  expect(cancelled.failed).toBeUndefined();
  expect(failedSettleRecord("r001", "empty report", true).failed).toBe("empty report");
});

test("normalizeMechanism is the one spelling rule, and it is total", () => {
  // Both halves of the gate key on this. A mechanism the coordinator omitted
  // must not collide with one it merely spelled oddly.
  expect(normalizeMechanism("  Spectral   Bound\n")).toBe("spectral bound");
  expect(normalizeMechanism("SPECTRAL BOUND")).toBe(normalizeMechanism("spectral bound"));
  expect(normalizeMechanism("")).toBe("");
  expect(normalizeMechanism("a")).not.toBe(normalizeMechanism(""));
});

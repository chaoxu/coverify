// The dispatch gate and the handle lifecycle. Six review rounds concentrated on
// campaign identity and starved this code; the first serious look at it found
// both defects below, neither of which any test could see.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { GateStore, liveWorkersOnMechanism, normalizeMechanism } = await import("../src/gates.ts");
const { failedSettleRecord, runningHandles } = await import("../src/harness.ts");
const { coordinatorTools } = await import("../src/coordinator-tools.ts");
import type { Handle } from "../src/harness.ts";

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

test("cancelling a worker that already finished keeps its report", async () => {
  // The handle map is drained only at the next wake's harvest, so a worker that
  // settles DURING a coordinator turn is still listed as running in the digest
  // that turn is acting on. Cancelling it used to splice out the settled entry
  // and record a cancellation, discarding a complete, paid-for report that
  // nothing else names — the same loss `declare_campaign_state` harvests first
  // to avoid. Asserted on the queue and the store, because the eviction IS the
  // damage.
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-cancel-settled-`);
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`${os.tmpdir()}/coverify-cancel-state-`);
  const store = new GateStore(dir);

  const handle = { id: "r001", kind: "worker", mechanism: "m" } as unknown as Handle;
  const handles = new Map<string, Handle>([["r001", handle]]);
  const settledQueue = [{ h: handle, failed: undefined }];
  const tools = coordinatorTools({
    dir,
    store,
    contract: "CONTRACT",
    models: {},
    opts: {},
    sessionsRoot: path.join(dir, ".coverify", "sessions"),
    evidenceRelative: (p: string) => p,
    declaration: () => undefined,
    declare: () => {},
    nextId: () => 1,
    wake: () => 1,
    handles,
    settledQueue,
    liveWorkers: () => 1,
    liveOnMechanism: () => 1,
    registerHandle: () => {},
    harvestSettled: () => ({ total: 0 }),
    bumpActivity: () => {},
  } as never);

  const out = JSON.stringify(await tools.cancelWorker.execute!("c1", { id: "r001", reason: "silent" }));
  expect(out).toContain("already finished");
  // Still queued for harvest, and NOT recorded as cancelled.
  expect(settledQueue).toHaveLength(1);
  expect(store.all().some((r) => r.kind === "completion" && r.cancelled === true)).toBe(false);

  // The queue holds failures too, and the two cases must not get one message:
  // telling the coordinator its report is intact when the stream actually died
  // invites closing the route on an infrastructure failure — which the
  // delivered record itself says is never PASS and carries no content.
  const dead = { id: "r002", kind: "worker", mechanism: "m" } as unknown as Handle;
  handles.set("r002", dead);
  settledQueue.push({ h: dead, failed: "stream closed mid-response" });
  const failedOut = JSON.stringify(
    await tools.cancelWorker.execute!("c2", { id: "r002", reason: "silent" }),
  );
  expect(failedOut).toContain("INFRASTRUCTURE failure");
  expect(failedOut).toContain("Do not close the route on it");
});

test("a worker that settled mid-turn stops counting as live", () => {
  // Same harvest-timing window as the cancel test above, on the other two
  // readers of the handle map: counting a settled worker live refused a
  // dispatch under --agent-limit with nothing actually running, and made the
  // wave gate assert a concurrent worker on a mechanism that had already
  // returned — over-enforcing a clause scoped to concurrency.
  const a = { id: "r001", kind: "worker", mechanism: "spectral bound" };
  const b = { id: "r002", kind: "worker", mechanism: "Spectral  Bound" };
  const handles = [a, b];

  // Both running: the second worker on the mechanism is genuinely concurrent.
  expect(runningHandles(handles, []).length).toBe(2);
  expect(liveWorkersOnMechanism(runningHandles(handles, []), "spectral bound")).toBe(2);

  // r001 settled and is awaiting harvest: one slot free, one live on the route.
  const settledQueue = [{ h: a }];
  expect(runningHandles(handles, settledQueue).map((h) => h.id)).toEqual(["r002"]);
  expect(liveWorkersOnMechanism(runningHandles(handles, settledQueue), "spectral bound")).toBe(1);
});

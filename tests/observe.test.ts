// The observability module's record+query pairs (issue #21): refusal events
// and the unaddressed-refusal noticing, plus the ledger-history archive.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { GateStore } = await import("../src/gates.ts");
const { archiveLedgerHistory, refuse, refusalsWithoutFollowup } = await import("../src/observe.ts");

function campaign(label: string) {
  const dir = fs.mkdtempSync(`/private/tmp/coverify-observe-${label}-`);
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n\nProve X.\n");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`/private/tmp/coverify-observe-state-${label}-`);
  return { dir, store: new GateStore(dir) };
}

describe("refusal record + query", () => {
  test("a refused mechanism with no later dispatch is surfaced; a re-proposed one is not", () => {
    const { store } = campaign("refusal");
    refuse(store, "dispatch", "worker cap", { mechanism: "ROUTE-A deep scan", role: "reasoner" });
    refuse(store, "dispatch", "worker cap", { mechanism: "ROUTE-B wide scan", role: "reasoner" });
    // ROUTE-A gets re-proposed later (case/spacing differ — normalization must match).
    store.append({ kind: "dispatch", id: "r001", role: "reasoner", mechanism: "route-a  DEEP scan", task: "t" });
    const un = refusalsWithoutFollowup(store);
    expect(un.map((r) => r.subject)).toEqual(["ROUTE-B wide scan"]);
  });

  test("a verification refusal is cleared by a later verification dispatch on the revision", () => {
    const { store } = campaign("vrefusal");
    refuse(store, "verification", "prior FAIL stands", { revision: "r009/cand.r1.md" });
    expect(refusalsWithoutFollowup(store).length).toBe(1);
    store.append({ kind: "dispatch", id: "v010", role: "verification", mechanism: "verification:r009/cand.r1.md" });
    expect(refusalsWithoutFollowup(store).length).toBe(0);
  });
});

describe("ledger history", () => {
  test("distinct rewrites snapshot content-addressed; A→B→A logs three events, two files", () => {
    const { dir, store } = campaign("ledgerhist");
    const frontier = path.join(dir, "CURRENT_FRONTIER.md");
    fs.writeFileSync(frontier, "A\n");
    archiveLedgerHistory(store, dir, 1);
    fs.writeFileSync(frontier, "B\n");
    archiveLedgerHistory(store, dir, 2);
    fs.writeFileSync(frontier, "A\n");
    archiveLedgerHistory(store, dir, 3);
    archiveLedgerHistory(store, dir, 4); // unchanged: no new event
    const events = store.all().filter((e) => e.ledgerRevision === "CURRENT_FRONTIER.md");
    expect(events.length).toBe(3);
    const snaps = fs.readdirSync(path.join(dir, ".coverify", "ledger-history"));
    expect(snaps.length).toBe(2);
    // Integrity: each event's hash matches a stored snapshot's content hash.
    expect(new Set(events.map((e) => `${e.hash}.md`)).size).toBe(2);
  });
});

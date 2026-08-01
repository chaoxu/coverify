// Campaign-logic enforcement: verdict recency, idea-gate re-arming, and the
// FAILED.md check. Added after the round-4 review found each of these
// reachable by an ordinary coordinator, not by deliberate evasion.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { GateStore, checkDispatch, checkPromotion, statementHash } = await import("../src/gates.ts");
const { sha256File } = await import("../src/campaign.ts");

function campaign(label: string) {
  const dir = fs.mkdtempSync(`/private/tmp/coverify-gates-${label}-`);
  fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n");
  fs.writeFileSync(path.join(dir, "PROVED.md"), "");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`/private/tmp/coverify-state-${label}-`);
  return { dir, store: new GateStore(dir) };
}

const base = { mechanism: "m1", task: "t", context: "c", deliverable: "d" };

describe("FAILED.md check", () => {
  const { store } = campaign("failed");
  const check = (failedCheck: string) =>
    checkDispatch(store, "reasoner", { ...base, failedCheck } as any, undefined, 0, 0).allowed;
  test("accepts a real check", () => expect(check("no close prior route")).toBe(true));
  test("accepts a real differentiation", () =>
    expect(check("closest prior route is R7; this differs materially because it drops the acyclicity assumption")).toBe(
      true,
    ));
  test("refuses the parameter's own placeholder", () =>
    expect(check("closest prior route is X; this differs materially because ...")).toBe(false));
});

describe("idea gate is re-armable", () => {
  const { store } = campaign("idea");
  const dispatch = () =>
    checkDispatch(store, "reasoner", { ...base, failedCheck: "no close prior route" } as any, undefined, 1, 1)
      .allowed;
  test("a second concurrent worker needs IDEA PASS", () => expect(dispatch()).toBe(false));
  test("IDEA PASS opens the wave", () => {
    store.append({ kind: "gate-verdict", mechanism: "m1", verdict: "IDEA PASS" });
    expect(dispatch()).toBe(true);
  });
  test("a later IDEA FAIL closes it again", () => {
    store.append({ kind: "gate-verdict", mechanism: "m1", verdict: "IDEA FAIL" });
    expect(dispatch()).toBe(false);
  });
});

describe("promotion follows the latest verdict", () => {
  const { dir, store } = campaign("promote");
  const rel = "cand.md";
  const candidate = path.join(dir, "EVIDENCE", rel);
  fs.writeFileSync(candidate, "# candidate proof\n");
  const hashes = () => ({ candidateHash: sha256File(candidate), statementHash: statementHash(dir) });
  test("both stages PASS ⇒ promotable", () => {
    store.append({ kind: "audit", revision: rel, verdict: "PASS", ...hashes() });
    store.append({ kind: "comparison", revision: rel, verdict: "PASS", ...hashes() });
    expect(checkPromotion(store, dir, rel).allowed).toBe(true);
  });
  test("a later FAIL on the same content revokes it", () => {
    store.append({ kind: "comparison", revision: rel, verdict: "FAIL", ...hashes() });
    expect(checkPromotion(store, dir, rel).allowed).toBe(false);
  });
  test("a fresh PASS after the FAIL restores it", () => {
    store.append({ kind: "comparison", revision: rel, verdict: "PASS", ...hashes() });
    expect(checkPromotion(store, dir, rel).allowed).toBe(true);
  });
  test("editing the candidate invalidates promotion", () => {
    fs.appendFileSync(candidate, "\nedit\n");
    expect(checkPromotion(store, dir, rel).allowed).toBe(false);
  });
});

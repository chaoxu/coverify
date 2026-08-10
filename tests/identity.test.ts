// Campaign identity: which state directory a campaign's authoritative gate
// history lives in, and who is allowed to claim it.
//
// This file exists because six review rounds kept re-breaking exactly this
// function while every other part of the harness held. It had no tests at all,
// and each fix was hand-verified in a shell and then broken by the next one —
// including a refusal whose own motivating example (an id written in uppercase
// by another tool) was the case that silently defeated it.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { GateStore } = await import("../src/gates.ts");
const { Refusal } = await import("../src/refusal.ts");

afterEach(() => {
  delete process.env.COVERIFY_STATE_DIR;
});

/** A campaign directory, optionally with an id file and a journal. */
function campaign(opts: { id?: string; journal?: boolean } = {}) {
  const state = fs.mkdtempSync(`${os.tmpdir()}/coverify-idstate-`);
  process.env.COVERIFY_STATE_DIR = state;
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-id-`);
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# STATEMENT\n\nA fixture.\n");
  if (opts.id !== undefined) fs.writeFileSync(path.join(dir, ".coverify", "campaign-id"), opts.id);
  if (opts.journal === true) {
    fs.writeFileSync(
      path.join(dir, ".coverify", "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-08-10T00:00:00Z", kind: "note", note: "ran" })}\n`,
    );
  }
  return { dir, state };
}

const stateDirs = (state: string) => fs.readdirSync(state).sort();

test("an id is read case-insensitively and names one state directory", () => {
  // The same 64 bits either way. Refusing uppercase would strand the history of
  // any campaign whose id file was copied by hand or written by another tool.
  const { dir, state } = campaign({ id: "ABCDEF0123456789\n" });
  new GateStore(dir).append({ kind: "note", note: "x" } as never);
  expect(stateDirs(state)).toEqual(["abcdef0123456789"]);
});

test("surrounding whitespace and CRLF do not change the identity", () => {
  const { dir, state } = campaign({ id: "  abcdef0123456789  \r\n" });
  new GateStore(dir).append({ kind: "note", note: "x" } as never);
  expect(stateDirs(state)).toEqual(["abcdef0123456789"]);
});

test("a copy is refused even when the original's id file is uppercase", () => {
  // The claimant check used to compare the OTHER directory's file RAW against
  // an already-normalized id, so an uppercase id file made two directories
  // write one authoritative store with no refusal — the exact corruption the
  // guard exists to stop, reachable through the case the guard's own comment
  // gave as its motivation.
  const { dir, state } = campaign({ id: "ABCDEF0123456789\n" });
  new GateStore(dir).append({ kind: "note", note: "original" } as never);

  const copy = `${dir}-copy`;
  fs.cpSync(dir, copy, { recursive: true });
  expect(() => new GateStore(copy)).toThrow(Refusal);
  expect(() => new GateStore(copy)).toThrow(/claimed by two directories/);

  // The original keeps working, and a reader of the copy may still look.
  expect(() => new GateStore(dir)).not.toThrow();
  expect(() => new GateStore(copy, { readOnly: true })).not.toThrow();
  expect(stateDirs(state)).toEqual(["abcdef0123456789"]);
});

test("garbage in the id file is a hard stop, not a new identity", () => {
  // Minting here would orphan an intact gate store under the id this file used
  // to hold, with no tool that names it — while the ADOPT guard then steers
  // the operator to the lower-trust journal rebuild.
  const { dir } = campaign({ id: "not-an-id\n", journal: true });
  expect(() => new GateStore(dir)).toThrow(Refusal);
  expect(() => new GateStore(dir)).toThrow(/malformed/);
});

test("an empty id file self-heals when nothing can be lost", () => {
  // Emptiness carries no information about a previous id, so "restore it from
  // backup" points at nothing. On a campaign that never ran there is no gate
  // history anywhere to orphan.
  const { dir, state } = campaign({ id: "" });
  new GateStore(dir).append({ kind: "note", note: "x" } as never);
  expect(stateDirs(state)).toHaveLength(1);
});

test("an empty id file is a stop once the campaign has run", () => {
  const { dir } = campaign({ id: "", journal: true });
  expect(() => new GateStore(dir)).toThrow(Refusal);
});

test("a reader derives the same state directory on every invocation", () => {
  // A reader never persists the id it derived. Minting a random one per process
  // made `spend` print a different recovery path each run — advice that could
  // not be followed.
  const { dir } = campaign({ journal: true });
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) seen.add(new GateStore(dir, { readOnly: true }).campaignDir);
  expect(seen.size).toBe(1);
});

test("a reader writes nothing: no id file, no state directory", () => {
  // `coverify spend` on someone else's campaign used to brand it with an
  // identity it had not chosen.
  const { dir, state } = campaign();
  new GateStore(dir, { readOnly: true });
  expect(fs.existsSync(path.join(dir, ".coverify", "campaign-id"))).toBe(false);
  expect(stateDirs(state)).toEqual([]);
});

test("a reader never rebuilds gate history from the in-tree mirror", () => {
  // Reconstructing from the role-writable journal is a trust-boundary event
  // that stamps a permanent lower-trust mark on the campaign. An operator who
  // exported COVERIFY_ADOPT=1 once would otherwise have had every later read
  // do it silently.
  process.env.COVERIFY_ADOPT = "1";
  try {
    const { dir, state } = campaign({ journal: true });
    const before = fs.readFileSync(path.join(dir, ".coverify", "journal.jsonl"), "utf-8");
    const store = new GateStore(dir, { readOnly: true });
    expect(store.all()).toEqual([]);
    expect(fs.readFileSync(path.join(dir, ".coverify", "journal.jsonl"), "utf-8")).toBe(before);
    expect(stateDirs(state)).toEqual([]);
  } finally {
    delete process.env.COVERIFY_ADOPT;
  }
});

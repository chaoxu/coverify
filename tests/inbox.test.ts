// The user->coordinator inbox (coverify say) is delivery infrastructure:
// messages must survive until actually delivered, and consumption must never
// eat a message queued after the wake peeked.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const {
  queueUserMessage,
  peekUserMessages,
  consumeUserMessages,
  initCampaign,
  readJournal,
  appendJournal,
  newEvidencePath,
} = await import("../src/campaign.ts");
const { GateStore } = await import("../src/gates.ts");

function campaign(): string {
  const dir = fs.mkdtempSync("/private/tmp/coverify-inbox-");
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  return dir;
}

describe("user message inbox", () => {
  test("queue then peek preserves order and verbatim text", () => {
    const dir = campaign();
    expect(peekUserMessages(dir)).toEqual([]);
    queueUserMessage(dir, "first: focus on route A");
    queueUserMessage(dir, 'second: "quoted" & multi\nline');
    expect(peekUserMessages(dir)).toEqual(["first: focus on route A", 'second: "quoted" & multi\nline']);
  });

  test("consume removes only the delivered prefix, keeping later arrivals", () => {
    const dir = campaign();
    queueUserMessage(dir, "a");
    queueUserMessage(dir, "b");
    const peeked = peekUserMessages(dir);
    // A message queued between peek and consume (during the coordinator's
    // turn) must survive for the next wake.
    queueUserMessage(dir, "c");
    consumeUserMessages(dir, peeked.length);
    expect(peekUserMessages(dir)).toEqual(["c"]);
    consumeUserMessages(dir, 1);
    expect(peekUserMessages(dir)).toEqual([]);
  });

  test("a message appended during consumption is not lost", () => {
    // `coverify say` is a separate process appending whenever the user types,
    // so consumption must not rewrite the log: a read-modify-write drops
    // anything that lands between the read and the write.
    const dir = campaign();
    queueUserMessage(dir, "a");
    const peeked = peekUserMessages(dir);
    const inbox = path.join(dir, ".coverify", "inbox.jsonl");
    const before = fs.readFileSync(inbox, "utf8");
    queueUserMessage(dir, "raced in");
    consumeUserMessages(dir, peeked.length);
    expect(peekUserMessages(dir)).toEqual(["raced in"]);
    // The log itself is append-only: every earlier entry is still on disk.
    expect(fs.readFileSync(inbox, "utf8").startsWith(before)).toBe(true);
  });

  test("failed delivery consumes nothing; torn trailing line tolerated", () => {
    const dir = campaign();
    queueUserMessage(dir, "keep me");
    consumeUserMessages(dir, 0); // turn failed -> nothing consumed
    expect(peekUserMessages(dir)).toEqual(["keep me"]);
    fs.appendFileSync(path.join(dir, ".coverify", "inbox.jsonl"), '{"ts":"x","mess');
    expect(peekUserMessages(dir)).toEqual(["keep me"]);
  });
});

describe("adopted campaigns and damaged state", () => {
  test("a campaign with no .coverify/ can still be journaled and messaged", () => {
    // The interop path: a campaign created by a skill session has ledgers but
    // no harness directory, and the first thing every command does is append.
    const dir = fs.mkdtempSync("/private/tmp/coverify-adopted-");
    fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# STATEMENT\n\nX.\n");
    expect(() => appendJournal(dir, { kind: "note", note: "run-start" })).not.toThrow();
    expect(() => queueUserMessage(dir, "hello")).not.toThrow();
    expect(peekUserMessages(dir)).toEqual(["hello"]);
  });

  test("initCampaign refuses to overwrite surviving ledgers", () => {
    const dir = fs.mkdtempSync("/private/tmp/coverify-damaged-");
    fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
    fs.writeFileSync(path.join(dir, "PROVED.md"), "# PROVED\n\n## lemma.r1.md — promoted\n");
    // STATEMENT.md is missing (renamed, or a partial restore).
    expect(() => initCampaign(dir, "a new statement")).toThrow(/refusing to initialize/);
    expect(fs.readFileSync(path.join(dir, "PROVED.md"), "utf8")).toContain("promoted");
  });

  test("a torn gate line does not brick the campaign", () => {
    const dir = fs.mkdtempSync("/private/tmp/coverify-torn-");
    fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
    process.env.COVERIFY_STATE_DIR = fs.mkdtempSync("/private/tmp/coverify-torn-state-");
    const store = new GateStore(dir);
    store.append({ kind: "gate-verdict", mechanism: "m", verdict: "IDEA PASS" });
    const file = path.join(process.env.COVERIFY_STATE_DIR, fs.readdirSync(process.env.COVERIFY_STATE_DIR)[0], "gates.jsonl");
    fs.appendFileSync(file, '{"kind":"audit","verdi');
    const reopened = new GateStore(dir);
    expect(reopened.all().length).toBe(1);
    expect(reopened.all()[0].verdict).toBe("IDEA PASS");
  });

  test("a corrupt journal line costs observability, not the campaign", () => {
    const dir = fs.mkdtempSync("/private/tmp/coverify-journal-");
    fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
    appendJournal(dir, { kind: "note", note: "first" });
    fs.appendFileSync(path.join(dir, ".coverify", "journal.jsonl"), '{"torn\n');
    appendJournal(dir, { kind: "note", note: "second" });
    const entries = readJournal(dir);
    expect(entries.map((e) => (e as any).note)).toEqual(["first", "second"]);
  });
});

describe("campaign identity travels with the campaign", () => {
  function ranBefore(dir: string) {
    appendJournal(dir, { kind: "note", note: "run-start" });
  }

  test("moving a campaign keeps its gate history", () => {
    process.env.COVERIFY_STATE_DIR = fs.mkdtempSync("/private/tmp/coverify-idstate-");
    const a = fs.mkdtempSync("/private/tmp/coverify-move-");
    fs.mkdirSync(path.join(a, ".coverify"), { recursive: true });
    fs.writeFileSync(path.join(a, "STATEMENT.md"), "# S\n\nX.\n");
    const store = new GateStore(a);
    store.append({ kind: "audit", revision: "cand.md", verdict: "FAIL", candidateHash: "h" });
    ranBefore(a);
    const moved = a + "-renamed";
    fs.renameSync(a, moved);
    // Renaming a project folder is an ordinary action; it must not disarm the
    // statement freeze or erase recorded FAILs.
    const after = new GateStore(moved);
    expect(after.all().length).toBe(1);
    expect(after.all()[0].verdict).toBe("FAIL");
    fs.rmSync(moved, { recursive: true, force: true });
  });

  test("a campaign that ran before but has no gate history refuses to adopt", () => {
    process.env.COVERIFY_STATE_DIR = fs.mkdtempSync("/private/tmp/coverify-idstate2-");
    const dir = fs.mkdtempSync("/private/tmp/coverify-lost-");
    fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
    fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# S\n\nX.\n");
    ranBefore(dir);
    expect(() => new GateStore(dir)).toThrow(/no gate history/);
    process.env.COVERIFY_ADOPT = "1";
    expect(() => new GateStore(dir)).not.toThrow();
    delete process.env.COVERIFY_ADOPT;
  });

  test("a fresh campaign is not mistaken for lost state", () => {
    process.env.COVERIFY_STATE_DIR = fs.mkdtempSync("/private/tmp/coverify-idstate3-");
    const dir = fs.mkdtempSync("/private/tmp/coverify-fresh-");
    initCampaign(dir, "a brand new statement");
    expect(() => new GateStore(dir)).not.toThrow();
  });

  test("evidence names are reserved, so two callers cannot take the same one", () => {
    const dir = fs.mkdtempSync("/private/tmp/coverify-eviname-");
    fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });
    const first = newEvidencePath(dir, "v001/report");
    const second = newEvidencePath(dir, "v001/report");
    expect(first).not.toBe(second);
    expect(first.endsWith("report.r1.md")).toBe(true);
    expect(second.endsWith("report.r2.md")).toBe(true);
  });

  test("a torn cursor does not redeliver every message ever sent", () => {
    const dir = campaign();
    queueUserMessage(dir, "old guidance");
    consumeUserMessages(dir, 1);
    // A crash mid-write used to leave a truncated cursor reading as 0.
    const cursor = path.join(dir, ".coverify", "inbox.cursor");
    expect(fs.existsSync(cursor)).toBe(true);
    expect(fs.readFileSync(cursor, "utf8").trim()).toBe("1");
    expect(peekUserMessages(dir)).toEqual([]);
  });
});

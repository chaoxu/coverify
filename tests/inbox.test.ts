// The user->coordinator inbox (coverify say) is delivery infrastructure:
// messages must survive until actually delivered, and consumption must never
// eat a message queued after the wake peeked.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { queueUserMessage, peekUserMessages, consumeUserMessages, initCampaign, readJournal, appendJournal } =
  await import("../src/campaign.ts");
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

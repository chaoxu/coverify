// The user->coordinator inbox (coverify say) is delivery infrastructure:
// messages must survive until actually delivered, and consumption must never
// eat a message queued after the wake peeked.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { queueUserMessage, peekUserMessages, consumeUserMessages } = await import(
  "../src/campaign.ts"
);

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
    expect(fs.existsSync(path.join(dir, ".coverify", "inbox.jsonl"))).toBe(false);
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

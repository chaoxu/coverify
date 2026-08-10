// coverify turns is derived observability: it must read the session trees
// faithfully (usage sums include compaction spend; torn/foreign lines are
// skipped) and never write anything.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { campaignTurns } = await import("../src/telemetry/turns.ts");

test("campaignTurns derives records and usage from a session tree", () => {
  const dir = fs.mkdtempSync("/private/tmp/coverify-turns-");
  const sess = path.join(dir, ".coverify", "sessions", "--camp--");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(
    path.join(sess, "2026-08-02T00-00-00_abc123.jsonl"),
    [
      '{"type":"session","version":3,"id":"abc123","timestamp":"t","cwd":"/x"}',
      '{"type":"message","message":{"role":"user","content":"hi","timestamp":1000}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hello"},{"type":"toolCall"}],' +
        '"timestamp":3000,"stopReason":"stop","usage":{"input":10,"output":5,"cacheRead":90,"cacheWrite":0}}}',
      '{"type":"message","message":{"role":"assistant","content":"","timestamp":9000,"stopReason":"stop",' +
        '"usage":{"input":2,"output":1,"cacheRead":0,"cacheWrite":0}}}',
      '{"type":"compaction","usage":{"input":50,"output":20,"cacheRead":0,"cacheWrite":0}}',
      'torn{',
    ].join("\n") + "\n",
  );
  const before = fs.readdirSync(dir, { recursive: true }).sort();

  const sessions = campaignTurns(dir);
  expect(sessions).toHaveLength(1);
  const s = sessions[0];
  expect(s.id).toBe("abc123");
  // Records: sizes/gaps only, torn line and compaction excluded from turns.
  expect(s.turns).toHaveLength(3);
  expect(s.turns[1]).toMatchObject({ role: "assistant", textChars: 5, toolCalls: 1, stopReason: "stop" });
  expect(s.turns[2].gapMs).toBe(6000); // assistant-to-assistant gap
  // Usage: messages plus the compaction entry's own spend.
  expect(s.usage).toMatchObject({ input: 62, output: 26, cacheRead: 90 });
  // No backend reported reasoning tokens, so the field stays absent.
  expect(s.usage.reasoning).toBeUndefined();

  expect(fs.readdirSync(dir, { recursive: true }).sort()).toEqual(before); // read-only
});

test("pi's nested cost block never reaches a record", () => {
  // Every lane is subscription-billed, so the CLI/pi price is notional list
  // price. It is dropped at the boundary rather than journalled as spend —
  // and it must not survive into the per-turn JSON either.
  const dir = fs.mkdtempSync("/private/tmp/coverify-turns-cost-");
  const sess = path.join(dir, ".coverify", "sessions", "s");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(
    path.join(sess, "2026-08-09T00-00-00_priced.jsonl"),
    [
      '{"type":"session","version":3,"id":"priced","timestamp":"t","cwd":"/x"}',
      '{"type":"message","message":{"role":"assistant","content":"a","timestamp":1000,"usage":' +
        '{"input":649,"output":1990,"cacheRead":4608,"cacheWrite":0,"reasoning":1809,"cost":{"total":0.065249}}}}',
      '{"type":"compaction","usage":{"input":50,"output":20,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.25}}}',
    ].join("\n") + "\n",
  );
  const s = campaignTurns(dir)[0];
  // Tokens are summed across messages and the compaction entry; reasoning too.
  expect(s.usage).toMatchObject({ input: 699, output: 2010, cacheRead: 4608 });
  expect(s.usage.reasoning).toBe(1809);
  expect(JSON.stringify(s.usage)).not.toMatch(/cost/i);
  expect(JSON.stringify(s.turns[0])).not.toMatch(/cost/i);
});


test("both sides of the cross-check apply one accumulation rule", async () => {
  // turns.ts rebuilds usage from pi's session JSONL while providers.ts builds
  // it from the live message list, and their agreement was the 2026-08-09
  // study's only genuine cross-check (0.2% on presented/output/reasoning; the
  // one disagreement located a real defect). Two hand-synced copies of the
  // rule would have turned that check into a comparison of one rule against a
  // stale fork of itself (issue #43), so there is now one exported function
  // and this pins the behaviour that used to differ: a NON-assistant message
  // carrying usage is billed by neither side.
  const { sumMessagesUsage } = await import("../src/providers.ts");
  const dir = fs.mkdtempSync("/private/tmp/coverify-turns-drift-");
  const sess = path.join(dir, ".coverify", "sessions", "--camp--");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(
    path.join(sess, "2026-08-02T00-00-00_drift.jsonl"),
    [
      '{"type":"session","version":3,"id":"drift","timestamp":"t","cwd":"/x"}',
      // A user message carrying usage: pi writes none today, but the two
      // implementations disagreed about it, which is drift waiting to happen.
      '{"type":"message","message":{"role":"user","content":"hi","timestamp":1000,' +
        '"usage":{"input":999,"output":999,"cacheRead":999}}}',
      '{"type":"message","message":{"role":"assistant","content":"a","timestamp":2000,' +
        '"usage":{"input":10,"output":5,"cacheRead":1,"reasoning":4}}}',
    ].join("\n") + "\n",
  );
  const fromTree = campaignTurns(dir)[0].usage;
  const fromMessages = sumMessagesUsage([
    { role: "user", usage: { input: 999, output: 999, cacheRead: 999 } },
    { role: "assistant", usage: { input: 10, output: 5, cacheRead: 1, reasoning: 4 } },
  ]);
  expect(fromTree).toEqual(fromMessages);
  expect(fromTree.input).toBe(10); // the user message's 999 is billed by neither
  expect(fromTree.reasoning).toBe(4);
});

// coverify turns is derived observability: it must read the session trees
// faithfully (usage sums include compaction spend; torn/foreign lines are
// skipped) and never write anything.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { campaignTurns } = await import("../src/turns.ts");

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

  expect(fs.readdirSync(dir, { recursive: true }).sort()).toEqual(before); // read-only
});

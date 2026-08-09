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
  // None of those turns priced its tokens, so cost stays absent — reporting
  // $0 over 62k input tokens would be a false record, not a cheap session.
  expect(s.usage.costUSD).toBeUndefined();

  expect(fs.readdirSync(dir, { recursive: true }).sort()).toEqual(before); // read-only
});

test("priced sessions sum cost from pi's nested cost.total", () => {
  // pi writes the priced total under `usage.cost.total`; reading a flattened
  // `costUSD` that the session log never contains reports every priced
  // coordinator session as unpriced.
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
  expect(s.usage.costUSD).toBeCloseTo(0.315249, 6);
  expect(s.usage.reasoning).toBe(1809);
  // Per-turn records report cost the same way the session total does; the
  // nested wire shape must not leak into `coverify turns --session`.
  expect(s.turns[0].usage?.costUSD).toBeCloseTo(0.065249, 6);
  expect(JSON.stringify(s.turns[0])).not.toContain('"cost"');
});

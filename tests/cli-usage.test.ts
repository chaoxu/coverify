// The one place the three CLI token conventions are reconciled. Each lane
// answers "is `input` the uncached part?" differently, and getting it wrong is
// silent and one-directional — the codex nesting overstated fresh input by 30%
// in the 2026-08-09 study with nothing in the totals looking wrong.
import { expect, test } from "bun:test";

const { agyJsonUsage, agyReply, claudeJsonUsage, codexJsonlUsage } = await import(
  "../src/cli-usage.ts"
);

test("codex nests cached and cache-write inside input_tokens; both are subtracted", () => {
  const line = JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 100,
      output_tokens: 50,
      reasoning_output_tokens: 40,
    },
  });
  const u = codexJsonlUsage(line)!;
  // 1000 INCLUDES the 600 cached and 100 written, so fresh input is 300.
  expect(u.input).toBe(300);
  expect(u.cacheRead).toBe(600);
  expect(u.cacheWrite).toBe(100);
  expect(u.meter).toBe("codex-cli-jsonl");
  // reasoning is a SUBSET of output; adding them double-counts.
  expect(u.output).toBe(50);
  expect(u.reasoning).toBe(40);
});

test("codex sums every turn.completed, so a tool loop is not counted as one turn", () => {
  const turn = (input: number) =>
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, output_tokens: 1 } });
  const u = codexJsonlUsage([turn(10), turn(20)].join("\n"))!;
  expect(u.input).toBe(30);
  expect(u.output).toBe(2);
});

test("claude reports input already disjoint from cache, and no thinking field", () => {
  const u = claudeJsonUsage({
    input_tokens: 300,
    output_tokens: 50,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 100,
  });
  expect(u.input).toBe(300);
  expect(u.cacheRead).toBe(600);
  expect(u.cacheWrite).toBe(100);
  // Absent, never 0: the result JSON has no thinking-token field (absent ≠ zero).
  expect(u.reasoning).toBeUndefined();
});

test("agy's cache is disjoint from input, matching the measurement that set the convention", () => {
  // The live 2026-08-10 reading: cache_read (20096) EXCEEDS input (6405), which
  // is impossible under nesting, and total = input + output excludes the cache.
  const u = agyJsonUsage({
    input_tokens: 6405,
    output_tokens: 314,
    thinking_tokens: 308,
    cache_read_tokens: 20096,
    total_tokens: 6719,
  })!;
  expect(u.input).toBe(6405);
  expect(u.cacheRead).toBe(20096);
  expect(u.output).toBe(314);
  expect(u.reasoning).toBe(308);
  expect(u.meter).toBe("agy-json");
  expect(u.input + u.output).toBe(6719);
});

test("a librarian reply that is not the json envelope keeps its report and loses only the usage", () => {
  // COVERIFY_LITERATURE_CMD can point at any command. A librarian whose SPEND
  // cannot be read must never become a librarian whose REPORT is lost.
  const plain = agyReply("A prose report about the literature.\n");
  expect(plain.report).toBe("A prose report about the literature.\n");
  expect(plain.usage).toBeUndefined();

  const truncated = agyReply('{"response":"partial');
  expect(truncated.report).toBe('{"response":"partial');
  expect(truncated.usage).toBeUndefined();

  // Envelope present but usage missing: report survives, spend is a gap.
  const noUsage = agyReply(JSON.stringify({ response: "found three papers", status: "SUCCESS" }));
  expect(noUsage.report).toBe("found three papers");
  expect(noUsage.usage).toBeUndefined();
});

test("a full agy envelope yields the report and its usage together", () => {
  const r = agyReply(
    JSON.stringify({
      response: "ok\n",
      usage: { input_tokens: 22711, output_tokens: 63, thinking_tokens: 59, cache_read_tokens: 0 },
    }),
  );
  expect(r.report).toBe("ok\n");
  expect(r.usage?.input).toBe(22711);
  expect(r.usage?.reasoning).toBe(59);
});

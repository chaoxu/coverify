// The CLI verdict backends' output contract: the final text comes from the
// {out} file when the template names one, and the temp workdir must not be
// reaped before that file is read. Regression test for c60c03f, where an
// earlier 'close' handler deleted the workdir first and every codex-cli
// verdict fell back to raw --json stdout (parsed UNPARSEABLE) — caught by
// the 2026-08-07 smoke campaign.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { createCliRoleSession } = await import("../src/backends.ts");

const stubDir = fs.mkdtempSync("/private/tmp/coverify-cli-stub-");
afterEach(() => {
  delete process.env.COVERIFY_CODEX_CMD;
  delete process.env.COVERIFY_CLAUDE_CMD;
});

/** Run one stubbed CLI call and hand back what the backend journalled. */
async function usageFrom(
  provider: "codex-cli" | "claude-cli",
  envVar: "COVERIFY_CODEX_CMD" | "COVERIFY_CLAUDE_CMD",
  script: string,
  name: string,
) {
  const stub = path.join(stubDir, name);
  fs.writeFileSync(stub, script, { mode: 0o755 });
  process.env[envVar] = provider === "codex-cli" ? `${stub} {out}` : stub;
  const session = createCliRoleSession({
    contract: "c",
    charge: "c",
    prompt: "unused",
    spec: { provider, modelId: "stub", thinking: "off" },
    models: undefined as never,
  });
  await session.ask("q");
  return session.usage();
}

test("outfile backend reads {out} before the temp dir is reaped", async () => {
  // A stub "codex": noisy JSONL on stdout (what --json emits), final text in
  // the {out} file — exactly the real backend's shape.
  const stub = path.join(stubDir, "codex-stub.sh");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\necho '{"type":"turn.started"}'\nprintf 'VERDICT: PASS' > "$1"\n`,
    { mode: 0o755 },
  );
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  const session = createCliRoleSession({
    contract: "contract text",
    charge: "charge text",
    prompt: "unused",
    spec: { provider: "codex-cli", modelId: "stub", thinking: "off" },
    models: undefined as never,
  });
  expect(session.capabilities).toEqual({ steerable: false, durable: false });
  const text = await session.ask("candidate to judge");
  // The verdict, not the JSONL noise: outfile beats stdout.
  expect(text).toBe("VERDICT: PASS");
  expect(await session.steer("nudge")).toBe(false);
});

test("claude-cli usage records tokens and drops the reported price", async () => {
  // The payload carries total_cost_usd even on a subscription plan, where it
  // is notional list price rather than spend. Tokens are the record.
  const u = await usageFrom(
    "claude-cli",
    "COVERIFY_CLAUDE_CMD",
    `#!/bin/sh\ncat <<'EOF'\n{"result":"VERDICT: PASS","total_cost_usd":0.1516415,` +
      `"usage":{"input_tokens":10,"output_tokens":23,"cache_read_input_tokens":17893,"cache_creation_input_tokens":14207}}\nEOF\n`,
    "claude-priced.sh",
  );
  expect(u?.cacheRead).toBe(17893);
  expect(u?.cacheWrite).toBe(14207);
  expect(JSON.stringify(u)).not.toMatch(/cost/i);
});

test("codex usage records only real reasoning tokens", async () => {
  const withReasoning = await usageFrom(
    "codex-cli",
    "COVERIFY_CODEX_CMD",
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2,"reasoning_output_tokens":9}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    "codex-reasoning.sh",
  );
  expect(withReasoning?.reasoning).toBe(9);
  expect(withReasoning?.input).toBe(7);

  const without = await usageFrom(
    "codex-cli",
    "COVERIFY_CODEX_CMD",
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    "codex-noreasoning.sh",
  );
  expect(without?.reasoning).toBeUndefined();
});

test("codex-cli records input DISJOINT from cacheRead/cacheWrite", async () => {
  // Codex nests: input_tokens includes cached_input_tokens and
  // cache_write_input_tokens. Every other lane records `input` as the uncached
  // part (view/turns.ts: "usage.input is the uncached part"), so copying
  // input_tokens through unsubtracted made this lane's records mean something
  // different from the rest of the journal. That divergence overstated fresh
  // input by 30% across gate-critic/certifier/reconstructor/comparator in the
  // 2026-08-09 cost study. The invariant this pins: cacheRead may exceed input.
  const u = await usageFrom(
    "codex-cli",
    "COVERIFY_CODEX_CMD",
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":1000,` +
      `"cached_input_tokens":900,"cache_write_input_tokens":50,"output_tokens":40}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    "codex-cached.sh",
  );
  expect(u?.input).toBe(50); // 1000 − 900 cached − 50 written
  expect(u?.cacheRead).toBe(900);
  expect(u?.cacheWrite).toBe(50);
  expect(u?.output).toBe(40);
  // Presented input reconstructs by addition, never by reading input alone.
  expect((u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0)).toBe(1000);
});

test("codex-cli never reports negative input when cached exceeds input", async () => {
  // Defensive: a backend that reports cached > input (or omits input) must not
  // produce a negative token count that then poisons every downstream sum.
  const u = await usageFrom(
    "codex-cli",
    "COVERIFY_CODEX_CMD",
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":10,` +
      `"cached_input_tokens":900,"output_tokens":5}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    "codex-negative.sh",
  );
  expect(u?.input).toBe(0);
  expect(u?.cacheRead).toBe(900);
});

test("a CLI oracle answers exactly once", async () => {
  const stub = path.join(stubDir, "codex-once.sh");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf 'VERDICT: PASS' > "$1"\n`, { mode: 0o755 });
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  const session = createCliRoleSession({
    contract: "c",
    charge: "c",
    prompt: "unused",
    spec: { provider: "codex-cli", modelId: "stub", thinking: "off" },
    models: undefined as never,
  });
  await session.ask("first");
  // Awaited: an unawaited rejects() is a floating promise, so removing the
  // throw left this green.
  await expect(session.ask("second")).rejects.toThrow(/exactly once/);
});

test("each CLI lane stamps its own meter and its real gaps", async () => {
  // A reader must never have to infer the convention from the role and the
  // commit date — that inference is what overstated fresh input 30% in the
  // 2026-08-09 study. Each parser declares itself at the construction site.
  const codex = await usageFrom(
    "codex-cli",
    "COVERIFY_CODEX_CMD",
    `#!/bin/sh\necho '{"type":"thread.started","thread_id":"019fe743-d96b-7a93-8cb3-80b0c4aaa890"}'\n` +
      `echo '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":900,` +
      `"output_tokens":40,"reasoning_output_tokens":31}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    "codex-meter.sh",
  );
  expect(codex?.meter).toBe("codex-cli-jsonl");
  // cache_write_input_tokens is absent upstream (codex #32479, pi #6469), so
  // the field stays ABSENT rather than recording a 0 that would read as a
  // measurement. Observed per record, not read off a lane table — the day the
  // field starts arriving this records the real number with no code change.
  expect(codex?.cacheWrite).toBeUndefined();
  expect(codex?.reasoning).toBe(31);

  const claude = await usageFrom(
    "claude-cli",
    "COVERIFY_CLAUDE_CMD",
    `#!/bin/sh\ncat <<'EOF2'\n{"result":"VERDICT: PASS","usage":{"input_tokens":8,"output_tokens":23,` +
      `"cache_read_input_tokens":17893,"cache_creation_input_tokens":14207}}\nEOF2\n`,
    "claude-meter.sh",
  );
  expect(claude?.meter).toBe("claude-cli-json");
  // No thinking-token field in the result JSON at all (absent on 204/204 audit
  // records). pi's Usage contract already fixes undefined as "provider does
  // not report it", so no parallel gap list is needed.
  expect(claude?.reasoning).toBeUndefined();
  // This lane really does report cacheWrite, unlike the codex lanes.
  expect(claude?.cacheWrite).toBe(14207);
});

test("codexThreadId finds the rollout join key, and tolerates its absence", async () => {
  const { codexThreadId } = await import("../src/backends.ts");
  const stdout =
    `{"type":"thread.started","thread_id":"019fe743-d96b-7a93-8cb3-80b0c4aaa890"}\n` +
    `{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":5}}\n`;
  // Verbatim the session_id of the rollout under ~/.codex/sessions/, which
  // carries rate_limits.primary.used_percent — the meter that ends campaigns
  // and that nothing in this journal could previously join to.
  expect(codexThreadId(stdout)).toBe("019fe743-d96b-7a93-8cb3-80b0c4aaa890");
  expect(codexThreadId(`{"type":"turn.completed"}\n`)).toBeUndefined();
  expect(codexThreadId("not json at all\n")).toBeUndefined();
});

test("a nonzero exit after the provider was paid keeps its tokens and its turn count", async () => {
  // The provider was billed before the CLI failed; stdout already holds the
  // turn.completed usage. Rejecting before parsing threw away a measured
  // number. The turn count must survive too — the usage SUMS every turn, so a
  // floor of 1 would report N turns of tokens against one claimed request.
  const stub = path.join(stubDir, "codex-billed-fail.sh");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}'\n` +
      `echo '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":3}}'\n` +
      `echo 'boom' >&2\nexit 3\n`,
    { mode: 0o755 },
  );
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  const session = createCliRoleSession({
    contract: "c",
    charge: "c",
    prompt: "unused",
    spec: { provider: "codex-cli", modelId: "stub", thinking: "off" },
    models: undefined as never,
  });
  const err = await session.ask("q").then(
    () => undefined,
    (e) => e as { usage?: { input: number }; requests?: number; usageLeafed?: true },
  );
  expect(err?.usage?.input).toBe(110); // (100−40) + 50
  expect(err?.requests).toBe(2);
  // No component has claimed this payment yet, so a settle path may record it.
  expect(err?.usageLeafed).toBeUndefined();
  // The session reports the real turn count, not its answers-once floor.
  expect(session.requests?.()).toBe(2);
});

test("codex requests are counted from the stream, not assumed to be one", async () => {
  // codexJsonlUsage explicitly SUMS every turn.completed event, so a tool loop
  // records N turns of usage. Stamping requests:1 alongside that made
  // `GROUP BY requests` meaningless — a record could report four turns of
  // tokens against one claimed request.
  const { codexTurns } = await import("../src/backends.ts");
  const three =
    `{"type":"turn.completed","usage":{"input_tokens":1}}\n` +
    `{"type":"turn.completed","usage":{"input_tokens":2}}\n` +
    `{"type":"turn.completed","usage":{"input_tokens":3}}\n`;
  expect(codexTurns(three)).toBe(3);
  expect(codexTurns(`{"type":"thread.started"}\n`)).toBe(0);
});

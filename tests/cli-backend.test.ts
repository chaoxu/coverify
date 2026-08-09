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
  expect(session.ask("second")).rejects.toThrow(/exactly once/);
});

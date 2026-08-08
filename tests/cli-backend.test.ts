// The CLI verdict backends' output contract: the final text comes from the
// {out} file when the template names one, and the temp workdir must not be
// reaped before that file is read. Regression test for c60c03f, where an
// earlier 'close' handler deleted the workdir first and every codex-cli
// verdict fell back to raw --json stdout (parsed UNPARSEABLE) — caught by
// the 2026-08-07 smoke campaign.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { createCliRoleSession } = await import("../src/providers.ts");

const stubDir = fs.mkdtempSync("/private/tmp/coverify-cli-stub-");
afterEach(() => {
  delete process.env.COVERIFY_CODEX_CMD;
});

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

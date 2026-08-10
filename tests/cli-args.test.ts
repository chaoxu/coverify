// Argv parsing. Untested until now, which is how a real hole survived: the
// hand-rolled parser accepted ANY `--name value` into a map and nothing read
// unknown keys, so `coverify resume --max-wake 40` — one character off
// --max-wakes — ran UNBOUNDED and silently. That is the same failure class
// optionalInt() guards, which covers a bad VALUE and left a bad flag NAME open.
import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve("src/cli.ts");

/** Run the CLI and hand back what an operator would see. */
function run(...args: string[]): { code: number; err: string } {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, COVERIFY_STATE_DIR: `${os.tmpdir()}/coverify-cliargs-state` },
  });
  return {
    code: r.exitCode,
    err: new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout),
  };
}

test("a mistyped flag stops the run instead of being ignored", () => {
  const { code, err } = run("resume", "--max-wake", "40", "--dir", "/tmp/coverify-no-such");
  expect(code).not.toBe(0);
  expect(err).toContain("--max-wake");
  // And it must NOT have proceeded to the campaign check, which is what
  // "silently ignored the flag and ran" looked like.
  expect(err).not.toContain("no campaign at");
});

test("declared flags still parse, including the unlimited sentinel", () => {
  // `--agent-limit 0` is the documented request for unlimited workers; strict
  // parsing must not swallow the 0 or reject it as a missing value.
  const { err } = run("resume", "--agent-limit", "0", "--dir", "/tmp/coverify-no-such");
  expect(err).toContain("no campaign at");
  const eq = run("resume", "--agent-limit=0", "--dir", "/tmp/coverify-no-such");
  expect(eq.err).toContain("no campaign at");
});

test("a value-less flag is a boolean, and a bad value for it is rejected", () => {
  const ok = run("resume", "--no-computation", "--dir", "/tmp/coverify-no-such");
  expect(ok.err).toContain("no campaign at");
  // The old parser stored "false" as a STRING and compared it to "true", so
  // this happened to work by luck; strict mode rejects it outright.
  const bad = run("resume", "--no-computation=false", "--dir", "/tmp/coverify-no-such");
  expect(bad.code).not.toBe(0);
});

test("an argument beginning with '-' is passable, and the error says how", () => {
  // A frozen statement can legitimately open with a minus sign
  // ("-1 is not expressible as ..."). Strict mode rejects it as a flag, so the
  // message has to name the escape hatch rather than dump the usage block.
  const { code, err } = run("say", "-weird message", "--dir", "/tmp/coverify-no-such");
  expect(code).not.toBe(0);
  expect(err).toContain('after --');
  // With the separator it gets through to the campaign check.
  const viaSep = run("say", "--dir", "/tmp/coverify-no-such", "--", "-weird message");
  expect(viaSep.err).toContain("no campaign at");
});

test("a bad --max-wakes VALUE is still rejected with its own message", () => {
  // optionalInt's guard must survive the parser swap: this is the user's only
  // budget control and a bad value must stop the run, not disable itself.
  const { code, err } = run("resume", "--max-wakes", "-3", "--dir", "/tmp/coverify-no-such");
  expect(code).not.toBe(0);
  expect(err).toMatch(/must be a positive whole number|Unknown option|ambiguous/);
});

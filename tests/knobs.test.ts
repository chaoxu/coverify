// The env-knob registry (issue #45). Its value is that four things derive from
// ONE table — the read, `coverify config`, the generated usage text, and the
// run stamp — so these pin the properties that make that safe.
import { expect, test } from "bun:test";

const { KNOBS, knobSnapshot, knobUsage, readKnob, resolvedKnobs, formatResolvedKnobs, validateKnobs } =
  await import("../src/knobs.ts");

test("a present-but-invalid value hard-stops instead of falling back", () => {
  // The subtle rule, verified against envalid's behaviour before adopting it:
  // a declared default must NOT rescue a value that was set and is wrong. A
  // typo'd limit that silently means "no limit", or an effort setting that is
  // silently ignored, is worse than a crash — the second would make issue
  // #31's A/B compare an arm against itself.
  try {
    process.env.COVERIFY_RUN_MEM_MB = "lots";
    expect(() => readKnob("COVERIFY_RUN_MEM_MB")).toThrow(/is invalid/);
    // Valid values still read back verbatim.
    process.env.COVERIFY_RUN_MEM_MB = "8192";
    expect(readKnob("COVERIFY_RUN_MEM_MB")).toBe("8192");
  } finally {
    delete process.env.COVERIFY_RUN_MEM_MB;
  }
  // Unset falls back to the declared default.
  expect(readKnob("COVERIFY_RUN_MEM_MB")).toBe("4096");
});

test("reads are live, not parsed once and frozen", () => {
  // Why no config library was adopted: envalid, znv and @t3-oss/env-core all
  // parse eagerly and freeze. This codebase resolves specs and limits per call
  // so a mid-campaign change takes effect, and the tests set env vars after
  // import and expect the next read to see them.
  try {
    process.env.COVERIFY_RETRY_MAX = "0";
    expect(readKnob("COVERIFY_RETRY_MAX")).toBe("0");
    process.env.COVERIFY_RETRY_MAX = "9";
    expect(readKnob("COVERIFY_RETRY_MAX")).toBe("9");
  } finally {
    delete process.env.COVERIFY_RETRY_MAX;
  }
});

test("an undeclared knob is a programming error, not a silent undefined", () => {
  expect(() => readKnob("COVERIFY_NOT_A_KNOB")).toThrow(/unknown knob/);
});

test("provenance distinguishes env from default from unset", () => {
  // The point of `coverify config`: confirm an A/B arm is what you think it is
  // BEFORE spending quota, rather than discovering it in the journal after.
  try {
    process.env.COVERIFY_EFFORT_REASONER = "xhigh";
    const rows = resolvedKnobs();
    const effort = rows.find((r) => r.name === "COVERIFY_EFFORT_REASONER");
    expect(effort).toMatchObject({ source: "env", value: "xhigh" });
    // Declared fallback, nothing set.
    expect(rows.find((r) => r.name === "COVERIFY_RUN_MEM_MB")).toMatchObject({
      source: "default",
      value: "4096",
    });
    // No value and no declared default — the effective one is computed
    // elsewhere (ROLE_DEFAULTS), which the report says rather than implying 0.
    expect(rows.find((r) => r.name === "COVERIFY_MODEL_REASONER")?.source).toBe("unset");
  } finally {
    delete process.env.COVERIFY_EFFORT_REASONER;
  }
});

test("the run stamp records only what was SET", () => {
  // 31 rows of "unset" on every campaign would bury the signal; what a run
  // must prove is what governed IT.
  //
  // Asserted as a DELTA, not against an empty object: other tests in this
  // suite set COVERIFY_STATE_DIR and COVERIFY_LITERATURE_CMD and never unset
  // them, so a pristine-environment assumption fails only when the whole
  // suite runs — the shape of flake that gets marked "unrelated" and skipped.
  // The snapshot picking those up is the registry working.
  const before = knobSnapshot();
  expect(before).not.toHaveProperty("COVERIFY_EFFORT");
  try {
    process.env.COVERIFY_EFFORT = "low";
    expect(knobSnapshot()).toEqual({ ...before, COVERIFY_EFFORT: "low" });
  } finally {
    delete process.env.COVERIFY_EFFORT;
  }
  expect(knobSnapshot()).toEqual(before);
});

test("usage text is generated from the table, so it cannot drift", () => {
  // The defect this replaces: a hand-written list naming 5 of 31 knobs.
  const text = knobUsage();
  for (const k of KNOBS) expect(text).toContain(k.name);
});

test("the config report names the effective role routing, not just the variables", () => {
  // A model knob is "unset" as a VARIABLE while the run still has a model —
  // rendering only the variable would be true and useless.
  const text = formatResolvedKnobs(resolvedKnobs(), { reasoner: "openai-codex/gpt-5.6-sol@max" });
  expect(text).toContain("Effective role routing");
  expect(text).toContain("openai-codex/gpt-5.6-sol@max");
});

test("declared defaults match the real read sites", async () => {
  // A registry that DISPLAYS a wrong default is worse than none: `coverify
  // config` is billed as the A/B pre-flight, so a confidently-wrong number
  // there is read as ground truth. The first version shipped three wrong —
  // RETRY_MAX 5 (really 3), RETRY_BASE_MS 1000 (really 2000), and
  // CODEX_TRANSPORT "responses", which is not even a member of pi's Transport
  // union, so an operator who trusted it and set it explicitly would have
  // pushed an invalid transport into pi.
  const { retryPolicy, codexTransport } = await import("../src/providers.ts");
  const { runTimeoutMs, runMemMb } = await import("../src/sandbox.ts");
  const declared = (n: string) => KNOBS.find((k) => k.name === n)?.fallback;

  const retry = retryPolicy();
  expect(declared("COVERIFY_RETRY_MAX")).toBe(String(retry.maxRetries));
  expect(declared("COVERIFY_RETRY_BASE_MS")).toBe(String(retry.baseDelayMs));
  expect(declared("COVERIFY_CODEX_TRANSPORT")).toBe(codexTransport());
  expect(declared("COVERIFY_RUN_TIMEOUT_MS")).toBe(String(runTimeoutMs()));
  expect(declared("COVERIFY_RUN_MEM_MB")).toBe(String(runMemMb()));
});

test("a transport outside pi's union is rejected, not blind-cast", () => {
  try {
    process.env.COVERIFY_CODEX_TRANSPORT = "responses";
    expect(() => validateKnobs()).toThrow(/expected one of: sse, websocket, websocket-cached, auto/);
  } finally {
    delete process.env.COVERIFY_CODEX_TRANSPORT;
  }
});

test("validateKnobs reports EVERY bad knob, not just the first", () => {
  // An operator setting up an A/B arm should learn about all their typos in
  // one run, not one per attempt.
  try {
    process.env.COVERIFY_RETRY_MAX = "abc";
    process.env.COVERIFY_EFFORT = "maximum";
    const err = (() => {
      try {
        validateKnobs();
        return "";
      } catch (e) {
        return String((e as Error).message);
      }
    })();
    expect(err).toContain("COVERIFY_RETRY_MAX");
    expect(err).toContain("COVERIFY_EFFORT");
  } finally {
    delete process.env.COVERIFY_RETRY_MAX;
    delete process.env.COVERIFY_EFFORT;
  }
});

test("a lenient coercion does not bless a value the real readers turn into NaN", () => {
  // typebox's Convert is generous: "true", "0x10" and "1e3" all satisfy
  // Integer. Accepting them would hand the real readers strings that Number()
  // maps to NaN or to a silently different value.
  for (const bad of ["true", "0x10", "1e3", "3.7"]) {
    try {
      process.env.COVERIFY_RETRY_MAX = bad;
      expect(() => validateKnobs()).toThrow(/is invalid/);
    } finally {
      delete process.env.COVERIFY_RETRY_MAX;
    }
  }
});

test("the pre-flight SHOWS an invalid value instead of reporting it healthy", () => {
  // `coverify config` exists to confirm an arm before spending quota. Marking
  // a typo'd knob as a healthy `env` value is the one thing it must not do.
  try {
    process.env.COVERIFY_EFFORT_REASONER = "maxx";
    const row = resolvedKnobs().find((r) => r.name === "COVERIFY_EFFORT_REASONER");
    expect(row?.source).toBe("env");
    expect(row?.invalid).toContain("expected one of");
  } finally {
    delete process.env.COVERIFY_EFFORT_REASONER;
  }
});

test("a command template is stamped as set, never verbatim", () => {
  // The run stamp is mirrored into the campaign's in-tree journal, which lives
  // in a project repo and is plausibly committed. Command templates carry auth
  // flags; recording THAT one was overridden is what reproducing a run needs.
  try {
    process.env.COVERIFY_CHATGPT_CMD = "chatgpt --api-key sk-SECRET-VALUE";
    const snap = knobSnapshot();
    expect(snap.COVERIFY_CHATGPT_CMD).toBe("<set>");
    expect(JSON.stringify(snap)).not.toContain("sk-SECRET-VALUE");
  } finally {
    delete process.env.COVERIFY_CHATGPT_CMD;
  }
});

test("usage text carries the allowed values, read off the schema", () => {
  // The hand-written block spelled the effort ladder by hand; losing it in the
  // generated version would be a regression the registry caused.
  const text = knobUsage();
  expect(text).toContain("off|minimal|low|medium|high|xhigh|max");
  expect(text).toContain("sse|websocket|websocket-cached|auto");
  // A secret's default is never printed either.
  expect(text).not.toContain("dangerously-skip-permissions");
});

test("no run-stamp field carries a command template verbatim when it was overridden", async () => {
  // Redacting knobSnapshot() alone was not enough: `cliTemplates` in the run
  // stamp records the same values through a different field, and was still
  // writing them verbatim. Found while reviewing the commit that added the
  // redaction — the leak was half-closed and the message said closed.
  const { cliBackendCommandForRecord, cliBackendCommand } = await import("../src/backends.ts");
  try {
    process.env.COVERIFY_CODEX_CMD = "codex --api-key sk-SECRET-VALUE {out}";
    // The live command still resolves to the override — behaviour unchanged.
    expect(cliBackendCommand("codex-cli")).toContain("sk-SECRET-VALUE");
    // The RECORD does not.
    expect(cliBackendCommandForRecord("codex-cli")).toBe("<set: COVERIFY_CODEX_CMD>");
    expect(JSON.stringify(knobSnapshot())).not.toContain("sk-SECRET-VALUE");
  } finally {
    delete process.env.COVERIFY_CODEX_CMD;
  }
  // A built-in default carries no secret and IS the reproducibility fact, so
  // it is recorded verbatim.
  expect(cliBackendCommandForRecord("codex-cli")).toBe(cliBackendCommand("codex-cli"));
});

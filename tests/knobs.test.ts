// The env-knob registry (issue #45). It declares NAMES, never defaults: each
// default lives at its one read site, and a copy here drifted (40c5e06 shipped
// three wrong ones). What the table still buys is the two things a name list
// can be right about — the generated usage text, and the run stamp's record of
// what the operator actually set — plus the conformance check that no knob is
// read without being declared. These pin the properties that make that safe.
import { expect, test } from "bun:test";

const { KNOBS, knobSnapshot, knobUsage, validateKnobs } = await import("../src/knobs.ts");

test("the registry declares no defaults, so it cannot disagree with a read site", () => {
  // The defect this replaces: a second declaration of every default, policed by
  // a script, which shipped three wrong values. A knob object carries a name, a
  // shape for a PRESENT value, and prose — nothing that claims to know what the
  // run does when the variable is unset.
  for (const k of KNOBS) {
    expect(Object.keys(k).sort()).toEqual(["detail", "name", "rule", ...(k.secret ? ["secret"] : [])].sort());
  }
});

test("a present-but-invalid value hard-stops instead of falling back", () => {
  // The read site's default must not rescue a present-but-wrong value: a
  // silently ignored effort setting makes #31's A/B compare an arm against
  // itself.
  try {
    process.env.COVERIFY_RUN_MEM_MB = "lots";
    expect(() => validateKnobs()).toThrow(/COVERIFY_RUN_MEM_MB/);
    process.env.COVERIFY_RUN_MEM_MB = "8192";
    expect(() => validateKnobs()).not.toThrow();
  } finally {
    delete process.env.COVERIFY_RUN_MEM_MB;
  }
});

test("reads are live, not parsed once and frozen", async () => {
  // The surveyed config libraries all parse once and freeze, which this
  // codebase and its tests depend on not happening: every read site consults
  // process.env on each call, so a mid-campaign change takes effect.
  const { runMemMb } = await import("../src/sandbox.ts");
  try {
    process.env.COVERIFY_RUN_MEM_MB = "8192";
    expect(runMemMb()).toBe(8192);
    process.env.COVERIFY_RUN_MEM_MB = "2048";
    expect(runMemMb()).toBe(2048);
  } finally {
    delete process.env.COVERIFY_RUN_MEM_MB;
  }
});

test("the run stamp records only what was SET", () => {
  // 37 rows of "unset" on every campaign would bury the signal; what a run must
  // prove is what governed IT.
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

test("a per-role effort knob is stamped, though nothing reads it by literal name", () => {
  // providers.ts reads these through a computed key
  // (`COVERIFY_EFFORT_${ROLE}`), so no static check sees the read. Dropping the
  // declaration would not disable the knob — it would leave it working and
  // unrecorded, which is the one failure the run stamp exists to prevent.
  try {
    process.env.COVERIFY_EFFORT_REASONER = "xhigh";
    expect(knobSnapshot().COVERIFY_EFFORT_REASONER).toBe("xhigh");
  } finally {
    delete process.env.COVERIFY_EFFORT_REASONER;
  }
});

test("usage text is generated from the table, so it cannot drift", () => {
  // The defect this replaces: a hand-written list naming 5 of 31 knobs.
  const text = knobUsage();
  for (const k of KNOBS) expect(text).toContain(k.name);
});

test("usage text carries the allowed values, read off the rule", () => {
  // The hand-written block spelled the effort ladder by hand; losing it in the
  // generated version would be a regression the registry caused.
  const text = knobUsage();
  expect(text).toContain("off|minimal|low|medium|high|xhigh|max");
  expect(text).toContain("sse|websocket|websocket-cached|auto");
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
  // "true", "0x10", "1e3" and "3.7" all reach a reader that Number()s them into
  // NaN or into a silently different value. An integer knob takes digits only.
  for (const bad of ["true", "0x10", "1e3", "3.7"]) {
    try {
      process.env.COVERIFY_RETRY_MAX = bad;
      expect(() => validateKnobs()).toThrow(/is invalid/);
    } finally {
      delete process.env.COVERIFY_RETRY_MAX;
    }
  }
  // Zero is meaningful on this knob — it disables retries — and must not be
  // swept up by a "falsy is missing" guard.
  try {
    process.env.COVERIFY_RETRY_MAX = "0";
    expect(() => validateKnobs()).not.toThrow();
  } finally {
    delete process.env.COVERIFY_RETRY_MAX;
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

test("a free-form string knob accepts surrounding whitespace", () => {
  // The numeric digits-only guard must not touch strings: a command template
  // pasted from a heredoc carries a trailing newline, and validateKnobs is the
  // first statement of prove(), so rejecting it would refuse to start the
  // campaign.
  try {
    process.env.COVERIFY_CLAUDE_CMD = " claude -p \n";
    expect(() => validateKnobs()).not.toThrow();
    process.env.COVERIFY_MODEL_REASONER = " openai-codex/gpt-5.6-sol@max ";
    expect(() => validateKnobs()).not.toThrow();
  } finally {
    delete process.env.COVERIFY_CLAUDE_CMD;
    delete process.env.COVERIFY_MODEL_REASONER;
  }
});

test("no error message is ever empty about why", () => {
  // A previous whitespace bug produced "is invalid." with no reason, because a
  // valid string yielded no schema errors and the knob had no choices. An
  // operator cannot act on that.
  for (const [name, bad] of [
    ["COVERIFY_RETRY_MAX", "true"],
    ["COVERIFY_EFFORT", "maximum"],
    ["COVERIFY_RUN_MEM_MB", "lots"],
  ] as const) {
    try {
      process.env[name] = bad;
      const msg = (() => {
        try {
          validateKnobs();
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect(msg).toContain(name);
      expect(msg).toMatch(/expected|must be/);
    } finally {
      delete process.env[name];
    }
  }
});

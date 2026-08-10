// The env-knob registry (issue #45). Its value is that four things derive from
// ONE table — the read, `coverify config`, the generated usage text, and the
// run stamp — so these pin the properties that make that safe.
import { expect, test } from "bun:test";

const { KNOBS, knobSnapshot, knobUsage, readKnob, resolvedKnobs, formatResolvedKnobs } =
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

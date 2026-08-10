// The NAMES of every environment knob this harness reads (issue #45), so the
// run stamp can record what the operator actually set and the conformance check
// can fail on a read that was never declared. Never write a knob COUNT here.
//
// What this file deliberately does NOT hold is the DEFAULTS. Each default lives
// at its one read site — `envNumber(process.env.X, 300_000, 1)` — which is the
// value that actually runs. A copy here was a second declaration of the same
// fact, policed by a script, and it drifted (40c5e06 shipped three wrong ones).
// A registry that can be wrong about the run is worse than no registry.
//
// Deliberately NOT a config file (issue #44 removed an ambient input that made
// runs unreproducible), and NOT a config library: the surveyed ones offer no
// provenance or serializable snapshot, and all parse eagerly and freeze, which
// breaks the lazy reads this codebase depends on.

/** What a PRESENT value must look like. Not a default: an unset knob never
 *  reaches here, and the effective value is whatever its read site says. */
type Rule =
  | { kind: "string" }
  | { kind: "int"; min: number }
  | { kind: "oneOf"; values: readonly string[] };

const str = { kind: "string" } as const;
const posInt = { kind: "int", min: 1 } as const;
const nonNegInt = { kind: "int", min: 0 } as const;
const flag = { kind: "oneOf", values: ["1", "true", "yes"] } as const;
const effort = {
  kind: "oneOf",
  values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
} as const;

export interface Knob {
  name: string;
  /** A present-but-invalid value never falls back to the read site's default. */
  rule: Rule;
  detail: string;
  /** A shell command template, which routinely carries auth flags. The run
   *  stamp reaches the in-tree journal, so these are stamped `<set>`. */
  secret?: true;
}

/** Role suffixes as spelled in the env names (NOT the RoleName union: the gate
 *  critic's is CRITIC). Importing providers.ts would be circular, so the
 *  conformance check pins these against ROLE_ENV. */
export const ROLE_ENV_SUFFIXES = [
  "COORDINATOR",
  "REASONER",
  "TECHNICIAN",
  "CRITIC",
  "AUDITOR",
  "CERTIFIER",
  "RECONSTRUCTOR",
  "COMPARATOR",
] as const;

const FAMILIES = ["FABLE", "GEMINI", "PRO"] as const;

export const KNOBS: readonly Knob[] = [
  // Model routing. Defaults: ROLE_DEFAULTS / FAMILY_SPECS in providers.ts.
  ...ROLE_ENV_SUFFIXES.map((r) => ({
    name: `COVERIFY_MODEL_${r}`,
    rule: str,
    detail: `${r.toLowerCase()} model as provider/model[@thinking]; default in ROLE_DEFAULTS`,
  })),
  {
    name: "COVERIFY_EFFORT",
    rule: effort,
    detail: "reasoning effort for every role, leaving provider and model alone (#31's A/B knob)",
  },
  ...ROLE_ENV_SUFFIXES.map((r) => ({
    name: `COVERIFY_EFFORT_${r}`,
    rule: effort,
    detail: `reasoning effort for ${r.toLowerCase()} alone; beats COVERIFY_EFFORT`,
  })),
  ...FAMILIES.map((f) => ({
    name: `COVERIFY_FAMILY_${f}`,
    rule: str,
    detail: `ideation family "${f.toLowerCase()}" spec; default in FAMILY_SPECS`,
  })),

  // Backend transports. Templates, not argv: {model}/{out} substituted per call.
  { name: "COVERIFY_CLAUDE_CMD", secret: true, rule: str, detail: "claude-cli command template" },
  { name: "COVERIFY_CODEX_CMD", secret: true, rule: str, detail: "codex-cli command template ({out})" },
  { name: "COVERIFY_CHATGPT_CMD", secret: true, rule: str, detail: "chatgpt-cli oracle command template" },
  { name: "COVERIFY_AGY_CMD", secret: true, rule: str, detail: "agy oracle command template ({repo}, {model})" },
  {
    name: "COVERIFY_CODEX_TRANSPORT",
    rule: { kind: "oneOf", values: ["sse", "websocket", "websocket-cached", "auto"] },
    detail: "openai-codex wire transport",
  },
  {
    name: "COVERIFY_LITERATURE_CMD",
    rule: str,
    secret: true,
    detail: "librarian CLI (external agent with live web search)",
  },
  {
    name: "COVERIFY_LITERATURE_STATE_DIRS",
    rule: str,
    detail: "colon-separated dirs the librarian may write (token refresh, cache)",
  },

  // Limits. User-set only: the launcher forbids harness-invented ceilings, and
  // these bound resources, never proof work.
  { name: "COVERIFY_RUN_TIMEOUT_MS", rule: posInt, detail: "run_script batch wall limit" },
  { name: "COVERIFY_RUN_MEM_MB", rule: posInt, detail: "run_script batch combined RSS cap" },
  { name: "COVERIFY_RETRY_MAX", rule: nonNegInt, detail: "provider retry attempts; 0 disables" },
  { name: "COVERIFY_RETRY_BASE_MS", rule: posInt, detail: "provider retry backoff base" },
  {
    name: "COVERIFY_COORDINATOR_CONTEXT_TOKENS",
    rule: posInt,
    detail: "coordinator context cap before in-place compaction",
  },
  {
    name: "COVERIFY_WAKE_GROWTH_NOTE_TOKENS",
    rule: posInt,
    detail: "per-wake context growth above which the harness notes it",
  },

  // Paths and state.
  {
    name: "COVERIFY_STATE_DIR",
    rule: str,
    detail: "out-of-tree gate store root (the trust domain no role can write)",
  },
  {
    name: "COVERIFY_LAUNCHER_PATH",
    rule: str,
    detail: "launcher contract override; set-but-missing hard-fails, never falls back",
  },

  // Operations.
  { name: "COVERIFY_WIRE_LOG", rule: str, detail: "path to append raw provider wire traffic" },
  {
    name: "COVERIFY_ADOPT",
    rule: flag,
    detail: "allow rebuilding gate history from the lower-trust journal mirror",
  },
];

/** The literal values a knob accepts, or undefined for a free-form string. */
function knobChoices(knob: Knob): readonly string[] | undefined {
  return knob.rule.kind === "oneOf" ? knob.rule.values : undefined;
}

/** Why this raw value is invalid for this knob, or undefined if it is fine.
 *  Exact forms only. An integer knob takes digits and nothing else: `true`,
 *  `0x10`, `1e3` and `3.7` all reach a reader that Number()s them into NaN or
 *  into a silently different value, so they are rejected here rather than
 *  discovered as a compaction that never fired. Free-form strings accept
 *  anything, including surrounding whitespace — a command template pasted from
 *  a heredoc carries a trailing newline, and validateKnobs is the first
 *  statement of prove(), so rejecting it would refuse to start the campaign. */
function knobError(knob: Knob, raw: string): string | undefined {
  const rule = knob.rule;
  const refuse = " Refusing to fall back to the default: a silently ignored setting is worse than a stop.";
  if (rule.kind === "oneOf") {
    if (rule.values.includes(raw)) return undefined;
    return `${knob.name}="${raw}" is invalid (expected one of: ${rule.values.join(", ")}).` + refuse;
  }
  if (rule.kind === "int") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed) && Number(trimmed) >= rule.min) return undefined;
    return (
      `${knob.name}="${raw}" is invalid (expected an integer >= ${rule.min}, written in digits ` +
      `only — not a form that silently coerces, such as true, 0x10, 1e3 or 3.7).` + refuse
    );
  }
  return undefined;
}

/** Validate every knob set in this environment, throwing with ALL the bad ones.
 *  Called once at campaign start, where "never silently falls back" is enforced:
 *  individual readers stay lenient because `runTimeoutMs()` runs while a tool
 *  executes and throwing there would kill a live campaign. Without this,
 *  `COVERIFY_COORDINATOR_CONTEXT_TOKENS=abc` becomes NaN and compaction never
 *  fires. */
export function validateKnobs(): void {
  const bad = KNOBS.map((k) => {
    const raw = process.env[k.name];
    return raw === undefined || raw === "" ? undefined : knobError(k, raw);
  }).filter((e): e is string => e !== undefined);
  if (bad.length > 0) throw new Error(bad.join("\n"));
}

/** The run stamp's view: only what was actually SET. Command templates are
 *  stamped `<set>` — that one was overridden reproduces the run, the flag that
 *  authenticated it is a leak. */
export function knobSnapshot(): Record<string, string> {
  return Object.fromEntries(
    KNOBS.filter((k) => {
      const raw = process.env[k.name];
      return raw !== undefined && raw !== "";
    }).map((k) => [k.name, k.secret ? "<set>" : (process.env[k.name] as string)]),
  );
}

/** The env section of `coverify --help`, generated so it cannot drift. Values
 *  only, never defaults: the default is at the read site named in the code. */
export function knobUsage(): string {
  const w = Math.max(...KNOBS.map((k) => k.name.length));
  return KNOBS.map((k) => {
    const choices = knobChoices(k);
    return `  ${k.name.padEnd(w)}  ${k.detail}${choices ? ` (${choices.join("|")})` : ""}`;
  }).join("\n");
}

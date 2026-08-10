// Every environment knob, declared once (issue #45).
//
// The problem was never the count — this many knobs against 6 CLI flags is a
// lot, but not wrong. It was that the truth lived in three hand-synced places:
// the read site in code, the usage string in cli.ts, and the run stamp in
// observe.ts. The usage string named 5 of them, six were stamped nowhere, so a
// campaign could not prove what governed it. That is the same drift pattern as
// issue #43, one layer up.
//
// Counts are deliberately not written down here. The first version of this
// file said "31" in three places while declaring 37, inside the module whose
// whole thesis is that a number kept by hand goes stale.
//
// Deliberately NOT a config file. Coverify just spent issue #44 removing an
// ambient input that made runs unreproducible; a config file adds a new one —
// "which config governed this run?" — for benefits available without it. One
// source of truth per knob: the environment, with a declared default.
//
// Deliberately NOT a config LIBRARY either. envalid, znv, @t3-oss/env-core,
// convict and nconf were surveyed: none provides provenance, generated help,
// or a serializable snapshot — the three things actually needed — and all of
// them parse eagerly and freeze, which breaks the lazy reads this codebase and
// its tests depend on (tests set COVERIFY_FAMILY_* and COVERIFY_CODEX_CMD
// mid-run and expect the next read to see it). typebox, already a dependency,
// does the coercion and validation that was the only part they'd have covered.
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

export interface Knob {
  name: string;
  /** Validated with typebox: a present-but-invalid value never falls back to
   *  the default (envalid's one genuinely subtle rule, worth stealing). */
  schema: TSchema;
  /** Rendered in help and used when the variable is unset. `undefined` means
   *  the effective default is computed elsewhere and named in `detail`. */
  fallback?: string;
  detail: string;
  /** Which module reads it — so a reader can go straight to the enforcement. */
  module: string;
  /** A free-form shell command template, which routinely carries auth flags
   *  (`--api-key sk-…`). The run stamp is mirrored into the campaign's in-tree
   *  journal, which lives in a project repo and is plausibly committed, so
   *  these are stamped as `<set>` rather than verbatim. Standing rule: never
   *  put a secret value in code, logs, or issues. */
  secret?: true;
}

const str = Type.String();
const posInt = Type.Integer({ minimum: 1 });
const nonNegInt = Type.Integer({ minimum: 0 });
const flag = Type.Union([Type.Literal("1"), Type.Literal("true"), Type.Literal("yes")]);

/** Role suffixes as spelled in the env names (NOT the RoleName union: the gate
 *  critic's variable is CRITIC and the auditor's is AUDITOR). Imported from
 *  providers.ts would be circular, so the conformance check pins that these
 *  match the ROLE_ENV table rather than a comment asking you to remember. */
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
  // Model routing.
  ...ROLE_ENV_SUFFIXES.map((r) => ({
    name: `COVERIFY_MODEL_${r}`,
    schema: str,
    detail: `${r.toLowerCase()} model as provider/model[@thinking]; default in ROLE_DEFAULTS`,
    module: "providers.ts",
  })),
  {
    name: "COVERIFY_EFFORT",
    schema: Type.Union(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => Type.Literal(l)),
    ),
    detail: "reasoning effort for every role, leaving provider and model alone (#31's A/B knob)",
    module: "providers.ts",
  },
  ...ROLE_ENV_SUFFIXES.map((r) => ({
    name: `COVERIFY_EFFORT_${r}`,
    schema: Type.Union(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => Type.Literal(l)),
    ),
    detail: `reasoning effort for ${r.toLowerCase()} alone; beats COVERIFY_EFFORT`,
    module: "providers.ts",
  })),
  ...FAMILIES.map((f) => ({
    name: `COVERIFY_FAMILY_${f}`,
    schema: str,
    detail: `ideation family "${f.toLowerCase()}" spec; default in FAMILY_SPECS`,
    module: "providers.ts",
  })),

  // Backend transports. Templates, not resolved argv: {model} and {out} are
  // substituted per call.
  { name: "COVERIFY_CLAUDE_CMD", secret: true, schema: str, detail: "claude-cli command template", module: "backends.ts" },
  { name: "COVERIFY_CODEX_CMD", secret: true, schema: str, detail: "codex-cli command template ({out})", module: "backends.ts" },
  { name: "COVERIFY_CHATGPT_CMD", secret: true, schema: str, detail: "chatgpt-cli oracle command template", module: "backends.ts" },
  { name: "COVERIFY_AGY_CMD", secret: true, schema: str, detail: "agy oracle command template ({repo}, {model})", module: "backends.ts" },
  {
    name: "COVERIFY_CODEX_TRANSPORT",
    schema: Type.Union(["sse", "websocket", "websocket-cached", "auto"].map((l) => Type.Literal(l))),
    fallback: "auto",
    detail: "openai-codex wire transport",
    module: "providers.ts",
  },
  {
    name: "COVERIFY_LITERATURE_CMD",
    schema: str,
    secret: true,
    fallback: "agy --dangerously-skip-permissions --print-timeout 168h -p",
    detail: "librarian CLI (external agent with live web search)",
    module: "workspace.ts",
  },
  {
    name: "COVERIFY_LITERATURE_STATE_DIRS",
    schema: str,
    detail: "colon-separated dirs the librarian may write (token refresh, cache)",
    module: "workspace.ts",
  },

  // Limits. User-set only: the launcher forbids harness-invented ceilings, and
  // these bound resources, never proof work.
  { name: "COVERIFY_RUN_TIMEOUT_MS", schema: posInt, fallback: "600000", detail: "run_script batch wall limit", module: "sandbox.ts" },
  { name: "COVERIFY_RUN_MEM_MB", schema: posInt, fallback: "4096", detail: "run_script batch combined RSS cap", module: "sandbox.ts" },
  { name: "COVERIFY_RETRY_MAX", schema: nonNegInt, fallback: "3", detail: "provider retry attempts; 0 disables", module: "providers.ts" },
  { name: "COVERIFY_RETRY_BASE_MS", schema: posInt, fallback: "2000", detail: "provider retry backoff base", module: "providers.ts" },
  {
    name: "COVERIFY_COORDINATOR_CONTEXT_TOKENS",
    schema: posInt,
    fallback: "300000",
    detail: "coordinator context cap before in-place compaction",
    module: "harness.ts",
  },
  {
    name: "COVERIFY_WAKE_GROWTH_NOTE_TOKENS",
    schema: posInt,
    fallback: "40000",
    detail: "per-wake context growth above which the harness notes it",
    module: "harness.ts",
  },

  // Paths and state.
  {
    name: "COVERIFY_STATE_DIR",
    schema: str,
    fallback: "~/.local/state/coverify",
    detail: "out-of-tree gate store root (the trust domain no role can write)",
    module: "gates.ts",
  },
  {
    name: "COVERIFY_LAUNCHER_PATH",
    schema: str,
    fallback: "contract/math-proof-search-launcher.md",
    detail: "launcher contract override; set-but-missing hard-fails, never falls back",
    module: "launcher.ts",
  },

  // Operations.
  { name: "COVERIFY_WIRE_LOG", schema: str, detail: "path to append raw provider wire traffic", module: "providers.ts" },
  {
    name: "COVERIFY_ADOPT",
    schema: flag,
    detail: "allow rebuilding gate history from the lower-trust journal mirror",
    module: "gates.ts",
  },
];

const BY_NAME = new Map(KNOBS.map((k) => [k.name, k]));

/**
 * Read one knob, coercing and validating against its schema. A value that is
 * PRESENT BUT INVALID throws — it never falls back to the default, because a
 * silently-ignored setting is how an A/B ends up comparing an arm against
 * itself, and how a typo'd limit reads as no limit at all.
 *
 * Reads live, on every call, deliberately: this codebase resolves specs and
 * limits per call so a mid-campaign env change takes effect, and the tests
 * depend on it. Every surveyed config library parses once and freezes.
 */
export function readKnob(name: string): string | undefined {
  const knob = BY_NAME.get(name);
  if (!knob) throw new Error(`unknown knob ${name} — declare it in src/knobs.ts`);
  const raw = process.env[name];
  if (raw === undefined || raw === "") return knob.fallback;
  const why = knobError(knob, raw);
  if (why !== undefined) throw new Error(why);
  return raw;
}

/** Why this raw value is invalid for this knob, or undefined if it is fine.
 *
 *  Validates the CONVERTED value but reports the RAW one, because the raw
 *  string is what the operator typed and what every real reader will see —
 *  typebox's Convert is lenient enough that "true", "0x10" and "1e3" all
 *  satisfy Integer, so a check that returned the converted value would bless
 *  strings the actual readers then turn into NaN. */
/** The literal values a union-schema knob accepts, read off the schema rather
 *  than spelled in prose — the hand-written usage block used to list the
 *  effort ladder by hand, which is precisely the drift this registry ends. */
function knobChoices(knob: Knob): string[] | undefined {
  const anyOf = (knob.schema as { anyOf?: { const?: string }[] }).anyOf;
  const consts = anyOf?.map((s) => s.const).filter((c): c is string => c !== undefined);
  return consts !== undefined && consts.length > 0 ? consts : undefined;
}

function knobError(knob: Knob, raw: string): string | undefined {
  const converted = Value.Convert(knob.schema, raw);
  const choices = knobChoices(knob);
  if (!Value.Check(knob.schema, converted)) {
    const detail = [...Value.Errors(knob.schema, converted)].map((e) => e.message).join("; ");
    return (
      `${knob.name}="${raw}" is invalid` +
      (choices ? ` (expected one of: ${choices.join(", ")})` : detail ? ` (${detail})` : "") +
      ". Refusing to fall back to the default: a silently ignored setting is worse than a stop."
    );
  }
  // Re-serialization check, for NUMERIC and enum knobs only. It defeats
  // typebox Convert's leniency — "true", "0x10" and "1e3" all satisfy
  // Integer, and the real readers then Number() them into NaN or a silently
  // different value.
  //
  // NOT applied to free-form strings, and that exclusion is the bug fix: for a
  // plain Type.String() Convert is the identity and Check always passes, so
  // the comparison could only ever REJECT. It rejected any value with
  // surrounding whitespace — ` claude -p `, or a template set from a heredoc
  // with a trailing newline — and since validateKnobs() is the first statement
  // of prove(), that refused to start the campaign, with an empty reason
  // because a valid string produces no Value.Errors. 20 of the knobs are
  // plain strings, including every model spec and every command template.
  const freeForm = (knob.schema as { type?: string }).type === "string" && choices === undefined;
  if (freeForm || String(converted) === raw.trim()) return undefined;
  return (
    `${knob.name}="${raw}" is invalid (expected exactly ` +
    `${(knob.schema as { type?: string }).type ?? "a declared value"}, not a form that silently ` +
    `coerces to ${String(converted)}). Refusing to fall back to the default: a silently ignored ` +
    "setting is worse than a stop."
  );
}

/**
 * Validate every knob set in this environment, and throw listing ALL the bad
 * ones. Called once at campaign start.
 *
 * This is where the "never silently falls back" property is actually
 * enforced. The individual readers stay lenient on purpose — `runTimeoutMs()`
 * is called while a tool is executing, and throwing there would kill a live
 * campaign over a telemetry-shaped setting — so the check runs up front,
 * before any spend, where a bad value costs nothing to reject. Without it the
 * registry documents a guarantee nothing provides: `COVERIFY_RETRY_MAX=abc`
 * silently became 3, and `COVERIFY_COORDINATOR_CONTEXT_TOKENS=abc` became
 * NaN, which made `approxTokens() > NaN` false forever so compaction never
 * fired and the coordinator's context grew unbounded.
 */
export function validateKnobs(): void {
  const bad = KNOBS.map((k) => {
    const raw = process.env[k.name];
    return raw === undefined || raw === "" ? undefined : knobError(k, raw);
  }).filter((e): e is string => e !== undefined);
  if (bad.length > 0) throw new Error(bad.join("\n"));
}

export interface ResolvedKnob {
  name: string;
  value: string | undefined;
  /** Where the value came from. The point of the whole exercise: an operator
   *  can confirm an A/B arm is what they think BEFORE spending quota on it. */
  source: "env" | "default" | "unset";
  detail: string;
  module: string;
  /** Set when the environment holds a value this knob's schema rejects. The
   *  pre-flight has to SHOW this: a command whose stated purpose is "confirm
   *  the arm before spending quota" would otherwise render a typo'd arm as a
   *  healthy `env`-sourced value. */
  invalid?: string;
}

export function resolvedKnobs(): ResolvedKnob[] {
  return KNOBS.map((k) => {
    const raw = process.env[k.name];
    const set = raw !== undefined && raw !== "";
    const invalid = set ? knobError(k, raw) : undefined;
    return {
      name: k.name,
      value: set ? raw : k.fallback,
      source: set ? "env" : k.fallback !== undefined ? "default" : "unset",
      detail: k.detail,
      module: k.module,
      ...(invalid !== undefined ? { invalid } : {}),
    };
  });
}

/** The run stamp's view: only what was actually SET, so the record says what
 *  governed this run without a row of "unset" for every knob that was not.
 *
 *  Command templates are stamped as `<set>`. They are free-form shell strings
 *  that routinely carry auth flags, and this record is mirrored into the
 *  campaign's in-tree journal — a file inside a project repo that is
 *  plausibly committed. Recording THAT a template was overridden is the part
 *  that matters for reproducing a run; recording the flag that authenticated
 *  it is a leak. */
export function knobSnapshot(): Record<string, string> {
  return Object.fromEntries(
    KNOBS.filter((k) => {
      const raw = process.env[k.name];
      return raw !== undefined && raw !== "";
    }).map((k) => [k.name, k.secret ? "<set>" : (process.env[k.name] as string)]),
  );
}

/** The env section of `coverify --help`, generated so it cannot drift from the
 *  table the way the hand-written list did. */
export function knobUsage(): string {
  const w = Math.max(...KNOBS.map((k) => k.name.length));
  return KNOBS.map((k) => {
    const choices = knobChoices(k);
    const suffix = choices
      ? ` (${choices.join("|")})`
      : k.fallback !== undefined
        ? ` (default: ${k.fallback})`
        : "";
    return `  ${k.name.padEnd(w)}  ${k.detail}${suffix}`;
  }).join("\n");
}

/**
 * @param effective role -> the spec that will actually be used, resolved by
 *        providers.ts. Passed in rather than imported so this module stays
 *        dependency-free (the conformance check imports it). Without it the
 *        model knobs render as "unset", which is true of the VARIABLE and
 *        misleading about the run: their defaults live in ROLE_DEFAULTS, and
 *        the effective spec is the thing an operator is actually checking
 *        before spending quota on an A/B arm.
 */
export function formatResolvedKnobs(
  rows: readonly ResolvedKnob[],
  effective?: Record<string, string>,
): string {
  const out: string[] = [];
  const set = rows.filter((r) => r.source === "env");
  if (effective !== undefined) {
    out.push("Effective role routing — model and reasoning effort as this run would use them.");
    out.push("This is the A/B pre-flight: confirm the arm before spending quota on it.");
    const rw = Math.max(...Object.keys(effective).map((k) => k.length));
    for (const [role, spec] of Object.entries(effective)) out.push(`  ${role.padEnd(rw)}  ${spec}`);
    out.push("");
  }
  out.push("Every knob. `env` = set in this process's environment; `default` = declared");
  out.push("fallback; `unset` = no value and no declared default (the effective value, if");
  out.push("any, is computed in the module named and shown above for role routing).");
  out.push("");
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    // Redacted only when the ENVIRONMENT supplied it. A shipped default
    // carries no secret and IS the fact this command exists to show; printing
    // `default: <set>` was incoherent and hid the built-in from the reader.
    const secret = KNOBS.find((k) => k.name === r.name)?.secret === true;
    const shown = r.value === undefined ? "—" : secret && r.source === "env" ? "<set>" : r.value;
    out.push(`  ${(r.invalid ? "INVALID" : r.source).padEnd(7)} ${r.name.padEnd(w)}  ${shown}`);
  }
  out.push("");
  out.push(
    set.length === 0
      ? "Nothing is set in this environment: every value above is a declared default."
      : `${set.length} set in this environment: ${set.map((r) => r.name).join(", ")}.`,
  );
  out.push("Only the SET ones are stamped into a run record — that is what lets a campaign");
  out.push("prove what governed it without 31 rows of `unset` on every run.");
  return out.join("\n");
}

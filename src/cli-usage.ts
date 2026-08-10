// Token accounting for spawned CLIs, in one place.
//
// Every CLI coverify spawns reports its usage in its own shape, with its own
// answer to the one question that decides whether the numbers can be added up:
// IS `input` THE UNCACHED PART, OR DOES IT INCLUDE THE CACHE? Get that wrong
// and the error is silent, one-directional, and large — copying codex's
// `input_tokens` through unsubtracted overstated fresh input by 30% in the
// 2026-08-09 study, and nothing in the totals looked wrong.
//
// So the convention is settled HERE, once, and every parser below returns the
// same shape: `input` is the uncached part on every lane, `cacheRead` and
// `cacheWrite` are disjoint from it, and `reasoning` is a SUBSET of `output`
// (adding it double-counts). That is docs/journal-shape.md rule 1, executable.
//
//   lane              wire convention                        measured
//   codex-cli-jsonl   input_tokens INCLUDES cached + write    50,152 records
//   claude-cli-json   input_tokens excludes cache_read        —
//   agy-json          input_tokens excludes cache_read        2026-08-10, below
//
// The agy row was measured rather than assumed: one call reported
// input 6,405 / cache_read 20,096 / total 6,719. A cache read LARGER than
// input is impossible under nesting, and `total = input + output` excludes the
// cache entirely, so agy's input is already the uncached part.
//
// Adding a CLI means adding a row here and nowhere else. A backend that parses
// usage inline is how the second convention gets invented.
import type { RoleUsage } from "./providers.js";

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** codex `--json` JSONL: sum the `turn.completed` events. Nested — subtract. */
export function codexJsonlUsage(stdout: string): RoleUsage | undefined {
  let found = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawCacheWrite = false;
  // Absent unless an event carried it (absent ≠ zero; see RoleUsage).
  let reasoning: number | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    let event: {
      type?: string;
      usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "turn.completed" || !event.usage) continue;
    found = true;
    const cr = event.usage.cached_input_tokens ?? 0;
    const cw = event.usage.cache_write_input_tokens ?? 0;
    if (event.usage.cache_write_input_tokens !== undefined) sawCacheWrite = true;
    input += Math.max(0, (event.usage.input_tokens ?? 0) - cr - cw);
    output += event.usage.output_tokens ?? 0;
    cacheRead += cr;
    cacheWrite += cw;
    if (event.usage.reasoning_output_tokens !== undefined)
      reasoning = (reasoning ?? 0) + event.usage.reasoning_output_tokens;
  }
  return found
    ? {
        input,
        output,
        cacheRead,
        reasoning,
        meter: "codex-cli-jsonl" as const,
        // Observed per record, never read off a lane table: the day codex
        // #32479 lands, this records the real number.
        ...(sawCacheWrite ? { cacheWrite } : {}),
      }
    : undefined;
}

/** `claude -p --output-format json`. Already disjoint — pass through. */
export function claudeJsonUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): RoleUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    ...(u.cache_creation_input_tokens !== undefined
      ? { cacheWrite: u.cache_creation_input_tokens }
      : {}),
    meter: "claude-cli-json" as const,
  };
}

/** `agy --output-format json`. Already disjoint (measured, see header). */
export function agyJsonUsage(usage: Record<string, unknown> | undefined): RoleUsage | undefined {
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const reasoning = num(usage?.thinking_tokens);
  return {
    input,
    output,
    cacheRead: num(usage?.cache_read_tokens) ?? 0,
    ...(reasoning === undefined ? {} : { reasoning }),
    meter: "agy-json" as const,
  };
}

/** An `agy --output-format json` reply: the report plus its usage.
 *
 *  Parsed defensively, because COVERIFY_LITERATURE_CMD can point at any
 *  command. A reply that is not this envelope is treated as the report itself
 *  and the caller records an unmetered gap — a librarian whose SPEND cannot be
 *  read must never become a librarian whose REPORT is lost. */
export function agyReply(stdout: string): { report: string; usage?: RoleUsage } {
  try {
    const j = JSON.parse(stdout) as { response?: unknown; usage?: Record<string, unknown> };
    if (typeof j.response !== "string") return { report: stdout };
    return { report: j.response, usage: agyJsonUsage(j.usage) };
  } catch {
    return { report: stdout };
  }
}

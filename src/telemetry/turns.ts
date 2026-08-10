// On-demand turn telemetry derived from the pi session JSONL trees under
// .coverify/sessions/. Read-only observability (design rule 2): sizes,
// per-request usage, gaps, and stopReason per message, never prompt text.
// Every field is a pure function of the stored messages.
import * as fs from "node:fs";
import * as path from "node:path";
import { type RoleUsage, sumMessagesUsage } from "../providers.js";

/** One message's telemetry: sizes + provider accounting, no content. On
 *  assistant messages `usage.input` and `usage.cacheRead` are disjoint, so the
 *  per-request cache-hit rate is cacheRead/(input+cacheRead); `gapMs` from the
 *  previous assistant message exposes cache-TTL effects. */
export interface TurnRecord {
  i: number;
  role: string;
  ts?: number;
  gapMs?: number;
  textChars: number;
  thinkingChars: number;
  toolCalls: number;
  stopReason?: string;
  errorMessage?: string;
  usage?: RoleUsage;
}

/** Usage as pi writes it: token fields plus a `cost` block this harness does not
 *  record — every lane is subscription-billed, so it is notional list price. */
type SessionUsage = RoleUsage & { cost?: unknown };

/** Drop the wire-only `cost` block; token fields pass through unchanged. */
function toRoleUsage({ cost: _cost, ...u }: SessionUsage): RoleUsage {
  return u;
}

interface SessionMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  usage?: SessionUsage;
}

function messagesToTurns(messages: readonly SessionMessage[]): TurnRecord[] {
  const out: TurnRecord[] = [];
  let prevAssistantTs: number | undefined;
  messages.forEach((msg, i) => {
    let textChars = 0;
    let thinkingChars = 0;
    let toolCalls = 0;
    if (typeof msg.content === "string") textChars = msg.content.length;
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content as { type?: string; text?: string; thinking?: string }[]) {
        if (b.type === "text") textChars += b.text?.length ?? 0;
        else if (b.type === "thinking") thinkingChars += b.thinking?.length ?? 0;
        else if (b.type === "toolCall" || b.type === "tool_use" || b.type === "toolResult") toolCalls++;
        else if (typeof b.text === "string") textChars += b.text.length;
      }
    }
    const rec: TurnRecord = {
      i,
      role: msg.role ?? "?",
      ts: msg.timestamp,
      textChars,
      thinkingChars,
      toolCalls,
      stopReason: msg.stopReason,
      errorMessage: msg.errorMessage,
      usage: msg.usage && toRoleUsage(msg.usage),
    };
    if (msg.role === "assistant") {
      if (prevAssistantTs !== undefined && msg.timestamp !== undefined) {
        rec.gapMs = msg.timestamp - prevAssistantTs;
      }
      if (msg.timestamp !== undefined) prevAssistantTs = msg.timestamp;
    }
    out.push(rec);
  });
  return out;
}

export interface SessionTelemetry {
  /** Path relative to the sessions root (grep-friendly identifier). */
  file: string;
  /** Session id from the file name (<timestamp>_<id>.jsonl). */
  id: string;
  turns: TurnRecord[];
  /** Message usage plus compaction entries' own spend (a summarization call's
   *  usage lives on the compaction entry, not on any message). */
  usage: RoleUsage;
  /** The compaction half of `usage`, alone. Kept separable because it belongs
   *  to no turn: sum(turn deltas) legitimately differs from `usage` on any
   *  session that compacted (reconciling per-session deltas against the session's own total). */
  compaction?: RoleUsage;
  compactions: number;
}

function walkJsonl(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path.join(e.parentPath, e.name));
  }
  return out.sort();
}

/** Derive telemetry for every session in the campaign, oldest file first.
 *  Torn or foreign lines are skipped — observability must not be brittle. */
export function campaignTurns(campaignDir: string): SessionTelemetry[] {
  const root = path.join(campaignDir, ".coverify", "sessions");
  return walkJsonl(root).map((file) => {
    const messages: SessionMessage[] = [];
    // Everything that spent tokens, shaped as the accumulator expects. A
    // compaction is not a message but is billed like one, so it is wrapped as
    // an assistant message — the same wrapping providers.ts does.
    const billed: { role: string; usage: RoleUsage }[] = [];
    const compacted: { role: string; usage: RoleUsage }[] = [];
    const add = (raw: SessionUsage | undefined, into = billed) => {
      if (!raw) return;
      into.push({ role: "assistant", usage: toRoleUsage(raw) });
    };
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: SessionMessage; usage?: SessionUsage };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
        // Only assistant messages are billed. Keep the filter even though pi
        // writes no usage on user messages today: without it the two sides of
        // the cross-check silently disagree the day one appears.
        if (entry.message.role === "assistant") add(entry.message.usage);
      } else if (entry.type === "compaction") {
        add(entry.usage);
        add(entry.usage, compacted);
      }
    }
    return {
      file: path.relative(root, file),
      id: path.basename(file, ".jsonl").split("_").at(-1) ?? path.basename(file, ".jsonl"),
      turns: messagesToTurns(messages),
      usage: sumMessagesUsage(billed),
      compactions: compacted.length,
      ...(compacted.length > 0 ? { compaction: sumMessagesUsage(compacted) } : {}),
    };
  });
}

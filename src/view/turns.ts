// On-demand turn telemetry derived from the pi session JSONL trees under
// .coverify/sessions/ — the single transcript store. Read-only observability
// (design rule 2): sizes, per-request usage, gaps, and stopReason per
// message, never prompt text. Replaces the retired always-on turns sidecars;
// every field is a pure function of the stored messages.
import * as fs from "node:fs";
import * as path from "node:path";
import type { RoleUsage } from "../providers.js";

/** One message's telemetry: sizes + provider accounting, no content. For
 *  assistant messages `usage.input` is the uncached billed input of THAT
 *  request and `usage.cacheRead` the cached part (disjoint fields), so
 *  per-request cache-hit rate is cacheRead/(input+cacheRead); `gapMs` from
 *  the previous assistant message exposes cache-TTL effects; `stopReason`
 *  diagnoses truncation/empty-final-text failures. */
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

/** Usage as pi writes it to the session log: token fields plus a `cost` block
 *  this harness deliberately does not record (see RoleUsage — every lane is
 *  subscription-billed, so that figure is notional list price). */
type SessionUsage = RoleUsage & { cost?: unknown };

/** Drop the wire-only `cost` block so no notional dollar figure reaches a
 *  record; token fields pass through unchanged. */
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

/** Walk a message history into TurnRecords (content sizes only). */
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
  /** Message usage plus compaction entries' own spend (a summarization
   *  call's usage lives on the compaction entry, not on any message). */
  usage: RoleUsage;
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
    // `reasoning` is seeded absent, not zero: a session whose turns never
    // reported the field must not claim it measured zero (same rule as
    // addUsage).
    const usage: RoleUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const add = (raw: SessionUsage | undefined) => {
      if (!raw) return;
      const u = toRoleUsage(raw);
      usage.input += u.input ?? 0;
      usage.output += u.output ?? 0;
      usage.cacheRead += u.cacheRead ?? 0;
      usage.cacheWrite += u.cacheWrite ?? 0;
      if (u.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + u.reasoning;
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
        add(entry.message.usage);
      } else if (entry.type === "compaction") {
        add(entry.usage);
      }
    }
    return {
      file: path.relative(root, file),
      id: path.basename(file, ".jsonl").split("_").at(-1) ?? path.basename(file, ".jsonl"),
      turns: messagesToTurns(messages),
      usage,
    };
  });
}

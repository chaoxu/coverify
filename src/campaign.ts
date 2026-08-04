import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface JournalEntry {
  ts: string;
  kind: "note" | "wake" | "usage";
  [key: string]: unknown;
}

const JOURNAL_DIR = ".coverify";

export function initCampaign(dir: string, statement: string): void {
  const statementPath = path.join(dir, "STATEMENT.md");
  if (fs.existsSync(statementPath)) {
    throw new Error(`campaign already exists at ${dir}; use resume or status`);
  }
  fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });
  fs.mkdirSync(path.join(dir, JOURNAL_DIR), { recursive: true });
  // Launcher: "verbatim user statement, conventions, method constraints, and
  // success criteria. Fix its revision before search."
  fs.writeFileSync(
    statementPath,
    `# STATEMENT (revision r1)\n\n${statement.trim()}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "CURRENT_FRONTIER.md"),
    "# CURRENT_FRONTIER\n\nCampaign initialized; nothing dispatched yet.\n",
  );
  // Field templates are scaffolding, not schema: they quote the launcher's
  // required fields so entry format survives coordinator changes. Nothing
  // mechanical parses these files.
  fs.writeFileSync(
    path.join(dir, "REGISTRY.md"),
    "# REGISTRY\n\n<!-- per route (contract): exact claim · gap · smallest obstruction · " +
      "next decisive test · status · retry novelty; grouped by mechanism × terminal gap; " +
      "claim labels: candidate / self-audited / verifier-backed / promoted / independently audited -->\n\n" +
      "No routes registered.\n",
  );
  fs.writeFileSync(
    path.join(dir, "FAILED.md"),
    "# FAILED (append-only)\n\n<!-- per entry (contract): exact obstruction + evidence · " +
      "what would make a retry materially new -->\n",
  );
  fs.writeFileSync(
    path.join(dir, "PROVED.md"),
    "# PROVED (append-only)\n\n<!-- per entry (contract): exact statement · proof/certificate " +
      "revision · dependencies · audit artifacts (appended via record_promotion only) -->\n",
  );
  fs.writeFileSync(
    path.join(dir, "PROCESS_LESSONS.md"),
    "# PROCESS_LESSONS\n\n<!-- actionable = changes how a future fan-out/test/gate/allocation " +
      "is run, else deferred with an activation test; mathematical facts belong in the ledgers; " +
      "mark cross-campaign lessons 'graduate' -->\n",
  );
}

export function campaignExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, "STATEMENT.md"));
}

export function readLedger(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf-8");
}

/**
 * Reserve the next free append-only evidence path for a basename. Launcher:
 * "every semantic change is a new revision-suffixed filename, a cited
 * artifact is never edited in place." Never returns an existing path, so
 * overwriting is impossible by construction. Creates parent directories.
 */
export function newEvidencePath(dir: string, base: string): string {
  const safe = base.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/\.\.+/g, ".");
  for (let r = 1; ; r++) {
    const p = path.join(dir, "EVIDENCE", `${safe}.r${r}.md`);
    if (!p.startsWith(path.join(dir, "EVIDENCE") + path.sep)) {
      throw new Error(`evidence path escapes EVIDENCE/: ${base}`);
    }
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    }
  }
}

/** Harness-generated audit metadata — permitted by the launcher's EVIDENCE bullet. */
export function appendJournal(
  dir: string,
  entry: { kind: JournalEntry["kind"] } & Record<string, unknown>,
): JournalEntry {
  const full: JournalEntry = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(
    path.join(dir, JOURNAL_DIR, "journal.jsonl"),
    JSON.stringify(full) + "\n",
  );
  return full;
}

export function readJournal(dir: string): JournalEntry[] {
  const p = path.join(dir, JOURNAL_DIR, "journal.jsonl");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const entries: JournalEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as JournalEntry);
    } catch {
      // Tolerate a torn trailing line from a crash mid-append; anything else is corruption.
      if (i === lines.length - 1) break;
      throw new Error(`corrupt journal line ${i + 1} in ${p}`);
    }
  }
  return entries;
}

/**
 * User→coordinator message channel (`coverify say`). The inbox lives under
 * .coverify/, which every role's write scope denies, so only the user (via
 * the CLI, outside any role) can queue a message — a role cannot forge user
 * guidance. Transport is verbatim: the harness delivers the text unchanged
 * at the next wake and journals it; it adds no policy of its own. This is
 * the headless analog of typing to an interactive skill session — the
 * message arrives at the coordinator's next turn.
 */
export function queueUserMessage(dir: string, message: string): void {
  fs.appendFileSync(
    path.join(dir, JOURNAL_DIR, "inbox.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), message }) + "\n",
  );
}

/** Every inbox entry ever queued, oldest first. Torn trailing line tolerated. */
function readInbox(dir: string): string[] {
  const p = path.join(dir, JOURNAL_DIR, "inbox.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { message?: unknown };
      if (typeof e.message === "string") out.push(e.message);
    } catch {
      /* torn line from a crash mid-append */
    }
  }
  return out;
}

/** How many inbox entries the harness has already delivered. */
function inboxCursor(dir: string): number {
  const p = path.join(dir, JOURNAL_DIR, "inbox.cursor");
  if (!fs.existsSync(p)) return 0;
  const n = Number(fs.readFileSync(p, "utf-8").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Pending user messages, oldest first. */
export function peekUserMessages(dir: string): string[] {
  return readInbox(dir).slice(inboxCursor(dir));
}

/**
 * Mark the first `count` pending messages delivered.
 *
 * The inbox is never rewritten: `coverify say` runs in another process and
 * appends whenever the user types, so a read-modify-write here would drop any
 * message that landed between the read and the write — silently, and exactly
 * when the user is most likely to be typing. Advancing a separate cursor makes
 * the two writers independent.
 */
export function consumeUserMessages(dir: string, count: number): void {
  if (count <= 0) return;
  fs.writeFileSync(path.join(dir, JOURNAL_DIR, "inbox.cursor"), String(inboxCursor(dir) + count) + "\n");
}

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Statements-only projection of PROVED.md for prompt contexts: each entry is
 * cut at its provenance metadata (**Dependencies:** / **Audit artifacts:**),
 * keeping the heading, theorem statements, and scope. The ledger itself is
 * untouched — this slims what rides into gate/audit/reconstruction prompts
 * (provenance is dispute-time material; the toolful coordinator can always
 * read the full file). Pure context assembly: semantics-invisible mechanics.
 */
export function promotedStatementsView(dir: string): string {
  const full = readLedger(dir, "PROVED.md");
  return full
    .split(/\n(?=## )/)
    .map((entry) => {
      const cut = entry.search(/\n\*\*(Dependencies|Audit artifacts):\*\*/);
      return cut < 0 ? entry.trimEnd() : entry.slice(0, cut).trimEnd();
    })
    .join("\n\n");
}

/**
 * Minimal resume/wake bundle. Launcher: "After restart or context compaction,
 * reread the skill, STATEMENT.md, CURRENT_FRONTIER.md, actionable lessons,
 * the registry index, and every detailed claim actually reused."
 */
export function resumeBundle(dir: string): string {
  return [
    readLedger(dir, "STATEMENT.md"),
    readLedger(dir, "CURRENT_FRONTIER.md"),
    readLedger(dir, "REGISTRY.md"),
    readLedger(dir, "PROCESS_LESSONS.md"),
  ].join("\n\n---\n\n");
}

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Claim labels — closed vocabulary from the launcher ("Claim labels — literal, never inflated"). */
export const CLAIM_LABELS = [
  "candidate",
  "self-audited",
  "verifier-backed",
  "promoted",
  "independently audited",
] as const;
export type ClaimLabel = (typeof CLAIM_LABELS)[number];

export const LEDGERS = [
  "STATEMENT.md",
  "CURRENT_FRONTIER.md",
  "REGISTRY.md",
  "FAILED.md",
  "PROVED.md",
  "LESSONS.md",
] as const;

export interface JournalEntry {
  ts: string;
  kind:
    | "dispatch"
    | "completion"
    | "gate-verdict"
    | "audit"
    | "reconstruction"
    | "promotion"
    | "cancel"
    | "wake"
    | "note";
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
    "# CURRENT_FRONTIER\n\nCampaign initialized; no waves dispatched yet.\n",
  );
  fs.writeFileSync(
    path.join(dir, "REGISTRY.md"),
    "# REGISTRY\n\nNo routes registered.\n",
  );
  fs.writeFileSync(path.join(dir, "FAILED.md"), "# FAILED (append-only)\n");
  fs.writeFileSync(path.join(dir, "PROVED.md"), "# PROVED (append-only)\n");
  fs.writeFileSync(path.join(dir, "LESSONS.md"), "# LESSONS (process only)\n");
}

export function campaignExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, "STATEMENT.md"));
}

export function readLedger(dir: string, name: (typeof LEDGERS)[number]): string {
  return fs.readFileSync(path.join(dir, name), "utf-8");
}

/**
 * Reserve an append-only evidence path. Launcher: "every semantic change is a
 * new revision-suffixed filename, a cited artifact is never edited in place".
 * Throws if the revision already exists — in-place edits are impossible.
 */
export function newEvidencePath(dir: string, base: string, revision: number): string {
  const safe = base.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/\.\.+/g, ".");
  const p = path.join(dir, "EVIDENCE", `${safe}.r${revision}.md`);
  if (!p.startsWith(path.join(dir, "EVIDENCE") + path.sep)) {
    throw new Error(`evidence path escapes EVIDENCE/: ${base}`);
  }
  if (fs.existsSync(p)) {
    throw new Error(`evidence revision already exists: ${p} (evidence is append-only)`);
  }
  return p;
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

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
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
    readLedger(dir, "LESSONS.md"),
  ].join("\n\n---\n\n");
}

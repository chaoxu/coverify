import { execSync } from "node:child_process";
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
  // A missing STATEMENT.md is not proof of an empty directory: if the ledgers
  // survived a partial restore, writing the templates destroys every promotion
  // and closed route.
  const survivors = ["PROVED.md", "FAILED.md", "REGISTRY.md", "PROCESS_LESSONS.md", "CURRENT_FRONTIER.md"]
    .filter((f) => fs.existsSync(path.join(dir, f)));
  if (survivors.length > 0) {
    throw new Error(
      `refusing to initialize over existing campaign ledgers at ${dir} (${survivors.join(", ")}): ` +
        "STATEMENT.md is missing, so this is a damaged campaign rather than a new one. Restore " +
        "STATEMENT.md and use resume, or move these files aside deliberately.",
    );
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
  // Scaffolding, not schema: these quote the launcher's required fields so the
  // entry format survives coordinator changes. Nothing parses them.
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

/** Reserve the next free append-only evidence path for a basename. Launcher:
 *  "every semantic change is a new revision-suffixed filename, a cited artifact
 *  is never edited in place." Never returns an existing path. */
export function newEvidencePath(dir: string, base: string): string {
  const safe = base.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/\.\.+/g, ".");
  for (let r = 1; ; r++) {
    const p = path.join(dir, "EVIDENCE", `${safe}.r${r}.md`);
    if (!p.startsWith(path.join(dir, "EVIDENCE") + path.sep)) {
      throw new Error(`evidence path escapes EVIDENCE/: ${base}`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      // O_EXCL, not existsSync-then-return: the caller writes later, and two
      // concurrent cadences on one revision compute the same slug.
      fs.closeSync(fs.openSync(p, "wx"));
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/** Evidence paths cited in the ledgers that do not exist on disk: `EVIDENCE/...`
 *  tokens checked against the filesystem, never reading content. A missing
 *  citation is a typo or a hallucination, both invisible to a trusting reader. */
export function danglingCitations(dir: string): { ledger: string; citation: string }[] {
  const out: { ledger: string; citation: string }[] = [];
  for (const ledger of ["PROVED.md", "FAILED.md", "REGISTRY.md", "CURRENT_FRONTIER.md"]) {
    const p = path.join(dir, ledger);
    if (!fs.existsSync(p)) continue;
    for (const cited of citedEvidencePaths(fs.readFileSync(p, "utf-8"))) {
      if (!fs.existsSync(path.join(dir, cited))) out.push({ ledger, citation: cited });
    }
  }
  return out;
}

/** The one definition of "cited", shared by citation lint and trace metrics. */
export function citedEvidencePaths(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/EVIDENCE\/[A-Za-z0-9._\/-]+/g)) {
    out.add(m[0].replace(/[.,;:)\]]+$/, ""));
  }
  return out;
}

/** Read the campaign lock file; `held` is absent when missing or torn. The lock
 *  location and {pid, startedAt} shape are owned here: `coverify stop` and the
 *  acquire path must agree on both. */
export function readCampaignLock(dir: string): {
  lockPath: string;
  held?: { pid?: number; startedAt?: string };
} {
  const lockPath = path.join(dir, JOURNAL_DIR, "lock.json");
  try {
    return { lockPath, held: JSON.parse(fs.readFileSync(lockPath, "utf-8")) };
  } catch {
    return { lockPath };
  }
}

/** Exclusive access to a campaign for as long as the returned release lives.
 *  Every mechanism here assumes ONE writer: handle ids come from a per-process
 *  counter, GateStore snapshots its records at construction, and evidence
 *  directories are handed out by name. Two runs mint the same `r001` and each
 *  gates against a record set missing the other's FAILs. */
export function acquireCampaignLock(dir: string): () => void {
  const lock = path.join(dir, JOURNAL_DIR, "lock.json");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const mine = { pid: process.pid, startedAt: new Date().toISOString() };
  const claim = () => fs.writeFileSync(lock, JSON.stringify(mine) + "\n", { flag: "wx" });
  try {
    claim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const held = readCampaignLock(dir).held ?? {};
    let alive = false;
    if (typeof held.pid === "number") {
      try {
        process.kill(held.pid, 0);
        alive = true;
      } catch {
        alive = false; // no such process
      }
    }
    if (alive) {
      throw new Error(
        `campaign at ${dir} is already running (pid ${held.pid}, started ${held.startedAt}). Two runs ` +
          "would mint the same agent ids, share evidence directories, and gate against each other's " +
          "stale records. Stop that run, or use 'coverify status'/'trace' to watch it.",
      );
    }
    // The holder is gone (crash, kill): take over.
    fs.rmSync(lock, { force: true });
    claim();
    appendJournal(dir, {
      kind: "note",
      note: `took over a stale campaign lock from pid ${held.pid ?? "unknown"}`,
    });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(lock, "utf-8")) as { pid?: number };
      if (cur.pid === process.pid) fs.rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
  return release;
}

/** The coverify checkout root (src/'s parent): the one authority for locating
 *  the checkout and its node_modules. Never re-derive this per file. */
export function repoRoot(): string {
  return path.dirname(path.dirname(new URL(import.meta.url).pathname));
}

export function gitInRepo(cmd: string): string | undefined {
  try {
    return execSync(cmd, { cwd: repoRoot() }).toString().trim();
  } catch {
    return undefined;
  }
}

export function appendJournal(
  dir: string,
  entry: { kind: JournalEntry["kind"] } & Record<string, unknown>,
): JournalEntry {
  const full: JournalEntry = { ts: new Date().toISOString(), ...entry };
  // An adopted campaign has no .coverify/ yet, and every command journals first.
  fs.mkdirSync(path.join(dir, JOURNAL_DIR), { recursive: true });
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
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as JournalEntry);
    } catch {
      // The journal is an audit mirror gates never read, so a torn line costs
      // observability at most; failing hard would take `status` and `trace`
      // away when they are most wanted.
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(`[coverify] warning: skipped ${skipped} unparseable journal line(s) in ${p}`);
  }
  return entries;
}

/** Unwrap the mirrored gate record from a journal entry ({kind:"note", gate}):
 *  the one reading of that shape, shared by status, trace, and adopt-rebuild. */
export function gateOf(e: unknown): Record<string, unknown> | undefined {
  const g = (e as Record<string, unknown> | null)?.gate;
  return typeof g === "object" && g !== null ? (g as Record<string, unknown>) : undefined;
}

/** User→coordinator message channel (`coverify say`). The inbox lives under
 *  .coverify/, which every role's write scope denies, so a role cannot forge
 *  user guidance. Transport is verbatim. */
export function queueUserMessage(dir: string, message: string): void {
  fs.mkdirSync(path.join(dir, JOURNAL_DIR), { recursive: true });
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

function inboxCursor(dir: string): number {
  const p = path.join(dir, JOURNAL_DIR, "inbox.cursor");
  if (!fs.existsSync(p)) return 0;
  const n = Number(fs.readFileSync(p, "utf-8").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function peekUserMessages(dir: string): string[] {
  return readInbox(dir).slice(inboxCursor(dir));
}

/** Mark the first `count` pending messages delivered. The inbox is NEVER
 *  rewritten: `coverify say` appends from another process, so a
 *  read-modify-write here drops any message that landed in between. */
export function consumeUserMessages(dir: string, count: number): void {
  if (count <= 0) return;
  const target = path.join(dir, JOURNAL_DIR, "inbox.cursor");
  const tmp = `${target}.${process.pid}.tmp`;
  // Written atomically: a truncated cursor reads as 0 and redelivers every
  // message ever queued.
  fs.writeFileSync(tmp, String(inboxCursor(dir) + count) + "\n");
  fs.renameSync(tmp, target);
}

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Statements-only projection of PROVED.md for prompt contexts: each entry cut
 *  at its provenance metadata (**Dependencies:** / **Audit artifacts:**), which
 *  is dispute-time material. The ledger itself is untouched. Mechanics. */
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

/** Minimal resume/wake bundle. Launcher: "After restart or context compaction,
 *  reread the skill, STATEMENT.md, CURRENT_FRONTIER.md, actionable lessons, the
 *  registry index, and every detailed claim actually reused." */
export function resumeBundle(dir: string): string {
  return [
    readLedger(dir, "STATEMENT.md"),
    readLedger(dir, "CURRENT_FRONTIER.md"),
    readLedger(dir, "REGISTRY.md"),
    readLedger(dir, "PROCESS_LESSONS.md"),
  ].join("\n\n---\n\n");
}

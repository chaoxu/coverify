import * as fs from "node:fs";
import { stateHome } from "./userdirs.js";
import * as path from "node:path";
import { appendJournal, gateOf, readLedger, Refusal, sha256File, sha256Text } from "./campaign.js";
import { spendFields, type RoleUsage } from "./providers.js";

/**
 * Gate state store. Gate decisions must not depend on files any role's
 * workspace write tools can edit, so the authoritative record lives OUTSIDE the campaign directory
 * (in ~/.local/state/coverify/<campaign-id>/gates.jsonl) and is mirrored into
 * the campaign journal for auditability. Content hashes recorded here are
 * harness-generated audit metadata, which the launcher explicitly permits.
 */
export interface GateRecord {
  ts: string;
  kind:
    | "statement"
    | "dispatch"
    | "completion"
    | "gate-verdict"
    | "audit"
    | "bundle-cert"
    | "reconstruction"
    | "comparison"
    | "rebuttal"
    | "promotion"
    | "delivery"
    /** Provider spend with no stage record of its own (cancelled cadence, a
     *  paid-then-failed call, a coordinator compaction). A leaf, so cost never
     *  has to be recovered by subtracting children from a summary.
     *
     *  NOT all verification spend: a `role-call` with `role: "coordinator"` is
     *  coordinator-lane, so a per-stage query must filter on `role IS NULL` or
     *  it pulls compaction into the verdict-stage table (design.md queries). */
    | "role-call"
    // Campaign events. One event log: these live in the same out-of-tree store
    // as gate records, because anything read back for behavior must come from
    // the trust domain no role's workspace tools can write.
    | "wake"
    | "usage"
    | "note";
  [key: string]: unknown;
}

/**
 * The one read-side view with a consumer: the four verification stage records
 * share a shape, and modelSubstitutions() reads it (observe.ts). Every other
 * reader hand-casts at its own boundary, which is the honest thing to do when
 * the write shape is deliberately open.
 *
 * Every field stays optional by design: a campaign recorded before a field
 * existed narrows to `undefined` rather than erroring, which is why this layer
 * needs no migrations.
 */
export interface VerdictView {
  revision?: string;
  verdict?: string;
  candidateHash?: string;
  artifact?: string;
  artifactHash?: string;
  /** Requested spec, or the server-attested model when one exists (#20). */
  modelFamily?: string;
  /** The backend's own statement of what answered, when it makes one (#21 P3). */
  reportedModel?: string;
}

/** Stage records of one kind, as the verdict view. The cast is the single
 *  place the open write shape is narrowed for this query. */
export function verdictViews(store: GateStore, kind: string): (VerdictView & GateRecord)[] {
  return store.all().filter((e) => e.kind === kind) as (VerdictView & GateRecord)[];
}

/** Values that ENABLE journal-mirror adoption. NOT a truthiness test: a bare
 *  one turned `COVERIFY_ADOPT=0` and `=false` ON, the opposite of what an
 *  operator means, on the one knob that crosses coverify's trust boundary.
 *  Matches knobs.ts's schema, so validateKnobs rejects any other spelling at
 *  startup instead of silently enabling. */
const ADOPT_ENABLED = new Set(["1", "true", "yes"]);

/** The out-of-tree state root — one authority, shared with dev tooling
 *  (scripts/smoke.ts) so cleanup never guesses at this path. */
export function stateRootDir(): string {
  return process.env.COVERIFY_STATE_DIR ?? path.join(stateHome(), "coverify");
}

/** Where a campaign records its opaque state-dir id (16 hex chars). */
export function campaignIdPath(campaignDir: string): string {
  return path.join(campaignDir, ".coverify", "campaign-id");
}

/**
 * A campaign's identity, stored INSIDE the campaign so it survives being moved.
 * As `sha256(realpath(dir))` it did not: renaming or restoring a folder
 * elsewhere produced a campaign with intact ledgers and zero gate history.
 * Existing campaigns keep their id by writing the legacy path hash on first
 * read.
 */
function campaignIdentity(campaignDir: string, stateDir: string, readOnly = false): string {
  const idFile = campaignIdPath(campaignDir);
  if (fs.existsSync(idFile)) {
    const id = fs.readFileSync(idFile, "utf-8").trim();
    if (/^[0-9a-f]{16}$/.test(id)) return id;
  }
  const legacy = sha256Text(campaignDir).slice(0, 16);
  // Adopt the legacy id when its store exists, otherwise mint a fresh one.
  const id = fs.existsSync(path.join(stateDir, legacy, "gates.jsonl"))
    ? legacy
    : sha256Text(`${campaignDir}:${Date.now()}:${Math.random()}`).slice(0, 16);
  // A reader must not brand a campaign it is only looking at: `coverify spend`
  // on someone else's directory used to mint .coverify/campaign-id there and
  // create a state directory for it, which is a write dressed as a read.
  if (!readOnly) {
    try {
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      fs.writeFileSync(idFile, id + "\n");
    } catch {
      /* read-only checkout or a race: the legacy lookup still works */
    }
  }
  return id;
}

/** Keep only the fields that have a value. Absence is load-bearing throughout
 *  this journal and every reader keys on a field simply not being there
 *  (absent ≠ zero; see RoleUsage in providers.ts). */
export function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Completions the coordinator has not been shown yet, rendered for a wake.
 *
 * Pure query over the store, exported so it can be TESTED against the real rule
 * rather than a test-local reimplementation.
 *
 * Persistence and delivery are separate on purpose: a wake that fails after
 * harvesting must not consume the only chance to show a report.
 */
export function undeliveredCompletions(
store: GateStore,
dir: string,
): { id: string; mechanism: string; section: string }[] {
  const delivered = new Set<string>();
  const mechanisms = new Map<string, string>();
  for (const e of store.all()) {
    if (e.kind === "delivery") for (const id of (e.ids as string[]) ?? []) delivered.add(id);
    if (e.kind === "dispatch" && typeof e.id === "string") {
      mechanisms.set(e.id, String(e.mechanism ?? ""));
    }
  }
  const out: { id: string; mechanism: string; section: string }[] = [];
  for (const e of store.all()) {
    if (e.kind !== "completion" || typeof e.id !== "string") continue;
    if (e.cancelled || delivered.has(e.id)) continue;
    const mechanism = mechanisms.get(e.id) ?? "";
    if (typeof e.failed === "string") {
      out.push({
        id: e.id,
        mechanism,
        section:
          `## ${e.id} [${mechanism}] FAILED (infrastructure): ${e.failed}\n\n` +
          (typeof e.partial === "string"
            ? `No completed report exists. Partial work from the interrupted attempt is preserved ` +
              `at ${e.partial} — notes only, no claim label; mine it if useful when redispatching.`
            : `No report artifact exists.`) +
          ` Per the contract this is never PASS and carries no mathematical content; ` +
          `re-dispatching the assignment is legitimate.`,
      });
      continue;
    }
    if (typeof e.report !== "string") continue;
    const p = path.join(dir, e.report);
    if (!fs.existsSync(p)) continue;
    const bytes = fs.readFileSync(p, "utf-8");
    // Integrity check against the recorded hash: an edited report is delivered
    // with a loud taint instead of silently.
    const tainted =
      typeof e.reportSha256 === "string" && sha256Text(bytes) !== e.reportSha256
        ? `\n\n[WARNING: this report file no longer matches the hash recorded at completion — ` +
          `it was modified after the worker returned. Treat content as untrusted; the original ` +
          `bytes are not recoverable.]`
        : "";
    out.push({
      id: e.id,
      mechanism,
      section: `## ${e.id} [${mechanism}] (saved: ${e.report})\n\n${bytes}${tainted}`,
    });
  }
return out;
}

export class GateStore {
  private records: GateRecord[];
  private file: string;
  readonly campaignDir: string;
  /** Stamped on every record this process writes; older records are marked by
   *  its ABSENCE. The run-config `runStart` note carries harnessRev,
   *  launcherSha256, piVersions, patches and roleSpecs, so "which convention did
   *  this record use" becomes "look up its run". */
  private runId: string | undefined;

  /** `readOnly` downgrades the two-claimant refusal to a warning. The guard
   *  protects the store from two WRITERS; a reader cannot corrupt it, and
   *  refusing to let someone look at a copied campaign's history — with a stack
   *  trace, no less — helps nobody diagnose the copy. */
  constructor(campaignDir: string, opts?: { readOnly?: boolean }) {
    const resolved = path.resolve(campaignDir);
    this.campaignDir = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
    const stateDir = stateRootDir();
    const id = campaignIdentity(this.campaignDir, stateDir, opts?.readOnly === true);
    const dir = path.join(stateDir, id);
    // Same rule for the state directory: a reader of a campaign that has never
    // run must not create one.
    if (opts?.readOnly !== true) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "gates.jsonl");
    // meta.json names the opaque 16-hex state dir for cross-campaign analytics
    // (design.md, Appendix: Canonical analytics queries): campaign path plus the
    // statement's first line, best-effort, refreshed each construction.
    // Runs OUTSIDE the best-effort meta block below: that one swallows errors
    // for a campaign with no statement yet, and swallowing this would restore
    // the very corruption it detects.
    const metaPath = path.join(dir, "meta.json");
    // A campaign's id lives INSIDE it so a rename or a restore keeps its gate
    // history. `cp -R` copies that id too, and then two directories write one
    // authoritative store: an edit in the copy re-arms the original's
    // statement freeze, and each takes its own per-directory lock, so the
    // "one writer per campaign" rule does not see it. A rename leaves the old
    // path GONE; a copy leaves it standing with the same id. That difference
    // is the only signal available, and it is enough.
    if (fs.existsSync(metaPath)) {
      // Torn meta reads as absent. It is written non-atomically, so a crash
      // mid-write leaves a partial file — and because this check deliberately
      // runs outside the best-effort block below, a bare JSON.parse here would
      // make every prove/resume/amend/spend die on a raw SyntaxError forever,
      // with nothing to repair it. That is the exact failure this file already
      // guards against for gates.jsonl twenty lines down.
      let prior: { campaignDir?: string } = {};
      try {
        prior = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { campaignDir?: string };
      } catch {
        prior = {};
      }
      const other = prior.campaignDir;
      if (
        typeof other === "string" &&
        other !== this.campaignDir &&
        fs.existsSync(campaignIdPath(other)) &&
        fs.readFileSync(campaignIdPath(other), "utf-8").trim() === id
      ) {
        const conflict =
          `campaign id ${id} is claimed by two directories:\n  ${other}\n  ${this.campaignDir}\n` +
          "They share one authoritative gate store, so work in either corrupts the other. This is\n" +
          "what copying a campaign directory does. Keep one, and give the other a new identity by\n" +
          "deleting its .coverify/campaign-id (it then starts with no gate history).";
        // A reader cannot corrupt the store, and refusing to let anyone LOOK at
        // a copied campaign's history is what makes the copy hard to diagnose.
        if (opts?.readOnly !== true) throw new Refusal(conflict);
        console.error(`[coverify] WARNING: ${conflict}\nReading anyway; this command does not write.`);
      }
    }

    try {
      const stmt = readLedger(this.campaignDir, "STATEMENT.md");
      const firstLine = stmt.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
      const meta = path.join(dir, "meta.json");
      const next = JSON.stringify({ campaignDir: this.campaignDir, statement: firstLine.slice(0, 200) }) + "\n";
      // Skip identical rewrites so read-only commands (status, outcomes) stay
      // write-free on an unchanged campaign.
      if (opts?.readOnly !== true && (!fs.existsSync(meta) || fs.readFileSync(meta, "utf-8") !== next)) {
        // tmp + rename: a non-atomic write could tear, and a torn meta reads as
        // absent — which let whichever directory ran during that window take
        // the claim and leave the legitimate one refused forever.
        const tmp = `${meta}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, meta);
      }
    } catch {
      /* fresh campaign without a statement yet */
    }
    // A campaign with a journal but no gate history has lost its authoritative
    // state. Adopting silently would re-arm the statement freeze on whatever
    // STATEMENT.md now says and erase every recorded FAIL, so this stops. A
    // fresh campaign has no journal, so it proceeds normally.
    const journalPath = path.join(this.campaignDir, ".coverify", "journal.jsonl");
    let recoveredFromMirror = 0;
    if (!fs.existsSync(this.file) && fs.existsSync(journalPath)) {
      if (!ADOPT_ENABLED.has((process.env.COVERIFY_ADOPT ?? "").toLowerCase())) {
        throw new Error(
          `campaign at ${this.campaignDir} has ledgers but no gate history at ${dir}. Its verification ` +
            "records, statement freeze and FAIL history are not where its id points. Restore the state " +
            "directory, or re-run with COVERIFY_ADOPT=1 to rebuild gate history from the campaign's " +
            "journal mirror (recorded with an explicit lower-trust provenance mark; if the journal " +
            "holds no gate entries this falls back to accepting the current STATEMENT.md as a new " +
            "baseline).",
        );
      }
      // Mirror-based recovery from the derived journal (gate records wrapped as
      // {kind:"note", gate}, campaign events verbatim). The mirror is in-tree
      // and role-adjacent, so the rebuilt history is testimony, not the trust
      // anchor it replaced — hence the permanent taint below.
      const lines: string[] = [];
      for (const raw of fs.readFileSync(journalPath, "utf-8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          const e = JSON.parse(raw) as Record<string, unknown>;
          const gate = gateOf(e);
          if (gate && typeof gate.kind === "string") lines.push(JSON.stringify(gate));
          else if (e.kind === "wake" || e.kind === "usage" || e.kind === "note") lines.push(JSON.stringify(e));
        } catch {
          /* torn mirror line: recover the rest */
        }
      }
      if (lines.length > 0) fs.writeFileSync(this.file, lines.join("\n") + "\n");
      recoveredFromMirror = lines.length;
      console.error(
        `[coverify] COVERIFY_ADOPT: rebuilt ${lines.length} gate-history record(s) at ${this.file} ` +
          "from the campaign journal mirror (lower-trust provenance; marked on the record).",
      );
    }
    // A torn line (crash mid-append) must not make the campaign unresumable:
    // records are append-only, so the salvageable prefix is authoritative and a
    // damaged line is dropped loudly. Failing hard here bricks every
    // prove/resume/amend with a raw SyntaxError.
    this.records = [];
    if (fs.existsSync(this.file)) {
      let dropped = 0;
      for (const line of fs.readFileSync(this.file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.records.push(JSON.parse(line) as GateRecord);
        } catch {
          dropped++;
        }
      }
      if (dropped > 0) {
        console.error(
          `[coverify] warning: skipped ${dropped} unparseable line(s) in ${this.file} ` +
            "(torn write from a crash); gate history before them is intact.",
        );
      }
    }
    // Permanent provenance mark: on the ledger forever.
    if (recoveredFromMirror > 0) {
      this.event({
        kind: "note",
        note: "gate history reconstructed from the in-tree journal mirror (COVERIFY_ADOPT)",
        reconstructedFromMirror: recoveredFromMirror,
      });
    }
  }

  /** Called once per process, before any record is written. */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  append(record: { kind: GateRecord["kind"] } & Record<string, unknown>): GateRecord {
    // Stamp LAST: a caller-supplied runId must not win over the process
    // identity the "absence means pre-2026-08-09" reading rule depends on.
    const full: GateRecord = { ts: new Date().toISOString(), ...record, ...this.runStamp() };
    this.records.push(full);
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    // Derived mirror in the campaign journal: observability only, never read
    // back for behavior. Wrapped here (the journal's historical shape);
    // campaign events mirror verbatim via event().
    appendJournal(this.campaignDir, { kind: "note", gate: full });
    return full;
  }

  /**
   * A campaign event: same authoritative out-of-tree log as gate records,
   * mirrored VERBATIM into the in-tree journal so status keeps its
   * input shape. The only sanctioned way to record an event the harness may
   * later read back, because the in-tree journal is role-adjacent (a script
   * could append to it) and nothing behavioral may be read from there.
   */
  event(record: { kind: "wake" | "usage" | "note" } & Record<string, unknown>): GateRecord {
    const full = { ts: new Date().toISOString(), ...record, ...this.runStamp() };
    this.records.push(full);
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    appendJournal(this.campaignDir, full);
    return full;
  }

  private runStamp(): { runId?: string } {
    return this.runId === undefined ? {} : { runId: this.runId };
  }

  all(): readonly GateRecord[] {
    return this.records;
  }

  maxHandleId(): number {
    let max = 0;
    for (const r of this.records) {
      if (r.kind === "dispatch" && typeof r.id === "string") {
        const n = Number((r.id as string).replace(/^[a-z]+/, ""));
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return max;
  }

  dispatchesWithoutCompletion(): GateRecord[] {
    const completed = new Set(
      this.records.filter((r) => r.kind === "completion").map((r) => r.id as string),
    );
    return this.records.filter((r) => r.kind === "dispatch" && !completed.has(r.id as string));
  }
}

/**
 * Strict verdict parsing: only the first non-empty line counts, and it must
 * be exactly the verdict token. Anything else fails closed — a quoted or
 * hypothetical "VERDICT: PASS" deeper in a report never registers.
 */
export function parseFirstLineVerdict(
  text: string,
  tokens: readonly string[],
): string | undefined {
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return undefined;
  return tokens.find((t) => first.toUpperCase() === t.toUpperCase());
}

/**
 * Platform-enforced reconstruction blindness: refuse to dispatch a
 * reconstructor whose rendered prompt contains the candidate text. This is
 * what lets the journal's "candidate file withheld by harness (enforced)"
 * claim be a checked fact for whole-file interpolation rather than testimony
 * (launcher: self-attestation does not establish blindness). Partial
 * paraphrase inside keyIdeas remains the bundle certifier's judgment.
 */
export function assertCandidateWithheld(renderedPrompt: string, candidate: string): void {
  // Whitespace collapsed: a candidate reaching the prompt re-indented,
  // re-wrapped, or CRLF is the same leak, and an exact-substring check waves it
  // through while the journal still claims the candidate was withheld.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const c = norm(candidate);
  if (c.length > 0 && norm(renderedPrompt).includes(c)) {
    throw new Error(
      "blindness violation: the reconstruction prompt contains the candidate text; refusing to dispatch",
    );
  }
}

export interface DispatchPacket {
  mechanism: string;
  task: string;
  context: string;
  deliverable: string;
  /** Launcher: "check FAILED.md and record either 'no close prior route' or
   *  'closest prior route is X; this differs materially because ...'" */
  failedCheck: string;
}

/** A reasoning agent: proves, constructs, refutes. Prose tools only. */
export interface ReasonerPacket extends DispatchPacket {
  /** Present iff the reasoner is a literature scout: states the literature
   *  question. Grants the delegated librarian search tool (an external
   *  web-searching agent). Reasoners never hold code tools. */
  literature?: string;
  /** Optional ideation family ("fable" | "gemini" | "pro"): routes this one
   *  reasoner to a different model family (providers.ts resolveFamily). */
  family?: string;
}

/** A computation technician: encodes and runs one preregistered computation. */
export interface TechnicianPacket extends DispatchPacket {
  /** Launcher: "Use computation only for a preregistered finite domain and
   *  stopping rule yielding a small witness, certificate, or table." */
  computation: string;
}

/**
 * Revision identity for gate lookups. Records predating on-disk-case
 * canonicalization hold the coordinator's spelling, and on a case-insensitive
 * volume both name the same file, so comparison is case-folded too.
 */
export function sameRevision(a: unknown, b: string): boolean {
  return typeof a === "string" && (a === b || a.toLowerCase() === b.toLowerCase());
}

/** Dispatch-mechanism prefix marking a verification cadence on a revision —
 *  minted in cadence.ts, parsed by the refusal follow-up query in observe.ts. */
export const VERIFICATION_MECHANISM_PREFIX = "verification:";

/**
 * Promoted revisions that have since received a substantive FAIL.
 *
 * The contract requires a retraction when this happens (relabel, append to
 * FAILED.md, mark the PROVED.md entry historical, demote dependents). Deciding
 * that is model judgment; noticing it is arithmetic over records the harness
 * already holds.
 */
export function promotionsNeedingRetraction(store: GateStore): { revision: string; stage: string }[] {
  const records = store.all();
  const out: { revision: string; stage: string }[] = [];
  records.forEach((p, i) => {
    if (p.kind !== "promotion") return;
    const hash = p.candidateHash;
    // Record order, not timestamps: two records written in the same
    // millisecond compare equal, and this must not depend on clock resolution.
    for (const f of records.slice(i + 1)) {
      if ((f.kind !== "audit" && f.kind !== "comparison") || f.verdict !== "FAIL") continue;
      const sameContent = hash !== undefined && f.candidateHash === hash;
      if (sameContent || sameRevision(f.revision, String(p.revision))) {
        out.push({ revision: String(p.revision), stage: String(f.kind) });
      }
    }
  });
  return out;
}

/** Promotion records carry machine-resolvable `premises` (revisions of earlier
 *  promotions), so retractionClosure can enumerate every promotion standing on
 *  a failed one transitively. Enumeration only: relabeling, FAILED.md appends,
 *  and demotion remain the coordinator's judgment (contract). */
function promotionPremises(p: GateRecord): string[] {
  return Array.isArray(p.premises) ? (p.premises as unknown[]).map(String) : [];
}

/**
 * Resolve coordinator-typed premise names to recorded promotions. Each must
 * match an existing promotion, or a typo silently disconnects the dependency
 * edge retraction enumeration walks. Returns the canonical stored revisions and
 * their content hashes, or the first unresolvable name.
 */
export function resolvePremises(
  store: GateStore,
  raw: readonly string[],
): { premises: { revision: string; candidateHash?: string }[] } | { unresolved: string } {
  const promotions = store.all().filter((e) => e.kind === "promotion");
  const premises: { revision: string; candidateHash?: string }[] = [];
  for (const name of raw) {
    // Latest match: a retracted-and-re-promoted revision's current hash is
    // what a new dependent stands on, not the retracted content's.
    const match = [...promotions].reverse().find((e) => sameRevision(e.revision, name.trim()));
    if (!match) return { unresolved: name };
    premises.push({
      revision: String(match.revision),
      candidateHash: typeof match.candidateHash === "string" ? match.candidateHash : undefined,
    });
  }
  return { premises };
}

export function retractionClosure(
  store: GateStore,
): { revision: string; stage: string; dependents: string[] }[] {
  const promotions = store.all().filter((e) => e.kind === "promotion");
  const dependentsOf = (rev: string): string[] =>
    promotions
      .filter((p) => promotionPremises(p).some((pr) => sameRevision(pr, rev)))
      .map((p) => String(p.revision));
  // Keyed case-insensitively, like revision identity everywhere else: two
  // case spellings of one file are one retraction, not two.
  const seeds = new Map<string, { revision: string; stage: string }>();
  for (const r of promotionsNeedingRetraction(store)) {
    const key = r.revision.toLowerCase();
    if (!seeds.has(key)) seeds.set(key, r);
  }
  return [...seeds.values()].map(({ revision, stage }) => {
    const closure = new Set<string>();
    const queue = [revision];
    while (queue.length > 0) {
      for (const dep of dependentsOf(queue.pop()!)) {
        if (sameRevision(dep, revision) || closure.has(dep)) continue;
        closure.add(dep);
        queue.push(dep);
      }
    }
    return { revision, stage, dependents: [...closure] };
  });
}

/**
 * Promotion events whose recorded PROVED.md entry no longer appears in the
 * file: mechanical noticing, judgment stays with the coordinator. A legitimate
 * retraction relabel shows up here once; a silently vanished entry is the ledger
 * corruption this catches. Only promotions recorded with their entry text
 * (2026-08-07+) are checkable.
 */
export function promotionsMissingFromProved(store: GateStore, dir: string): { revision: string }[] {
  const provedPath = path.join(dir, "PROVED.md");
  const proved = fs.existsSync(provedPath) ? fs.readFileSync(provedPath, "utf-8") : "";
  return store
    .all()
    .filter((e) => e.kind === "promotion" && typeof e.entry === "string" && !proved.includes(e.entry))
    .map((e) => ({ revision: String(e.revision) }));
}

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

const FAILED_CHECK_RE = /^(no close prior route|closest prior route is .+; this differs materially because .+)/is;

/**
 * Gate keys are compared on this, never on the raw string. A mechanism name is
 * free text the coordinator retypes across turns, and it decides two launcher
 * rules. Raw comparison fails both ways: a trailing space or capital letter
 * evades the wave gate AND discards an IDEA PASS the campaign already paid for.
 */
export function normalizeMechanism(mechanism: string): string {
  return mechanism.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Latest verdict wins: a mechanism re-gated to IDEA FAIL/REPAIR loses fan-out
 *  permission it earned earlier, or the gate could never be re-armed. */
function ideaGatePassed(store: GateStore, mechanism: string): boolean {
  const key = normalizeMechanism(mechanism);
  return (
    store
      .all()
      .filter((e) => e.kind === "gate-verdict" && normalizeMechanism(String(e.mechanism ?? "")) === key)
      .at(-1)?.verdict === "IDEA PASS"
  );
}

/**
 * Fan-out gate. Launcher: "Do not allow recursive subagent fan-out or broad
 * concurrent exploration of a route before the parent mechanism receives
 * IDEA PASS". Enforced only at the unambiguous threshold — a second CONCURRENT
 * worker on the same mechanism. Sequential retries stay the coordinator's
 * judgment; the harness attaches an advisory reminder instead of refusing.
 */
export function checkDispatch(
  store: GateStore,
  role: "reasoner" | "technician",
  packet: ReasonerPacket | TechnicianPacket,
  userAgentLimit: number | undefined,
  liveAgents: number,
  liveOnMechanism: number,
): GateDecision {
  if (!packet.task || !packet.deliverable || !packet.mechanism) {
    return { allowed: false, reason: "packet must name a mechanism, task, and finite deliverable" };
  }
  const failedCheck = packet.failedCheck?.trim() ?? "";
  if (/differs materially because \.\.\.\s*$/.test(failedCheck) || /^no close prior route\b.*\bnot\b/i.test(failedCheck)) {
    return {
      allowed: false,
      reason: "failedCheck repeats the parameter's placeholder text; state the actual check result",
    };
  }
  if (!FAILED_CHECK_RE.test(failedCheck)) {
    return {
      allowed: false,
      reason:
        "failedCheck must record either 'no close prior route' or " +
        "'closest prior route is X; this differs materially because ...' (contract: FAILED.md check)",
    };
  }
  if (role === "technician") {
    const computation = (packet as TechnicianPacket).computation ?? "";
    if (computation.trim().length < 40 || !/\d/.test(computation)) {
      return {
        allowed: false,
        reason:
          "computation must state the preregistered finite domain and stopping rule with concrete " +
          'bounds (contract: "Use computation only for a preregistered finite domain and stopping ' +
          'rule yielding a small witness, certificate, or table.")',
      };
    }
  }
  const literature = (packet as ReasonerPacket).literature;
  if (role === "reasoner" && literature !== undefined && literature.trim().length < 30) {
    return {
      allowed: false,
      reason: "literature must state a substantive, self-contained question; omit it for a non-scout reasoner",
    };
  }
  if (userAgentLimit !== undefined && liveAgents >= userAgentLimit) {
    return { allowed: false, reason: `user-set concurrent-agent limit (${userAgentLimit}) reached` };
  }
  if (liveOnMechanism >= 1 && !ideaGatePassed(store, packet.mechanism)) {
    return {
      allowed: false,
      reason:
        `mechanism "${packet.mechanism}" already has ${liveOnMechanism} concurrent worker(s) and no ` +
        "IDEA PASS on file; concurrent workers on one mechanism require the idea gate first (dispatch_gate_critic).",
    };
  }
  const warning =
    !ideaGatePassed(store, packet.mechanism) && wasDispatchedBefore(store, packet.mechanism)
      ? `note: mechanism "${packet.mechanism}" was explored before without an IDEA PASS on file; ` +
        "the contract requires gating before investing follow-up workers — your judgment whether this is that."
      : undefined;
  return { allowed: true, warning };
}

function wasDispatchedBefore(store: GateStore, mechanism: string): boolean {
  const key = normalizeMechanism(mechanism);
  return store
    .all()
    .some((e) => e.kind === "dispatch" && normalizeMechanism(String(e.mechanism ?? "")) === key);
}

export function recordGateVerdict(
  store: GateStore,
  mechanism: string,
  verdictText: string,
  usage?: unknown,
  /** Identity and provenance for the gate lane, whose spend was otherwise
   *  unattributable. Use `dispatchId`, never `id`: an `id` on a non-dispatch
   *  kind joins wrong in the analytics queries. */
  request?: {
    promptChars?: number;
    durationMs?: number;
    dispatchId?: string;
    modelFamily?: string;
    modelSpec?: string;
    reportedModel?: string;
    providerSessionId?: string;
    backendCwd?: string;
    attempts?: number;
    requests?: number;
  },
): string {
  const verdict =
    parseFirstLineVerdict(verdictText, ["IDEA PASS", "IDEA FAIL", "IDEA REPAIR"]) ?? "UNPARSEABLE";
  // A DECISION record. The critic's call opens its own span, so with a sink
  // installed the tokens are already on a `role-call` leaf joined by
  // `dispatchId`, and repeating them here counted the whole gate lane twice
  // (rule 13: record at leaves, and exactly one writer per billed call).
  const { attempts, requests, ...identity } = request ?? {};
  const spend = spendFields({ usage: usage as RoleUsage | undefined, attempts, requests });
  store.append({ kind: "gate-verdict", mechanism, verdict, text: verdictText, ...identity, ...spend });
  return verdict;
}

export function statementHash(dir: string): string {
  return sha256File(path.join(dir, "STATEMENT.md"));
}

export function recordStatement(store: GateStore, dir: string, why: string): void {
  store.append({ kind: "statement", hash: statementHash(dir), why });
}

/** Latest user-accepted statement hash; undefined if never recorded. */
export function acceptedStatementHash(store: GateStore): string | undefined {
  const recs = store.all().filter((e) => e.kind === "statement");
  return recs.length > 0 ? (recs[recs.length - 1].hash as string) : undefined;
}

/**
 * Two-stage verification bookkeeping, bound to content: each stage record
 * carries sha256 of the candidate file and of STATEMENT.md at verification time.
 * `verifier-backed` requires a stage-1 audit PASS and a stage-2 comparison PASS
 * (the launcher's PASS belongs to the comparison, not to the blind
 * reconstructor) whose hashes still match the files on disk.
 */
function verificationState(store: GateStore, dir: string, revision: string) {
  const candidatePath = path.join(dir, "EVIDENCE", revision);
  const candidateHash = fs.existsSync(candidatePath) ? sha256File(candidatePath) : undefined;
  const stmtHash = statementHash(dir);
  // Latest verdict wins per stage: a PASS followed by a FAIL on the same
  // candidate and statement is not verifier-backed, however the FAIL arose.
  const latest = (kind: string) =>
    store
      .all()
      .filter(
        (e) =>
          e.kind === kind &&
          sameRevision(e.revision, revision) &&
          e.candidateHash === candidateHash &&
          e.statementHash === stmtHash,
      )
      .at(-1)?.verdict === "PASS";
  const stage1 = latest("audit");
  const stage2 = latest("comparison");
  return { stage1Passed: stage1, stage2Passed: stage2, verifierBacked: stage1 && stage2 };
}

/**
 * The one carry-forward lookup for every reusable verifier response.
 *
 * Reuse soundness here is information-flow control, not memoization: a record is
 * reusable iff its output provably could not have influenced the request now
 * presenting these inputs. Two conditions always hold — content-keyed on every
 * hash the caller passes, and content-bound to the saved artifact. The policy
 * difference lives in `requireStranded`:
 *
 * - `true` (audit, bundle-cert): the stage saw the candidate, so its PASS is
 *   reusable only while its own cadence is stranded. A PASS from a finished
 *   cadence is never reused; a rebuttal or re-request owes fresh scrutiny.
 * - `false` (reconstruction): the reconstructor never sees any candidate, so
 *   reuse crosses completed cadences by design, with `candidateHash` in the keys
 *   as an influence-tracking bound, not a disclosed input.
 */
export function priorReusableRecord(
  store: GateStore,
  dir: string,
  kind: "audit" | "bundle-cert" | "reconstruction",
  inputHashes: Record<string, string>,
  policy: { requireStranded: boolean },
): GateRecord | undefined {
  // Stranded = the journal's definition of an infrastructure failure: a
  // dispatch with NO completion, or one whose completion is itself a failure or
  // cancellation. Without the second clause, byte-identical re-runs after a
  // restart re-paid every stage (observed twice on lin3cut, 2026-08-09).
  const stranded = policy.requireStranded
    ? new Set([
        ...store.dispatchesWithoutCompletion().map((d) => d.id as string),
        ...store
          .all()
          .filter((e) => e.kind === "completion" && (e.failed !== undefined || e.cancelled === true))
          .map((e) => e.id as string),
      ])
    : undefined;
  return [...store.all()]
    .reverse()
    .find(
      (e) =>
        e.kind === kind &&
        (stranded === undefined ||
          (e.verdict === "PASS" && typeof e.dispatchId === "string" && stranded.has(e.dispatchId))) &&
        Object.entries(inputHashes).every(([k, v]) => e[k] === v) &&
        typeof e.artifact === "string" &&
        fs.existsSync(path.join(dir, e.artifact)) &&
        e.artifactHash === sha256File(path.join(dir, e.artifact)),
    );
}

export function checkPromotion(store: GateStore, dir: string, revision: string): GateDecision {
  const state = verificationState(store, dir, revision);
  if (!state.verifierBacked) {
    return {
      allowed: false,
      reason:
        `revision ${revision} is not verifier-backed against the current file contents ` +
        `(stage 1 hostile audit: ${state.stage1Passed}; stage 2 reconstruction+comparison: ${state.stage2Passed}). ` +
        "Both stages must PASS on the exact revision, and the candidate and STATEMENT.md must be " +
        "byte-identical to what was verified.",
    };
  }
  return { allowed: true };
}

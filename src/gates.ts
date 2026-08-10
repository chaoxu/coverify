import * as fs from "node:fs";
import { stateHome } from "./userdirs.js";
import * as path from "node:path";
import { appendJournal, gateOf, readLedger, sha256File, sha256Text } from "./campaign.js";

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
    /** Provider spend with no stage record of its own. Three sources today: a
     *  cadence cancelled after the call returned, a call the provider was paid
     *  for before it failed, and a coordinator compaction (which is a real
     *  request that leaves no assistant message behind). A leaf, so cost never
     *  has to be recovered by subtracting children from a summary.
     *
     *  NOT all verification spend: a `role-call` carrying `role: "coordinator"`
     *  belongs to the coordinator lane, so a per-stage query must filter on
     *  `role IS NULL` or it will pull compaction into the verdict-stage table
     *  (see design.md's analytics queries). */
    | "role-call"
    // Campaign events (wakes, usage, notes, replayed user guidance). One
    // event log: these live in the same out-of-tree store as gate records —
    // anything read back for behavior (standing guidance, delivery) must
    // come from the trust domain no role's workspace tools can write.
    | "wake"
    | "usage"
    | "note";
  [key: string]: unknown;
}

/**
 * The one read-side view with a consumer: the four verification stage records
 * share a shape, and modelSubstitutions() reads it (observe.ts).
 *
 * There were five of these — DispatchView, CompletionView, PromotionView,
 * RefusalView — behind a generic `viewsOf<K>` map. None of the other four was
 * ever instantiated: every other reader hand-casts at its own boundary
 * (view/spend.ts, view/outcomes.ts, view/limits.ts, view/trace.ts), which is
 * the honest thing to do when the write shape is deliberately open. A typed
 * lookup table serving one caller is the abstraction-for-single-use the house
 * style rejects.
 *
 * Every field stays optional by design: a campaign recorded before a field
 * existed narrows to `undefined` rather than erroring, which is exactly why
 * this layer needs no migrations.
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

/**
 * A campaign's identity, stored inside the campaign so it survives being moved.
 *
 * It used to be `sha256(realpath(dir))`, which meant renaming a folder — or
 * restoring a backup elsewhere, or mounting it at another path — produced a
 * campaign with intact ledgers and zero gate history: the statement freeze
 * re-armed on whatever the file now said, and every recorded FAIL vanished.
 * Existing campaigns keep their id by writing the legacy path hash into the
 * file on first read, so nothing in flight is disturbed.
 */
/** The out-of-tree state root — one authority, shared with dev tooling
 *  (scripts/smoke.ts) so cleanup never guesses at this path. */
/** Values that ENABLE journal-mirror adoption. Previously this was a bare
 *  truthiness test, so `COVERIFY_ADOPT=0` and `COVERIFY_ADOPT=false` both
 *  turned it ON — the opposite of what an operator typing them means, on the
 *  one knob that crosses coverify's trust boundary (it rebuilds gate history
 *  from the lower-trust in-tree mirror). Matches the schema declared in
 *  knobs.ts; a value outside this set is rejected at startup by validateKnobs,
 *  so an unrecognised spelling stops the run instead of silently enabling. */
const ADOPT_ENABLED = new Set(["1", "true", "yes"]);

export function stateRootDir(): string {
  return process.env.COVERIFY_STATE_DIR ?? path.join(stateHome(), "coverify");
}

/** Where a campaign records its opaque state-dir id (16 hex chars). */
export function campaignIdPath(campaignDir: string): string {
  return path.join(campaignDir, ".coverify", "campaign-id");
}

function campaignIdentity(campaignDir: string, stateDir: string): string {
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
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, id + "\n");
  } catch {
    /* read-only checkout or a race: the legacy lookup still works */
  }
  return id;
}

/** Keep only the fields that have a value. Record writers stamp optional
 *  telemetry through this because absence is load-bearing throughout this
 *  journal — "the backend never reported it" is a different record from a
 *  measured value, and every reader keys on the field simply not being there.
 *  One call replaces a row of `...(x !== undefined ? { x } : {})` spreads,
 *  which had multiplied to five per record site. */
export function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Completions the coordinator has not been shown yet, rendered for a wake.
 *
 * Pure query over the store, exported so it can be TESTED. It used to be a
 * closure inside runLockedCampaign, so the test that claimed to cover it
 * reimplemented the logic locally and asserted against its own copy —
 * deleting the real rule left that test green.
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
    // Integrity check against the recorded hash: an edited report is
    // delivered with a loud taint instead of silently, mirroring the
    // candidate-hash discipline everywhere else.
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
  /** Stamped on every record this process writes. Records that predate it are
   *  marked by its ABSENCE, which is a cleaner boundary than any date rule —
   *  and the run-config `runStart` note carries harnessRev, launcherSha256,
   *  piVersions, patches and roleSpecs, so "which convention did this record
   *  use" becomes "look up its run" rather than "know the commit history".
   *  A `v: 3` integer would say only THAT the shape changed, never what. */
  private runId: string | undefined;

  constructor(campaignDir: string) {
    const resolved = path.resolve(campaignDir);
    this.campaignDir = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
    const stateDir = stateRootDir();
    const id = campaignIdentity(this.campaignDir, stateDir);
    const dir = path.join(stateDir, id);
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "gates.jsonl");
    // meta.json names the opaque 16-hex state dir for cross-campaign
    // analytics (design.md, Appendix: Canonical analytics queries): the campaign path and its statement's
    // first line, best-effort, refreshed each construction.
    try {
      const stmt = readLedger(this.campaignDir, "STATEMENT.md");
      const firstLine = stmt.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
      const meta = path.join(dir, "meta.json");
      const next = JSON.stringify({ campaignDir: this.campaignDir, statement: firstLine.slice(0, 200) }) + "\n";
      // Skip identical rewrites so read-only commands (status, trace) stay
      // write-free on an unchanged campaign.
      if (!fs.existsSync(meta) || fs.readFileSync(meta, "utf-8") !== next) fs.writeFileSync(meta, next);
    } catch {
      /* fresh campaign without a statement yet */
    }
    // A campaign that has run before (its journal exists) but has no gate
    // history has lost its authoritative state — moved before ids travelled
    // with it, or ~/.local/state wiped. Adopting silently would re-arm the
    // statement freeze on whatever STATEMENT.md now says and erase every
    // recorded FAIL, so this stops instead. A first run has no journal yet,
    // and neither does a fresh campaign, so both proceed normally.
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
      // Mirror-based recovery: the journal is a derived mirror of the lost
      // authoritative log — gate records wrapped as {kind:"note", gate},
      // campaign events verbatim. Rebuilding from it turns "lose every
      // recorded FAIL or refuse to run" into "recover, with the taint on the
      // ledger forever": the mirror is in-tree and role-adjacent, so the
      // rebuilt history is honest testimony, not the trust anchor it replaced.
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
    // A torn line (crash or full disk mid-append) must not make the campaign
    // unresumable: gate records are append-only, so the salvageable prefix is
    // authoritative and a damaged line is dropped loudly. Failing hard here
    // would brick every prove/resume/amend with a raw SyntaxError.
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
    // Permanent provenance mark: a rebuilt history is testimony from the
    // in-tree mirror, not the original trust anchor. On the ledger forever.
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
    // Stamp LAST: a caller-supplied runId must not silently win over the
    // process identity that the whole "absence means pre-2026-08-09" reading
    // rule depends on.
    const full: GateRecord = { ts: new Date().toISOString(), ...record, ...this.runStamp() };
    this.records.push(full);
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    // Derived mirror in the campaign journal: observability only, never read
    // back for behavior. Gate records mirror wrapped (the journal's
    // historical shape); campaign events mirror verbatim via event().
    appendJournal(this.campaignDir, { kind: "note", gate: full });
    return full;
  }

  /**
   * A campaign event (wake, usage, note): same authoritative out-of-tree log
   * as gate records, mirrored VERBATIM into the in-tree journal so trace and
   * status keep their input shape. This is the only sanctioned way to record
   * an event the harness may later read back (standing user guidance,
   * delivery bookkeeping): the in-tree journal is role-adjacent — on a
   * degraded-confinement platform a script could append to it — so nothing
   * behavioral may ever be read from there.
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
  // Compared with whitespace collapsed: a candidate that reaches the prompt
  // re-indented, re-wrapped, or with CRLF endings is the same leak, and an
  // exact-substring check would wave it through while the journal still
  // claims the candidate was withheld. This catches verbatim inclusion under
  // reformatting; paraphrase remains model judgment (see the honesty ledger).
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
 * Revision identity for gate lookups. Records written before revisions were
 * canonicalized to their on-disk case hold the coordinator's spelling, and on
 * a case-insensitive volume both name the same file — comparing case-folded
 * as well keeps prior FAIL/PASS records matching after the change.
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
 * The contract requires a retraction when this happens — relabel in
 * REGISTRY.md, append to FAILED.md, mark the PROVED.md entry historical,
 * demote dependents. Deciding all that is model judgment, but *noticing* it is
 * arithmetic over records the harness already holds, and a promoted claim
 * quietly contradicted by a later verdict is the worst thing this ledger can
 * contain.
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

/**
 * Retractions with their recorded dependent closure.
 *
 * Promotion records carry machine-resolvable `premises` (revisions of earlier
 * promotions), so when a promoted revision later takes a substantive FAIL the
 * harness can enumerate every promotion standing on it — transitively —
 * instead of leaving the coordinator to rediscover the graph from prose.
 * Enumeration only: relabeling, FAILED.md appends, and demotion remain the
 * coordinator's judgment (contract).
 */
function promotionPremises(p: GateRecord): string[] {
  return Array.isArray(p.premises) ? (p.premises as unknown[]).map(String) : [];
}

/**
 * Resolve coordinator-typed premise names to recorded promotions. Each must
 * match an existing promotion (via revision identity): a typo would silently
 * disconnect the dependency edge that retraction enumeration walks, which is
 * the whole point of recording it. Returns the canonical stored revisions and
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
 * file. The same pattern as danglingCitations: mechanical noticing, judgment
 * stays with the coordinator. An entry legitimately rewritten by a recorded
 * retraction relabel will show up here once and be recognized as such; an
 * entry that silently vanished is the ledger corruption this exists to catch.
 * Only promotions recorded with their entry text (2026-08-07+) are checkable.
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

/** Latest verdict wins: a mechanism re-gated to IDEA FAIL/REPAIR loses fan-out
 *  permission it earned earlier, or the gate could never be re-armed. */
/**
 * Gate keys are compared on this, not on the raw string.
 *
 * A mechanism name is free text the coordinator retypes across turns, and it
 * decides two launcher rules: whether a wave needs the idea gate, and whether
 * an IDEA PASS already exists. Raw comparison fails in both directions — a
 * trailing space or a capital letter both evades the wave gate (the harness
 * sees no concurrent worker on "that" mechanism) and discards an IDEA PASS the
 * campaign already paid for.
 */
export function normalizeMechanism(mechanism: string): string {
  return mechanism.trim().replace(/\s+/g, " ").toLowerCase();
}

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
 * IDEA PASS". Enforced only
 * at the unambiguous threshold — a second CONCURRENT worker on the same
 * mechanism. History-based cases (sequential retries) are the coordinator's
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
  /** Identity and provenance for the gate lane. Before this, all 544
   *  gate-verdict records on file carried usage and NO id, no model and no
   *  dispatch link — the only record of that lane's spend, and unattributable.
   *  `dispatchId` (never `id`: an `id` on a non-dispatch kind joins wrong in
   *  the analytics queries) plus the served/requested model and the codex
   *  rollout join key. */
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
  store.append({ kind: "gate-verdict", mechanism, verdict, text: verdictText, usage, ...request });
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
 * carries sha256 of the candidate file and of STATEMENT.md at verification
 * time. `verifier-backed` requires a stage-1 audit PASS and a stage-2
 * comparison PASS (the launcher's PASS belongs to the comparison mapping the
 * reconstruction to the candidate, not to the blind reconstructor itself)
 * whose hashes still match the files on disk.
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
 * Reuse soundness in this cadence is information-flow control, not
 * memoization: a record is reusable iff its output provably could not have
 * influenced the request now presenting these inputs. Two enforced
 * conditions always hold — content-keyed on every hash the caller passes (a
 * repaired candidate changes `candidateHash` and never matches), and
 * content-bound to the saved artifact (an artifact edited since it was
 * recorded is no longer the response that was verified). The one policy
 * difference between the mechanisms lives in `requireStranded`:
 *
 * - `true` (audit, bundle-cert): the stage saw the candidate, so its PASS is
 *   reusable only while its own cadence is stranded — a verification
 *   dispatch with no completion record, the journal's definition of the
 *   contract's "protocol or infrastructure failure" (observed: campaign
 *   2026-08-01 v033/v035). A PASS from a finished cadence is never reused;
 *   a rebuttal challenge or duplicate re-request owes fresh scrutiny.
 * - `false` (reconstruction): the reconstructor never sees any candidate,
 *   so its output cannot have been influenced by a repair — reuse crosses
 *   completed cadences by design (it is the dominant cost of a clerical
 *   re-cadence), with `candidateHash` in the keys as an influence-tracking
 *   bound, not a disclosed input.
 */
export function priorReusableRecord(
  store: GateStore,
  dir: string,
  kind: "audit" | "bundle-cert" | "reconstruction",
  inputHashes: Record<string, string>,
  policy: { requireStranded: boolean },
): GateRecord | undefined {
  // Stranded = the journal's definition of an infrastructure failure: a
  // dispatch with NO completion, or one whose completion is itself a failure
  // or cancellation (a restart records failed completions for killed
  // cadences — without this clause, byte-identical re-runs after a restart
  // re-paid every stage; observed twice on lin3cut, 2026-08-09).
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

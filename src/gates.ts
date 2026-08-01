import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendJournal, sha256File, sha256Text } from "./campaign.js";

/**
 * Gate state store. Gate decisions must not depend on files any role's bash
 * can edit, so the authoritative record lives OUTSIDE the campaign directory
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
    | "promotion";
  [key: string]: unknown;
}

export class GateStore {
  private records: GateRecord[];
  private file: string;
  readonly campaignDir: string;

  constructor(campaignDir: string) {
    this.campaignDir = path.resolve(campaignDir);
    const id = sha256Text(this.campaignDir).slice(0, 16);
    const stateDir =
      process.env.COVERIFY_STATE_DIR ?? path.join(os.homedir(), ".local/state/coverify");
    const dir = path.join(stateDir, id);
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "gates.jsonl");
    this.records = fs.existsSync(this.file)
      ? fs
          .readFileSync(this.file, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as GateRecord)
      : [];
  }

  append(record: { kind: GateRecord["kind"] } & Record<string, unknown>): GateRecord {
    const full: GateRecord = { ts: new Date().toISOString(), ...record };
    this.records.push(full);
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    // Audit mirror in the campaign journal (write-only; never read by gates).
    appendJournal(this.campaignDir, { kind: "note", gate: full });
    return full;
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
}

/** A computation technician: encodes and runs one preregistered computation. */
export interface TechnicianPacket extends DispatchPacket {
  /** Launcher: "Use computation only for a preregistered finite domain and
   *  stopping rule yielding a small witness, certificate, or table." */
  computation: string;
}

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

const FAILED_CHECK_RE = /^(no close prior route|closest prior route is .+; this differs materially because .+)/is;

function ideaGatePassed(store: GateStore, mechanism: string): boolean {
  return store
    .all()
    .some((e) => e.kind === "gate-verdict" && e.mechanism === mechanism && e.verdict === "IDEA PASS");
}

/**
 * Wave gate. Launcher: "Do not allow recursive subagent fan-out or a large
 * route wave before the parent mechanism receives IDEA PASS". Enforced only
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
  if (!FAILED_CHECK_RE.test(packet.failedCheck?.trim() ?? "")) {
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
        "IDEA PASS on file; a multi-worker wave requires the idea gate first (dispatch_gate_critic).",
    };
  }
  const warning =
    !ideaGatePassed(store, packet.mechanism) && wasDispatchedBefore(store, packet.mechanism)
      ? `note: mechanism "${packet.mechanism}" was explored before without an IDEA PASS on file; ` +
        "the contract requires gating before investing a follow-up wave — your judgment whether this is one."
      : undefined;
  return { allowed: true, warning };
}

function wasDispatchedBefore(store: GateStore, mechanism: string): boolean {
  return store.all().some((e) => e.kind === "dispatch" && e.mechanism === mechanism);
}

export function recordGateVerdict(
  store: GateStore,
  mechanism: string,
  verdictText: string,
  usage?: unknown,
): string {
  const verdict =
    parseFirstLineVerdict(verdictText, ["IDEA PASS", "IDEA FAIL", "IDEA REPAIR"]) ?? "UNPARSEABLE";
  store.append({ kind: "gate-verdict", mechanism, verdict, text: verdictText, usage });
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
export function verificationState(store: GateStore, dir: string, revision: string) {
  const candidatePath = path.join(dir, "EVIDENCE", revision);
  const candidateHash = fs.existsSync(candidatePath) ? sha256File(candidatePath) : undefined;
  const stmtHash = statementHash(dir);
  const match = (e: GateRecord) =>
    e.revision === revision &&
    e.verdict === "PASS" &&
    e.candidateHash === candidateHash &&
    e.statementHash === stmtHash;
  const stage1 = store.all().some((e) => e.kind === "audit" && match(e));
  const stage2 = store.all().some((e) => e.kind === "comparison" && match(e));
  return { stage1Passed: stage1, stage2Passed: stage2, verifierBacked: stage1 && stage2 };
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

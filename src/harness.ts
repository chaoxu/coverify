import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  acquireCampaignLock,
  consumeUserMessages,
  gitInRepo,
  newEvidencePath,
  peekUserMessages,
  readJournal,
  resumeBundle,
  sha256Text,
} from "./campaign.js";
import {
  acceptedStatementHash,
  defined,
  recordStatement,
  undeliveredCompletions,
  GateStore,
  statementHash,
} from "./gates.js";
import { type BilledFailure } from "./backends.js";
import { requestVerificationTool } from "./cadence.js";
import { coordinatorTools } from "./coordinator-tools.js";
import { archiveLedgerHistory, recordRunConfig, wakeBookkeeping } from "./observe.js";
import { loadLauncherContract } from "./launcher.js";
import { CHARGES } from "./roles.js";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
  buildModels,
  setTelemetrySink,
  telemetrySink,
  createHarnessRoleSession,
  roleModelSpec,
  specKey,
  spendFields,
  spendLeafed,
  subUsage,
  type RoleSession,
  type RoleUsage,
} from "./providers.js";
import { envNumber, type WriteScope } from "./sandbox.js";

/** How a delivered `coverify say` is journaled. Spelled once on each side:
 *  the writers and the replay reader used to carry four hand-written copies,
 *  and a typo in any one silently stops a directive surviving the next context
 *  rebuild — which is the failure `standingGuidance` exists to prevent. */
const USER_MESSAGE_PREFIX = "user message: ";
const STEERED_MESSAGE_PREFIX = "user message steered mid-turn: ";

/** The directive inside a journal note, or undefined if it carries none.
 *  Exported for the test that pins these two strings as an ON-DISK format:
 *  every campaign's journal already contains them, so changing either constant
 *  stops old guidance replaying rather than renaming anything. */
export function userDirective(note: string): string | undefined {
  if (note.startsWith(USER_MESSAGE_PREFIX)) return note.slice(USER_MESSAGE_PREFIX.length);
  if (note.startsWith(STEERED_MESSAGE_PREFIX)) return note.slice(STEERED_MESSAGE_PREFIX.length);
  return undefined;
}

export interface CampaignOptions {
  campaignDir: string;
  /** User-set limit only; the launcher forbids a fixed harness ceiling. */
  userAgentLimit?: number;
  /** Stop waking the coordinator after this many wakes (user runtime limit). */
  maxWakes?: number;
  /** User-set reasoning-only policy: refuse every technician dispatch, so no
   *  code is written or run anywhere in the campaign (Chao, 2026-08-08). */
  noComputation?: boolean;
  /** Builds the measurement sink from the run's store. Supplied by cli.ts;
   *  absent means NOOP, which is what makes src/telemetry/ deletable. */
  telemetry?: (store: GateStore) => TelemetryContext;
}

export interface Handle {
  id: string;
  /** What this handle is. --agent-limit caps workers only and the wave gate
   *  counts workers on a mechanism, so this must be an explicit field: deciding
   *  it from id-string prefixes let a change of id spelling silently move a
   *  launcher limit. */
  kind: "worker" | "gate" | "verification";
  mechanism: string;
  promise: Promise<string>;
  /** The work's session, when it runs as one (workers only). What the session
   *  can do is its `capabilities` flag, not the presence of this field. */
  session?: RoleSession;
  /** Stop this work, whatever substrate runs it. Idempotent; safe on work that
   *  already finished. */
  stop?: () => void;
  /** Usage read at completion (undefined when the backend reported none —
   *  absent ≠ zero; see RoleUsage). */
  usage?: () => RoleUsage | undefined;
  /** Request-level counts; see RoleSession.attempts. */
  attempts?: () => number;
  requests?: () => number;
  /** Tool-spawned provider calls with no measurable usage; see RoleSession. */
  unmetered?: () => { lane: string; detail: string; usage?: RoleUsage }[];
  /** Resolves (never rejects) when the handle finishes; set by registerHandle. */
  settled: Promise<void>;
}

/** Consecutive wakes with no dispatch, no verification, and no declaration
 *  before the harness pauses operationally to stop runaway spend. This is an
 *  operational pause (campaign stays authorized), never a completion. */
const NOOP_WAKE_PAUSE = 3;

/** Consecutive failed coordinator turns before the harness pauses. A failing
 *  turn is retried with exponential backoff; a backend that is simply broken
 *  should stop the campaign loudly instead of spinning. */
const TURN_FAILURE_LIMIT = 5;

/** Coordinator context cap (approx tokens): the coordinator stays resident
 *  across wakes until this cap, then compacts in place (the launcher's
 *  anticipated "context compaction"), with restart-rule rebuild as the fallback.
 *  Mechanics — the cap changes cost, not semantics.
 *
 *  Guarded, not bare Number(): a typo made this NaN, and `approxTokens() > NaN`
 *  is false forever, so compaction never fired and context grew unbounded. */
const COORDINATOR_CONTEXT_TOKENS = envNumber(process.env.COVERIFY_COORDINATOR_CONTEXT_TOKENS, 300_000, 1);

/**
 * The harness event loop — the only persistent process. Completions wake the
 * resident coordinator session (compacted in place at its context cap, with
 * ledger rebuild as the fallback); there is no polling.
 */
export async function runCampaign(opts: CampaignOptions): Promise<string> {
  const dir = path.resolve(opts.campaignDir);
  // Held for the whole run and released on every exit path, throwing ones
  // included; leaving this to each return statement lost reports three times.
  const release = acquireCampaignLock(dir);
  try {
    // The store and run id are minted here so the measurement sink exists
    // before any work does, and the run span can wrap the whole campaign
    // without touching the event loop's control flow.
    const store = new GateStore(dir);
    const runId = randomUUID().slice(0, 8);
    store.setRunId(runId);
    if (opts.telemetry !== undefined) setTelemetrySink(opts.telemetry(store));
    return await telemetrySink().startSpan(
      {
        name: "coverify.run",
        attributes: {
          "coverify.run_id": runId,
          "coverify.harness_rev": gitInRepo("git rev-parse HEAD") ?? undefined,
        },
      },
      () => runLockedCampaign(opts, dir, store, runId),
    );
  } finally {
    release();
  }
}

async function runLockedCampaign(
  opts: CampaignOptions,
  dir: string,
  // Both minted by runCampaign, so the sink and the run span exist before any
  // work does. runId is set on the store before ANY record is written: the
  // reading rule "no runId means the record predates 2026-08-09" breaks if a
  // present-day writer emits unstamped.
  store: GateStore,
  runId: string,
): Promise<string> {
  const contract = loadLauncherContract();
  const models = await buildModels();

  // One-time import: guidance recorded before the event-log unification
  // (2026-08-07) lives only in the in-tree journal. The marker keeps the
  // lower-trust provenance on the record and makes the import idempotent.
  if (!store.all().some((e) => e.kind === "note" && e.journalGuidanceImport === true)) {
    for (const e of readJournal(dir) as unknown as Record<string, unknown>[]) {
      const note = typeof e.note === "string" ? e.note : "";
      if (userDirective(note) !== undefined) {
        store.event({ kind: "note", note, journalGuidanceImport: true, originalTs: e.ts });
      }
    }
    store.event({ kind: "note", note: "journal guidance import complete", journalGuidanceImport: true });
  }

  // Run-config stamp: attributes this run to an exact (harness, contract,
  // policy, runtime) tuple — see observe.ts. One resolution per run; every
  // record naming the coordinator model spells it from this, so the stamp and
  // the usage events join.
  const coordinatorSpec = roleModelSpec("coordinator");
  recordRunConfig(store, {
    runId,
    harnessRev: gitInRepo("git rev-parse HEAD") ?? "unknown",
    launcherSha256: sha256Text(contract),
    userAgentLimit: opts.userAgentLimit,
    maxWakes: opts.maxWakes,
    ...(opts.noComputation ? { noComputation: true } : {}),
    coordinatorContextTokens: COORDINATOR_CONTEXT_TOKENS,
  });

  // Statement freeze: hard-stop if STATEMENT.md changed without a recorded
  // user amendment ("only an explicit user amendment may replace it").
  const accepted = acceptedStatementHash(store);
  if (accepted === undefined) {
    // Foreign or pre-harness campaign (e.g. created by a skill session):
    // adopt the current statement as the accepted baseline so the freeze arms.
    recordStatement(store, dir, "adopted existing campaign at first coverify run");
  } else if (accepted !== statementHash(dir)) {
    throw new Error(
      "STATEMENT.md differs from the last user-accepted revision. If this is an explicit user " +
        "amendment, run 'coverify amend' to accept it (starting a new statement revision and " +
        "invalidating earlier completion evidence); otherwise restore the file.",
    );
  }

  const handles = new Map<string, Handle>();
  const settledQueue: { h: Handle; failed?: string }[] = [];
  let nextId = store.maxHandleId() + 1;
  let activityThisWake = 0;
  let declaration: { state: "pause" | "complete"; reason: string } | undefined;
  let lastWakeText = "";

  const coordinatorScope: WriteScope = {
    allow: [dir],
    deny: [
      path.join(dir, ".coverify"),
      path.join(dir, "STATEMENT.md"),
      path.join(dir, "PROVED.md"),
    ],
  };

  const evidenceRelative = (p: string): string | undefined => {
    const root = fs.existsSync(path.join(dir, "EVIDENCE"))
      ? fs.realpathSync.native(path.join(dir, "EVIDENCE"))
      : path.join(dir, "EVIDENCE");
    let resolved = path.resolve(root, p);
    if (!resolved.startsWith(root + path.sep)) return undefined;
    // Canonical on-disk case: gate records key on this string, and darwin opens
    // `Cand.md` and `cand.md` as one file — without this, retyping the case
    // looks like a new revision and slips past anti-verdict-shopping.
    if (fs.existsSync(resolved)) resolved = fs.realpathSync.native(resolved);
    if (!resolved.startsWith(root + path.sep)) return undefined;
    return path.relative(root, resolved);
  };

  const liveOnMechanism = (mechanism: string): number =>
    [...handles.values()].filter((h) => h.kind === "worker" && h.mechanism === mechanism).length;

  // --agent-limit caps concurrent WORKERS only. Judges (gate critics, cadences)
  // are handles too but must not consume the workers' budget: ten pending
  // verdicts should never block a dispatch.
  const liveWorkers = (): number =>
    [...handles.values()].filter((h) => h.kind === "worker").length;

  const sessionsRoot = path.join(dir, ".coverify", "sessions");

  /** Registers a settled-queue handle. A thunk is started only after the handle
   *  is in `handles`, so work with a synchronous prefix cannot observe its own
   *  id as missing and spuriously self-cancel. */
  const registerHandle = (
    h: Omit<Handle, "settled" | "promise"> & { promise: Promise<string> | (() => Promise<string>) },
  ) => {
    const handle = h as unknown as Handle;
    // Durability happens at the moment work settles, never later when some exit
    // path remembers to harvest: three exit paths each lost an hour of agent
    // work when the report lived only in the queue. The queue then carries
    // nothing but a pointer to bytes already on disk.
    //
    // Failure is classified here too, so `failed` is the single source of truth:
    // `failed` set ⟺ no report artifact exists.
    const persist = (report: string, failed?: string, partialText?: string, billed?: RoleUsage) => {
      const live = handles.has(handle.id);
      // Written even when the handle is no longer live, deliberately: a cancel
      // records handle.usage() synchronously, but a pi session refreshes totals
      // only in an attempt's `finally`, so the cancel record of a mid-turn
      // worker is ~0 and the real number lands HERE. Both are cumulative
      // snapshots of one session and telemetry/spend.ts keeps the last per id, so
      // writing both de-duplicates at read time.
      //
      // `billed` is the fallback for a call the provider was PAID for before it
      // failed (a CLI exiting nonzero after turn.completed). Skipped once
      // something upstream claimed that payment (BilledFailure.usageLeafed), so
      // that leaf and this record cannot both count it.
      //
      // The session's own total is written only when nothing leafed it: with a
      // sink installed each turn already appended its own `role-call`, and
      // stamping the cumulative total here as well counted every worker twice.
      // `billed` survives either way — a call that threw before returning wrote
      // no leaf, so this record is its only writer.
      const spend = () => ({
        ...spendFields({
          usage: handle.usage?.(),
          attempts: handle.attempts?.(),
          requests: handle.requests?.(),
        }),
        ...(handle.usage?.() === undefined && billed !== undefined ? { usage: billed } : {}),
      });
      // Tool-spawned calls, leafed once per settle: a gap when the lane could
      // not be measured, real spend when it could but no telemetry sink was
      // installed to leaf it. Drained rather than peeked, so a refactor cannot
      // emit each entry twice.
      for (const u of handle.unmetered?.().splice(0) ?? []) {
        store.append({
          kind: "role-call",
          dispatchId: handle.id,
          detail: u.detail,
          ...(u.usage === undefined
            ? { unmetered: u.lane }
            : { role: u.lane, usage: u.usage, requests: 1 }),
        });
      }
      if (failed !== undefined) {
        // Preserve what the dead stream produced. NOT a deliverable: the
        // completion stays an infrastructure failure and redispatch stays
        // legitimate, but the coordinator can mine the notes.
        let partial: string | undefined;
        if (partialText !== undefined && partialText.trim() !== "") {
          const p = newEvidencePath(dir, `${handle.id}/partial`);
          fs.writeFileSync(
            p,
            `# PARTIAL work from ${handle.id} — the provider connection failed mid-response\n\n` +
              `This is NOT a completed deliverable and carries no claim label. The assignment was ` +
              `not finished; treat this as notes from an interrupted attempt.\n\n---\n\n${partialText}\n`,
          );
          partial = path.relative(dir, p);
        }
        store.append({
          kind: "completion",
          id: handle.id,
          failed,
          ...defined({ partial }),
          ...spend(),
        });
        if (live) settledQueue.push({ h: handle, failed });
        return;
      }
      const reportPath = newEvidencePath(dir, `${handle.id}/report`);
      fs.writeFileSync(reportPath, report);
      const rel = path.relative(dir, reportPath);
      if (live) {
        // Hash-bound: delivery re-reads the file from a path the coordinator's
        // write scope can touch, so the bytes delivered must be provably the
        // bytes the worker returned.
        store.append({
          kind: "completion",
          id: handle.id,
          report: rel,
          reportSha256: sha256Text(report),
          ...spend(),
        });
        settledQueue.push({ h: handle, failed: undefined });
      } else {
        // Cancelled while running: the completion is already recorded, so this
        // is a late artifact rather than a second completion — kept, not
        // double-counted, and never resurfaced as a new report. Same id, so a
        // reader supersedes the earlier snapshot rather than adding to it.
        store.event({
          kind: "note",
          note: `late report after cancellation`,
          id: handle.id,
          report: rel,
          ...spend(),
        });
      }
    };
    handles.set(handle.id, handle);
    handle.promise = typeof h.promise === "function" ? h.promise() : h.promise;
    handle.settled = handle.promise.then(
      (report) =>
        persist(report, report.trim() === "" ? "empty report (no final text returned)" : undefined),
      (err: unknown) => {
        let failure = String(err);
        // Name the real cause: the SESSION grew past the model context, not the
        // packet. Without this the coordinator reaches for packet-splitting,
        // which measurably does not help (issue #22: r181/r185 died the same
        // way).
        if (/context window|context length|maximum context/i.test(failure)) {
          failure +=
            " [harness diagnosis: the worker's session outgrew the model window mid-run — " +
            "accumulated reads and reasoning, not packet size. Packet-splitting will not help. " +
            "Redispatch with a tighter exploration scope: name the exact files to read.]";
        }
        const billed = err as BilledFailure;
        persist(
          "",
          failure,
          (err as { partialText?: string })?.partialText,
          billed.usageLeafed ? undefined : billed.usage,
        );
      },
    );
    activityThisWake++;
  };

  /**
   * Drain every settled handle. Every path that empties the queue must come
   * through here; dropping it instead destroys finished work.
   */
  const harvestSettled = (): { total: number; failed: number } => {
    const settled = settledQueue.splice(0, settledQueue.length);
    for (const s of settled) handles.delete(s.h.id);
    // Counts only: the wake's report text is rendered from the durable record by
    // undeliveredCompletions(store, dir).
    return {
      total: settled.length,
      failed: settled.filter((s) => s.failed !== undefined).length,
    };
  };

  /**
   * Every user directive delivered so far, oldest first. Directives are
   * journaled on delivery and replayed here: living only in the coordinator's
   * conversation, a `coverify say` silently stopped applying at the next
   * rebuild (the resume bundle has no user channel).
   */
  const standingGuidance = (): string[] => {
    const out: string[] = [];
    for (const e of store.all()) {
      const note = typeof e.note === "string" ? e.note : "";
      const directive = userDirective(note);
      if (directive !== undefined) out.push(directive);
    }
    return out.slice(-20);
  };


  const requestVerification = requestVerificationTool({
    dir,
    store,
    contract,
    models,
    evidenceRelative,
    declaration: () => declaration,
    mintVerificationId: () => `v${String(nextId++).padStart(3, "0")}`,
    wake: () => wakeCount,
    hasHandle: (id) => handles.has(id),
    liveCount: () => handles.size,
    registerHandle,
  });

  const {
    dispatchReasoner,
    dispatchTechnician,
    dispatchGateCritic,
    recordPromotion,
    cancelWorker,
    steerWorker,
    declareState,
  } = coordinatorTools({
    dir,
    store,
    contract,
    models,
    opts,
    sessionsRoot,
    evidenceRelative,
    declaration: () => declaration,
    declare: (d) => {
      declaration = d;
    },
    nextId: () => nextId++,
    wake: () => wakeCount,
    handles,
    settledQueue,
    liveWorkers,
    liveOnMechanism,
    registerHandle,
    harvestSettled,
    bumpActivity: () => {
      activityThisWake++;
    },
  });

  // Reading discipline for a just-built or just-compacted coordinator. Measured
  // 2026-08-01 (issue #17): a rebuilt coordinator re-read the ledgers wholesale
  // — 143–208k tokens of onboarding against a ~5k bundle, which is why only ~3
  // wakes fit per window. Mechanics: it forbids nothing.
  const readingDiscipline =
    "\n\nReading discipline (context economy): the bundle above is the contract's scoped reread — " +
    "statement, frontier, registry index, and lessons. PROVED.md, FAILED.md, and EVIDENCE/ are " +
    "on-demand references: consult the specific entries a decision turns on (grep, or read with " +
    "offset/limit), and read in full only a detailed claim you are actually reusing. Wholesale " +
    "ledger reads accelerate the next compaction without adding durable state.";

  // Surface work lost to a previous crash: dispatched, never completed.
  const lost = store.dispatchesWithoutCompletion();
  let lostNote =
    lost.length > 0
      ? `Lost to a previous restart (dispatched, no report): ${lost
          .map((d) => `${d.id} [${d.mechanism}]`)
          .join(", ")}. Re-dispatch if still wanted.\n`
      : "";

  let wakeCount = 0;
  let noopWakes = 0;
  let turnFailures = 0;
  let coordinator: RoleSession | undefined;
  let coordinatorEpoch = 0;
  /** Unique per (run, rebuild). Serves as pi's session id (hence prompt cache
   *  key) and as `sessionId` on every coordinator usage record, so spend groups
   *  by an identity on the record rather than by inferring a reset from a
   *  counter that went backwards — that inference over-split one campaign into
   *  18 epochs against 15 real sessions and overstated fresh input by 16.7M
   *  tokens. */
  const coordinatorSessionId = () => `coordinator-${runId}-${coordinatorEpoch}`;
  // Baseline for the per-wake deltas, reset with the session. One object so the
  // two counters cannot be reset in different places and drift.
  let prevCoord: { usage?: RoleUsage; attempts: number; requests: number } = { attempts: 0, requests: 0 };
  /** Both discard paths (compaction failure, failed turn) throw the session
   *  away, and the call that failed was already billed. This is the last
   *  chance to journal what it cost — as a leaf, like every ordinary wake. */
  const leafDiscardedCoordSpend = (why: { compactionFailed: true } | { turnFailed: true }) => {
    const total = coordinator?.usage();
    if (!total) return;
    // A failed TURN was already leafed: `ask` records in a `finally`, so the
    // span wrote this payment before the throw reached here. A failed
    // COMPACTION was not — `compact()` opens no span, its designated single
    // writer is leafCompactionSpend below, and that never ran. So this record
    // stays the only writer for the compaction case and carries join keys only
    // for the turn case.
    if ("turnFailed" in why && spendLeafed()) {
      store.event({
        kind: "usage",
        role: "coordinator",
        sessionId: coordinatorSessionId(),
        wake: wakeCount,
        ...why,
        modelSpec: specKey(coordinatorSpec),
      });
      return;
    }
    store.event({
      kind: "usage",
      role: "coordinator",
      sessionId: coordinatorSessionId(),
      wake: wakeCount,
      ...why,
      modelSpec: specKey(coordinatorSpec),
      usage: subUsage(total, prevCoord.usage),
      // The retries are the POINT of this record: a failed turn is the lane
      // retryAssistantCall fires on, and attempts are the one count no later
      // reader can reconstruct — the session holding it is discarded next line.
      ...defined({
        attempts: (coordinator?.attempts?.() ?? 0) - prevCoord.attempts,
        requests: Math.max(0, (coordinator?.requests?.() ?? 0) - prevCoord.requests),
      }),
    });
  };
  /** The compaction's own spend, leafed like any other call: a real, large
   *  provider request whose tokens otherwise fold silently into the session
   *  total, leaving the resident-coordinator design's first-order cost
   *  unmeasurable (#37). Carries the DELTA plus the context traded away. */
  const leafCompactionSpend = (session: RoleSession, before: RoleUsage | undefined, beforeTokens: number) => {
    const after = session.usage();
    if (!after) return;
    store.append({
      kind: "role-call",
      role: "coordinator",
      sessionId: coordinatorSessionId(),
      wake: wakeCount,
      compaction: true,
      modelSpec: specKey(coordinatorSpec),
      usage: subUsage(after, before),
      // compact() leaves no assistant message, so `requests` (transcript-
      // derived) cannot see it and `attempts` is its only record. Rule 13
      // requires both on every usage-bearing record.
      attempts: 1,
      requests: 0,
      contextTokensBefore: beforeTokens,
      contextTokensAfter: session.approxTokens(),
    });
    // BOTH baselines move: compact() increments the session's attempt counter,
    // so advancing only `usage` leaves the wake's leaf reporting a wake-only
    // token delta beside an attempt count that still includes this call.
    prevCoord = {
      usage: after,
      attempts: session.attempts?.() ?? prevCoord.attempts,
      requests: session.requests?.() ?? prevCoord.requests,
    };
  };
  // Per-wake context growth, surfaced when large (issue #17): the measured
  // campaign grew 29–55k tokens per wake, ~90% of it the coordinator's own
  // reads and output. Telemetry plus a note — never a refusal.
  const GROWTH_NOTE_TOKENS = envNumber(process.env.COVERIFY_WAKE_GROWTH_NOTE_TOKENS, 40_000, 1);
  let prevContextTokens: number | undefined;
  let growthNote = "";
  while (true) {
    wakeCount++;
    if (opts.maxWakes !== undefined && wakeCount > opts.maxWakes) {
      // Harvest before returning: what unblocked this loop is usually an agent
      // finishing.
      const atLimit = harvestSettled();
      store.event({
        kind: "note",
        note: `user wake limit ${opts.maxWakes} reached; pausing`,
        ...(atLimit.total > 0 ? { harvested: atLimit.total } : {}),
      });
      return (
        `${lastWakeText}\n\n[coverify: user wake limit reached; campaign paused` +
        (atLimit.total > 0 ? `; ${atLimit.total} finished report(s) saved to EVIDENCE` : "") +
        `. Resume with 'coverify resume']`
      );
    }
    activityThisWake = 0;
    // Harvest first, so the digest describes the world the coordinator is about
    // to act in: otherwise a finished agent is reported as still running in the
    // same message that delivers its report.
    const harvested = harvestSettled();
    // Delivered from the record, not from the queue: a report the previous
    // wake failed to show is still pending here.
    const pending = undeliveredCompletions(store, dir);
    const reportSections = pending.map((p) => p.section);
    const limits: string[] = [];
    if (opts.userAgentLimit !== undefined) limits.push(`workers ${liveWorkers()}/${opts.userAgentLimit}`);
    if (opts.maxWakes !== undefined) limits.push(`wakes ${wakeCount}/${opts.maxWakes}`);
    // Mechanical fact only; allocation judgment stays the coordinator's
    // (skill-feedback 2026-08-09).
    const liveJudges = [...handles.values()].filter((h) => h.kind !== "worker").length;
    if (
      opts.userAgentLimit !== undefined &&
      liveJudges > 0 &&
      liveWorkers() < opts.userAgentLimit
    ) {
      limits.push(
        `${opts.userAgentLimit - liveWorkers()} worker slot(s) idle while ${liveJudges} judge handle(s) run`,
      );
    }
    const digest =
      (handles.size === 0
        ? "No workers are currently running."
        : `Still running (do not interrupt for slowness): ${[...handles.values()]
            .map((h) => `${h.id} [${h.mechanism}]`)
            .join(", ")}`) + (limits.length > 0 ? `\nUser limits: ${limits.join("; ")}.` : "");
    store.event({
      kind: "wake",
      wake: wakeCount,
      live: handles.size,
      newReports: harvested.total - harvested.failed,
      pendingDelivery: pending.length,
      ...(harvested.failed > 0 ? { failed: harvested.failed } : {}),
    });
    // Bookkeeping the harness can check so the coordinator need not remember it
    // (observe.ts): dangling citations, edited promotions, unfollowed refusals.
    const bookkeeping = wakeBookkeeping(store, dir);
    const idleNudge =
      handles.size === 0 && reportSections.length === 0 && wakeCount > 1
        ? "\nNothing is live and no new reports arrived. Per the contract the campaign remains " +
          "authorized: dispatch the next materially new fan-out, or explicitly declare_campaign_state."
        : "";
    // Resident coordinator: at the context cap the session compacts in place;
    // rebuild happens only at start, on compaction failure, or after a failed
    // turn (the launcher's restart rule is the rebuild).
    let justCompacted = false;
    if (coordinator && coordinator.approxTokens() > COORDINATOR_CONTEXT_TOKENS) {
      if (coordinator.compact) {
        store.event({
          kind: "note",
          note: `coordinator context cap (${COORDINATOR_CONTEXT_TOKENS} tok) reached; compacting (restart rule applies)`,
        });
        const beforeTokens = coordinator.approxTokens();
        const beforeUsage = coordinator.usage();
        try {
          await coordinator.compact(
            "The campaign ledgers (STATEMENT.md, CURRENT_FRONTIER.md, REGISTRY.md, FAILED.md, " +
              "PROVED.md, PROCESS_LESSONS.md) are the durable state and remain authoritative; this " +
              "summary is soft context only and must never be cited over them. Preserve precisely: " +
              "live agent assignments and their mechanisms, the verification queue state, dispatch " +
              "decisions not yet externalized, and open questions from the newest reports.",
          );
          justCompacted = true;
          leafCompactionSpend(coordinator, beforeUsage, beforeTokens);
        } catch (e) {
          // Compaction is a real LLM call and can fail; the campaign must not
          // die with workers live, so fall back to the restart-rule rebuild.
          leafDiscardedCoordSpend({ compactionFailed: true });
          store.event({
            kind: "note",
            note: `compaction failed (${String(e).slice(0, 200)}); rebuilding via restart rule`,
          });
          coordinator = undefined;
        }
      } else {
        store.event({
          kind: "note",
          note: `coordinator context cap (${COORDINATOR_CONTEXT_TOKENS} tok) reached; rebuilding via restart rule`,
        });
        coordinator = undefined;
      }
    }
    let fresh = false;
    if (coordinator === undefined) {
      fresh = true;
      coordinatorEpoch++;
      prevCoord = { attempts: 0, requests: 0 };
      coordinator = await createHarnessRoleSession(
        {
          contract,
          charge: CHARGES.coordinator,
          // failedLedger: the coordinator authors the prior-route check
          // (`failedCheck`, gated by checkDispatch) and its session is
          // long-lived, which is where a 31 KB read is re-presented most.
          // Wiring it to workers only left ~32% of FAILED.md traffic unhelped
          // (#28).
          workspace: { cwd: dir, scope: coordinatorScope, failedLedger: path.join(dir, "FAILED.md") },
          extraTools: [
            dispatchReasoner,
            dispatchTechnician,
            dispatchGateCritic,
            requestVerification,
            recordPromotion,
            cancelWorker,
            steerWorker,
            declareState,
          ],
          spec: coordinatorSpec,
          models,
        },
        {
          // Epoch-numbered per rebuild AND scoped to this run: pi derives
          // prompt_cache_key from this id, so a run-independent id makes two
          // concurrent campaigns share a cache key.
          sessionId: coordinatorSessionId(),
          sessionsRoot,
          cwd: dir,
        },
      );
    }
    const newsBlock =
      reportSections.length > 0
        ? `# Newly completed work\n\n${reportSections.join("\n\n---\n\n")}`
        : "No new completions this wake.";
    // Pre-compaction warning: past 80% of the cap, remind the coordinator
    // that the next rebuild will start from the ledgers alone.
    const compactionWarning =
      !fresh && !justCompacted && coordinator.approxTokens() > COORDINATOR_CONTEXT_TOKENS * 0.8
        ? "\nNote: your session is approaching its context cap and will soon be compacted " +
          "(the contract's restart rule applies at that boundary). Anything living only in this " +
          "conversation must be externalized — ensure CURRENT_FRONTIER.md and the registry capture it now."
        : "";
    // The contract's restart rule at the compaction boundary: post-compaction
    // the reread is SUPPLIED, not merely instructed — the same resume bundle a
    // rebuilt coordinator gets. Replayed on any prompt that rebuilds context,
    // never on an ordinary continuing wake where the coordinator already has it.
    const guidance = fresh || justCompacted ? standingGuidance() : [];
    const guidanceBlock =
      guidance.length > 0
        ? `\n\n## Standing user guidance (delivered earlier in this campaign)\n\n` +
          guidance.map((m) => `- ${m}`).join("\n") +
          `\n\nThese remain in force unless the user withdraws them. They are guidance, not a ` +
          `statement amendment.\n`
        : "";
    const rereadBlock = justCompacted
      ? "Your context was just compacted. Per the contract's restart rule, the current ledgers " +
        "follow; the compaction summary never overrides them.\n\n" +
        `${resumeBundle(dir)}${readingDiscipline}\n\n---\n\n`
      : "";
    // A growth note describes the previous wake of THIS context; after a
    // rebuild or compaction it describes a context that no longer exists, and
    // the growth baseline resets with it (one mechanism for both).
    if (fresh || justCompacted) {
      growthNote = "";
      prevContextTokens = undefined;
    }
    // User messages (coverify say): delivered verbatim at the wake boundary and
    // consumed only after the turn succeeds; a failed turn leaves them queued.
    const userMessages = peekUserMessages(dir);
    const userBlock =
      userMessages.length > 0
        ? `\n\n# Messages from the user (verbatim)\n\n${userMessages.join("\n\n---\n\n")}\n\n` +
          "These are user guidance, not a statement amendment: STATEMENT.md changes still " +
          "require 'coverify amend'."
        : "";
    // Mid-turn steer: messages queued during the turn are injected live rather
    // than waiting a wake. The inbox is FIFO and append-only, so mid-turn
    // arrivals are exactly the entries past the wake batch plus what this
    // watcher already steered. At-least-once: a failed turn loses the steered
    // content with the session, so it redelivers at the next wake.
    let steeredCount = 0;
    let watcherBusy = false;
    const inboxWatcher = setInterval(() => {
      if (watcherBusy) return;
      watcherBusy = true;
      void (async () => {
        try {
          const fresh_ = peekUserMessages(dir).slice(userMessages.length + steeredCount);
          for (const m of fresh_) {
            const delivered = await coordinator!.steer(
              `# Message from the user (verbatim)\n\n${m}\n\n(Steered mid-turn via 'coverify say'. ` +
                "User guidance, not a statement amendment: STATEMENT.md changes still require 'coverify amend'.)",
            );
            if (!delivered) break; // turn just ended; the wake boundary takes over
            steeredCount++;
            store.event({ kind: "note", note: `${STEERED_MESSAGE_PREFIX}${m}` });
          }
        } catch {
          /* transport only; never break the campaign */
        } finally {
          watcherBusy = false;
        }
      })();
    }, 1000);
    try {
      // The wake span: without a parent the coordinator's own leaves carried no
      // role and no wake and bucketed as `orphaned-spend` — roughly a third of
      // measured campaign spend, unattributable (rule 13, "record every edge").
      // Re-pointed each wake because the session outlives any one span; with
      // telemetry off this is a pass-through that runs the same callback.
      const wakePrompt = fresh
        ? `${resumeBundle(dir)}${readingDiscipline}${guidanceBlock}\n\n---\n\nCampaign directory: ${dir}\n${lostNote}${digest}${bookkeeping}${idleNudge}\n\n${newsBlock}${userBlock}`
        : `${rereadBlock}${guidanceBlock}${lostNote}${digest}${bookkeeping}${idleNudge}${compactionWarning}${growthNote}\n\n${newsBlock}${userBlock}`;
      lastWakeText = await telemetrySink().startSpan(
        {
          name: "coverify.wake",
          attributes: { "coverify.wake": wakeCount, "coverify.role": "coordinator" },
        },
        (wakeSpan) => {
          coordinator!.setTelemetryParent?.(wakeSpan);
          return coordinator!.ask(wakePrompt);
        },
      );
      for (const m of userMessages) store.event({ kind: "note", note: `${USER_MESSAGE_PREFIX}${m}` });
      consumeUserMessages(dir, userMessages.length + steeredCount);
      if (pending.length > 0) store.append({ kind: "delivery", ids: pending.map((p) => p.id) });
    } catch (e) {
      // A hard provider failure must not kill the campaign with workers live:
      // journal it and rebuild via the restart rule. But a persistent failure
      // (expired token, retired model id, quota) fails in milliseconds, so
      // immediate retry spins — measured 2610 rebuilds a second, one session
      // tree each. Back off, then pause rather than burn the wake budget.
      turnFailures++;
      store.event({
        kind: "note",
        note: `coordinator turn failed (${String(e).slice(0, 200)}); rebuilding via restart rule`,
        consecutiveFailures: turnFailures,
      });
      // A failed turn still spent tokens (the call plus every retry attempt);
      // journal them before the session is discarded.
      leafDiscardedCoordSpend({ turnFailed: true });
      coordinator = undefined;
      prevCoord = { attempts: 0, requests: 0 }; // the next turn rebuilds; a new series starts
      wakeCount--; // a failed turn is not a wake the user asked to spend
      if (turnFailures >= TURN_FAILURE_LIMIT) {
        store.event({
          kind: "note",
          note: `pausing after ${turnFailures} consecutive coordinator failures`,
        });
        return (
          `${lastWakeText}\n\n[coverify: paused after ${turnFailures} consecutive coordinator turn ` +
          `failures — the last was: ${String(e).slice(0, 200)}. Live agents keep their work (reports ` +
          `are persisted as they finish). Fix the backend and 'coverify resume']`
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** (turnFailures - 1))));
      continue;
    } finally {
      clearInterval(inboxWatcher);
    }
    const contextNow = coordinator.approxTokens();
    // Growth is meaningful only between two ordinary wakes of one session;
    // the baseline was cleared above on rebuild/compaction.
    const growth = prevContextTokens !== undefined ? contextNow - prevContextTokens : undefined;
    prevContextTokens = contextNow;
    growthNote =
      growth !== undefined && growth > GROWTH_NOTE_TOKENS
        ? `\nNote: your context grew ~${Math.round(growth / 1000)}k tokens last wake ` +
          `(now ~${Math.round(contextNow / 1000)}k of the ${Math.round(
            COORDINATOR_CONTEXT_TOKENS / 1000,
          )}k cap). If much of that was wholesale file reads, prefer grep or read with ` +
          "offset/limit — re-reads are cheap, residency is not."
        : "";
    // A LEAF record: what this wake cost, not a running total. Deltas sum;
    // snapshots need reset-detection, and that heuristic split one campaign
    // into 18 epochs against 15 real sessions and overstated fresh input by
    // 16.7M tokens.
    const sessionTotal = coordinator.usage();
    const spent = sessionTotal && subUsage(sessionTotal, prevCoord.usage);
    // Attempts are cumulative per session like usage, so they are deltaed too.
    const attemptsNow = coordinator.attempts?.() ?? 0;
    const attempts = attemptsNow - prevCoord.attempts;
    // Requests is cumulative too; journalling it raw beside a delta inverted
    // `attempts < requests` on every wake after the first and inflated sums
    // quadratically. The clamp is a backstop only — pi's storage is append-only
    // and compaction appends rather than dropping superseded messages.
    const requestsNow = coordinator.requests?.() ?? 0;
    const requests = Math.max(0, requestsNow - prevCoord.requests);
    prevCoord = { usage: sessionTotal, attempts: attemptsNow, requests: requestsNow };
    store.event({
      kind: "usage",
      role: "coordinator",
      sessionId: coordinatorSessionId(),
      wake: wakeCount,
      modelSpec: specKey(coordinatorSpec),
      // Tokens only when the turn's own span did not leaf them: with a sink
      // installed this record is the wake's context gauge and a join key, never
      // a second copy of what the wake spent.
      ...spendFields({ usage: spent, attempts, requests }),
      approxContextTokens: contextNow,
      ...defined({ contextGrowthTokens: growth }),
    });
    lostNote = "";

    archiveLedgerHistory(store, dir, wakeCount);

    if (declaration) {
      // Anything that settled during the rest of the turn (including agents
      // left running under supervision) is persisted before the process ends.
      const finalHarvest = harvestSettled();
      store.event({
        kind: "note",
        note: `declared ${declaration.state}: ${declaration.reason}`,
        ...(finalHarvest.total > 0 ? { harvested: finalHarvest.total } : {}),
      });
      return (
        `${lastWakeText}\n\n[coverify: campaign ${declaration.state} — ${declaration.reason}` +
        (finalHarvest.total > 0 ? `; ${finalHarvest.total} late report(s) saved to EVIDENCE` : "") +
        `]`
      );
    }
    if (handles.size === 0 && settledQueue.length === 0) {
      noopWakes = activityThisWake === 0 ? noopWakes + 1 : 0;
      if (noopWakes >= NOOP_WAKE_PAUSE) {
        store.event({
          kind: "note",
          note: `harness safety pause after ${NOOP_WAKE_PAUSE} no-op wakes; campaign remains authorized`,
        });
        return `${lastWakeText}\n\n[coverify: harness safety pause after ${NOOP_WAKE_PAUSE} idle wakes — the campaign remains authorized and incomplete; resume with 'coverify resume']`;
      }
      continue;
    } else {
      noopWakes = 0;
    }
    if (handles.size > 0 && settledQueue.length === 0) {
      // Settled, not raw: one transient API error in any live agent would
      // reject the race and kill the whole campaign. registerHandle already
      // turns a rejection into a failure report.
      //
      // The inbox is raced too, or `coverify say` waits for the next agent
      // completion — hours, with multi-hour reasoners live — while the CLI has
      // already reported the message as queued.
      const pending = peekUserMessages(dir).length;
      let stopPolling = () => {};
      const inboxArrival = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (peekUserMessages(dir).length > pending) {
            clearInterval(timer);
            resolve();
          }
        }, 1000);
        stopPolling = () => {
          clearInterval(timer);
          resolve();
        };
      });
      await Promise.race([...[...handles.values()].map((h) => h.settled), inboxArrival]);
      stopPolling();
    }
  }
}


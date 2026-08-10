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
  GateStore,
  statementHash,
} from "./gates.js";
import { requestVerificationTool } from "./cadence.js";
import { coordinatorTools } from "./coordinator-tools.js";
import { archiveLedgerHistory, recordRunConfig, wakeBookkeeping } from "./observe.js";
import { loadLauncherContract } from "./launcher.js";
import { CHARGES } from "./roles.js";
import {
  buildModels,
  createHarnessRoleSession,
  roleModelSpec,
  specKey,
  subUsage,
  type RoleSession,
  type RoleUsage,
} from "./providers.js";
import { type WriteScope } from "./sandbox.js";

export interface CampaignOptions {
  campaignDir: string;
  /** User-set limit only; the launcher forbids a fixed harness ceiling. */
  userAgentLimit?: number;
  /** Stop waking the coordinator after this many wakes (user runtime limit). */
  maxWakes?: number;
  /** User-set reasoning-only policy: refuse every technician dispatch, so no
   *  code is written or run anywhere in the campaign (Chao, 2026-08-08). */
  noComputation?: boolean;
}

export interface Handle {
  id: string;
  /** What this handle is. The user's --agent-limit caps workers only, and the
   *  wave gate counts workers on a mechanism — both were previously decided by
   *  string prefixes on the id and a `gate:` prefix stuffed into `mechanism`,
   *  so a change of id spelling would have silently moved a launcher limit. */
  kind: "worker" | "gate" | "verification";
  mechanism: string;
  promise: Promise<string>;
  /** The work's session, when it runs as one (workers; the coordinator is
   *  held separately; a verification cadence has none). What the session can
   *  do — steered mid-flight, or only stopped — is its explicit
   *  `capabilities` flag, not the presence of this field. */
  session?: RoleSession;
  /** Stop this work, whatever substrate runs it: abort a session, kill a
   *  spawned child, or make a composite cadence notice it was cancelled.
   *  Idempotent; safe to call on work that has already finished. */
  stop?: () => void;
  /** Provider- or CLI-reported usage, read at completion (undefined when the
   *  backend reported none). */
  usage?: () => RoleUsage | undefined;
  /** Request-level counts; see RoleSession.attempts. */
  attempts?: () => number;
  requests?: () => number;
  /** Tool-spawned provider calls with no measurable usage; see RoleSession. */
  unmetered?: () => { lane: string; detail: string }[];
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

/** Coordinator context cap (approx tokens). The coordinator stays resident
 *  across wakes — matching how the skill runs in a live harness session —
 *  until this cap, at which point the session compacts in place (the
 *  launcher's anticipated "context compaction", summary subordinated to the
 *  ledgers, restart-rule reread in the next wake message); kill-and-rebuild
 *  via the restart rule remains the fallback when compaction is unavailable
 *  or fails. Mechanics: the cap changes cost, not semantics, because
 *  every decision must be externalized to the ledgers regardless. */
const COORDINATOR_CONTEXT_TOKENS = Number(process.env.COVERIFY_COORDINATOR_CONTEXT_TOKENS ?? 300_000);

/**
 * The harness event loop — the only persistent process. Completions wake the
 * resident coordinator session (compacted in place at its context cap, with
 * ledger rebuild as the fallback); there is no polling.
 */
export async function runCampaign(opts: CampaignOptions): Promise<string> {
  const dir = path.resolve(opts.campaignDir);
  // Held for the whole run and released on every exit path, including the
  // throwing ones — this is exactly the shape of obligation that produced
  // three lost-report bugs when it was left to each return statement.
  const release = acquireCampaignLock(dir);
  try {
    return await runLockedCampaign(opts, dir);
  } finally {
    release();
  }
}

async function runLockedCampaign(opts: CampaignOptions, dir: string): Promise<string> {
  const contract = loadLauncherContract();
  const models = await buildModels();
  const store = new GateStore(dir);
  // Set before ANY record is written — the guidance import below and the
  // statement freeze both append, and the reading rule this enables ("no runId
  // means the record predates 2026-08-09") is corrupted by present-day writers
  // that also write unstamped.
  const runId = randomUUID().slice(0, 8);
  store.setRunId(runId);

  // One-time import: standing user guidance recorded before the event-log
  // unification (2026-08-07) lives only in the in-tree journal. Adopt it into
  // the authoritative log once, marked as imported — the journal is the
  // lower-trust surface, and the marker keeps that provenance on the record
  // forever. The closing marker also makes the import idempotent.
  if (!store.all().some((e) => e.kind === "note" && e.journalGuidanceImport === true)) {
    for (const e of readJournal(dir) as unknown as Record<string, unknown>[]) {
      const note = typeof e.note === "string" ? e.note : "";
      if (note.startsWith("user message: ") || note.startsWith("user message steered mid-turn: ")) {
        store.event({ kind: "note", note, journalGuidanceImport: true, originalTs: e.ts });
      }
    }
    store.event({ kind: "note", note: "journal guidance import complete", journalGuidanceImport: true });
  }

  // Run-config stamp: attributes this run to an exact (harness, contract,
  // policy, runtime) tuple — see observe.ts.
  // One id per harness process, stamped on every usage event. Coordinator
  // usage is CUMULATIVE per session, and the only previous way to find an
  // epoch boundary was to watch the counter go backwards — an inference that
  // over-split one campaign into 18 epochs against 15 real sessions and
  // overstated its fresh input by 16.7M tokens. Short and human-typeable: it
  // appears in operator queries.

  // One resolution per run; every record naming the coordinator model spells
  // it from this, so the run-config stamp and the usage events join.
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
    // Canonical on-disk case: gate records (prior FAIL, bundle-cert FAIL,
    // promotion) key on this string, and darwin opens `Cand.md` and `cand.md`
    // as one file — without this, retyping the case would look like a new
    // revision and slip past anti-verdict-shopping.
    if (fs.existsSync(resolved)) resolved = fs.realpathSync.native(resolved);
    if (!resolved.startsWith(root + path.sep)) return undefined;
    return path.relative(root, resolved);
  };

  const liveOnMechanism = (mechanism: string): number =>
    [...handles.values()].filter((h) => h.kind === "worker" && h.mechanism === mechanism).length;

  // The user's --agent-limit caps concurrent WORKERS (reasoners r*, technicians
  // t*). Judges — gate critics g* and verification cadences v* — are also
  // handles but must not consume the workers' budget: ten pending verdicts
  // should never block a dispatch.
  const liveWorkers = (): number =>
    [...handles.values()].filter((h) => h.kind === "worker").length;

  const sessionsRoot = path.join(dir, ".coverify", "sessions");

  /** Registers a settled-queue handle: the one async pattern every dispatch
   *  shares. The work arrives as a promise or a thunk; a thunk is started
   *  only after the handle is in `handles`, so work with a synchronous
   *  prefix (a fully carried-forward verification cadence) can never observe
   *  its own id as missing and spuriously self-cancel. Already-running
   *  promises register as before. */
  const registerHandle = (
    h: Omit<Handle, "settled" | "promise"> & { promise: Promise<string> | (() => Promise<string>) },
  ) => {
    const handle = h as unknown as Handle;
    // Durability happens here, at the moment work settles — not later, when
    // some exit path remembers to harvest. Three separate bugs (pause, the
    // wake-limit exit, the declaration return) each lost an hour of an agent's
    // work because the report lived only in this queue until harvested; with
    // the write at settle time that class cannot recur, and the queue carries
    // nothing but a pointer to bytes already on disk.
    //
    // Failure is classified here too — a rejected call or empty final text is
    // an infrastructure failure — so `failed` is the single source of truth
    // and `failed` set ⟺ no report artifact exists.
    const persist = (report: string, failed?: string, partialText?: string) => {
      const live = handles.has(handle.id);
      if (failed !== undefined) {
        // Preserve whatever the dead stream had produced. It is NOT a
        // deliverable — the completion stays an infrastructure failure, the
        // assignment stays unfinished, and redispatch stays legitimate —
        // but half an hour of reasoning is worth more on disk than in a
        // dropped socket, and the coordinator can mine it when redispatching.
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
          ...(partial !== undefined ? { partial } : {}),
          usage: handle.usage?.(),
        });
        if (live) settledQueue.push({ h: handle, failed });
        return;
      }
      const reportPath = newEvidencePath(dir, `${handle.id}/report`);
      fs.writeFileSync(reportPath, report);
      const rel = path.relative(dir, reportPath);
      if (live) {
        // Hash-bound like every other trusted artifact: delivery re-reads the
        // file from an in-tree path a coordinator's write scope can touch, so
        // the bytes delivered must be provably the bytes the worker returned.
        store.append({
          kind: "completion",
          id: handle.id,
          report: rel,
          reportSha256: sha256Text(report),
          usage: handle.usage?.(),
        });
        settledQueue.push({ h: handle, failed: undefined });
      } else {
        // Cancelled while running: its completion is already recorded, so this
        // is journaled as a late artifact rather than a second completion —
        // the work is kept, the accounting is not double-counted, and it never
        // resurfaces to the coordinator as a new report.
        store.event({ kind: "note", note: `late report after cancellation`, id: handle.id, report: rel });
      }
    };
    handles.set(handle.id, handle);
    handle.promise = typeof h.promise === "function" ? h.promise() : h.promise;
    handle.settled = handle.promise.then(
      (report) =>
        persist(report, report.trim() === "" ? "empty report (no final text returned)" : undefined),
      (err: unknown) => {
        let failure = String(err);
        // Name the real cause of a mid-run window overflow: the SESSION grew
        // past the model context (accumulated tool results + reasoning), not
        // the packet. Without this the coordinator's natural response is
        // packet-splitting, which measurably does not help (issue #22:
        // r181/r185 — the minimal split retry died the same way).
        if (/context window|context length|maximum context/i.test(failure)) {
          failure +=
            " [harness diagnosis: the worker's session outgrew the model window mid-run — " +
            "accumulated reads and reasoning, not packet size. Packet-splitting will not help. " +
            "Redispatch with a tighter exploration scope: name the exact files to read.]";
        }
        persist("", failure, (err as { partialText?: string })?.partialText);
      },
    );
    activityThisWake++;
  };

  /**
   * Drain every settled handle: persist its report (or its infrastructure
   * failure) and journal the completion. A report exists only in memory until
   * it is harvested, so every path that empties the queue must come through
   * here — dropping it instead destroys finished work.
   */
  const harvestSettled = (): { total: number; failed: number } => {
    const settled = settledQueue.splice(0, settledQueue.length);
    for (const s of settled) handles.delete(s.h.id);
    // Counts only. The wake's report text is rendered from the durable record
    // by undeliveredCompletions() — this used to render a second copy that no
    // caller read, an invitation for the two to drift.
    return {
      total: settled.length,
      failed: settled.filter((s) => s.failed !== undefined).length,
    };
  };

  /**
   * Completions the coordinator has not been shown yet.
   *
   * Persistence and delivery are separate obligations: a report is written the
   * moment it settles, but if the wake that would show it throws (a provider
   * error) or the run ends at its wake limit, the in-memory sections are gone
   * and the completion record already excludes it from the lost-work list — so
   * no coordinator would ever see it, in this run or any later one. Delivery is
   * therefore recorded too, and anything unmarked is re-offered, including
   * across restarts.
   */
  /**
   * Every user directive delivered so far, oldest first.
   *
   * A delivered `coverify say` used to live only in the coordinator's
   * conversation: the resume bundle has no user channel and the compaction
   * preserve-list names ledgers, so "never spend on route B" silently stopped
   * applying at the next rebuild while the campaign ran on. Directives are
   * journaled on delivery, so they can simply be replayed.
   */
  const standingGuidance = (): string[] => {
    const out: string[] = [];
    for (const e of store.all()) {
      const note = typeof e.note === "string" ? e.note : "";
      if (note.startsWith("user message: ")) out.push(note.slice("user message: ".length));
      else if (note.startsWith("user message steered mid-turn: ")) {
        out.push(note.slice("user message steered mid-turn: ".length));
      }
    }
    return out.slice(-20);
  };

  const undeliveredCompletions = (): { id: string; mechanism: string; section: string }[] => {
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

  // Reading discipline for a coordinator whose context was just built or
  // compacted. Measured on the 2026-08-01 lin3cut campaign (issue #17): a
  // rebuilt coordinator voluntarily re-read PROVED.md, FAILED.md, and old
  // candidates wholesale — 143–208k tokens of onboarding against a ~5k
  // bundle — which is why only ~3 wakes fit per context window. The restart
  // clause already scopes the reread; this note makes the scope explicit at
  // the moment of temptation. Mechanics: it forbids nothing.
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
  // Baseline for the per-wake delta. A rebuilt session starts a new cumulative
  // series, so this resets with it — the one place the epoch boundary is now
  // used, and it is known here rather than inferred at read time.
  let prevCoordUsage: RoleUsage | undefined;
  let prevCoordAttempts = 0;
  // Per-wake context growth, surfaced when large (issue #17): the measured
  // campaign grew 29–55k tokens per wake, ~90% of it the coordinator's own
  // reads and output, invisible to the coordinator itself. Telemetry plus a
  // note — never a refusal.
  const GROWTH_NOTE_TOKENS = Number(process.env.COVERIFY_WAKE_GROWTH_NOTE_TOKENS ?? 40_000);
  let prevContextTokens: number | undefined;
  let growthNote = "";
  while (true) {
    wakeCount++;
    if (opts.maxWakes !== undefined && wakeCount > opts.maxWakes) {
      // Harvest before returning: what unblocked this loop is usually an agent
      // finishing, and its report lives only in the queue until persisted.
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
    // Harvest first: the digest and the live-agent limits must describe the
    // world the coordinator is about to act in, not the one before completions
    // landed — otherwise a finished agent is reported as still running in the
    // same message that delivers its report.
    const harvested = harvestSettled();
    // Delivered from the record, not from the queue: a report the previous
    // wake failed to show is still pending here.
    const pending = undeliveredCompletions();
    const reportSections = pending.map((p) => p.section);
    const limits: string[] = [];
    if (opts.userAgentLimit !== undefined) limits.push(`workers ${liveWorkers()}/${opts.userAgentLimit}`);
    if (opts.maxWakes !== undefined) limits.push(`wakes ${wakeCount}/${opts.maxWakes}`);
    // Mechanical fact only (allocation judgment stays the coordinator's):
    // idle worker capacity alongside live judges is easy to overlook from
    // inside a wake, and stated plainly it lets the coordinator decide
    // whether waiting is deliberate (skill-feedback 2026-08-09).
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
    // Bookkeeping the harness can check, so the coordinator does not have to
    // remember it (observe.ts): dangling citations, contradicted or edited
    // promotions, refused work nothing followed up.
    const bookkeeping = wakeBookkeeping(store, dir);
    const idleNudge =
      handles.size === 0 && reportSections.length === 0 && wakeCount > 1
        ? "\nNothing is live and no new reports arrived. Per the contract the campaign remains " +
          "authorized: dispatch the next materially new fan-out, or explicitly declare_campaign_state."
        : "";
    // Resident coordinator: at the context cap the session compacts in
    // place; rebuild happens only at start, on compaction failure, or after
    // a failed coordinator turn (the launcher's restart rule is the rebuild).
    let justCompacted = false;
    if (coordinator && coordinator.approxTokens() > COORDINATOR_CONTEXT_TOKENS) {
      if (coordinator.compact) {
        // Redesign phase 2: real in-place compaction (the launcher's
        // anticipated "context compaction") instead of session kill+rebuild.
        // The reread rule fires in the next wake message; the summary is
        // explicitly subordinated to the ledgers.
        store.event({
          kind: "note",
          note: `coordinator context cap (${COORDINATOR_CONTEXT_TOKENS} tok) reached; compacting (restart rule applies)`,
        });
        try {
          await coordinator.compact(
            "The campaign ledgers (STATEMENT.md, CURRENT_FRONTIER.md, REGISTRY.md, FAILED.md, " +
              "PROVED.md, PROCESS_LESSONS.md) are the durable state and remain authoritative; this " +
              "summary is soft context only and must never be cited over them. Preserve precisely: " +
              "live agent assignments and their mechanisms, the verification queue state, dispatch " +
              "decisions not yet externalized, and open questions from the newest reports.",
          );
          justCompacted = true;
        } catch (e) {
          // Compaction is a real LLM call and can fail (quota, provider);
          // the campaign must not die with workers live — fall back to the
          // infallible restart-rule rebuild (review 2026-08-02).
          // The failed summarization call was already billed, and the session
          // holding its cost is about to be discarded. Leaf it first.
          const preRebuild = coordinator?.usage();
          if (preRebuild) {
            store.event({
              kind: "usage",
              role: "coordinator",
              sessionId: `coordinator-${coordinatorEpoch}`,
              wake: wakeCount,
              compactionFailed: true,
              modelSpec: specKey(coordinatorSpec),
              usage: subUsage(preRebuild, prevCoordUsage),
            });
          }
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
      prevCoordUsage = undefined;
      prevCoordAttempts = 0;
      coordinator = await createHarnessRoleSession(
        {
          contract,
          charge: CHARGES.coordinator,
          workspace: { cwd: dir, scope: coordinatorScope },
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
          // Epoch-numbered per rebuild; the JSONL filename adds a
          // timestamp, so restarts never collide.
          sessionId: `coordinator-${coordinatorEpoch}`,
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
    // The contract's restart rule, applied at the compaction boundary: the
    // summary is soft context; the ledgers are what the coordinator re-reads.
    // Post-compaction the contract's reread is SUPPLIED, not merely
    // instructed — the same resume bundle a rebuilt coordinator gets, so the
    // compaction branch enforces the identical clause (review 2026-08-02).
    // Replayed on any prompt that rebuilds context (first wake of a run, and
    // after an in-place compaction): standing guidance is not re-sent on an
    // ordinary continuing wake, where the coordinator already has it.
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
    // User messages (coverify say): delivered verbatim at the wake boundary —
    // the headless analog of the user typing to an interactive skill session.
    // Consumed only after the coordinator's turn succeeds; a failed turn
    // leaves them queued for the next wake.
    const userMessages = peekUserMessages(dir);
    const userBlock =
      userMessages.length > 0
        ? `\n\n# Messages from the user (verbatim)\n\n${userMessages.join("\n\n---\n\n")}\n\n` +
          "These are user guidance, not a statement amendment: STATEMENT.md changes still " +
          "require 'coverify amend'."
        : "";
    // Mid-turn steer: messages queued while the coordinator's turn runs are
    // injected live via session steer instead of waiting a wake. The inbox is
    // FIFO and append-only, so mid-turn arrivals are exactly the entries past
    // the wake batch plus what this watcher already steered; delivery order
    // is preserved by steering them in sequence. At-least-once: a steered
    // message is consumed only if the turn succeeds — a failed turn loses the
    // steered content with the session, so it redelivers at the next wake.
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
            store.event({ kind: "note", note: `user message steered mid-turn: ${m}` });
          }
        } catch {
          /* transport only; never break the campaign */
        } finally {
          watcherBusy = false;
        }
      })();
    }, 1000);
    try {
      lastWakeText = await coordinator.ask(
        fresh
          ? `${resumeBundle(dir)}${readingDiscipline}${guidanceBlock}\n\n---\n\nCampaign directory: ${dir}\n${lostNote}${digest}${bookkeeping}${idleNudge}\n\n${newsBlock}${userBlock}`
          : `${rereadBlock}${guidanceBlock}${lostNote}${digest}${bookkeeping}${idleNudge}${compactionWarning}${growthNote}\n\n${newsBlock}${userBlock}`,
      );
      for (const m of userMessages) store.event({ kind: "note", note: `user message: ${m}` });
      consumeUserMessages(dir, userMessages.length + steeredCount);
      if (pending.length > 0) store.append({ kind: "delivery", ids: pending.map((p) => p.id) });
    } catch (e) {
      // A hard provider failure on the coordinator's turn must not kill the
      // campaign with workers live: journal it and rebuild from the ledgers
      // (the restart rule is already the recovery path). But a *persistent*
      // failure — expired token, retired model id, quota exhausted — fails in
      // milliseconds, so retrying immediately spins: measured 2610 rebuilds a
      // second, one session tree each, while the campaign silently does
      // nothing. Back off, and give up into a pause rather than burn a
      // bounded run's whole wake budget on one broken credential.
      turnFailures++;
      store.event({
        kind: "note",
        note: `coordinator turn failed (${String(e).slice(0, 200)}); rebuilding via restart rule`,
        consecutiveFailures: turnFailures,
      });
      // A failed turn still spent tokens — the call itself plus every
      // retryAssistantCall attempt. Journal them before the session is
      // discarded, or "coordinator records sum like every other role's" holds
      // only for wakes that happened to succeed.
      const failedTotal = coordinator?.usage();
      if (failedTotal) {
        store.event({
          kind: "usage",
          role: "coordinator",
          sessionId: `coordinator-${coordinatorEpoch}`,
          wake: wakeCount,
          turnFailed: true,
          modelSpec: specKey(coordinatorSpec),
          usage: subUsage(failedTotal, prevCoordUsage),
        });
      }
      coordinator = undefined;
      prevCoordUsage = undefined; // the next turn rebuilds; a new series starts
      prevCoordAttempts = 0;
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
    // A LEAF record, like every other role's: what this wake cost, not a
    // running total. The session total was the only derived aggregate in the
    // coordinator lane, and it is why reading this journal used to need
    // reset-detection — a heuristic that split one campaign into 18 epochs
    // against 15 real sessions and overstated its fresh input by 16.7M tokens.
    // Deltas sum; snapshots have to be un-inferred first.
    const sessionTotal = coordinator.usage();
    const spent = sessionTotal && subUsage(sessionTotal, prevCoordUsage);
    prevCoordUsage = sessionTotal;
    // Cumulative per session, exactly like usage, so it is journalled as a
    // delta too. This is the lane where retryAssistantCall actually fires.
    const attemptsNow = coordinator.attempts?.() ?? 0;
    const attempts = attemptsNow - prevCoordAttempts;
    prevCoordAttempts = attemptsNow;
    store.event({
      kind: "usage",
      role: "coordinator",
      sessionId: `coordinator-${coordinatorEpoch}`,
      wake: wakeCount,
      modelSpec: specKey(coordinatorSpec),
      ...defined({ usage: spent, attempts, requests: coordinator.requests?.() }),
      approxContextTokens: contextNow,
      ...(growth !== undefined ? { contextGrowthTokens: growth } : {}),
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
      // Settled, not raw: a rejected promise here (one transient API error in
      // any live agent) would reject the race and kill the whole campaign,
      // including every other live agent. registerHandle already turns a
      // rejection into a failure report.
      //
      // The inbox is raced too. Without it, `coverify say` — the operator's
      // one lever over a running campaign — waits for the next agent
      // completion, which with three multi-hour reasoners live means hours,
      // while the CLI has already reported the message as queued.
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


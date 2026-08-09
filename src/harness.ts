import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  acquireCampaignLock,
  consumeUserMessages,
  gitInRepo,
  newEvidencePath,
  peekUserMessages,
  readJournal,
  promotedStatementsView,
  readLedger,
  resumeBundle,
  sha256File,
  sha256Text,
} from "./campaign.js";
import {
  acceptedStatementHash,
  recordStatement,
  checkPromotion,
  checkDispatch,
  resolvePremises,
  sameRevision,
  GateStore,
  recordGateVerdict,
  statementHash,
  type ReasonerPacket,
  type TechnicianPacket,
} from "./gates.js";
import { requestVerificationTool } from "./cadence.js";
import { archiveLedgerHistory, recordRunConfig, refuse, wakeBookkeeping } from "./observe.js";
import { loadLauncherContract } from "./launcher.js";
import {
  buildModels,
  CHARGES,
  runMemMb,
  runTimeoutMs,
  createCliRoleSession,
  createHarnessRoleSession,
  resolveFamily,
  isCliProvider,
  roleModelSpec,
  runRole,
  type RoleUsage,
  specLabel,
  toolText,
  type RoleSession,
  type WriteScope,
} from "./roles.js";

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

interface Handle {
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
  recordRunConfig(store, {
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
  const settledQueue: { h: Handle; report: string; failed?: string; reportPath?: string }[] = [];
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
    const persist = (report: string, failed?: string) => {
      const live = handles.has(handle.id);
      if (failed !== undefined) {
        store.append({ kind: "completion", id: handle.id, failed, usage: handle.usage?.() });
        if (live) settledQueue.push({ h: handle, report: "", failed });
        return;
      }
      const reportPath = newEvidencePath(dir, `${handle.id}/report`);
      fs.writeFileSync(reportPath, report);
      const rel = path.relative(dir, reportPath);
      if (live) {
        store.append({ kind: "completion", id: handle.id, report: rel, usage: handle.usage?.() });
        settledQueue.push({ h: handle, report, failed: undefined, reportPath: rel });
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
            "Redispatch with a tighter exploration scope: name the exact files to read and " +
            "require an early commitment to one route.]";
        }
        persist("", failure);
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
  const harvestSettled = (): { sections: string[]; total: number; failed: number } => {
    const settled = settledQueue.splice(0, settledQueue.length);
    for (const s of settled) handles.delete(s.h.id);
    // Delivery only: the artifact and its completion record were written when
    // the work settled, so nothing here can be lost by an exit path that skips
    // this call.
    const sections = settled.map((s) =>
      s.failed !== undefined
        ? `## ${s.h.id} [${s.h.mechanism}] FAILED (infrastructure): ${s.failed}\n\n` +
          `No report artifact exists. Per the contract this is never PASS and carries no ` +
          `mathematical content; re-dispatching the assignment is legitimate.`
        : `## ${s.h.id} [${s.h.mechanism}] (saved: ${s.reportPath})\n\n${s.report}`,
    );
    return {
      sections,
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
            `No report artifact exists. Per the contract this is never PASS and carries no ` +
            `mathematical content; re-dispatching the assignment is legitimate.`,
        });
        continue;
      }
      if (typeof e.report !== "string") continue;
      const p = path.join(dir, e.report);
      if (!fs.existsSync(p)) continue;
      out.push({
        id: e.id,
        mechanism,
        section: `## ${e.id} [${mechanism}] (saved: ${e.report})\n\n${fs.readFileSync(p, "utf-8")}`,
      });
    }
    return out;
  };

  const PACKET_PARAMS = {
    mechanism: Type.String({ description: "Mechanism identifier for the registry" }),
    task: Type.String({ description: "Exact task" }),
    context: Type.String({ description: "Constraints, promoted premises, nearest failed boundary" }),
    deliverable: Type.String({ description: "The finite mathematical deliverable" }),
    failedCheck: Type.String({
      description:
        "'no close prior route' or 'closest prior route is X; this differs materially because ...'",
    }),
  };

  /** Shared dispatch path for the two agent roles the coordinator authors. */
  const dispatchAgent = async (
    role: "reasoner" | "technician",
    packet: ReasonerPacket | TechnicianPacket,
  ) => {
    // "cease dispatch": once the campaign is declared, new work would run in a
    // process that is about to return, and its report would be discarded.
    if (declaration) {
      return toolText(
        `DISPATCH REFUSED: the campaign is already declared ${declaration.state}; the contract says ` +
          "cease dispatch. Checkpoint the ledgers and finish this turn.",
      );
    }
    if (role === "technician" && opts.noComputation) {
      return refuse(
        store,
        "dispatch",
        "this campaign is reasoning-only by user policy (--no-computation): no code is written " +
          "or run; carry finite checks by hand inside reasoner proofs or record them as stated " +
          "obligations",
        { mechanism: packet.mechanism, role },
      );
    }
    const decision = checkDispatch(
      store,
      role,
      packet,
      opts.userAgentLimit,
      liveWorkers(),
      liveOnMechanism(packet.mechanism),
    );
    if (!decision.allowed) {
      return refuse(store, "dispatch", decision.reason ?? "", { mechanism: packet.mechanism, role });
    }
    let spec = roleModelSpec(role);
    // Ideation families: a reasoner may be routed to a different model
    // family for decorrelated proposals — same charge, same gates. Refused
    // with guidance (not errored) when the family has no usable auth, so a
    // coordinator can fall back to a default dispatch in the same turn.
    const family =
      role === "reasoner" ? (packet as ReasonerPacket).family : undefined;
    if (family !== undefined) {
      // A family-routed reasoner is a toolless single-shot CLI consult: it
      // cannot hold the librarian, so granting a literature question would
      // render a "(granted)" prompt for a tool that does not exist.
      if ((packet as ReasonerPacket).literature !== undefined) {
        return refuse(
          store,
          "dispatch",
          "family-routed reasoners are toolless single-shot consults and cannot carry a " +
            "literature grant — dispatch the literature scout without the family field, or " +
            "drop the literature field from this packet",
          { mechanism: packet.mechanism, role },
        );
      }
      const resolved = await resolveFamily(models, family);
      if ("reason" in resolved) {
        return refuse(store, "dispatch", resolved.reason, { mechanism: packet.mechanism, role });
      }
      spec = resolved.spec;
    }
    const isTechnician = role === "technician";
    if (isTechnician && isCliProvider(spec.provider)) {
      const reason =
        "the configured technician backend is a tool-less CLI oracle; a computation packet needs " +
        "a tool-running backend";
      return refuse(store, "dispatch", reason, { mechanism: packet.mechanism, role });
    }
    const id = `${isTechnician ? "t" : "r"}${String(nextId++).padStart(3, "0")}`;
    const evidenceDir = path.join(dir, "EVIDENCE", id);
    fs.mkdirSync(evidenceDir, { recursive: true });
    // Role-authoritative, read once: tool schemas allow unknown extras, so a
    // `literature` field smuggled onto a technician packet must neither reach
    // the prompt nor grant the librarian.
    const literature = role === "reasoner" ? (packet as ReasonerPacket).literature : undefined;
    store.append({
      kind: "dispatch",
      id,
      role,
      mechanism: packet.mechanism,
      task: packet.task,
      deliverable: packet.deliverable,
      context: packet.context,
      failedCheck: packet.failedCheck,
      ...(family !== undefined ? { family, model: specLabel(spec) } : {}),
      computation: isTechnician ? (packet as TechnicianPacket).computation : undefined,
      literature: literature ? (packet as ReasonerPacket).literature : undefined,
      evidenceDir: path.relative(dir, evidenceDir),
      modelFamily: specLabel(spec),
    });
    const packetPrompt =
      `# Task\n\n${packet.task}\n\n# Deliverable\n\n${packet.deliverable}\n\n# Context\n\n${packet.context}` +
      (isTechnician
        ? `\n\n# Preregistered computation\n\n${(packet as TechnicianPacket).computation}`
        : "") +
      (literature ? `\n\n# Literature question (granted)\n\n${literature}` : "");
    // One dispatch path: every worker is a RoleSession asked for its packet.
    // A CLI backend yields a degenerate session (one deep attempt, no tools,
    // the reply IS the deliverable — created synchronously); an API provider
    // gets a durable pi AgentHarness session with a JSONL transcript under
    // .coverify/sessions/ (crash-survivable, prompt_cache_key = the handle
    // id), created asynchronously — the handle's promise chains behind it so
    // dispatch stays synchronous for the coordinator.
    let session: RoleSession | undefined;
    const sessionPromise: Promise<RoleSession> = isCliProvider(spec.provider)
      ? Promise.resolve(
          createCliRoleSession({
            contract,
            charge:
              CHARGES.reasoner +
              "\nYou have no tools in this run: produce the deliverable directly and completely in your reply.",
            prompt: packetPrompt,
            spec,
            models,
          }),
        )
      : createHarnessRoleSession(
          {
            contract,
            charge: isTechnician
              ? CHARGES.technician
              : family !== undefined
                ? CHARGES.reasonerToolless
                : CHARGES.reasoner,
            workspace: {
              cwd: evidenceDir,
              scope: { allow: [evidenceDir], deny: [] },
              code: isTechnician,
              literature: literature !== undefined,
            },
            spec,
            models,
          },
          // cwd is the campaign dir for every session: JsonlSessionRepo groups
          // by cwd-encoded subdirectory, and one-directory-per-worker keyed on
          // absolute evidence paths was pure junk layout (review 2026-08-02).
          { sessionId: id, sessionsRoot, cwd: dir },
        );
    void sessionPromise.then((s) => {
      session = s;
      // The handle may register before the async session resolves; patch it
      // in place so steer/cancel/turns-dump see the live session.
      const h = handles.get(id);
      if (h) h.session = s;
    });
    const promise = sessionPromise.then((live) => {
      // Cancelled while the session was being created: don't launch the
      // turn at all — nothing could stop it and the report would be dropped.
      if (!handles.has(id)) return "";
      // A tooled session gets its evidence directory; a toolless oracle has
      // nowhere to write, so the line would be a false affordance.
      const opening = live.capabilities.steerable
        ? `Assigned evidence directory: ${evidenceDir}\n\n${packetPrompt}`
        : packetPrompt;
      return live.ask(opening).then(
        // Salvage nudge: deep-reasoning runs sometimes end without emitting a
        // final message (observed live 2026-08-02: four @max scouts, ~2.6M
        // tokens, empty final text). The session context is intact at this
        // point, so ask once for the report before the settle-side classifier
        // writes the run off as an infrastructure failure. Only a multi-turn
        // session can be nudged — a CLI oracle answers exactly once.
        (text) =>
          // No salvage for a cancelled handle (abort resolves empty by
          // design) — a nudge there is a full-context turn nobody reads.
          text.trim() !== "" || !handles.has(id) || !live.capabilities.steerable
            ? text
            : live.ask(
                "Your previous turn ended with no final message. Emit your complete " +
                  "conclusion-first report now, per your charge.",
              ),
      );
    });
    registerHandle({
      id,
      kind: "worker",
      // One verb for both substrates: a pi session aborts, a spawned CLI is
      // killed — session.abort() means whichever its substrate does. Before
      // the async session resolves, cancellation is the handles.has(id)
      // check above: the turn never launches.
      stop: () => session?.abort(),
      mechanism: packet.mechanism,
      promise,
      session,
      usage: () => session?.usage(),
    });
    return toolText(
      `dispatched ${id} (${handles.size} live). The report will arrive at a later wake.` +
        (isTechnician
          ? `\nREGISTRY.md launch record: id ${id}; workload ${evidenceDir}; ` +
            `limits ${Math.round(runTimeoutMs() / 60000)} min / ${runMemMb()} MB per batch; ` +
            `outputs + logs under ${path.relative(dir, evidenceDir)}/; cancel with cancel_agent ${id}.`
          : "") +
        (decision.warning ? `\n${decision.warning}` : ""),
    );
  };

  const dispatchReasoner: AgentTool = {
    name: "dispatch_reasoner",
    label: "Dispatch reasoner",
    description:
      "Dispatch a fresh minimal-context reasoning agent on one packet with one finite mathematical " +
      "deliverable: prove, construct, refute — prose tools only, no code, no execution. Returns a " +
      "handle id immediately; the report arrives at a later wake. The packet must include the " +
      "FAILED.md check record.",
    parameters: Type.Object({
      ...PACKET_PARAMS,
      family: Type.Optional(
        Type.String({
          description:
            'Optional ideation family: "fable" (Anthropic), "gemini" (Google), or "pro" ' +
            "(ChatGPT gpt-5.6-pro consult — single-shot and TOOLLESS: the packet must inline " +
            "everything the worker needs; a router-downgraded reply is discarded as no useful " +
            "response, so a failed consult costs nothing but time). Routes this one reasoner to " +
            "a different model family for decorrelated proposals — same charge, same gate " +
            "discipline. Omit for the default model. Refused with guidance if the family has no " +
            "usable auth on this host.",
        }),
      ),
      literature: Type.Optional(
        Type.String({
          description:
            "Only for a literature scout: the literature question. Grants a delegated librarian " +
            "search tool (external web-searching agent; reports archived as evidence).",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => dispatchAgent("reasoner", params as ReasonerPacket),
  } as AgentTool;

  const dispatchTechnician: AgentTool = {
    name: "dispatch_technician",
    label: "Dispatch technician",
    description:
      "Dispatch a computation technician on one preregistered computation: it writes and runs code " +
      "strictly to execute the declared finite search and reports raw outputs; it does no proof " +
      "work. Returns a handle id immediately; the report arrives at a later wake.",
    parameters: Type.Object({
      ...PACKET_PARAMS,
      computation: Type.String({
        description:
          "The preregistered finite domain, stopping rule, and expected witness/certificate/table, " +
          "with concrete bounds.",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) =>
      dispatchAgent("technician", params as TechnicianPacket),
  } as AgentTool;

  const dispatchGateCritic: AgentTool = {
    name: "dispatch_gate_critic",
    label: "Idea gate",
    description:
      "Run a fresh idea-gate critic on one mechanism before investing workers in it. Give only " +
      "the frozen target, promoted premises, the mechanism, and its claimed first nontrivial " +
      "implication; quote imported premises verbatim with their exact revision identities — the " +
      "critic is toolless and cannot read other campaigns' ledgers. Runs async like a worker: " +
      "returns a handle immediately, verdict at a later wake — gate independent mechanisms " +
      "concurrently rather than one per turn.",
    parameters: Type.Object({
      mechanism: Type.String(),
      firstImplication: Type.String({ description: "The claimed first nontrivial implication" }),
      importedPremises: Type.Optional(
        Type.String({
          description:
            "Promoted premises the mechanism relies on, quoted verbatim with exact revision " +
            "identities (source path + hypotheses) — required when they live outside this " +
            "campaign's PROVED.md. Statements only, and only load-bearing ones: the critic is " +
            "deliberately minimal-context, and exposition or your own reasoning here anchors it " +
            "toward your posterior (the packet is journaled; misquotes are auditable)",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      if (declaration) {
        return toolText(
          `GATE REFUSED: the campaign is already declared ${declaration.state}; cease dispatch and checkpoint.`,
        );
      }
      const p = params as { mechanism: string; firstImplication: string; importedPremises?: string };
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = promotedStatementsView(dir);
      const id = `g${String(nextId++).padStart(3, "0")}`;
      // The full gate packet is recorded (launcher: "Record every gate packet
      // and verdict"), including any coordinator-attested imported premises so
      // a misquote is auditable against the named source revision.
      store.append({
        kind: "dispatch",
        id,
        role: "gate-critic",
        mechanism: p.mechanism,
        task: p.firstImplication,
        importedPremises: p.importedPremises,
      });
      const gateStop = new AbortController();
      const promise = runRole({
        contract,
        charge: CHARGES.gateCritic,
        prompt:
          `# Frozen target\n\n${statement}\n\n# Promoted premises\n\n${proved}` +
          (p.importedPremises
            ? `\n\n# Imported premises (coordinator-supplied verbatim, with revision identities)\n\n${p.importedPremises}`
            : "") +
          `\n\n# Proposed mechanism\n\n${p.mechanism}\n\n# Claimed first nontrivial implication\n\n${p.firstImplication}`,
        spec: roleModelSpec("gateCritic"),
        models,
      }, gateStop.signal).then(({ text, usage: criticUsage, promptChars, durationMs }) => {
        // A cancelled gate must not record a verdict (mirrors verification):
        // an unseen verdict could later unlock concurrent workers nobody reviewed.
        if (!handles.has(id)) return `[gate ${id} cancelled; verdict not recorded]`;
        const verdict = recordGateVerdict(store, p.mechanism, text, criticUsage, { promptChars, durationMs });
        if (verdict === "UNPARSEABLE") {
          return (
            `UNPARSEABLE verdict (recorded as such; does not unlock concurrent workers). The critic's first ` +
            `line was not a verdict token — re-run the gate.\n\n${text}`
          );
        }
        return `${verdict}\n\n${text}`;
      });
      // liveOnMechanism counts workers only, so the mechanism is recorded as
      // itself — a pending gate no longer has to disguise its own subject.
      registerHandle({ id, kind: "gate", mechanism: p.mechanism.slice(0, 60), promise, stop: () => gateStop.abort() });
      return toolText(
        `gate ${id} dispatched (${handles.size} live). The verdict arrives at a later wake; ` +
          `gate other mechanisms or continue ledger work meanwhile.`,
      );
    },
  } as AgentTool;

  const requestVerification = requestVerificationTool({
    dir,
    store,
    contract,
    models,
    evidenceRelative,
    declaration: () => declaration,
    mintVerificationId: () => `v${String(nextId++).padStart(3, "0")}`,
    hasHandle: (id) => handles.has(id),
    liveCount: () => handles.size,
    registerHandle,
  });

  const recordPromotion: AgentTool = {
    name: "record_promotion",
    label: "Record promotion",
    description:
      "The only way to append to PROVED.md. Legal only when both verification stages passed on the " +
      "exact revision and the candidate and STATEMENT.md are byte-identical to what was verified.",
    parameters: Type.Object({
      revision: Type.String({ description: "EVIDENCE-relative candidate filename" }),
      exactStatement: Type.String({ description: "The exact promoted statement" }),
      dependencies: Type.String({ description: "Dependency identities (promoted premises, imports)" }),
      premises: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Revisions of THIS campaign's earlier promotions this result stands on " +
            "(machine-resolvable internal premises; external sources and imported theorems stay " +
            "in the dependencies prose). A later retraction of a premise mechanically enumerates " +
            "this promotion as a dependent.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as {
        revision: string;
        exactStatement: string;
        dependencies: string;
        premises?: string[];
      };
      const rel = evidenceRelative(p.revision);
      if (!rel) return toolText(`revision must be a path inside EVIDENCE/ (got: ${p.revision})`);
      const decision = checkPromotion(store, dir, rel);
      if (!decision.allowed) return refuse(store, "promotion", decision.reason ?? "", { revision: rel });
      const resolved = resolvePremises(store, p.premises ?? []);
      if ("unresolved" in resolved) {
        return refuse(
          store,
          "promotion",
          `premise "${resolved.unresolved}" matches no recorded promotion in this campaign. ` +
            "Premises name earlier promoted revisions exactly; external sources belong in the " +
            "dependencies prose.",
          { revision: rel },
        );
      }
      const premises = resolved.premises;
      const artifacts = store
        .all()
        .filter((e) => sameRevision(e.revision, rel) && typeof e.artifact === "string")
        .map((e) => `${e.kind}: ${e.artifact}`)
        .join("; ");
      // The promoted text is coordinator-authored; the harness cannot check
      // that it is what the candidate proves. Recording the verified
      // revision's content hash at least makes an over-claim auditable
      // against the exact artifact the verifiers saw.
      const verifiedHash = sha256File(path.join(dir, "EVIDENCE", rel));
      const premisesLine =
        premises.length > 0
          ? `**Premises (machine-resolvable):** ${premises
              .map((pr) => `${pr.revision}${pr.candidateHash ? ` (sha256 ${pr.candidateHash})` : ""}`)
              .join("; ")}\n\n`
          : "";
      const entry =
        `\n## ${rel} — promoted ${new Date().toISOString()}\n\n` +
        `**Statement (coordinator-authored):** ${p.exactStatement}\n\n` +
        `**Dependencies:** ${p.dependencies}\n\n` +
        premisesLine +
        `**Verified candidate:** ${rel} (sha256 ${verifiedHash})\n\n` +
        `**Audit artifacts:** ${artifacts}\n`;
      fs.appendFileSync(path.join(dir, "PROVED.md"), entry);
      store.append({
        kind: "promotion",
        revision: rel,
        candidateHash: verifiedHash,
        statement: p.exactStatement,
        // The exact appended entry: lets the wake check that PROVED.md still
        // contains what the events say it does (a skill-session resume can
        // edit the file; retraction relabeling is supposed to).
        entry,
        ...(premises.length > 0 ? { premises: premises.map((pr) => pr.revision) } : {}),
      });
      activityThisWake++;
      return toolText(`Promotion recorded in PROVED.md for ${rel}. Update REGISTRY.md to label it 'promoted'.`);
    },
  } as AgentTool;

  const cancelWorker: AgentTool = {
    name: "cancel_agent",
    label: "Cancel agent",
    description:
      "Interrupt a live agent (reasoner, technician, or verification). Per the contract, only on observable struggle evidence, a user " +
      "pause/stop, a safety issue, or an explicit user-specified deadline — never merely because " +
      "it is slow or quiet.",
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.String({ description: "The observable evidence or authorized trigger" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { id: string; reason: string };
      const handle = handles.get(p.id);
      if (!handle) return toolText(`no live agent ${p.id}`);
      handles.delete(p.id);
      const queued = settledQueue.findIndex((s) => s.h.id === p.id);
      if (queued >= 0) settledQueue.splice(queued, 1);
      handle.stop?.();
      store.append({ kind: "completion", id: p.id, cancelled: true, reason: p.reason });
      activityThisWake++;
      return toolText(`cancelled ${p.id}. Record the route state in the ledgers per the contract.`);
    },
  } as AgentTool;

  const steerWorker: AgentTool = {
    name: "steer_agent",
    label: "Steer agent",
    description:
      "Inject a redirecting message into a live agent without interrupting it. Same contract " +
      "triggers as cancellation: observable struggle evidence, not slowness.",
    parameters: Type.Object({
      id: Type.String(),
      message: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { id: string; message: string };
      const handle = handles.get(p.id);
      if (!handle) return toolText(`no live agent ${p.id}`);
      if (!handle.session || !handle.session.capabilities.steerable) {
        return toolText(
          `${p.id} is not steerable (a CLI oracle answers once and can only be stopped; a ` +
            `verification cadence has no session); cancel or wait`,
        );
      }
      const delivered = await handle.session.steer(p.message);
      if (!delivered) {
        return toolText(
          `${p.id} is idle (its turn just finished); steering dropped — its report arrives at the next wake regardless.`,
        );
      }
      store.event({ kind: "note", note: `steered ${p.id}`, message: p.message });
      return toolText(`steering message delivered to ${p.id} mid-run.`);
    },
  } as AgentTool;

  const declareState: AgentTool = {
    name: "declare_campaign_state",
    label: "Declare campaign state",
    description:
      "Explicitly pause or complete the campaign. Completion requires at least one recorded " +
      "promotion (the contract's completion criterion demands the full cadence on the final result). " +
      "Pause is operational state, not blocked or complete. Both states interrupt live agents and " +
      "cancel their computations (contract: on pause/stop, cease dispatch and interrupt task " +
      "agents); pass continueSupervised to leave them running under supervision instead.",
    parameters: Type.Object({
      state: Type.Union([Type.Literal("pause"), Type.Literal("complete")]),
      reason: Type.String(),
      continueSupervised: Type.Optional(
        Type.Boolean({
          description:
            "Leave live agents running (contract: only when the user explicitly authorized " +
            "continuing under supervision).",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { state: "pause" | "complete"; reason: string; continueSupervised?: boolean };
      if (p.state === "complete" && !store.all().some((e) => e.kind === "promotion")) {
        return toolText(
          "DECLARATION REFUSED: no promotion is on record; the completion criterion requires the " +
            "final result to pass the full cadence (verify, then record_promotion) first.",
        );
      }
      declaration = p;
      // Work that already finished is persisted before anything is
      // interrupted: a report lives only in memory until it is harvested, and
      // an agent that ran for an hour must not lose its result to a pause.
      const harvested = harvestSettled();
      // "cease dispatch, interrupt task agents, cancel task computations
      // unless explicitly authorized to continue under supervision".
      let interrupted = 0;
      if (!p.continueSupervised) {
        for (const [id, handle] of [...handles]) {
          handle.stop?.();
          store.append({ kind: "completion", id, cancelled: true, reason: `campaign ${p.state}` });
          handles.delete(id);
          interrupted++;
        }
      }
      return toolText(
        `Declared: ${p.state}. ` +
          (harvested.total > 0
            ? `${harvested.total} finished report(s) harvested and saved to EVIDENCE first. `
            : "") +
          (p.continueSupervised
            ? `${handles.size} agent(s) left running under supervision. `
            : `${interrupted} live agent(s) interrupted. `) +
          "The harness will stop after this wake; checkpoint the ledgers now.",
      );
    },
  } as AgentTool;

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
          spec: roleModelSpec("coordinator"),
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
      coordinator = undefined;
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
    store.event({
      kind: "usage",
      role: "coordinator",
      cumulative: coordinator.usage(),
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


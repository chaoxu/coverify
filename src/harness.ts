import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  acquireCampaignLock,
  appendJournal,
  consumeUserMessages,
  danglingCitations,
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
  retractionClosure,
  sameRevision,
  GateStore,
  parseFirstLineVerdict,
  recordGateVerdict,
  assertCandidateWithheld,
  statementHash,
  type ReasonerPacket,
  type TechnicianPacket,
} from "./gates.js";
import { loadLauncherContract } from "./launcher.js";
import {
  addUsage,
  buildModels,
  CHARGES,
  RUN_MEM_MB,
  RUN_TIMEOUT_MS,
  createHarnessRoleSession,
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
  /** Present when the work can be redirected mid-flight (a pi session).
   *  A spawned CLI has no such surface — it can be stopped, not steered. */
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

function harnessRevision(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: path.dirname(new URL(import.meta.url).pathname) })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

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

  // Version stamp at every run start: attributes this run to an exact
  // (harness, contract) pair. Harness audit metadata — launcher-permitted.
  appendJournal(dir, {
    kind: "note",
    note: "run-start",
    // Structural marker: trace epoch-caps open dispatches on this, so it must
    // not depend on the prose note's exact wording.
    runStart: true,
    harnessRev: harnessRevision(),
    launcherSha256: sha256Text(contract),
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

  /** Registers a settled-queue handle: the one async pattern every dispatch shares. */
  const registerHandle = (h: Omit<Handle, "settled">) => {
    const handle = h as Handle;
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
        appendJournal(dir, { kind: "note", note: `late report after cancellation`, id: handle.id, report: rel });
      }
    };
    handle.settled = handle.promise.then(
      (report) =>
        persist(report, report.trim() === "" ? "empty report (no final text returned)" : undefined),
      (err: unknown) => persist("", String(err)),
    );
    handles.set(handle.id, handle);
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
    for (const e of readJournal(dir) as unknown as Record<string, unknown>[]) {
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
  const dispatchAgent = (
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
    const decision = checkDispatch(
      store,
      role,
      packet,
      opts.userAgentLimit,
      liveWorkers(),
      liveOnMechanism(packet.mechanism),
    );
    if (!decision.allowed) return toolText(`DISPATCH REFUSED: ${decision.reason}`);
    const spec = roleModelSpec(role);
    const isTechnician = role === "technician";
    if (isTechnician && isCliProvider(spec.provider)) {
      return toolText(
        "DISPATCH REFUSED: the configured technician backend is a tool-less CLI oracle; a " +
          "computation packet needs a tool-running backend",
      );
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
    let session: RoleSession | undefined;
    let promise: Promise<string>;
    let oracleUsage: RoleUsage | undefined;
    const cliStop = new AbortController();
    if (isCliProvider(spec.provider)) {
      // Single-shot oracle reasoner (e.g. chatgpt-cli → gpt-5.6-pro): one
      // deep attempt, no tools; the reply IS the deliverable.
      promise = runRole({
        contract,
        charge:
          CHARGES.reasoner +
          "\nYou have no tools in this run: produce the deliverable directly and completely in your reply.",
        prompt: packetPrompt,
        spec,
        models,
      }, cliStop.signal).then((r) => {
        oracleUsage = r.usage;
        return r.text;
      });
    } else {
      // Redesign phase 1: workers run on pi's AgentHarness with durable
      // JSONL session trees under .coverify/sessions/ — crash-survivable
      // transcripts, prompt_cache_key = the handle id. The session is
      // created asynchronously; the handle's promise chains behind it so
      // dispatch stays synchronous for the coordinator.
      const sessionPromise = createHarnessRoleSession(
        {
          contract,
          charge: isTechnician ? CHARGES.technician : CHARGES.reasoner,
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
      ).then((s) => {
        session = s;
        // The handle was registered before the async session resolved; patch
        // it in place so steer/cancel/turns-dump see the live session.
        const h = handles.get(id);
        if (h) h.session = s;
        return s;
      });
      promise = sessionPromise.then((live) => {
        // Cancelled while the session was being created: don't launch the
        // turn at all — nothing could stop it and the report would be dropped.
        if (!handles.has(id)) return "";
        return live.ask(`Assigned evidence directory: ${evidenceDir}\n\n${packetPrompt}`).then(
        // Salvage nudge: deep-reasoning runs sometimes end without emitting a
        // final message (observed live 2026-08-02: four @max scouts, ~2.6M
        // tokens, empty final text). The session context is intact at this
        // point, so ask once for the report before the settle-side classifier
        // writes the run off as an infrastructure failure.
          (text) =>
            // No salvage for a cancelled handle (abort resolves empty by
            // design) — a nudge there is a full-context turn nobody reads.
            text.trim() !== "" || !handles.has(id)
              ? text
              : live.ask(
                  "Your previous turn ended with no final message. Emit your complete " +
                    "conclusion-first report now, per your charge.",
                ),
        );
      });
    }
    registerHandle({
      id,
      kind: "worker",
      // One verb for both substrates: a pi session aborts, a spawned CLI is
      // killed. Callers stop work without knowing which it is.
      stop: () => (session ? session.abort() : cliStop.abort()),
      mechanism: packet.mechanism,
      promise,
      session,
      usage: () => session?.usage() ?? oracleUsage,
    });
    return toolText(
      `dispatched ${id} (${handles.size} live). The report will arrive at a later wake.` +
        (isTechnician
          ? `\nREGISTRY.md launch record: id ${id}; workload ${evidenceDir}; ` +
            `limits ${Math.round(RUN_TIMEOUT_MS / 60000)} min / ${RUN_MEM_MB} MB per batch; ` +
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

  const requestVerification: AgentTool = {
    name: "request_verification",
    label: "Verification cadence",
    description:
      "Run the two-stage verification cadence on one exact candidate revision (an EVIDENCE-relative " +
      "filename). Stage 1: fresh hostile audit of the candidate. Stage 2: fresh bundle certification " +
      "(a leaky keyIdeas/allowedSources bundle is refused and hash-blocked), then no-context " +
      "reconstruction from statement + key ideas + allowed sources + promoted premises (never the " +
      "proof), then a fresh comparison mapping the reconstruction to the candidate's conclusions and " +
      "dependencies. Runs async like a worker: returns a handle immediately, verdict at a later " +
      "wake. A re-run on the identical candidate (after a protocol or infrastructure failure) reuses " +
      "the blind reconstruction; any change to the candidate regenerates it, because the contract " +
      "forbids reusing a verifier response that influenced the repair. Code records all verdicts bound to content " +
      "hashes; promotion (record_promotion) is only legal after both stages PASS on the exact revision.",
    parameters: Type.Object({
      revision: Type.String({ description: "EVIDENCE-relative candidate filename (revision identity)" }),
      declaredDependencies: Type.String({ description: "Declared dependencies of the candidate" }),
      keyIdeas: Type.String({
        description: "High-level key ideas for the reconstructor (not the proof or its paraphrase)",
      }),
      allowedSources: Type.String({
        description: "Allowed sources for the reconstructor (named theorems, background references)",
      }),
      rebuttalArtifact: Type.Optional(
        Type.String({
          description:
            "EVIDENCE-relative rebuttal artifact refuting a prior substantive FAIL on this exact " +
            "revision. Required to re-attempt after a FAIL (contract: a FAIL stands; do not rerun " +
            "a failed stage on an unchanged revision in search of a PASS).",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      if (declaration) {
        return toolText(
          `VERIFICATION REFUSED: the campaign is already declared ${declaration.state}; cease dispatch ` +
            "and checkpoint. Re-request verification after resuming.",
        );
      }
      const p = params as {
        revision: string;
        declaredDependencies: string;
        keyIdeas: string;
        allowedSources: string;
        rebuttalArtifact?: string;
      };
      const rel = evidenceRelative(p.revision);
      if (!rel) return toolText(`revision must be a path inside EVIDENCE/ (got: ${p.revision})`);
      const candidatePath = path.join(dir, "EVIDENCE", rel);
      if (!fs.existsSync(candidatePath)) return toolText(`no such evidence revision: ${rel}`);
      // One read, one hash: a candidate can live in a live worker's evidence
      // directory and be rewritten between two reads, which would record a
      // hash of bytes no verifier ever saw.
      const candidateBytes = fs.readFileSync(candidatePath);
      const candidate = candidateBytes.toString("utf-8");
      const candidateHash = sha256Text(candidate);
      const stmtHash = statementHash(dir);

      // Anti-verdict-shopping (contract): a substantive FAIL stands against
      // the exact revision contents; re-attempt only with a recorded rebuttal.
      // A bundle-cert FAIL is different: it faults the bundle, not the
      // candidate — retry is legal with a changed bundle (hash-checked below).
      const bundle = `# High-level key ideas\n\n${p.keyIdeas}\n\n# Allowed sources\n\n${p.allowedSources}`;
      const sameBundleCertFail = store
        .all()
        .some(
          (e) =>
            e.kind === "bundle-cert" &&
            sameRevision(e.revision, rel) &&
            e.candidateHash === candidateHash &&
            e.bundleHash === sha256Text(bundle) &&
            e.verdict === "FAIL",
        );
      if (sameBundleCertFail) {
        return toolText(
          "VERIFICATION REFUSED: this exact bundle already failed certification as leaking the " +
            "candidate argument. Revise keyIdeas/allowedSources before retrying.",
        );
      }
      // Matched on content, not on filename. "A substantive FAIL from any
      // stage stands against the revision that received it" — and identical
      // bytes under a different name are that revision, so copying a FAILed
      // candidate to a new path must not clear the requirement for a repair,
      // a retraction, or a recorded rebuttal.
      const priorFail = store
        .all()
        .some(
          (e) =>
            (e.kind === "audit" || e.kind === "comparison") &&
            e.candidateHash === candidateHash &&
            e.statementHash === stmtHash &&
            e.verdict === "FAIL",
        );
      if (priorFail) {
        const rebuttalRel = p.rebuttalArtifact ? evidenceRelative(p.rebuttalArtifact) : undefined;
        if (!rebuttalRel || !fs.existsSync(path.join(dir, "EVIDENCE", rebuttalRel))) {
          return toolText(
            "VERIFICATION REFUSED: a substantive FAIL is on record for this exact revision. Per the " +
              "contract, respond with a load-bearing repair (new revision), retraction, or a recorded " +
              "rebuttal artifact refuting the exact reported gap (pass rebuttalArtifact).",
          );
        }
        store.append({ kind: "rebuttal", revision: rel, artifact: rebuttalRel });
      }
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = promotedStatementsView(dir);
      const slug = rel.replace(/[\/]/g, "_");
      const bundleHash = sha256Text(bundle);
      const provedHash = sha256Text(proved);
      const usages: RoleUsage[] = [];
      const recordUsage = (u?: RoleUsage) => {
        if (u) usages.push(u);
      };

      // The cadence runs as an async handle, like a worker: during a long
      // blind reconstruction the coordinator keeps gating, dispatching, and
      // writing ledgers; the verdict arrives at a later wake.
      // Set once the handle exists; a cancelled cadence must stop recording
      // verdicts — otherwise cancel_agent would hide a verification that keeps
      // running and can still authorize promotion off an unseen PASS.
      const cadenceStop = new AbortController();
      let cancelled: () => boolean = () => cadenceStop.signal.aborted;
      const abortIfCancelled = () => {
        if (cancelled()) throw new Error(`verification cancelled; no verdict recorded for ${rel}`);
      };
      /**
       * One verdict stage of the cadence: a fresh role call, a first-line
       * PASS/FAIL parse, the output saved as a citable artifact, and a gate
       * record bound to the candidate + statement hashes. Audit, bundle
       * certification, and comparison differ only in inputs and disclosure —
       * the stage sequence itself stays spelled out in `cadence` below.
       */
      // One list drives both the prompt and the journal's suppliedInputs
      // (2026-08-02 uniformity review): what the model was sent and what the
      // record testifies can no longer drift. `blindness` stays hand-authored
      // per call — it carries enforcement-modality and content-provenance
      // claims a section list cannot derive.
      const sectionsOf = (sections: { heading: string; name: string; text: string }[]) => ({
        prompt: sections.map((s) => `# ${s.heading}\n\n${s.text}`).join("\n\n"),
        suppliedInputs: sections.map((s) => s.name),
      });
      // Derivable half of the launcher's "workspace/tool visibility" honesty
      // obligation: single-shot verdict roles get no workspace from us, but an
      // official-CLI backend carries the CLI's own tools (instructed-only).
      const toolVisibilityOf = (provider: string) =>
        isCliProvider(provider)
          ? "no workspace granted; official-CLI backend may expose its own tools (instructed only)"
          : "none (single-shot, no tools granted)";

      const verdictStage = async (stage: {
        kind: "audit" | "bundle-cert" | "comparison";
        role: "hostileAuditor" | "bundleCertifier" | "comparator";
        ctx: { prompt: string; suppliedInputs: string[] };
        blindness: string;
        extra?: Record<string, unknown>;
      }): Promise<{ text: string; pass: boolean; unparseable: boolean; artifact: string }> => {
        const spec = roleModelSpec(stage.role);
        const { text, usage, promptChars, durationMs } = await runRole({
          contract,
          charge: CHARGES[stage.role],
          prompt: stage.ctx.prompt,
          spec,
          models,
        });
        recordUsage(usage);
        abortIfCancelled();
        const evidence = newEvidencePath(dir, `audits/${slug}.${stage.kind}`);
        fs.writeFileSync(evidence, text);
        const artifact = path.relative(dir, evidence);
        const verdictLine = parseFirstLineVerdict(text, ["VERDICT: PASS", "VERDICT: FAIL"]);
        const pass = verdictLine === "VERDICT: PASS";
        // A reply with no verdict line is a protocol failure: never PASS
        // (launcher), but recorded as UNPARSEABLE rather than FAIL so it
        // neither arms anti-verdict-shopping against the revision nor
        // hash-blocks a legitimate bundle forever — re-running the stage is
        // the contract's legitimate response to an infrastructure failure.
        const verdict = pass ? "PASS" : verdictLine === undefined ? "UNPARSEABLE" : "FAIL";
        store.append({
          kind: stage.kind,
          revision: rel,
          verdict,
          candidateHash,
          statementHash: stmtHash,
          ...stage.extra,
          artifact,
          suppliedInputs: stage.ctx.suppliedInputs,
          blindness: stage.blindness,
          toolVisibility: toolVisibilityOf(spec.provider),
          modelFamily: specLabel(spec),
          usage,
          promptChars,
          durationMs,
        });
        return { text, pass, unparseable: verdictLine === undefined, artifact };
      };

      const cadence = async (): Promise<string> => {
        // Stage 1 — hostile audit (bundle includes PROVED.md so promoted claims are checkable).
        const audit = await verdictStage({
          kind: "audit",
          role: "hostileAuditor",
          ctx: sectionsOf([
            { heading: "Statement", name: "statement", text: statement },
            { heading: "Currently promoted (PROVED.md)", name: "PROVED.md (statements view)", text: proved },
            {
              heading: "Declared dependencies (coordinator-authored)",
              name: "declared dependencies",
              text: p.declaredDependencies,
            },
            { heading: `Candidate revision ${rel}`, name: "candidate revision", text: candidate },
          ]),
          blindness:
            "fresh instance (enforced); bundle built by harness (enforced); declaredDependencies coordinator-authored (instructed only)",
        });
        if (!audit.pass) {
          if (audit.unparseable) {
            return (
              `STAGE 1 PROTOCOL FAILURE — the auditor's reply had no verdict line; recorded as ` +
              `UNPARSEABLE (never PASS, but not a substantive FAIL). Re-running the stage is ` +
              `legitimate. Saved: ${audit.artifact}\n\n${audit.text}`
            );
          }
          return `STAGE 1 FAIL — not verifier-backed. Audit saved: ${audit.artifact}\n\n${audit.text}`;
        }

        // Bundle certification (contract): a fresh agent shown both the
        // candidate and the bundle certifies no element is a stepwise
        // paraphrase of — or contains — the candidate argument. Always rerun:
        // the certifier sees the candidate, so a new revision needs its own cert.
        const cert = await verdictStage({
          kind: "bundle-cert",
          role: "bundleCertifier",
          ctx: sectionsOf([
            { heading: `Candidate revision ${rel}`, name: "candidate revision", text: candidate },
            { heading: "Proposed reconstruction bundle", name: "proposed bundle", text: bundle },
          ]),
          blindness: "fresh instance (enforced); sees candidate by design (certification step)",
          extra: { bundleHash },
        });
        if (!cert.pass) {
          if (cert.unparseable) {
            return (
              `BUNDLE CERTIFICATION PROTOCOL FAILURE — the certifier's reply had no verdict line; ` +
              `recorded as UNPARSEABLE (the bundle is neither certified nor refused; this does not ` +
              `hash-block it). Re-running the stage is legitimate. Saved: ${cert.artifact}\n\n${cert.text}`
            );
          }
          return (
            `BUNDLE CERTIFICATION FAIL — the bundle leaks the candidate argument; stage 2 refused. ` +
            `Revise keyIdeas/allowedSources and retry. Cert saved: ${cert.artifact}\n\n${cert.text}`
          );
        }

        // Stage 2a — blind reconstruction (no verdict; the PASS belongs to
        // the comparison).
        //
        // Reuse is allowed ONLY for the identical candidate — a re-run after a
        // protocol or infrastructure failure. The contract is explicit for a
        // repaired candidate: "Invalidate both stages; rerun a fresh hostile
        // audit and then a fresh reconstruction. Never reuse a verifier
        // response that influenced the repair." Keying reuse on the bundle
        // alone broke exactly that: the comparator's FAIL is quoted verbatim
        // into the coordinator's wake, the repair is written to address it,
        // and the same reconstruction then judges the candidate written
        // against it — independence in name only. Carrying stages forward for
        // a *non-load-bearing* diff is legal, but the contract requires a
        // fresh delta auditor's PASS to authorize it, and there is no delta
        // auditor here yet (roadmap), so anything but identical bytes
        // regenerates.
        const priorRecon = [...store.all()]
          .reverse()
          .find(
            (e) =>
              e.kind === "reconstruction" &&
              e.candidateHash === candidateHash &&
              e.statementHash === stmtHash &&
              e.bundleHash === bundleHash &&
              e.provedHash === provedHash &&
              typeof e.artifact === "string" &&
              fs.existsSync(path.join(dir, e.artifact)) &&
              // Content-bound: an artifact edited since it was recorded is
              // no longer the independent reconstruction that was verified,
              // so it must be regenerated rather than reused.
              e.artifactHash === sha256File(path.join(dir, e.artifact)),
          );
        abortIfCancelled();
        let reconText: string;
        let reconArtifact: string;
        if (priorRecon) {
          reconArtifact = priorRecon.artifact as string;
          reconText = fs.readFileSync(path.join(dir, reconArtifact), "utf-8");
          const carriedHash = priorRecon.artifactHash as string;
          store.append({
            kind: "reconstruction",
            revision: rel,
            candidateHash,
            statementHash: stmtHash,
            bundleHash,
            provedHash,
            artifact: reconArtifact,
            artifactHash: carriedHash,
            carriedForwardFrom: priorRecon.revision,
            suppliedInputs: ["statement", "key ideas", "allowed sources", "promoted premises"],
            blindness:
              "carried forward (enforced): statement, bundle, and promoted premises byte-identical " +
              "to the prior reconstruction's inputs; the reconstructor never saw any candidate",
            modelFamily: priorRecon.modelFamily,
          });
        } else {
          const reconCtx = sectionsOf([
            { heading: "Statement", name: "statement", text: statement },
            { heading: "High-level key ideas", name: "key ideas", text: p.keyIdeas },
            { heading: "Allowed sources", name: "allowed sources", text: p.allowedSources },
            { heading: "Promoted premises", name: "promoted premises (statements view)", text: proved },
          ]);
          // Platform-enforced blindness: the "(enforced)" claim below is a
          // checked fact for whole-file interpolation, not testimony. Partial
          // paraphrase remains the bundle certifier's judgment.
          assertCandidateWithheld(reconCtx.prompt, candidate);
          const {
            text,
            usage: reconTextUsage,
            promptChars: reconPromptChars,
            durationMs: reconDurationMs,
          } = await runRole({
            contract,
            charge: CHARGES.reconstructor,
            prompt: reconCtx.prompt,
            spec: roleModelSpec("reconstructor"),
            models,
          });
          recordUsage(reconTextUsage);
          abortIfCancelled();
          reconText = text;
          const reconEvidence = newEvidencePath(dir, `audits/${slug}.reconstruction`);
          fs.writeFileSync(reconEvidence, reconText);
          reconArtifact = path.relative(dir, reconEvidence);
          store.append({
            kind: "reconstruction",
            revision: rel,
            candidateHash,
            statementHash: stmtHash,
            bundleHash,
            provedHash,
            artifact: reconArtifact,
            artifactHash: sha256File(reconEvidence),
            suppliedInputs: reconCtx.suppliedInputs,
            blindness:
              "fresh instance (enforced); candidate file withheld by harness (enforced — rendered prompt checked); keyIdeas coordinator-authored (instructed only — paraphrase risk not machine-checked)",
            toolVisibility: toolVisibilityOf(roleModelSpec("reconstructor").provider),
            modelFamily: specLabel(roleModelSpec("reconstructor")),
            usage: reconTextUsage,
            promptChars: reconPromptChars,
            durationMs: reconDurationMs,
          });
        }

        // Stage 2b — comparison: maps the reconstruction to the candidate's
        // conclusions and declared dependencies. This verdict is stage 2's PASS.
        const compare = await verdictStage({
          kind: "comparison",
          role: "comparator",
          ctx: sectionsOf([
            { heading: "Statement", name: "statement", text: statement },
            { heading: "Independent reconstruction", name: "reconstruction", text: reconText },
            { heading: `Candidate revision ${rel}`, name: "candidate", text: candidate },
            { heading: "Declared dependencies", name: "declared dependencies", text: p.declaredDependencies },
          ]),
          blindness: "fresh instance (enforced); sees both sides by design (comparison step)",
        });
        const promotion = checkPromotion(store, dir, rel);
        return (
          `STAGE 1 PASS; STAGE 2 ${compare.pass ? "PASS" : compare.unparseable ? "UNPARSEABLE (protocol failure — never PASS; re-run is legitimate)" : "FAIL"} (comparison verdict). ` +
          (promotion.allowed
            ? `Revision ${rel} is verifier-backed; record_promotion is now legal for it.`
            : `Not promotable: ${promotion.reason}`) +
          (priorRecon ? `\nReconstruction carried forward from revision ${priorRecon.revision}.` : "") +
          `\nArtifacts: ${audit.artifact}, ${reconArtifact}, ${compare.artifact}` +
          `\n\n## Stage 1 (hostile audit)\n\n${audit.text}\n\n## Stage 2b (comparison)\n\n${compare.text}`
        );
      };

      const id = `v${String(nextId++).padStart(3, "0")}`;
      // Journaled like an agent dispatch so ids stay unique across restarts
      // (maxHandleId reads dispatch records only).
      store.append({ kind: "dispatch", id, role: "verification", mechanism: `verification:${rel}`, task: rel });
      cancelled = () => cadenceStop.signal.aborted || !handles.has(id);
      registerHandle({
        id,
        kind: "verification",
        // A cadence is composite work: stopping it means its stage calls stop
        // recording, which abortIfCancelled already enforces between stages.
        stop: () => cadenceStop.abort(),
        mechanism: `verification:${rel}`,
        promise: cadence(),
        // Summed over the cadence's role calls; undefined when no backend
        // reported usage.
        usage: () => (usages.length === 0 ? undefined : usages.reduce(addUsage)),
      });
      return toolText(
        `verification ${id} dispatched on ${rel} (${handles.size} live). The verdict arrives at a ` +
          "later wake; keep gating, dispatching, and ledger work going meanwhile.",
      );
    },
  } as AgentTool;

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
      if (!decision.allowed) return toolText(`PROMOTION REFUSED: ${decision.reason}`);
      const resolved = resolvePremises(store, p.premises ?? []);
      if ("unresolved" in resolved) {
        return toolText(
          `PROMOTION REFUSED: premise "${resolved.unresolved}" matches no recorded promotion in ` +
            "this campaign. Premises name earlier promoted revisions exactly; external sources " +
            "belong in the dependencies prose.",
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
      if (!handle.session) return toolText(`${p.id} has no steerable session (CLI oracle or verification cadence); cancel or wait`);
      const delivered = await handle.session.steer(p.message);
      if (!delivered) {
        return toolText(
          `${p.id} is idle (its turn just finished); steering dropped — its report arrives at the next wake regardless.`,
        );
      }
      appendJournal(dir, { kind: "note", note: `steered ${p.id}`, message: p.message });
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
      appendJournal(dir, {
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
    const digest =
      (handles.size === 0
        ? "No workers are currently running."
        : `Still running (do not interrupt for slowness): ${[...handles.values()]
            .map((h) => `${h.id} [${h.mechanism}]`)
            .join(", ")}`) + (limits.length > 0 ? `\nUser limits: ${limits.join("; ")}.` : "");
    appendJournal(dir, {
      kind: "wake",
      wake: wakeCount,
      live: handles.size,
      newReports: harvested.total - harvested.failed,
      pendingDelivery: pending.length,
      ...(harvested.failed > 0 ? { failed: harvested.failed } : {}),
    });
    // Bookkeeping the harness can check, so the coordinator does not have to
    // remember it: a citation that points at nothing, and a promoted claim a
    // later verdict has contradicted.
    const dangling = danglingCitations(dir);
    const retractions = retractionClosure(store);
    const bookkeeping =
      (dangling.length > 0
        ? `\n\nLEDGER CITATIONS THAT POINT AT NOTHING (fix or remove them):\n` +
          dangling.map((d) => `- ${d.ledger} cites ${d.citation}, which does not exist`).join("\n")
        : "") +
      (retractions.length > 0
        ? `\n\nPROMOTED CLAIMS WITH A LATER SUBSTANTIVE FAIL — the contract requires a retraction ` +
          `(relabel in REGISTRY.md, append to FAILED.md, mark the PROVED.md entry historical, ` +
          `demote dependents):\n` +
          retractions
            .map(
              (r) =>
                `- ${r.revision} (later ${r.stage} FAIL)` +
                (r.dependents.length > 0
                  ? `; recorded dependents standing on it (transitive, via premises): ${r.dependents.join(", ")}`
                  : ""),
            )
            .join("\n")
        : "");
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
        appendJournal(dir, {
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
          appendJournal(dir, {
            kind: "note",
            note: `compaction failed (${String(e).slice(0, 200)}); rebuilding via restart rule`,
          });
          coordinator = undefined;
        }
      } else {
        appendJournal(dir, {
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
            appendJournal(dir, { kind: "note", note: `user message steered mid-turn: ${m}` });
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
      for (const m of userMessages) appendJournal(dir, { kind: "note", note: `user message: ${m}` });
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
      appendJournal(dir, {
        kind: "note",
        note: `coordinator turn failed (${String(e).slice(0, 200)}); rebuilding via restart rule`,
        consecutiveFailures: turnFailures,
      });
      coordinator = undefined;
      wakeCount--; // a failed turn is not a wake the user asked to spend
      if (turnFailures >= TURN_FAILURE_LIMIT) {
        appendJournal(dir, {
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
    appendJournal(dir, {
      kind: "usage",
      role: "coordinator",
      cumulative: coordinator.usage(),
      approxContextTokens: contextNow,
      ...(growth !== undefined ? { contextGrowthTokens: growth } : {}),
    });
    lostNote = "";

    if (declaration) {
      // Anything that settled during the rest of the turn (including agents
      // left running under supervision) is persisted before the process ends.
      const finalHarvest = harvestSettled();
      appendJournal(dir, {
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
        appendJournal(dir, {
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


import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  appendJournal,
  newEvidencePath,
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
  mechanism: string;
  promise: Promise<string>;
  /** Absent for single-shot CLI workers (oracle attempts) — not steerable/abortable. */
  session?: RoleSession;
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

/** Coordinator context cap (approx tokens). The coordinator stays resident
 *  across wakes — matching how the skill runs in a live harness session —
 *  until this cap, which is the compaction analog: the session is rebuilt
 *  via the launcher's restart rule (reread statement, frontier, lessons,
 *  registry index). Mechanics: the cap changes cost, not semantics, because
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
 * resident coordinator session (rebuilt from the ledgers at its context cap —
 * the compaction analog); there is no polling.
 */
export async function runCampaign(opts: CampaignOptions): Promise<string> {
  const dir = path.resolve(opts.campaignDir);
  const contract = loadLauncherContract();
  const models = await buildModels();
  const store = new GateStore(dir);

  // Version stamp at every run start: attributes this run to an exact
  // (harness, contract) pair. Harness audit metadata — launcher-permitted.
  appendJournal(dir, {
    kind: "note",
    note: "run-start",
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
  const settledQueue: { h: Handle; report: string; failed?: string }[] = [];
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
    [...handles.values()].filter((h) => h.mechanism === mechanism).length;

  // The user's --agent-limit caps concurrent WORKERS (reasoners r*, technicians
  // t*). Judges — gate critics g* and verification cadences v* — are also
  // handles but must not consume the workers' budget: ten pending verdicts
  // should never block a dispatch.
  const liveWorkers = (): number =>
    [...handles.keys()].filter((id) => id.startsWith("r") || id.startsWith("t")).length;

  // Per-request telemetry sidecars (.coverify/turns/<name>.jsonl): one line
  // per message with sizes, per-request usage, gaps, and stopReason — what
  // was sent and generated, never prompt text. This is the record that makes
  // cache effectiveness and empty-final-text failures diagnosable after the
  // fact. Telemetry only: a write failure never affects the campaign.
  const turnsDir = path.join(dir, ".coverify", "turns");
  const sessionsRoot = path.join(dir, ".coverify", "sessions");
  // Incremental: message history is append-only, so only new records are
  // written after the first dump (the full rewrite was quadratic over a
  // long coordinator session — review 2026-08-02). First dump per name in
  // this process truncates, clearing any stale file from a prior run.
  const turnsWritten = new Map<string, number>();
  const dumpTurns = (name: string, session?: RoleSession) => {
    if (!session) return;
    try {
      fs.mkdirSync(turnsDir, { recursive: true });
      const recs = session.turns();
      const prev = turnsWritten.get(name);
      const from = prev ?? 0;
      if (recs.length <= from && prev !== undefined) return;
      const text = recs
        .slice(from)
        .map((t) => JSON.stringify(t))
        .join("\n") + "\n";
      const file = path.join(turnsDir, `${name}.jsonl`);
      if (prev === undefined) fs.writeFileSync(file, text);
      else fs.appendFileSync(file, text);
      turnsWritten.set(name, recs.length);
    } catch {
      /* observability must never break the run */
    }
  };

  /** Registers a settled-queue handle: the one async pattern every dispatch shares. */
  const registerHandle = (h: Omit<Handle, "settled">) => {
    const handle = h as Handle;
    // A cancelled handle is removed from the table; its late report (or
    // failure) must not resurface at a later wake. Failure is classified here,
    // where the promise settles — a rejected call or empty final text is an
    // infrastructure failure — so `failed` is the single source of truth and
    // `failed` set ⟺ no usable report.
    const queue = (report: string, failed?: string) => {
      if (handles.has(handle.id)) settledQueue.push({ h: handle, report, failed });
    };
    handle.settled = handle.promise.then(
      (report) =>
        queue(report, report.trim() === "" ? "empty report (no final text returned)" : undefined),
      (err: unknown) => queue("", String(err)),
    );
    handles.set(handle.id, handle);
    activityThisWake++;
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
      }).then((r) => {
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
      }).then(({ text, usage: criticUsage, promptChars, durationMs }) => {
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
      // `gate:` prefix keeps liveOnMechanism from counting a pending gate as a
      // live worker on the mechanism it is judging.
      registerHandle({ id, mechanism: `gate:${p.mechanism.slice(0, 60)}`, promise });
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
      "wake. When statement, bundle, and promoted premises are unchanged since a prior run, the " +
      "blind reconstruction is carried forward automatically (it never sees the candidate) and only " +
      "audit, certification, and comparison rerun. Code records all verdicts bound to content " +
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
      const candidate = fs.readFileSync(candidatePath, "utf-8");
      const candidateHash = sha256File(candidatePath);
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
      const priorFail = store
        .all()
        .some(
          (e) =>
            (e.kind === "audit" || e.kind === "comparison") &&
            sameRevision(e.revision, rel) &&
            e.candidateHash === candidateHash &&
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
      const addUsage = (u?: RoleUsage) => {
        if (u) usages.push(u);
      };

      // The cadence runs as an async handle, like a worker: during a long
      // blind reconstruction the coordinator keeps gating, dispatching, and
      // writing ledgers; the verdict arrives at a later wake.
      // Set once the handle exists; a cancelled cadence must stop recording
      // verdicts — otherwise cancel_agent would hide a verification that keeps
      // running and can still authorize promotion off an unseen PASS.
      let cancelled: () => boolean = () => false;
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
        addUsage(usage);
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
        // the comparison). Carried forward when statement, bundle, and
        // promoted premises are byte-identical to a prior reconstruction's
        // inputs: the reconstructor never sees any candidate, so a candidate
        // repair cannot invalidate it (delta carry-forward; the contract's
        // full-re-verification was harness strictness, not a clause).
        const priorRecon = [...store.all()]
          .reverse()
          .find(
            (e) =>
              e.kind === "reconstruction" &&
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
          addUsage(reconTextUsage);
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
      cancelled = () => !handles.has(id);
      registerHandle({
        id,
        mechanism: `verification:${rel}`,
        promise: cadence(),
        // Summed over the cadence's role calls; undefined when no backend
        // reported usage.
        usage: () => {
          if (usages.length === 0) return undefined;
          const total: RoleUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
          for (const u of usages) {
            total.input += u.input;
            total.output += u.output;
            total.cacheRead += u.cacheRead;
            total.cacheWrite += u.cacheWrite;
            total.reasoning = (total.reasoning ?? 0) + (u.reasoning ?? 0);
          }
          return total;
        },
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
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { revision: string; exactStatement: string; dependencies: string };
      const rel = evidenceRelative(p.revision);
      if (!rel) return toolText(`revision must be a path inside EVIDENCE/ (got: ${p.revision})`);
      const decision = checkPromotion(store, dir, rel);
      if (!decision.allowed) return toolText(`PROMOTION REFUSED: ${decision.reason}`);
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
      const entry =
        `\n## ${rel} — promoted ${new Date().toISOString()}\n\n` +
        `**Statement (coordinator-authored):** ${p.exactStatement}\n\n` +
        `**Dependencies:** ${p.dependencies}\n\n` +
        `**Verified candidate:** ${rel} (sha256 ${verifiedHash})\n\n` +
        `**Audit artifacts:** ${artifacts}\n`;
      fs.appendFileSync(path.join(dir, "PROVED.md"), entry);
      store.append({ kind: "promotion", revision: rel, candidateHash: verifiedHash, statement: p.exactStatement });
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
      handle.session?.abort();
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
      handle.session.steer(p.message);
      appendJournal(dir, { kind: "note", note: `steered ${p.id}`, message: p.message });
      return toolText(`steering message delivered to ${p.id}.`);
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
      // "cease dispatch, interrupt task agents, cancel task computations
      // unless explicitly authorized to continue under supervision".
      let interrupted = 0;
      if (!p.continueSupervised) {
        for (const [id, handle] of [...handles]) {
          handle.session?.abort();
          store.append({ kind: "completion", id, cancelled: true, reason: `campaign ${p.state}` });
          handles.delete(id);
          interrupted++;
        }
        settledQueue.length = 0;
      }
      return toolText(
        `Declared: ${p.state}. ` +
          (p.continueSupervised
            ? `${handles.size} agent(s) left running under supervision. `
            : `${interrupted} live agent(s) interrupted. `) +
          "The harness will stop after this wake; checkpoint the ledgers now.",
      );
    },
  } as AgentTool;

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
  let coordinator: RoleSession | undefined;
  let coordinatorEpoch = 0;
  while (true) {
    wakeCount++;
    if (opts.maxWakes !== undefined && wakeCount > opts.maxWakes) {
      appendJournal(dir, { kind: "note", note: `user wake limit ${opts.maxWakes} reached; pausing` });
      return `${lastWakeText}\n\n[coverify: user wake limit reached; campaign paused, resume with 'coverify resume']`;
    }
    activityThisWake = 0;
    const limits: string[] = [];
    if (opts.userAgentLimit !== undefined) limits.push(`workers ${liveWorkers()}/${opts.userAgentLimit}`);
    if (opts.maxWakes !== undefined) limits.push(`wakes ${wakeCount}/${opts.maxWakes}`);
    const digest =
      (handles.size === 0
        ? "No workers are currently running."
        : `Still running (do not interrupt for slowness): ${[...handles.values()]
            .map((h) => `${h.id} [${h.mechanism}]`)
            .join(", ")}`) + (limits.length > 0 ? `\nUser limits: ${limits.join("; ")}.` : "");
    const reports = settledQueue.splice(0, settledQueue.length);
    for (const s of reports) handles.delete(s.h.id);
    // Infrastructure failure is journaled as a failed-flagged completion (the
    // shape cancellation already uses), never as one with an empty artifact:
    // the contract says infrastructure failure is never PASS, and a failed run
    // must not count as a new report anywhere spend accounting reads the journal.
    const reportSections = reports.map((s) => {
      dumpTurns(s.h.id, s.h.session);
      if (s.failed !== undefined) {
        store.append({ kind: "completion", id: s.h.id, failed: s.failed, usage: s.h.usage?.() });
        return (
          `## ${s.h.id} [${s.h.mechanism}] FAILED (infrastructure): ${s.failed}\n\n` +
          `No report artifact exists. Per the contract this is never PASS and carries no ` +
          `mathematical content; re-dispatching the assignment is legitimate.`
        );
      }
      const reportPath = newEvidencePath(dir, `${s.h.id}/report`);
      fs.writeFileSync(reportPath, s.report);
      store.append({ kind: "completion", id: s.h.id, report: path.relative(dir, reportPath), usage: s.h.usage?.() });
      return `## ${s.h.id} [${s.h.mechanism}] (saved: ${path.relative(dir, reportPath)})\n\n${s.report}`;
    });
    const failedCount = reports.filter((s) => s.failed !== undefined).length;
    appendJournal(dir, {
      kind: "wake",
      wake: wakeCount,
      live: handles.size,
      newReports: reports.length - failedCount,
      ...(failedCount > 0 ? { failed: failedCount } : {}),
    });
    const idleNudge =
      handles.size === 0 && reportSections.length === 0 && wakeCount > 1
        ? "\nNothing is live and no new reports arrived. Per the contract the campaign remains " +
          "authorized: dispatch the next materially new fan-out, or explicitly declare_campaign_state."
        : "";
    // Resident coordinator: rebuild only at start or past the context cap
    // (the compaction analog — the launcher's restart rule is the rebuild).
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
          // Matches the turns sidecar name (coordinator-<epoch>); the JSONL
          // filename adds a timestamp, so restarts never collide.
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
    const rereadBlock = justCompacted
      ? "Your context was just compacted. Per the contract's restart rule, the current ledgers " +
        "follow; the compaction summary never overrides them.\n\n" +
        `${resumeBundle(dir)}\n\n---\n\n`
      : "";
    lastWakeText = await coordinator.ask(
      fresh
        ? `${resumeBundle(dir)}\n\n---\n\nCampaign directory: ${dir}\n${lostNote}${digest}${idleNudge}\n\n${newsBlock}`
        : `${rereadBlock}${lostNote}${digest}${idleNudge}${compactionWarning}\n\n${newsBlock}`,
    );
    appendJournal(dir, {
      kind: "usage",
      role: "coordinator",
      cumulative: coordinator.usage(),
      approxContextTokens: coordinator.approxTokens(),
    });
    // Rewritten in full each wake: the file always mirrors the resident
    // session; a rebuild starts a new epoch file.
    dumpTurns(`coordinator-${coordinatorEpoch}`, coordinator);
    lostNote = "";

    // Frontier history: CURRENT_FRONTIER.md is rewritten by design, so the
    // harness snapshots each distinct post-wake version under .coverify/.
    // Pure audit metadata — nothing reads it; deleting it changes nothing.
    const frontier = readLedger(dir, "CURRENT_FRONTIER.md");
    const histDir = path.join(dir, ".coverify", "frontier-history");
    fs.mkdirSync(histDir, { recursive: true });
    const prev = fs.readdirSync(histDir).sort().at(-1);
    if (!prev || fs.readFileSync(path.join(histDir, prev), "utf-8") !== frontier) {
      fs.writeFileSync(path.join(histDir, `wake-${String(wakeCount).padStart(4, "0")}.md`), frontier);
    }

    if (declaration) {
      appendJournal(dir, { kind: "note", note: `declared ${declaration.state}: ${declaration.reason}` });
      return `${lastWakeText}\n\n[coverify: campaign ${declaration.state} — ${declaration.reason}]`;
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
      await Promise.race([...handles.values()].map((h) => h.settled));
    }
  }
}


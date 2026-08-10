// The coordinator's clause-mapped tool surface, out of the event loop:
// dispatch (reasoner/technician/gate critic), promotion recording,
// cancel/steer, and the campaign declaration. Same factory pattern as
// cadence.ts (CadenceDeps): the harness passes a narrow deps object and
// keeps the loop — handles, wake building, compaction, inbox — to itself.
// Every enforcement here traces to a launcher clause; the deps are the
// loop's live state, reached only through the accessors the loop grants.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { promotedStatementsView, readLedger, sha256File } from "./campaign.js";
import {
  checkPromotion,
  checkDispatch,
  resolvePremises,
  sameRevision,
  GateStore,
  recordGateVerdict,
  type ReasonerPacket,
  type TechnicianPacket,
} from "./gates.js";
import { refuse } from "./observe.js";
import { CHARGES } from "./roles.js";
import { createCliRoleSession, isCliProvider } from "./backends.js";
import {
  createHarnessRoleSession,
  type Models,
  resolveFamily,
  roleModelSpec,
  type RoleSession,
  runRole,
  specKey,
  specLabel,
} from "./providers.js";
import { runMemMb, runTimeoutMs, toolText } from "./sandbox.js";
import type { CampaignOptions, Handle } from "./harness.js";

/** What the coordinator's tools need from the campaign loop. Mirrors
 *  CadenceDeps, widened to what dispatch and declaration actually touch:
 *  the live handle map (dispatch patches sessions in place, cancel and
 *  declare remove entries), the settled queue (a cancelled handle's queued
 *  report must not be delivered), and get/set access to the declaration
 *  (declare_campaign_state writes it; every dispatch reads it). */
export interface CoordinatorToolDeps {
  dir: string;
  store: GateStore;
  /** The launcher contract text, embedded verbatim in every role prompt. */
  contract: string;
  models: Models;
  /** User-set policy only (launcher: no invented harness defaults). */
  opts: Pick<CampaignOptions, "userAgentLimit" | "noComputation">;
  sessionsRoot: string;
  evidenceRelative: (p: string) => string | undefined;
  /** Live declaration state: a declared campaign refuses new dispatch. */
  declaration: () => { state: "pause" | "complete"; reason: string } | undefined;
  declare: (d: { state: "pause" | "complete"; reason: string }) => void;
  /** Shared handle-id counter (workers, gates, and verification mint from one sequence). */
  nextId: () => number;
  /** The wake that is ordering this dispatch. The tree is
   *  campaign -> run -> wake -> dispatch -> stage records, and every aggregate
   *  is derivable from leaves ONLY if each parent edge is on file. This one
   *  was missing, so dispatched spend — the majority of the bill — could not
   *  be attributed to the wake that ordered it. */
  wake: () => number;
  handles: Map<string, Handle>;
  settledQueue: { h: Handle }[];
  liveWorkers: () => number;
  liveOnMechanism: (mechanism: string) => number;
  registerHandle: (
    h: Omit<Handle, "settled" | "promise"> & { promise: Promise<string> | (() => Promise<string>) },
  ) => void;
  harvestSettled: () => { total: number };
  /** Counts toward the loop's no-op-wake pause, like any dispatch. */
  bumpActivity: () => void;
}

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

export function coordinatorTools(deps: CoordinatorToolDeps): {
  dispatchReasoner: AgentTool;
  dispatchTechnician: AgentTool;
  dispatchGateCritic: AgentTool;
  recordPromotion: AgentTool;
  cancelWorker: AgentTool;
  steerWorker: AgentTool;
  declareState: AgentTool;
} {
  const {
    dir,
    store,
    contract,
    models,
    opts,
    sessionsRoot,
    evidenceRelative,
    handles,
    settledQueue,
    liveWorkers,
    liveOnMechanism,
    registerHandle,
    harvestSettled,
  } = deps;

  /** Shared dispatch path for the two agent roles the coordinator authors. */
  const dispatchAgent = async (
    role: "reasoner" | "technician",
    packet: ReasonerPacket | TechnicianPacket,
  ) => {
    // "cease dispatch": once the campaign is declared, new work would run in a
    // process that is about to return, and its report would be discarded.
    const declared = deps.declaration();
    if (declared) {
      return refuse(
        store,
        "dispatch",
        `the campaign is already declared ${declared.state}; the contract says cease dispatch. ` +
          "Checkpoint the ledgers and finish this turn.",
        { mechanism: packet.mechanism, role },
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
    const id = `${isTechnician ? "t" : "r"}${String(deps.nextId()).padStart(3, "0")}`;
    const evidenceDir = path.join(dir, "EVIDENCE", id);
    fs.mkdirSync(evidenceDir, { recursive: true });
    // Role-authoritative, read once: tool schemas allow unknown extras, so a
    // `literature` field smuggled onto a technician packet must neither reach
    // the prompt nor grant the librarian.
    const literature = role === "reasoner" ? (packet as ReasonerPacket).literature : undefined;
    store.append({
      kind: "dispatch",
      id,
      wake: deps.wake(),
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
      // Request-level counts, so a worker's completion can distinguish one
      // long turn from several retried ones.
      attempts: () => session?.attempts?.() ?? 0,
      requests: () => session?.requests?.() ?? 0,
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
      const declared = deps.declaration();
      if (declared) {
        return refuse(
          store,
          "gate",
          `the campaign is already declared ${declared.state}; cease dispatch and checkpoint.`,
        );
      }
      const p = params as { mechanism: string; firstImplication: string; importedPremises?: string };
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = promotedStatementsView(dir);
      const id = `g${String(deps.nextId()).padStart(3, "0")}`;
      // The full gate packet is recorded (launcher: "Record every gate packet
      // and verdict"), including any coordinator-attested imported premises so
      // a misquote is auditable against the named source revision.
      store.append({
        kind: "dispatch",
        id,
        wake: deps.wake(),
        role: "gate-critic",
        mechanism: p.mechanism,
        task: p.firstImplication,
        importedPremises: p.importedPremises,
      });
      const gateStop = new AbortController();
      // One resolution per gate: the spec the call requested is the spec the
      // record names, even if the env changes mid-campaign.
      const gateSpec = roleModelSpec("gateCritic");
      const promise = runRole({
        contract,
        charge: CHARGES.gateCritic,
        prompt:
          `# Frozen target\n\n${statement}\n\n# Promoted premises\n\n${proved}` +
          (p.importedPremises
            ? `\n\n# Imported premises (coordinator-supplied verbatim, with revision identities)\n\n${p.importedPremises}`
            : "") +
          `\n\n# Proposed mechanism\n\n${p.mechanism}\n\n# Claimed first nontrivial implication\n\n${p.firstImplication}`,
        spec: gateSpec,
        models,
      }, gateStop.signal).then(({
        text, usage: criticUsage, promptChars, durationMs,
        servedModel, reportedModel, providerSessionId, backendCwd,
        attempts, requests,
      }) => {
        // A cancelled gate must not record a verdict (mirrors verification):
        // an unseen verdict could later unlock concurrent workers nobody reviewed.
        if (!handles.has(id)) return `[gate ${id} cancelled; verdict not recorded]`;
        const verdict = recordGateVerdict(store, p.mechanism, text, criticUsage, {
          promptChars,
          durationMs,
          dispatchId: id,
          // specLabel like every other modelFamily writer (cadence.ts:295,539;
          // coordinator-tools.ts:200) — trace.ts compares this against
          // reportedModel, so the spelling must match across record kinds.
          // Thinking level rides in its own field rather than being fused in.
          modelFamily: servedModel ?? specLabel(gateSpec),
          modelSpec: specKey(gateSpec),
          ...(reportedModel !== undefined ? { reportedModel } : {}),
          ...(providerSessionId !== undefined ? { providerSessionId } : {}),
          ...(backendCwd !== undefined ? { backendCwd } : {}),
          ...(attempts !== undefined ? { attempts } : {}),
          ...(requests !== undefined ? { requests } : {}),
        });
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
      // Idempotence: a byte-identical revision already promoted is a no-op,
      // not a second PROVED.md entry (lin3cut double-promoted r358 across a
      // restart boundary, 2026-08-09).
      const already = store
        .all()
        .find((e) => e.kind === "promotion" && sameRevision(e.revision, rel));
      if (already !== undefined) {
        return toolText(
          `already promoted: ${rel} has a promotion on record (${String(already.ts)}). ` +
            "No duplicate entry was written; cite the existing promotion.",
        );
      }
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
      deps.bumpActivity();
      return toolText(`Promotion recorded in PROVED.md for ${rel}. Update REGISTRY.md to label it 'promoted'.`);
    },
  } as AgentTool;

  const cancelWorker: AgentTool = {
    name: "cancel_agent",
    label: "Cancel agent",
    description:
      "Interrupt a live agent (reasoner, technician, gate critic, or verification). Per the contract, only on observable struggle evidence, a user " +
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
      deps.bumpActivity();
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
        return refuse(
          store,
          "declaration",
          "no promotion is on record; the completion criterion requires the final result to pass " +
            "the full cadence (verify, then record_promotion) first.",
        );
      }
      deps.declare(p);
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

  return {
    dispatchReasoner,
    dispatchTechnician,
    dispatchGateCritic,
    recordPromotion,
    cancelWorker,
    steerWorker,
    declareState,
  };
}

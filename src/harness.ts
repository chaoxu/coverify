import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  appendJournal,
  newEvidencePath,
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
  statementHash,
  type ReasonerPacket,
  type TechnicianPacket,
} from "./gates.js";
import { loadLauncherContract } from "./launcher.js";
import {
  buildModels,
  CHARGES,
  createRoleSession,
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
  /** Provider-reported usage, read at completion (undefined for CLI oracles). */
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
const COORDINATOR_CONTEXT_TOKENS = Number(process.env.COVERIFY_COORDINATOR_CONTEXT_TOKENS ?? 150_000);

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
  const settledQueue: { h: Handle; report: string }[] = [];
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

  /** Registers a settled-queue handle: the one async pattern every dispatch shares. */
  const registerHandle = (h: Omit<Handle, "settled">) => {
    const handle = h as Handle;
    handle.settled = handle.promise.then(
      (report) => {
        if (handles.has(handle.id)) settledQueue.push({ h: handle, report });
      },
      (err: unknown) => {
        if (handles.has(handle.id))
          settledQueue.push({ h: handle, report: `[${handle.id} failed: ${String(err)}]` });
      },
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
      handles.size,
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
    store.append({
      kind: "dispatch",
      id,
      role,
      mechanism: packet.mechanism,
      task: packet.task,
      modelFamily: specLabel(spec),
    });
    const packetPrompt =
      `# Task\n\n${packet.task}\n\n# Deliverable\n\n${packet.deliverable}\n\n# Context\n\n${packet.context}` +
      (isTechnician
        ? `\n\n# Preregistered computation\n\n${(packet as TechnicianPacket).computation}`
        : "") +
      (role === "reasoner" && (packet as ReasonerPacket).literature
        ? `\n\n# Literature question (granted)\n\n${(packet as ReasonerPacket).literature}`
        : "");
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
      session = createRoleSession({
        contract,
        charge: isTechnician ? CHARGES.technician : CHARGES.reasoner,
        workspace: {
          cwd: evidenceDir,
          scope: { allow: [evidenceDir], deny: [] },
          code: isTechnician,
          // Role-authoritative: tool schemas allow unknown extras, so a
          // `literature` field smuggled onto a technician packet must not
          // grant the librarian alongside run_script.
          literature: role === "reasoner" && (packet as ReasonerPacket).literature !== undefined,
        },
        spec,
        models,
      });
      promise = session.ask(`Assigned evidence directory: ${evidenceDir}\n\n${packetPrompt}`);
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
      "Run a fresh idea-gate critic on one mechanism before investing a wave in it. Give only " +
      "the frozen target, promoted premises, the mechanism, and its claimed first nontrivial implication.",
    parameters: Type.Object({
      mechanism: Type.String(),
      firstImplication: Type.String({ description: "The claimed first nontrivial implication" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { mechanism: string; firstImplication: string };
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = readLedger(dir, "PROVED.md");
      const { text, usage: criticUsage } = await runRole({
        contract,
        charge: CHARGES.gateCritic,
        prompt: `# Frozen target\n\n${statement}\n\n# Promoted premises\n\n${proved}\n\n# Proposed mechanism\n\n${p.mechanism}\n\n# Claimed first nontrivial implication\n\n${p.firstImplication}`,
        spec: roleModelSpec("gateCritic"),
        models,
      });
      activityThisWake++;
      const verdict = recordGateVerdict(store, p.mechanism, text, criticUsage);
      if (verdict === "UNPARSEABLE") {
        return toolText(
          `UNPARSEABLE verdict (recorded as such; does not unlock waves). The critic's first line ` +
          `was not a verdict token — re-run the gate.\n\n${text}`,
        );
      }
      return toolText(`${verdict}\n\n${text}`);
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
      const passOf = (text: string) =>
        parseFirstLineVerdict(text, ["VERDICT: PASS", "VERDICT: FAIL"]) === "VERDICT: PASS";

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
      const proved = readLedger(dir, "PROVED.md");
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
      const cadence = async (): Promise<string> => {
        // Stage 1 — hostile audit (bundle includes PROVED.md so promoted claims are checkable).
        const { text: auditText, usage: auditTextUsage } = await runRole({
          contract,
          charge: CHARGES.hostileAuditor,
          prompt: `# Statement\n\n${statement}\n\n# Currently promoted (PROVED.md)\n\n${proved}\n\n# Declared dependencies (coordinator-authored)\n\n${p.declaredDependencies}\n\n# Candidate revision ${rel}\n\n${candidate}`,
          spec: roleModelSpec("hostileAuditor"),
          models,
        });
        addUsage(auditTextUsage);
        abortIfCancelled();
        const auditPass = passOf(auditText);
        const auditEvidence = newEvidencePath(dir, `audits/${slug}.audit`);
        fs.writeFileSync(auditEvidence, auditText);
        store.append({
          kind: "audit",
          revision: rel,
          verdict: auditPass ? "PASS" : "FAIL",
          candidateHash,
          statementHash: stmtHash,
          artifact: path.relative(dir, auditEvidence),
          suppliedInputs: ["candidate revision", "statement", "PROVED.md", "declared dependencies"],
          blindness:
            "fresh instance (enforced); bundle built by harness (enforced); declaredDependencies coordinator-authored (instructed only)",
          modelFamily: specLabel(roleModelSpec("hostileAuditor")),
          usage: auditTextUsage,
        });
        if (!auditPass) {
          return `STAGE 1 FAIL — not verifier-backed. Audit saved: ${path.relative(dir, auditEvidence)}\n\n${auditText}`;
        }

        // Bundle certification (contract): a fresh agent shown both the
        // candidate and the bundle certifies no element is a stepwise
        // paraphrase of — or contains — the candidate argument. Always rerun:
        // the certifier sees the candidate, so a new revision needs its own cert.
        const { text: certText, usage: certTextUsage } = await runRole({
          contract,
          charge: CHARGES.bundleCertifier,
          prompt: `# Candidate revision ${rel}\n\n${candidate}\n\n# Proposed reconstruction bundle\n\n${bundle}`,
          spec: roleModelSpec("bundleCertifier"),
          models,
        });
        addUsage(certTextUsage);
        abortIfCancelled();
        const certPass = passOf(certText);
        const certEvidence = newEvidencePath(dir, `audits/${slug}.bundle-cert`);
        fs.writeFileSync(certEvidence, certText);
        store.append({
          kind: "bundle-cert",
          revision: rel,
          verdict: certPass ? "PASS" : "FAIL",
          candidateHash,
          statementHash: stmtHash,
          bundleHash,
          artifact: path.relative(dir, certEvidence),
          suppliedInputs: ["candidate revision", "proposed bundle"],
          blindness: "fresh instance (enforced); sees candidate by design (certification step)",
          modelFamily: specLabel(roleModelSpec("bundleCertifier")),
          usage: certTextUsage,
        });
        if (!certPass) {
          return (
            `BUNDLE CERTIFICATION FAIL — the bundle leaks the candidate argument; stage 2 refused. ` +
            `Revise keyIdeas/allowedSources and retry. Cert saved: ${path.relative(dir, certEvidence)}\n\n${certText}`
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
          const { text, usage: reconTextUsage } = await runRole({
            contract,
            charge: CHARGES.reconstructor,
            prompt: `# Statement\n\n${statement}\n\n# High-level key ideas\n\n${p.keyIdeas}\n\n# Allowed sources\n\n${p.allowedSources}\n\n# Promoted premises\n\n${proved}`,
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
            suppliedInputs: ["statement", "key ideas", "allowed sources", "promoted premises"],
            blindness:
              "fresh instance (enforced); candidate file withheld by harness (enforced); keyIdeas coordinator-authored (instructed only — paraphrase risk not machine-checked)",
            modelFamily: specLabel(roleModelSpec("reconstructor")),
            usage: reconTextUsage,
          });
        }

        // Stage 2b — comparison: maps the reconstruction to the candidate's
        // conclusions and declared dependencies. This verdict is stage 2's PASS.
        const { text: compareText, usage: compareTextUsage } = await runRole({
          contract,
          charge: CHARGES.comparator,
          prompt: `# Statement\n\n${statement}\n\n# Independent reconstruction\n\n${reconText}\n\n# Candidate revision ${rel}\n\n${candidate}\n\n# Declared dependencies\n\n${p.declaredDependencies}`,
          spec: roleModelSpec("comparator"),
          models,
        });
        addUsage(compareTextUsage);
        abortIfCancelled();
        const comparePass = passOf(compareText);
        const compareEvidence = newEvidencePath(dir, `audits/${slug}.comparison`);
        fs.writeFileSync(compareEvidence, compareText);
        store.append({
          kind: "comparison",
          revision: rel,
          verdict: comparePass ? "PASS" : "FAIL",
          candidateHash,
          statementHash: stmtHash,
          artifact: path.relative(dir, compareEvidence),
          suppliedInputs: ["statement", "reconstruction", "candidate", "declared dependencies"],
          blindness: "fresh instance (enforced); sees both sides by design (comparison step)",
          modelFamily: specLabel(roleModelSpec("comparator")),
          usage: compareTextUsage,
        });
        const promotion = checkPromotion(store, dir, rel);
        return (
          `STAGE 1 PASS; STAGE 2 ${comparePass ? "PASS" : "FAIL"} (comparison verdict). ` +
          (promotion.allowed
            ? `Revision ${rel} is verifier-backed; record_promotion is now legal for it.`
            : `Not promotable: ${promotion.reason}`) +
          (priorRecon ? `\nReconstruction carried forward from revision ${priorRecon.revision}.` : "") +
          `\nArtifacts: ${path.relative(dir, auditEvidence)}, ${reconArtifact}, ${path.relative(dir, compareEvidence)}` +
          `\n\n## Stage 1 (hostile audit)\n\n${auditText}\n\n## Stage 2b (comparison)\n\n${compareText}`
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
        usage: () =>
          usages.length === 0
            ? undefined
            : usages.reduce((t, u) => ({
                input: (t.input ?? 0) + (u.input ?? 0),
                output: (t.output ?? 0) + (u.output ?? 0),
                cacheRead: (t.cacheRead ?? 0) + (u.cacheRead ?? 0),
                cacheWrite: (t.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
              })),
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
      "Pause is operational state, not blocked or complete.",
    parameters: Type.Object({
      state: Type.Union([Type.Literal("pause"), Type.Literal("complete")]),
      reason: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { state: "pause" | "complete"; reason: string };
      if (p.state === "complete" && !store.all().some((e) => e.kind === "promotion")) {
        return toolText(
          "DECLARATION REFUSED: no promotion is on record; the completion criterion requires the " +
            "final result to pass the full cadence (verify, then record_promotion) first.",
        );
      }
      declaration = p;
      return toolText(`Declared: ${p.state}. The harness will stop after this wake.`);
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
  while (true) {
    wakeCount++;
    if (opts.maxWakes !== undefined && wakeCount > opts.maxWakes) {
      appendJournal(dir, { kind: "note", note: `user wake limit ${opts.maxWakes} reached; pausing` });
      return `${lastWakeText}\n\n[coverify: user wake limit reached; campaign paused, resume with 'coverify resume']`;
    }
    activityThisWake = 0;
    const limits: string[] = [];
    if (opts.userAgentLimit !== undefined) limits.push(`agents ${handles.size}/${opts.userAgentLimit}`);
    if (opts.maxWakes !== undefined) limits.push(`wakes ${wakeCount}/${opts.maxWakes}`);
    const digest =
      (handles.size === 0
        ? "No workers are currently running."
        : `Still running (do not interrupt for slowness): ${[...handles.values()]
            .map((h) => `${h.id} [${h.mechanism}]`)
            .join(", ")}`) + (limits.length > 0 ? `\nUser limits: ${limits.join("; ")}.` : "");
    const reports = settledQueue.splice(0, settledQueue.length);
    for (const s of reports) handles.delete(s.h.id);
    const reportSections = reports.map((s) => {
      const reportPath = newEvidencePath(dir, `${s.h.id}/report`);
      fs.writeFileSync(reportPath, s.report);
      store.append({ kind: "completion", id: s.h.id, report: path.relative(dir, reportPath), usage: s.h.usage?.() });
      return `## ${s.h.id} [${s.h.mechanism}] (saved: ${path.relative(dir, reportPath)})\n\n${s.report}`;
    });
    appendJournal(dir, { kind: "wake", wake: wakeCount, live: handles.size, newReports: reports.length });
    const idleNudge =
      handles.size === 0 && reportSections.length === 0 && wakeCount > 1
        ? "\nNothing is live and no new reports arrived. Per the contract the campaign remains " +
          "authorized: dispatch the next materially new wave, or explicitly declare_campaign_state."
        : "";
    // Resident coordinator: rebuild only at start or past the context cap
    // (the compaction analog — the launcher's restart rule is the rebuild).
    if (coordinator && coordinator.approxTokens() > COORDINATOR_CONTEXT_TOKENS) {
      appendJournal(dir, {
        kind: "note",
        note: `coordinator context cap (${COORDINATOR_CONTEXT_TOKENS} tok) reached; rebuilding via restart rule`,
      });
      coordinator = undefined;
    }
    let fresh = false;
    if (coordinator === undefined) {
      fresh = true;
      coordinator = createRoleSession({
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
      });
    }
    const newsBlock =
      reportSections.length > 0
        ? `# Newly completed work\n\n${reportSections.join("\n\n---\n\n")}`
        : "No new completions this wake.";
    // Pre-compaction warning: past 80% of the cap, remind the coordinator
    // that the next rebuild will start from the ledgers alone.
    const compactionWarning =
      !fresh && coordinator.approxTokens() > COORDINATOR_CONTEXT_TOKENS * 0.8
        ? "\nNote: your session is approaching its context cap and will soon be rebuilt from the " +
          "ledgers alone (the contract's restart rule). Anything living only in this conversation " +
          "will be lost — ensure CURRENT_FRONTIER.md and the registry capture it now."
        : "";
    lastWakeText = await coordinator.ask(
      fresh
        ? `${resumeBundle(dir)}\n\n---\n\nCampaign directory: ${dir}\n${lostNote}${digest}${idleNudge}\n\n${newsBlock}`
        : `${lostNote}${digest}${idleNudge}${compactionWarning}\n\n${newsBlock}`,
    );
    appendJournal(dir, {
      kind: "usage",
      role: "coordinator",
      cumulative: coordinator.usage(),
      approxContextTokens: coordinator.approxTokens(),
    });
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


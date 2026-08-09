// The verification cadence: the launcher's two-stage verification compiled
// into code — fresh hostile audit, bundle certification, blind
// reconstruction, fresh comparison — with hash-binding, anti-verdict-
// shopping, and the carry-forward rules. This is the most clause-dense code
// in the repo (conformance table: the verification rows all point here);
// extracted from harness.ts so the enforcement is auditable file-by-file,
// while the scheduler it runs under stays semantics-invisible.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { newEvidencePath, promotedStatementsView, readLedger, sha256File, sha256Text } from "./campaign.js";
import { refuse } from "./observe.js";
import {
  GateStore,
  VERIFICATION_MECHANISM_PREFIX,
  assertCandidateWithheld,
  checkPromotion,
  parseFirstLineVerdict,
  priorReusableRecord,
  sameRevision,
  statementHash,
} from "./gates.js";
import { CHARGES } from "./roles.js";
import { isCliProvider } from "./backends.js";
import {
  addUsage,
  type Models,
  roleModelSpec,
  type RoleUsage,
  runRole,
  specLabel,
} from "./providers.js";
import { toolText } from "./sandbox.js";

/** What the cadence needs from the campaign loop. Narrow by design: the
 *  cadence never touches the settle queue, wake counters, or compaction —
 *  it dispatches itself as one verification handle and records gate state. */
export interface CadenceDeps {
  dir: string;
  store: GateStore;
  /** The launcher contract text, embedded verbatim in every role prompt. */
  contract: string;
  models: Models;
  evidenceRelative: (p: string) => string | undefined;
  /** Live declaration state: a declared campaign refuses new verification. */
  declaration: () => { state: string } | undefined;
  mintVerificationId: () => string;
  /** Cancellation surface: a cadence whose handle is gone must stop recording. */
  hasHandle: (id: string) => boolean;
  liveCount: () => number;
  registerHandle: (h: {
    id: string;
    kind: "verification";
    mechanism: string;
    stop?: () => void;
    promise: () => Promise<string>;
    usage?: () => RoleUsage | undefined;
  }) => void;
}

export function requestVerificationTool(deps: CadenceDeps): AgentTool {
  const { dir, store, contract, models } = deps;
  return {
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
      "forbids reusing a verifier response that influenced the repair. All verdicts are recorded bound to content " +
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
      const declared = deps.declaration();
      if (declared) {
        return refuse(
          store,
          "verification",
          `the campaign is already declared ${declared.state}; cease dispatch and checkpoint. ` +
            "Re-request verification after resuming.",
        );
      }
      const p = params as {
        revision: string;
        declaredDependencies: string;
        keyIdeas: string;
        allowedSources: string;
        rebuttalArtifact?: string;
      };
      const rel = deps.evidenceRelative(p.revision);
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
        return refuse(
          store,
          "verification",
          "this exact bundle already failed certification as leaking the candidate argument. " +
            "Revise keyIdeas/allowedSources before retrying.",
          { revision: rel, candidateHash },
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
        const rebuttalRel = p.rebuttalArtifact ? deps.evidenceRelative(p.rebuttalArtifact) : undefined;
        if (!rebuttalRel || !fs.existsSync(path.join(dir, "EVIDENCE", rebuttalRel))) {
          return refuse(
            store,
            "verification",
            "a substantive FAIL is on record for this exact revision. Per the contract, respond " +
              "with a load-bearing repair (new revision), retraction, or a recorded rebuttal " +
              "artifact refuting the exact reported gap (pass rebuttalArtifact).",
            { revision: rel, candidateHash },
          );
        }
        store.append({ kind: "rebuttal", revision: rel, artifact: rebuttalRel });
      }
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = promotedStatementsView(dir);
      const slug = rel.replace(/[\/]/g, "_");
      const bundleHash = sha256Text(bundle);
      const provedHash = sha256Text(proved);
      // Spend from a provider call that has returned but whose stage record
      // has not been written yet. If the cadence is cancelled in that window,
      // this is emitted as its own leaf record — so cadence spend is ALWAYS a
      // leaf, never a residual recovered by subtracting children from a
      // roll-up. That roll-up cost 80.4M tokens of double-counting and two
      // ordering bugs in four commits before it was deleted.
      let pending: RoleUsage | undefined;
      const recordUsage = (u?: RoleUsage) => {
        pending = u;
      };
      // The stage record carries the usage, so the pending spend is accounted
      // for; clear it. Called immediately AFTER store.append returns.
      const appendedChild = (_kind: string) => {
        pending = undefined;
      };
      // Cancelled mid-stage: the provider was paid and no stage record exists.
      // Emit the spend as its own leaf rather than losing it.
      const flushOrphanSpend = () => {
        if (!pending) return;
        store.append({
          kind: "role-call",
          dispatchId: id,
          revision: rel,
          orphaned: "cadence cancelled after the provider returned, before the stage record",
          usage: pending,
        });
        pending = undefined;
      };

      // The cadence runs as an async handle, like a worker: during a long
      // blind reconstruction the coordinator keeps gating, dispatching, and
      // writing ledgers; the verdict arrives at a later wake.
      // Set once the handle exists; a cancelled cadence must stop recording
      // verdicts — otherwise cancel_agent would hide a verification that keeps
      // running and can still authorize promotion off an unseen PASS.
      // Minted before the stage helpers close over it: every stage record
      // carries its cadence's dispatch id, which is what lets a later run
      // recognize a stranded (dispatched, never completed) cadence.
      const id = deps.mintVerificationId();
      const cadenceStop = new AbortController();
      let cancelled: () => boolean = () => cadenceStop.signal.aborted;
      const abortIfCancelled = () => {
        if (!cancelled()) return;
        // The provider may already have been paid for a stage whose record was
        // never written. Emit that spend as a leaf before unwinding, so it is
        // on file rather than recoverable only by subtraction.
        flushOrphanSpend();
        throw new Error(`verification cancelled; no verdict recorded for ${rel}`);
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
        const {
          text, usage, promptChars, durationMs, servedModel, reportedModel,
          providerSessionId, backendCwd,
        } = await runRole({
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
          // Join keys into the provider's own rollout, where the rate-limit
          // trajectory lives (see RoleSession.providerSessionId).
          ...(providerSessionId !== undefined ? { providerSessionId } : {}),
          ...(backendCwd !== undefined ? { backendCwd } : {}),
          ...stage.extra,
          dispatchId: id,
          artifact,
          // Content-binds the record to the saved reply so a byte-identical
          // re-run (priorReusableRecord) can reuse it, and an edited artifact can't.
          artifactHash: sha256File(evidence),
          suppliedInputs: stage.ctx.suppliedInputs,
          blindness: stage.blindness,
          toolVisibility: toolVisibilityOf(spec.provider),
          // Attested served model when the backend reports one (issue #20):
          // the requested spec label is testimony; the attestation is truth.
          modelFamily: servedModel ?? specLabel(spec),
          // Self-reported model beside it (#21 P3) — journal-only, never a
          // refusal trigger; modelSubstitutions() surfaces disagreements.
          ...(reportedModel !== undefined ? { reportedModel } : {}),
          usage,
          promptChars,
          durationMs,
        });
        appendedChild(stage.kind);
        return { text, pass, unparseable: verdictLine === undefined, artifact };
      };

      // Restart-lost stage reuse: the contract allows reusing a verifier
      // response only for "a re-run on the byte-identical candidate (a
      // protocol or infrastructure failure)". A cadence that died between
      // stages strands its completed PASSes; a fresh request on identical
      // bytes reuses them instead of paying the stage again. Three checks,
      // all enforced (priorReusableRecord): every input the stage saw matches by
      // content hash, the saved artifact is byte-unchanged, and the PASS's
      // own cadence is stranded — dispatched but never completed, the
      // journal's definition of an infrastructure failure. An ordinary
      // re-request whose prior cadence finished (a rebuttal challenge, a
      // duplicate ask) runs every stage fresh. A repaired candidate changes
      // candidateHash and never matches; comparison — the final verdict — is
      // never reused. Recorded as a carried-forward gate record so promotion
      // checking and the journal both see it.
      const dependenciesHash = sha256Text(p.declaredDependencies);
      const carried: string[] = [];
      // The one carried-record writer: copies the artifact binding and
      // provenance from the prior record, adds this cadence's identity, and
      // takes the reuse-policy justification as the hand-authored blindness
      // string (per the 2026-08-02 narrowed-form decision).
      const carriedRecord = (
        kind: "audit" | "bundle-cert" | "reconstruction",
        prior: NonNullable<ReturnType<typeof priorReusableRecord>>,
        extra: Record<string, unknown>,
        blindness: string,
      ): { text: string; artifact: string } => {
        // Same invariant as verdictStage: a cancelled cadence must stop
        // recording verdicts — enforced here too so a future await added
        // before a carry can't silently bypass cancel_agent.
        abortIfCancelled();
        const artifact = prior.artifact as string;
        store.append({
          kind,
          revision: rel,
          candidateHash,
          statementHash: stmtHash,
          ...extra,
          artifact,
          artifactHash: prior.artifactHash,
          carriedForwardFrom: prior.revision,
          suppliedInputs: prior.suppliedInputs,
          blindness,
          modelFamily: prior.modelFamily,
        });
        return { text: fs.readFileSync(path.join(dir, artifact), "utf-8"), artifact };
      };
      const carriedStage = (
        kind: "audit" | "bundle-cert",
        prior: NonNullable<ReturnType<typeof priorReusableRecord>>,
        extra: Record<string, unknown>,
      ): { text: string; pass: boolean; unparseable: boolean; artifact: string } => {
        const label = kind === "audit" ? "audit" : "bundle certification";
        carried.push(`${label} (from stranded ${prior.dispatchId} on ${prior.revision})`);
        const { text, artifact } = carriedRecord(
          kind,
          prior,
          { verdict: "PASS", ...extra, dispatchId: id, carriedForwardDispatch: prior.dispatchId },
          "carried forward (enforced): every input byte-identical to the prior PASS, artifact " +
            "byte-unchanged, and the prior cadence stranded (dispatched, never completed — a " +
            "protocol or infrastructure failure, not a repair)",
        );
        appendedChild(kind);
        return { text, pass: true, unparseable: false, artifact };
      };

      const cadence = async (): Promise<string> => {
        // Stage 1 — hostile audit (bundle includes PROVED.md so promoted claims are checkable).
        const auditInputHashes = { candidateHash, statementHash: stmtHash, provedHash, dependenciesHash };
        const priorAudit = priorReusableRecord(store, dir, "audit", auditInputHashes, { requireStranded: true });
        const audit = priorAudit
          ? carriedStage("audit", priorAudit, { provedHash, dependenciesHash })
          : await verdictStage({
          kind: "audit",
          role: "hostileAuditor",
          extra: { provedHash, dependenciesHash },
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
        // paraphrase of — or contains — the candidate argument. The certifier
        // sees the candidate, so a new revision needs its own cert; only a
        // byte-identical re-run (same candidate, same bundle) reuses a PASS.
        // statementHash is over-strict — the certifier sees only candidate +
        // bundle — but a statement change invalidates all verification
        // evidence anyway (amend flow), so the extra key only ever refuses.
        const certInputHashes = { candidateHash, statementHash: stmtHash, bundleHash };
        const priorCert = priorReusableRecord(store, dir, "bundle-cert", certInputHashes, { requireStranded: true });
        const cert = priorCert
          ? carriedStage("bundle-cert", priorCert, { bundleHash })
          : await verdictStage({
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
        // requireStranded: false — deliberately broader than the verdict
        // stages. The reconstructor never sees any candidate, so its output
        // cannot have been influenced by a repair — reusing it across
        // completed cadences is the whole point (it is the dominant cost of
        // a clerical re-cadence). candidateHash stays in the keys as an
        // influence-tracking bound, not a disclosed input.
        const priorRecon = priorReusableRecord(
          store,
          dir,
          "reconstruction",
          { candidateHash, statementHash: stmtHash, bundleHash, provedHash },
          { requireStranded: false },
        );
        abortIfCancelled();
        let reconText: string;
        let reconArtifact: string;
        if (priorRecon) {
          const carriedR = carriedRecord(
            "reconstruction",
            priorRecon,
            // carriedStage stamps this; without it a carried reconstruction
            // stays unjoinable to its cadence — systematically the cheap ones.
            { bundleHash, provedHash, dispatchId: id },
            "carried forward (enforced): statement, bundle, and promoted premises byte-identical " +
              "to the prior reconstruction's inputs; the reconstructor never saw any candidate",
          );
          appendedChild("reconstruction");
          reconText = carriedR.text;
          reconArtifact = carriedR.artifact;
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
          // Resolved once: the spec the call requested is the spec the record
          // names and attributes tool visibility to.
          const reconSpec = roleModelSpec("reconstructor");
          const {
            text,
            usage: reconTextUsage,
            promptChars: reconPromptChars,
            durationMs: reconDurationMs,
            servedModel: reconServedModel,
            reportedModel: reconReportedModel,
            providerSessionId: reconProviderSessionId,
            backendCwd: reconBackendCwd,
          } = await runRole({
            contract,
            charge: CHARGES.reconstructor,
            prompt: reconCtx.prompt,
            spec: reconSpec,
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
            // Every other stage carries this (verdictStage sets it); without
            // it all 139 reconstruction records on file are unjoinable to
            // their cadence, which is why the roll-up double-count could only
            // be found by hand-matching. Pure addition.
            dispatchId: id,
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
            toolVisibility: toolVisibilityOf(reconSpec.provider),
            modelFamily: reconServedModel ?? specLabel(reconSpec),
            ...(reconReportedModel !== undefined ? { reportedModel: reconReportedModel } : {}),
            usage: reconTextUsage,
            promptChars: reconPromptChars,
            durationMs: reconDurationMs,
            // The most expensive stage in the cadence, and until now the only
            // one still unjoinable to the provider's rate-limit trajectory.
            ...(reconProviderSessionId !== undefined
              ? { providerSessionId: reconProviderSessionId }
              : {}),
            ...(reconBackendCwd !== undefined ? { backendCwd: reconBackendCwd } : {}),
          });
          appendedChild("reconstruction");
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
          (carried.length > 0 ? `\nCarried forward on byte-identical inputs: ${carried.join("; ")}.` : "") +
          (priorRecon ? `\nReconstruction carried forward from revision ${priorRecon.revision}.` : "") +
          `\nArtifacts: ${audit.artifact}, ${reconArtifact}, ${compare.artifact}` +
          `\n\n## Stage 1 (hostile audit)\n\n${audit.text}\n\n## Stage 2b (comparison)\n\n${compare.text}`
        );
      };

      // Journaled like an agent dispatch so ids stay unique across restarts
      // (maxHandleId reads dispatch records only).
      store.append({
        kind: "dispatch",
        id,
        role: "verification",
        mechanism: `${VERIFICATION_MECHANISM_PREFIX}${rel}`,
        task: rel,
      });
      cancelled = () => cadenceStop.signal.aborted || !deps.hasHandle(id);
      deps.registerHandle({
        id,
        kind: "verification",
        // A cadence is composite work: stopping it means its stage calls stop
        // recording, which abortIfCancelled already enforces between stages.
        stop: () => cadenceStop.abort(),
        mechanism: `${VERIFICATION_MECHANISM_PREFIX}${rel}`,
        // Passed as a thunk: with carried-forward stages the cadence's prefix
        // is fully synchronous and checks abortIfCancelled(), so it must not
        // start before registerHandle sets the handle — registerHandle
        // guarantees that ordering for thunks.
        promise: cadence,
        // No `usage` here, deliberately. Every stage of this cadence already
        // records its own, and a summary alongside them was a derived
        // aggregate inside an append-only log: it cost 80.4M tokens of
        // double-counting (27% of the 2026-08-09 study), took two ordering
        // fixes in four commits, and nothing ever read it. Cadence cost is
        // now GROUP BY dispatchId over leaves — which workers already require.
      });
      return toolText(
        `verification ${id} dispatched on ${rel} (${deps.liveCount()} live). The verdict arrives at a ` +
          "later wake; keep gating, dispatching, and ledger work going meanwhile.",
      );
    },
  } as AgentTool;
}

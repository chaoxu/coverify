// The launcher's two-stage verification compiled into code — fresh hostile
// audit, bundle certification, blind reconstruction, fresh comparison — with
// hash-binding, anti-verdict-shopping, and the carry-forward rules. The most
// clause-dense code in the repo; the conformance table's verification rows all
// point here.
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
  defined,
  parseFirstLineVerdict,
  priorReusableRecord,
  sameRevision,
  statementHash,
} from "./gates.js";
import { CHARGES } from "./roles.js";
import { type BilledFailure, isCliProvider } from "./backends.js";
import {
  type Models,
  roleModelSpec,
  type RoleUsage,
  runRole,
  specKey,
  specLabel,
} from "./providers.js";
import { toolText } from "./sandbox.js";

/** What the cadence needs from the campaign loop. Narrow by design: it never
 *  touches the settle queue, wake counters, or compaction. */
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
  /** See CoordinatorDeps.wake — the wake -> dispatch edge. */
  wake: () => number;
  /** Cancellation surface: a cadence whose handle is gone must stop recording. */
  hasHandle: (id: string) => boolean;
  liveCount: () => number;
  registerHandle: (h: {
    id: string;
    kind: "verification";
    mechanism: string;
    stop?: () => void;
    promise: () => Promise<string>;
    // No `usage` reporter: a cadence-level total would be a sum of stage
    // records already on file (see the call site).
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
      // One read, one hash: a candidate in a live worker's evidence directory
      // can be rewritten between two reads, recording a hash of bytes no
      // verifier ever saw.
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
      // Matched on content, not filename: "a substantive FAIL from any stage
      // stands against the revision that received it", and identical bytes under
      // a different name are that revision.
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
      // Spend from a returned provider call whose stage record is not yet
      // written: set right after each runRole, cleared right after the append
      // that carries it. If the cadence unwinds in that window it is emitted as
      // its own leaf, so cadence spend is ALWAYS a leaf — the roll-up that
      // replaced this cost 80.4M tokens of double-counting.
      let unrecordedSpend: RoleUsage | undefined;

      // The cadence runs as an async handle, like a worker: the verdict arrives
      // at a later wake while the coordinator keeps working. The id is minted
      // before the stage helpers close over it, because every stage record
      // carries its cadence's dispatch id — that is what lets a later run
      // recognize a stranded (dispatched, never completed) cadence.
      const id = deps.mintVerificationId();
      const cadenceStop = new AbortController();
      let cancelled: () => boolean = () => cadenceStop.signal.aborted;
      /** Spend attached to a thrown error by a CLI backend that failed after
       *  the provider had already been paid (backends.ts attaches `usage` to
       *  the rejection). Leafed like any other unrecorded spend. */
      const flushErrorSpend = (e: unknown, why: string) => {
        const { usage, providerSessionId, backendCwd } = e as BilledFailure;
        if (!usage) return;
        // Claim this payment before writing it: the error is rethrown to the
        // handle's settle path, which also records billed spend.
        (e as BilledFailure).usageLeafed = true;
        store.append({
          kind: "role-call",
          dispatchId: id,
          revision: rel,
          orphaned: why,
          usage,
          // The failed call still has a rollout; without its join keys this leaf
          // is untraceable back to a provider.
          ...defined({ providerSessionId, backendCwd }),
        });
      };
      /** The provider was paid for a stage whose record was never written; emit
       *  that spend as its own leaf. Idempotent, and called from BOTH the
       *  cancellation path and the cadence's outer finally, because
       *  newEvidencePath, writeFileSync, sha256File and store.append can all
       *  throw in that window too. */
      const flushUnrecordedSpend = (why: string) => {
        if (!unrecordedSpend) return;
        store.append({
          kind: "role-call",
          dispatchId: id,
          revision: rel,
          orphaned: why,
          usage: unrecordedSpend,
        });
        unrecordedSpend = undefined;
      };
      const abortIfCancelled = () => {
        if (!cancelled()) return;
        flushUnrecordedSpend("cadence cancelled after the provider returned, before the stage record");
        throw new Error(`verification cancelled; no verdict recorded for ${rel}`);
      };
      // One list drives both the prompt and the journal's suppliedInputs, so
      // what the model was sent and what the record testifies cannot drift.
      // `blindness` stays hand-authored per call: it carries
      // enforcement-modality and provenance claims a section list cannot derive.
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

      /**
       * One verdict stage: a fresh role call, a first-line PASS/FAIL parse, the
       * output saved as a citable artifact, and a gate record bound to the
       * candidate + statement hashes. Audit, bundle certification and comparison
       * differ only in inputs and disclosure.
       */
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
          providerSessionId, backendCwd, attempts, requests,
        } = await runRole({
          contract,
          charge: CHARGES[stage.role],
          prompt: stage.ctx.prompt,
          spec,
          models,
        });
        unrecordedSpend = usage;
        abortIfCancelled();
        const evidence = newEvidencePath(dir, `audits/${slug}.${stage.kind}`);
        fs.writeFileSync(evidence, text);
        const artifact = path.relative(dir, evidence);
        const verdictLine = parseFirstLineVerdict(text, ["VERDICT: PASS", "VERDICT: FAIL"]);
        const pass = verdictLine === "VERDICT: PASS";
        // A reply with no verdict line is a protocol failure: never PASS
        // (launcher), but UNPARSEABLE rather than FAIL, so it neither arms
        // anti-verdict-shopping nor hash-blocks a legitimate bundle forever.
        const verdict = pass ? "PASS" : verdictLine === undefined ? "UNPARSEABLE" : "FAIL";
        try {
        store.append({
          kind: stage.kind,
          revision: rel,
          verdict,
          candidateHash,
          statementHash: stmtHash,
          // Join keys into the provider's own rollout, where the rate-limit
          // trajectory lives (see RoleSession.providerSessionId).
          ...defined({ providerSessionId, backendCwd }),
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
          // The requested spec INCLUDING thinking level: specLabel drops
          // @thinking, without which reasoning effort is unrecoverable per call
          // and issue #31's effort A/B is unmeasurable.
          modelSpec: specKey(spec),
          // Self-reported model (#21 P3) — journal-only, never a refusal
          // trigger; modelSubstitutions() surfaces disagreements.
          ...defined({ reportedModel }),
          usage,
          promptChars,
          durationMs,
          // stage -> provider request, the tree's last edge.
          ...defined({ attempts, requests }),
        });
        } finally {
          // Cleared in a finally so a failure of store.append's in-tree journal
          // MIRROR — which runs after the authoritative line is on disk —
          // cannot leave the debt standing and emit a duplicate leaf.
          unrecordedSpend = undefined;
        }
        return { text, pass, unparseable: verdictLine === undefined, artifact };
      };

      // Restart-lost stage reuse: the contract allows reusing a verifier response
      // only for "a re-run on the byte-identical candidate (a protocol or
      // infrastructure failure)". A cadence that died between stages strands its
      // completed PASSes, and a fresh request on identical bytes reuses them.
      // All three conditions are enforced in priorReusableRecord. Comparison —
      // the final verdict — is never reused.
      const dependenciesHash = sha256Text(p.declaredDependencies);
      const carried: string[] = [];
      // The one carried-record writer: copies the artifact binding and
      // provenance from the prior record, adds this cadence's identity, and takes
      // the reuse-policy justification as the hand-authored blindness string.
      const carriedRecord = (
        kind: "audit" | "bundle-cert" | "reconstruction",
        prior: NonNullable<ReturnType<typeof priorReusableRecord>>,
        extra: Record<string, unknown>,
        blindness: string,
      ): { text: string; artifact: string } => {
        // Same invariant as verdictStage: a cancelled cadence must stop recording
        // verdicts, enforced here too so a future await added before a carry
        // cannot silently bypass cancel_agent.
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
        unrecordedSpend = undefined;
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

        // Bundle certification (contract): a fresh agent shown both candidate
        // and bundle certifies that no element is a stepwise paraphrase of, or
        // contains, the candidate argument. statementHash in the key is
        // over-strict — the certifier never sees the statement — but a statement
        // change invalidates all verification evidence anyway, so it only ever
        // refuses.
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

        // Stage 2a — blind reconstruction (no verdict; the PASS belongs to the
        // comparison).
        //
        // Reuse is keyed on the identical candidate. The contract for a repaired
        // one: "Invalidate both stages; rerun a fresh hostile audit and then a
        // fresh reconstruction. Never reuse a verifier response that influenced
        // the repair." Keying reuse on the bundle alone broke exactly that, so
        // anything but identical bytes regenerates.
        //
        // requireStranded: false, deliberately broader than the verdict stages —
        // the reconstructor never sees any candidate, so reuse across completed
        // cadences is the point. candidateHash stays in the keys as an
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
            // Without dispatchId a carried reconstruction is unjoinable to its
            // cadence — systematically the cheap ones.
            { bundleHash, provedHash, dispatchId: id },
            "carried forward (enforced): statement, bundle, and promoted premises byte-identical " +
              "to the prior reconstruction's inputs; the reconstructor never saw any candidate",
          );
          unrecordedSpend = undefined;
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
          // checked fact for whole-file interpolation, not testimony.
          assertCandidateWithheld(reconCtx.prompt, candidate);
          // Resolved once: the spec the call requested is the spec the record
          // names and attributes tool visibility to.
          const reconSpec = roleModelSpec("reconstructor");
          const {
            text, usage, promptChars, durationMs, servedModel, reportedModel,
            providerSessionId, backendCwd, attempts, requests,
          } = await runRole({
            contract,
            charge: CHARGES.reconstructor,
            prompt: reconCtx.prompt,
            spec: reconSpec,
            models,
          });
          unrecordedSpend = usage;
          abortIfCancelled();
          reconText = text;
          const reconEvidence = newEvidencePath(dir, `audits/${slug}.reconstruction`);
          fs.writeFileSync(reconEvidence, reconText);
          reconArtifact = path.relative(dir, reconEvidence);
          try {
          store.append({
            kind: "reconstruction",
            // Without this a reconstruction record is unjoinable to its cadence,
            // which is why the roll-up double-count could only be found by
            // hand-matching.
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
            modelFamily: servedModel ?? specLabel(reconSpec),
            modelSpec: specKey(reconSpec),
            ...defined({ reportedModel }),
            usage,
            promptChars,
            durationMs,
            ...defined({ providerSessionId, backendCwd, attempts, requests }),
          });
          } finally {
            unrecordedSpend = undefined;
          }
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
        wake: deps.wake(),
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
        // A thunk, not a promise: with carried-forward stages the cadence's
        // prefix is fully synchronous and checks abortIfCancelled(), so it must
        // not start before registerHandle sets the handle. Every unwinding path
        // flushes, not just cancellation; flushUnrecordedSpend self-clears, so a
        // second call is a no-op.
        promise: async () => {
          try {
            return await cadence();
          } catch (e) {
            flushErrorSpend(e, "provider call failed after being billed (CLI reported a nonzero exit)");
            throw e;
          } finally {
            flushUnrecordedSpend("cadence failed after the provider returned, before the stage record");
          }
        },
        // No `usage` here, deliberately: every stage records its own, and a
        // summary alongside them cost 80.4M tokens of double-counting (27% of
        // the 2026-08-09 study). Cadence cost is GROUP BY dispatchId over leaves.
      });
      return toolText(
        `verification ${id} dispatched on ${rel} (${deps.liveCount()} live). The verdict arrives at a ` +
          "later wake; keep gating, dispatching, and ledger work going meanwhile.",
      );
    },
  } as AgentTool;
}

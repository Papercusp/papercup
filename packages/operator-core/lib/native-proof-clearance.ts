/** Current-clause clearance over the existing spec bindings and native run ledger. */
import { z } from 'zod';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import type { NativeProofRun } from './testing-run-store';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeProofWitnessSchema = z.object({
  runId: z.string().regex(/^native-proof-[a-f0-9]{64}$/), fingerprint: digest,
}).strict().refine(w => w.runId === 'native-proof-' + w.fingerprint, 'native proof witness identity mismatch');
export type NativeProofWitness = z.infer<typeof nativeProofWitnessSchema>;
export const nativeProofRequirementSchema = z.object({
  profile: z.literal('retained-baseline-v1'),
  preflightSpecIds: z.object({ numericFold: z.string().min(1), physicalInstall: z.string().min(1),
    priorFailureAudit: z.string().min(1) }).strict(),
}).strict();
export type NativeProofRequirement = z.infer<typeof nativeProofRequirementSchema>;
export const NATIVE_PROOF_WITNESS_KEY = 'nativeProof';

export type NativeClearanceScope = { workspaceId: string; harnessSlug: string; planSlug: string };
export type NativeClearanceBinding = { workItemId: string; specId: string; specRevision: number;
  specFingerprint: string; witness: unknown };
export type NativeClearancePreflight = NativeClearanceBinding & {
  current: boolean; createdAt: string; finishedAt: string | null;
  passed: number; failed: number; skipped: number; collectionFailed: boolean; status: string | null;
};
export interface NativeClearanceDeps {
  clauses(): Promise<SpecClauseRevision[]>;
  bindings(clause: SpecClauseRevision): Promise<NativeClearanceBinding[]>;
  run(runId: string): Promise<{ run: NativeProofRun; reservedAt: string } | null>;
  preflight(ref: string): Promise<NativeClearancePreflight | null>;
  fingerprint(run: NativeProofRun): string;
  review(run: NativeProofRun): Promise<unknown>;
  custody(run: NativeProofRun): Promise<unknown>;
}
export type NativeClearanceRefusal = { code: 'native_proof_required' | 'native_proof_authority_unavailable'; error: string };
const current = (c: SpecClauseRevision) => c.currentRevision === c.revision
  && (c.lifecycleStatus === 'active' || c.lifecycleStatus === 'accepted');
const sameEdition = (b: NativeClearanceBinding, c: SpecClauseRevision) => b.specId === c.specId
  && b.specRevision === c.revision && b.specFingerprint === c.contentHash;

/** No caller completion declaration, terminal token, cache or plan prose can waive this check.
 * Every scoped candidate is considered; exact preflight refs recover their original rows. */
export async function assessNativeProofClearance(scope: NativeClearanceScope & {
  planItemIds: readonly string[]; workItemId?: string;
}, deps: NativeClearanceDeps): Promise<NativeClearanceRefusal | null> {
  try {
    const clauses = await deps.clauses();
    for (const clause of clauses.filter(c => c.planSlug === scope.planSlug && current(c)
      && scope.planItemIds.includes(c.planItemId) && c.falsifier?.requiredNativeProof)) {
      const requirement = nativeProofRequirementSchema.parse(clause.falsifier!.requiredNativeProof);
      let qualified = false;
      for (const binding of await deps.bindings(clause)) {
        if (!sameEdition(binding, clause) || (scope.workItemId && binding.workItemId !== scope.workItemId)) continue;
        const parsed = nativeProofWitnessSchema.safeParse(binding.witness);
        if (!parsed.success) continue;
        const witness = parsed.data;
        const retained = await deps.run(witness.runId);
        if (!retained) continue;
        const { run, reservedAt } = retained;
        const reserved = Date.parse(reservedAt);
        if (!Number.isFinite(reserved) || run.runId !== witness.runId
          || run.fingerprint !== witness.fingerprint || deps.fingerprint(run) !== witness.fingerprint
          || run.admission.reviewedFingerprint !== witness.fingerprint
          || run.input.scope.workspaceId !== scope.workspaceId || run.input.scope.harnessSlug !== scope.harnessSlug
          || run.input.scope.planSlug !== scope.planSlug || run.input.scope.planItemId !== clause.planItemId
          || run.events.map(e => e.kind).join(',') !== 'reserved,started,installed,built,runtime,trace,sealed,readback'
          || run.events.some(e => e.fingerprint !== witness.fingerprint)) continue;
        let preflightsPass = true;
        for (const role of ['numericFold', 'physicalInstall', 'priorFailureAudit'] as const) {
          const proof = await deps.preflight(run.admission.preflightRefs[role]);
          const expected = clauses.find(c => c.specId === requirement.preflightSpecIds[role]
            && c.planSlug === scope.planSlug && current(c));
          const pin = nativeProofWitnessSchema.safeParse(proof?.witness);
          const created = Date.parse(proof?.createdAt ?? ''), finished = Date.parse(proof?.finishedAt ?? '');
          if (!proof || !expected || !sameEdition(proof, expected) || proof.workItemId !== binding.workItemId
            || !pin.success || pin.data.fingerprint !== witness.fingerprint || !proof.current
            || proof.status !== 'pass' || proof.passed < 1 || proof.failed !== 0 || proof.skipped !== 0 || proof.collectionFailed
            || !Number.isFinite(created) || !Number.isFinite(finished) || finished > created || created > reserved) {
            preflightsPass = false; break;
          }
        }
        if (!preflightsPass) continue;
        await deps.review(run);
        await deps.custody(run);
        const fresh = (await deps.clauses()).find(c => c.specId === clause.specId && c.planSlug === scope.planSlug && current(c));
        if (!fresh || fresh.revision !== clause.revision || fresh.contentHash !== clause.contentHash)
          return { code: 'native_proof_required', error: 'Native proof clause changed during clearance.' };
        qualified = true; break;
      }
      if (!qualified) return { code: 'native_proof_required',
        error: `Current ordered native proof is required for ${clause.specId}@${clause.revision}.` };
    }
    return null;
  } catch (error) {
    return { code: 'native_proof_authority_unavailable', error: `Cannot establish native proof authority: ${String(error)}` };
  }
}

/** Thin adapters only: canonical stores own currentness, review, run parsing and original custody. */
export async function requiredNativeProofClearance(scope: NativeClearanceScope & {
  planItemIds: readonly string[]; workItemId?: string;
}): Promise<NativeClearanceRefusal | null> {
  const { runWithWorkspace } = await import('./workspace-als');
  return runWithWorkspace(scope.workspaceId, async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { listSpecClauses } = await import('./agent-tools/plans/spec-clauses-store');
    const sql = getOrgPg().sql;
    return assessNativeProofClearance(scope, {
      clauses: () => listSpecClauses({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, planSlug: scope.planSlug }),
      async bindings(clause) {
        // No LIMIT: no valid candidate can starve behind older immutable bindings.
        const rows = await sql<{ work_item_id: string; spec_id: string; spec_revision: number;
          spec_fingerprint: string; details: Record<string, unknown> }[]>`
          SELECT work_item_id, spec_id, spec_revision, spec_fingerprint, details
          FROM harness_shared.spec_evidence_bindings
          WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
            AND plan_slug = ${scope.planSlug} AND spec_id = ${clause.specId}
            AND spec_revision = ${clause.revision} AND spec_fingerprint = ${clause.contentHash}
            AND retracted_at IS NULL
            AND (${scope.workItemId ?? null}::text IS NULL OR work_item_id = ${scope.workItemId ?? null})
          ORDER BY id DESC`;
        return rows.map(r => ({ workItemId: r.work_item_id, specId: r.spec_id,
          specRevision: Number(r.spec_revision), specFingerprint: r.spec_fingerprint, witness: r.details[NATIVE_PROOF_WITNESS_KEY] }));
      },
      async run(id) {
        const { readNativeProofRun } = await import('./testing-run-store');
        const run = await readNativeProofRun(sql, id);
        if (!run) return null;
        const [row] = await sql<{ reserved_at: string }[]>`SELECT started_at::text AS reserved_at
          FROM harness_shared.testing_run_snapshots WHERE run_id = ${id}`;
        if (!row) throw new Error('native proof reservation timestamp unavailable');
        return { run, reservedAt: row.reserved_at };
      },
      async preflight(ref) {
        const match = /^spec-evidence:([1-9][0-9]*)$/.exec(ref);
        if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
        const { listSpecEvidence } = await import('./agent-tools/plans/spec-evidence-store');
        const rows = await listSpecEvidence({ ...scope, planSlugs: [scope.planSlug],
          bindingIds: [Number(match[1])], includeCaseEvidence: true, limit: 1 });
        const row = rows[0];
        if (!row) return null;
        const execution = row.testRunExecution;
        return { workItemId: row.workItemId, specId: row.specId, specRevision: row.specRevision,
          specFingerprint: row.specFingerprint, witness: row.details[NATIVE_PROOF_WITNESS_KEY],
          current: row.currentness.overall === 'current' && row.currentness.provenance === 'server-measured',
          createdAt: row.createdAt, finishedAt: execution?.finishedAt ?? null,
          status: execution?.status ?? null, passed: execution?.passed ?? 0, failed: execution?.failed ?? -1,
          skipped: execution?.skipped ?? -1, collectionFailed: execution?.collectionFailed !== false };
      },
      fingerprint: run => {
        // The run reader already recomputes this using the canonical input schema.
        return run.fingerprint;
      },
      async review(run) {
        const { verifyMethodReviewAnswer } = await import('./consult/get-feedback-prod');
        return verifyMethodReviewAnswer({ ...scope, subjectPlan: scope.planSlug,
          fingerprint: run.fingerprint, reviewRef: run.admission.reviewRef });
      },
      async custody(run) {
        const { readBaselineQualification } = await import('./task-artifacts-baseline-custody');
        return readBaselineQualification(run);
      },
    });
  });
}

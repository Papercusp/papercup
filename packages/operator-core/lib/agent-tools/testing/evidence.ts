/** Test-time provenance uses existing immutable spec bindings, including pending executions. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import {
  bindSpecEvidence, listSpecEvidence, measureRepoFilesEvidenceAtRoot,
  ADHOC_WORK_ITEM_SPEC_SCOPE, repoFilesEvidenceMeasurementSchema,
  type BindSpecEvidenceInput, type RepoFilesEvidenceMeasurement,
} from '../plans/spec-evidence-store';
import { readHarnessTestRunEvidence, countUnattributedTestRunRows, type HarnessTestRunEvidence } from '../../testing-run-store';
import { resolveScenarioRerunScope } from './scenario-rerun-scope';
import type { TestFilesCoreResult } from './run';
import { SPEC_PROOF_OBLIGATION_ID_RE } from '../plans/spec-clauses-store';

const proofId = z.string().regex(SPEC_PROOF_OBLIGATION_ID_RE).max(200);
const bindingSchema = z.object({
  specId: z.string().min(1).max(200), specRevision: z.number().int().positive(),
  testPath: z.string().min(1).max(500),
  sourcePaths: repoFilesEvidenceMeasurementSchema.shape.sourcePaths,
  testLayer: z.enum(['unit', 'integration', 'e2e']),
  scenarioIds: z.array(proofId).min(1).max(100).optional(),
  causalPairId: proofId.optional(),
  counterexample: z.object({ test: z.string().min(1).max(500), messageIncludes: z.string().min(1).max(500) }).optional(),
}).strict();
export const testEvidenceSchema = z.object({
  workItemId: z.string().min(1).max(200), planSlug: z.string().min(1).max(120).optional(),
  bindings: z.array(bindingSchema).min(1).max(20),
}).strict();
export const recoverTestEvidenceSchema = z.object({
  workItemId: z.string().min(1).max(200), planSlug: z.string().min(1).max(120).optional(),
  originRunId: z.string().uuid(), runId: z.string().uuid(),
}).strict();
type Request = z.infer<typeof testEvidenceSchema>;
type Recovery = z.infer<typeof recoverTestEvidenceSchema>;
type Scope = { workspaceId: string; harnessSlug: string; actorId: string; root: string };
type Prepared = { input: BindSpecEvidenceInput; binding: Request['bindings'][number]; measurement: RepoFilesEvidenceMeasurement };
type Deps = {
  bind: typeof bindSpecEvidence; measure: typeof measureRepoFilesEvidenceAtRoot;
  ledger: typeof readHarnessTestRunEvidence; list: typeof listSpecEvidence;
  unattributed: typeof countUnattributedTestRunRows;
};
const defaults: Deps = { bind: bindSpecEvidence, measure: measureRepoFilesEvidenceAtRoot,
  ledger: readHarnessTestRunEvidence, list: listSpecEvidence,
  unattributed: countUnattributedTestRunRows };

/**
 * Why a scoped ledger read found no row. An absent run and an unattributed one
 * are opposite diagnoses — the first says re-run the test, the second says the
 * test already ran and the ledger write lost its tenant columns — so they must
 * never collapse into the same bare `pending`. 'unknown' is in-band: the probe
 * itself failed, which is not evidence that nothing ran.
 */
type LedgerAttribution = 'attributed' | 'unattributed' | 'absent' | 'ambiguous' | 'unknown';
const refFor = (runId: string, index: number) => `test-run-group:${runId}:${index}`;
const succeeded = (status: string) => status === 'created' || status === 'unchanged';

const executionDetailsSchema = z.object({
  schemaVersion: z.literal(1), root: z.string().min(1), filePath: z.string().min(1),
  runGroupId: z.string().uuid(), workspaceId: z.string().min(1), harnessSlug: z.string().min(1),
  testNamePattern: z.string().nullable(),
  passed: z.number().int().nonnegative().safe(), failed: z.number().int().nonnegative().safe(),
  skipped: z.number().int().nonnegative().safe(), collectionFailed: z.boolean(),
}).strict();

/** Only a complete, exact reporter measurement can replace a lost foreground result. */
function recoveredFileResult(run: HarnessTestRunEvidence | undefined, binding: Request['bindings'][number],
  runId: string, scope: Scope): TestFilesCoreResult | undefined {
  const parsed = executionDetailsSchema.safeParse(run?.execution_details);
  if (!parsed.success || !run || binding.counterexample) return undefined;
  const detail = parsed.data;
  if (detail.runGroupId !== runId || detail.workspaceId !== scope.workspaceId
    || detail.harnessSlug !== scope.harnessSlug || detail.root !== scope.root
    || detail.filePath !== binding.testPath || run.file_path !== binding.testPath) return undefined;
  // A pass row contradicting its measured failure must not manufacture proof.
  if (run.status === 'pass' && (detail.failed > 0 || detail.collectionFailed)) return undefined;
  return { ok: true, runId, root: scope.root, files: 1,
    passed: detail.passed, failed: detail.failed, skipped: detail.skipped,
    byFile: { [binding.testPath]: { passed: detail.passed, failed: detail.failed,
      skipped: detail.skipped, collectionFailed: detail.collectionFailed } },
    failures: [], failuresTruncated: false, durationMs: null,
    ...(detail.testNamePattern ? { testNamePattern: detail.testNamePattern } : {}),
  };
}

export async function prepareTestEvidence(request: Request, runId: string, files: string[], scope: Scope, deps: Deps = defaults) {
  const prepared: Prepared[] = [];
  // Validate every path and measure before any registration or process launch.
  const selected = new Set(files.map(file => resolve(scope.root, file)));
  for (const [index, binding] of request.bindings.entries()) {
    const absolute = resolve(scope.root, binding.testPath);
    if (!selected.has(absolute)) throw new Error(`evidence_test_not_selected:${binding.testPath}`);
    const testPath = relative(scope.root, absolute).replaceAll('\\', '/');
    const measurement = repoFilesEvidenceMeasurementSchema.parse({ schemaVersion: 1, kind: 'repo-files',
      sourcePaths: binding.sourcePaths, testPaths: [testPath] });
    const fingerprints = await deps.measure(scope.root, measurement);
    const normalized = { ...binding, testPath };
    const input: BindSpecEvidenceInput = {
      workItemId: request.workItemId, planSlug: request.planSlug,
      harnessSlug: scope.harnessSlug, actorId: scope.actorId,
      specId: binding.specId, specRevision: binding.specRevision,
      evidenceKind: binding.counterexample ? 'counterexample' : 'test', evidenceRef: refFor(runId, index),
      ...fingerprints,
      details: { currentMeasurement: measurement,
        testExecution: { schemaVersion: 1, phase: 'pending', runId, originRunId: runId, binding: normalized },
        adequacy: { testLayer: binding.testLayer, outcome: 'pending', collected: false, executed: false,
          ...(binding.scenarioIds ? { scenarioIds: binding.scenarioIds } : {}),
          ...(binding.causalPairId ? { causalPairIds: [binding.causalPairId] } : {}) },
      },
    };
    prepared.push({ input, binding: normalized, measurement });
  }
  for (const row of prepared) {
    const receipt = await deps.bind(row.input);
    if (!succeeded(receipt.status)) throw new Error(`evidence_registration_failed:${receipt.status}`);
  }
  return prepared;
}

export function testEvidenceOutcome(binding: Request['bindings'][number], result?: TestFilesCoreResult) {
  if (!result || result.error) return { outcome: result?.error ?? 'unknown', collected: false, executed: false };
  const counts = result.byFile[binding.testPath];
  if (!counts) return { outcome: 'unknown', collected: false, executed: false };
  const executed = !counts.collectionFailed && counts.passed + counts.failed > 0;
  // Vitest reports every non-matching assertion as `skipped` when an explicit
  // --testNamePattern is active. Those exclusions are not skipped evidence for
  // the selected proof. Preserve the old partial-skip behavior for unfiltered
  // runs, and still let any executed failure win over the selector.
  const nameFilterActive = typeof result.testNamePattern === 'string' && result.testNamePattern.trim().length > 0;
  let outcome = counts.collectionFailed
    ? 'error'
    : counts.failed > 0
      ? 'fail'
      : executed
        ? 'pass'
        : counts.skipped > 0
          ? 'skip'
          : 'unknown';
  if (!nameFilterActive && !counts.collectionFailed && counts.skipped > 0 && counts.failed === 0) outcome = 'skip';
  if (binding.counterexample && executed && counts.skipped === 0) {
    const negative = binding.counterexample;
    const exactFailure = result.failures.some(f => f.file === binding.testPath && f.test === negative.test && f.message.includes(negative.messageIncludes));
    outcome = executed && counts.failed === 1 && counts.skipped === 0 && exactFailure ? 'killed' : 'fail';
  }
  return { outcome, collected: !counts.collectionFailed, executed, skipped: counts.skipped > 0 };
}

/**
 * The evidence a PREVIOUS run left for this binding's scenario matrix, or null. Read only on
 * the name-filtered path — an unfiltered run re-measures the matrix and carries nothing, so
 * the happy path pays no extra query (same miss-path-only shape as the attribution probe).
 *
 * A failed probe returns null, which resolves to `no-sibling-evidence`: evidence you could
 * not read is not evidence you may carry. Pinned to the same spec REVISION on purpose — a
 * row proving an older contract is not proof of this one.
 */
async function readSiblingEvidence(row: Prepared, scope: Scope, deps: Deps) {
  const rows = await deps.list({
    harnessSlug: scope.harnessSlug,
    planSlugs: [row.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE],
    // `binding.specId` rather than `input.specId`: the store's input type makes `specId`
    // optional (a binding may instead be keyed by `sourceValId`), but this path is only ever
    // reached for a schema-validated binding, where it is required — and line-for-line the
    // same value the input was built from. Reading the required field keeps the query total.
    workItemIds: [row.input.workItemId], specIds: [row.binding.specId],
    evidenceKinds: ['test'], limit: 50,
  }).catch(() => null);
  if (!rows) return null;
  const settled = rows.filter(candidate => {
    if (candidate.evidenceRef === row.input.evidenceRef) return false; // never itself
    if (candidate.specRevision !== row.input.specRevision) return false;
    const execution = candidate.details?.testExecution as { phase?: string; binding?: { testPath?: string } } | undefined;
    return execution?.phase === 'settled' && execution.binding?.testPath === row.binding.testPath;
  });
  const latest = [...settled].sort((a, b) => b.id - a.id)[0];
  return latest ? { evidenceRef: latest.evidenceRef, ...latest.fingerprints } : null;
}

export async function finishTestEvidence(prepared: Prepared[], originRunId: string, runId: string, scope: Scope,
  result?: TestFilesCoreResult, deps: Deps = defaults) {
  const ledger = await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: runId });
  const rows = [];
  for (const row of prepared) {
    const matches = (ledger ?? []).filter(r => r.file_path === row.binding.testPath && r.finished_at !== null);
    const run = matches.length === 1 ? matches[0] : undefined;
    const measured = await deps.measure(scope.root, row.measurement).catch(() => null);
    const sourceStable = measured !== null && measured.sourceFingerprint === row.input.sourceFingerprint && measured.testFingerprint === row.input.testFingerprint;
    const priorExecution = row.input.details?.testExecution as { phase?: string; runId?: string; ledgerStatus?: string } | undefined;
    const priorProof = row.input.details?.adequacy as { outcome?: string } | undefined;
    if (!result && run && priorExecution?.phase === 'settled' && priorExecution.runId === runId
      && row.input.testRunId === run.id && priorExecution.ledgerStatus === run.status) {
      rows.push({ specId: row.input.specId, specRevision: row.input.specRevision,
        evidenceRef: row.input.evidenceRef, testRunId: run.id,
        phase: sourceStable ? 'settled' : 'source-changed', outcome: priorProof?.outcome ?? 'unknown', bindingStatus: 'unchanged' });
      continue;
    }
    const measuredResult = result ?? recoveredFileResult(run, row.binding, runId, scope);
    const outcome = testEvidenceOutcome(row.binding, measuredResult);
    const testNamePattern = measuredResult && !measuredResult.error ? measuredResult.testNamePattern : undefined;
    // A scoped read that found nothing cannot say WHY on its own. Probe the run
    // group WITHOUT the tenant predicate to tell a genuinely absent run apart
    // from one whose ledger write lost workspace_id/harness_slug — an
    // infrastructure fault, not a product one (R-8). Miss path only: the happy
    // path pays no extra query.
    let attribution: LedgerAttribution = 'attributed';
    let unattributedRows: number | null = null;
    if (matches.length > 1) attribution = 'ambiguous';
    else if (matches.length === 0) {
      unattributedRows = await deps
        .unattributed({ runGroupId: runId, filePath: row.binding.testPath })
        .catch(() => null);
      attribution = unattributedRows === null ? 'unknown'
        : unattributedRows > 0 ? 'unattributed' : 'absent';
    }
    // Legacy status-only rows remain unknown. Measured details are usable only
    // after exact scope/file attribution and the existing before/after hash check.
    // `ledger-unattributed` is a DIAGNOSTIC phase, never a proof phase: it is not
    // `settled`, so it cannot contribute a verificationFingerprint, and the
    // adequacy clamp below still forces outcome:'unknown'/executed:false.
    // SPEC-P006-FAILED-SCENARIO-RERUN: a name-filtered rerun executes ONE scenario but
    // settles a binding that claims the whole `scenarioIds` matrix, carrying the rest from
    // whatever a previous run recorded. Sound only while that record still matches disk.
    // The cheap pre-gate below mirrors the resolver's own null cases purely to avoid the
    // ledger read on the unfiltered path; `resolveScenarioRerunScope` stays the authority.
    const scenarioIds = (row.input.details?.adequacy as { scenarioIds?: string[] } | undefined)?.scenarioIds;
    const carriesSiblings = typeof testNamePattern === 'string' && testNamePattern.trim().length > 0
      && (scenarioIds?.length ?? 0) >= 2;
    const siblingEvidence = carriesSiblings ? await readSiblingEvidence(row, scope, deps) : null;
    const rerunScope = resolveScenarioRerunScope({ scenarioIds, testNamePattern,
      priorEvidence: siblingEvidence,
      current: { sourceFingerprint: row.input.sourceFingerprint, testFingerprint: row.input.testFingerprint } });
    // The carry was refused: this run measured strictly less than the binding claims, so it
    // is not proof — and, not being `settled`, it cannot contribute a verificationFingerprint.
    const carryRefused = rerunScope?.scope === 'full-matrix';
    const phase = !run
      ? attribution === 'unattributed' ? 'ledger-unattributed' : 'pending'
      : !sourceStable ? 'source-changed'
        : carryRefused ? 'stale-sibling-evidence'
          : !measuredResult || measuredResult.error ? 'review-required' : 'settled';
    const details = {
      ...row.input.details,
        testExecution: { schemaVersion: 1, phase, runId, originRunId, binding: row.binding,
          ...(testNamePattern ? { testNamePattern } : {}),
          sourceStable, ledgerStatus: run?.status ?? 'unknown', ledgerMatches: matches.length,
          ledgerAttribution: attribution,
          ...(unattributedRows !== null ? { ledgerUnattributedRows: unattributedRows } : {}),
          measuredOutcome: outcome.outcome,
          ...(rerunScope ? { rerunScope } : {}),
          ...(siblingEvidence?.evidenceRef ? { siblingEvidenceRef: siblingEvidence.evidenceRef } : {}),
        ...(result?.error ? { resultError: result.error } : {}),
      },
      adequacy: { ...(row.input.details?.adequacy as object), ...outcome,
        // Missing/ambiguous or contradictory ledger attribution cannot establish execution.
        ...(!run || (outcome.outcome === 'pass' && run.status !== 'pass') || (outcome.outcome === 'killed' && run.status !== 'fail')
          ? { outcome: 'unknown', executed: false } : {}),
        // A refused carry is the same clamp for a different reason: the remaining matrix
        // was neither measured here nor currently proven elsewhere.
        ...(carryRefused ? { outcome: 'unknown', executed: false } : {}),
      },
    };
    const receipt = await deps.bind({ ...row.input, testRunId: run?.id ?? null, details });
    rows.push({ specId: row.input.specId, specRevision: row.input.specRevision,
      evidenceRef: row.input.evidenceRef, testRunId: run?.id ?? null, phase,
      outcome: (details.adequacy as { outcome: string }).outcome, bindingStatus: receipt.status });
  }
  return { status: rows.every(r => succeeded(r.bindingStatus)) ? 'recorded' : 'incomplete',
    verificationFingerprint: rows.every(r => r.phase === 'settled')
      ? createHash('sha256').update(JSON.stringify(prepared.map(row => ({
        source: row.input.sourceFingerprint, test: row.input.testFingerprint, measurement: row.measurement,
      })))).digest('hex') : null,
    acceptance: 'requires-review', rows: rows.slice(0, 6), total: rows.length, omitted: Math.max(0, rows.length - 6),
    readRef: { tool: 'plans:get-spec-evidence', args: { harness: scope.harnessSlug,
      slug: prepared[0]!.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE,
      workItemIds: [prepared[0]!.input.workItemId], evidenceRefs: prepared.map(row => row.input.evidenceRef) } },
    recovery: { tool: 'testing:run', args: { harness: scope.harnessSlug, recoverEvidence: {
      workItemId: prepared[0]!.input.workItemId, planSlug: prepared[0]!.input.planSlug, originRunId, runId,
    } } },
  };
}

/** Rehydrate exact persisted mappings; no transcript or user-retyped fingerprints. */
export async function recoverTestEvidence(recovery: Recovery, scope: Scope, deps: Deps = defaults) {
  const evidence = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [recovery.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [recovery.workItemId],
    evidenceRefs: Array.from({ length: 20 }, (_, index) => refFor(recovery.originRunId, index)), limit: 200 });
  const latest = new Map<string, (typeof evidence)[number]>();
  for (const row of [...evidence].sort((a, b) => b.id - a.id)) if (!latest.has(row.evidenceRef)) latest.set(row.evidenceRef, row);
  const prepared: Prepared[] = [];
  for (const row of latest.values()) {
    const execution = row.details.testExecution as { schemaVersion?: number; runId?: string; originRunId?: string; binding?: unknown } | undefined;
    if (execution?.schemaVersion !== 1 || execution.originRunId !== recovery.originRunId || execution.runId !== recovery.runId) continue;
    const binding = bindingSchema.parse(execution.binding);
    const measurement = repoFilesEvidenceMeasurementSchema.parse(row.details.currentMeasurement);
    prepared.push({ binding, measurement, input: {
      harnessSlug: scope.harnessSlug, actorId: scope.actorId,
      planSlug: recovery.planSlug, workItemId: recovery.workItemId,
      specId: row.specId, specRevision: row.specRevision,
      evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef,
      testRunId: row.testRunId, coverageEvidenceRef: row.coverageEvidenceRef, details: row.details,
      sourceFingerprint: row.fingerprints.sourceFingerprint, testFingerprint: row.fingerprints.testFingerprint,
    } });
  }
  if (prepared.length === 0) throw new Error('evidence_recovery_not_found');
  return finishTestEvidence(prepared, recovery.originRunId, recovery.runId, scope, undefined, deps);
}

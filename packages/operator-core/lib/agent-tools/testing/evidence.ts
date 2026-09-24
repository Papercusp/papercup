/** Test-time provenance uses existing immutable spec bindings, including pending executions. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import {
  bindSpecEvidence, listSpecEvidence, measureRepoFilesEvidenceAtRoot, measureAndPinRepoFilesEvidenceAtRoot, retractSpecEvidence,
  ADHOC_WORK_ITEM_SPEC_SCOPE, MEASUREMENT_PIN_DETAILS_KEY, repoFilesEvidenceMeasurementSchema,
  type BindSpecEvidenceInput, type MeasurementPin, type RepoFilesEvidenceMeasurement,
} from '../plans/spec-evidence-store';
import { readHarnessTestRunEvidence, countUnattributedTestRunRows, type HarnessTestRunEvidence } from '../../testing-run-store';
import { resolveScenarioRerunScope } from './scenario-rerun-scope';
import type { TestFilesCoreResult } from './run';
import { SPEC_PROOF_OBLIGATION_ID_RE } from '../plans/spec-clauses-store';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';

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
  /**
   * P-018 commit pin. Optional so a caller with a fake `measure` never silently gets a
   * real filesystem/git probe mixed into its fixture; the production defaults supply it.
   */
  pin?: typeof measureAndPinRepoFilesEvidenceAtRoot;
  /** Used only by the re-measure path to withdraw a replaced stale predecessor. */
  retract?: typeof retractSpecEvidence;
};
const defaults: Deps = { bind: bindSpecEvidence, measure: measureRepoFilesEvidenceAtRoot,
  ledger: readHarnessTestRunEvidence, list: listSpecEvidence,
  unattributed: countUnattributedTestRunRows, pin: measureAndPinRepoFilesEvidenceAtRoot,
  retract: retractSpecEvidence };

/**
 * The commit pin for a measurement, or null. The pin re-reads the files, so it is kept
 * ONLY when its own fingerprints equal the ones being bound: a file that moved between
 * the two reads would otherwise pin bytes the proof was never measured against.
 */
async function pinFor(root: string, measurement: RepoFilesEvidenceMeasurement,
  fingerprints: { sourceFingerprint: string; testFingerprint: string | null }, deps: Deps): Promise<MeasurementPin | null> {
  if (!deps.pin) return null;
  const pinned = await deps.pin(root, measurement).catch(() => null);
  if (!pinned) return null;
  return pinned.sourceFingerprint === fingerprints.sourceFingerprint && pinned.testFingerprint === fingerprints.testFingerprint
    ? pinned.pin : null;
}

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

/** Only a complete, exact reporter measurement can replace a lost foreground result. */
function recoveredFileResult(run: HarnessTestRunEvidence | undefined, binding: Request['bindings'][number],
  runId: string, scope: Scope): TestFilesCoreResult | undefined {
  const detail = parseTestRunExecutionDetails(run?.execution_details);
  if (!detail || !run || binding.counterexample) return undefined;
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
    const pin = await pinFor(scope.root, measurement, fingerprints, deps);
    const normalized = { ...binding, testPath };
    const input: BindSpecEvidenceInput = {
      workItemId: request.workItemId, planSlug: request.planSlug,
      harnessSlug: scope.harnessSlug, actorId: scope.actorId,
      specId: binding.specId, specRevision: binding.specRevision,
      evidenceKind: binding.counterexample ? 'counterexample' : 'test', evidenceRef: refFor(runId, index),
      ...fingerprints,
      details: { currentMeasurement: measurement,
        ...(pin ? { [MEASUREMENT_PIN_DETAILS_KEY]: pin } : {}),
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

export function testEvidenceOutcome(
  binding: Request['bindings'][number],
  result?: TestFilesCoreResult,
): { outcome: string; collected: boolean; executed: boolean; skipped?: boolean; filteredSkipped?: number } {
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
  return {
    outcome,
    collected: !counts.collectionFailed,
    executed,
    // `skipped` is an adequacy claim about the selected proof, not the raw
    // reporter total. A name-filtered run reports non-matching cases as
    // skipped, but those cases were excluded rather than skipped evidence.
    skipped: !nameFilterActive && counts.skipped > 0,
    ...(nameFilterActive ? { filteredSkipped: counts.skipped } : {}),
  };
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
  const primaryLedger = await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: runId });
  // A foreground timeout can hand back a detached handle AFTER the reporter was
  // already launched with the original run-group id. Recovery must try that
  // persisted origin when the detached group has no rows; the exact reporter
  // scope/file/details checks below still decide whether it proves anything.
  const originLedger = originRunId !== runId && (primaryLedger?.length ?? 0) === 0
    ? await deps.ledger({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: originRunId })
    : null;
  const ledger = (primaryLedger?.length ?? 0) > 0 ? primaryLedger : originLedger ?? primaryLedger;
  const ledgerRunGroupId = (originLedger?.length ?? 0) > 0 ? originRunId : runId;
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
    const measuredResult = result ?? recoveredFileResult(run, row.binding, ledgerRunGroupId, scope);
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
        .unattributed({ runGroupId: ledgerRunGroupId, filePath: row.binding.testPath })
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
        testExecution: { schemaVersion: 1, phase, runId, originRunId, ledgerRunGroupId, binding: row.binding,
          ...(testNamePattern ? { testNamePattern } : {}),
          ...(outcome.filteredSkipped !== undefined ? { filteredSkipped: outcome.filteredSkipped } : {}),
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

/** Return a bounded pending bundle; defer ledger reconciliation until the detached run can settle. */
export function deferredTestEvidenceRecoveryBundle(
  request: Pick<Request, 'workItemId' | 'planSlug' | 'bindings'>,
  originRunId: string,
  runId: string,
  harnessSlug: string,
) {
  const evidenceRefs = request.bindings.map((_, index) => refFor(originRunId, index));
  return {
    status: 'incomplete' as const,
    verificationFingerprint: null,
    acceptance: 'requires-review' as const,
    message: 'The foreground test run timed out. Evidence remains pending until recovery reconciles the detached run with the test ledger.',
    rows: request.bindings.slice(0, 6).map((binding, index) => ({
      specId: binding.specId,
      specRevision: binding.specRevision,
      evidenceRef: evidenceRefs[index],
      testRunId: null,
      phase: 'pending' as const,
      outcome: 'unknown' as const,
    })),
    total: request.bindings.length,
    omitted: Math.max(0, request.bindings.length - 6),
    readRef: { tool: 'plans:get-spec-evidence', args: { harness: harnessSlug,
      slug: request.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE,
      workItemIds: [request.workItemId], evidenceRefs } },
    recovery: { tool: 'testing:run', args: { harness: harnessSlug, recoverEvidence: {
      workItemId: request.workItemId, planSlug: request.planSlug, originRunId, runId,
    } } },
  };
}

/**
 * P-018 / P-011: re-measure ONLY the test proofs whose measured source or test files
 * moved, in one call, from the recipes the bindings already persisted.
 *
 * The expensive part of a stale BAR was never the test run; it was the agent
 * re-deriving every binding's specId / testPath / sourcePaths / testLayer by hand
 * (~20 tool calls per BAR on turn-start-memory-two-class-2026-09-21). Every settled
 * test binding already stores that exact recipe in `details.testExecution.binding`, so
 * the re-measure is mechanical and needs no retyped fingerprints.
 *
 * NOTHING IS WEAKENED. A re-measured proof goes through the normal prepare → run →
 * finish path: it is only `settled` if the test actually passes against the moved
 * code, and a clause whose MEANING moved (spec-stale) is never re-measured here —
 * that is a new contract, not drift.
 */
export const remeasureTestEvidenceSchema = z.object({
  workItemId: z.string().min(1).max(200), planSlug: z.string().min(1).max(120).optional(),
  specIds: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
}).strict();
type Remeasure = z.infer<typeof remeasureTestEvidenceSchema>;
type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

/** Stale reasons a fresh run of the SAME recipe can cure. Anything else needs a human. */
const REMEASURABLE_STALE_REASONS = new Set(['source-stale', 'test-stale', 'testRun-stale']);
/** One evidence request is capped at 20 bindings by `testEvidenceSchema`. */
const MAX_REMEASURE_BINDINGS = 20;

export type RemeasureSkip = { specId: string; testPath: string; bindingId: number;
  reason: 'current' | 'clause-moved' | 'run-in-flight' | 'unmeasurable' | 'not-remeasurable' | 'cap'
    /** A test proof bound by hand (plans:bind-spec-evidence): no stored recipe to re-run. */
    | 'no-recipe'
    /** A mutation proof: curing it means re-running the mutation probe, not a test file. */
    | 'probe-required';
  detail?: string };
export type RemeasureSelection = { specId: string; testPath: string; bindingId: number;
  staleReasons: string[]; movedPaths?: unknown; binding: Request['bindings'][number];
  /** Every live row of this recipe at this revision — withdrawn only once a fresh run PASSES. */
  supersedes: number[] };

/** Evidence kinds a re-measure must ACCOUNT for, even when it cannot re-run them itself. */
export const REMEASURE_EVIDENCE_KINDS = ['test', 'mutation'] as const;

/**
 * A legacy hand-bound test can be re-run only when its immutable row still gives one exact
 * test file, its source set, and the recorded test layer. Do not infer a recipe from a title,
 * a test-run id, or free-form attestation text; and do not carry stale adequacy assertions into
 * the new run. Mutation rows deliberately never enter this path.
 */
function handBoundTestBinding(
  row: EvidenceRow,
  measurement: z.infer<typeof repoFilesEvidenceMeasurementSchema>,
): Request['bindings'][number] | null {
  const testPaths = measurement.testPaths ?? [];
  if (testPaths.length !== 1) return null;
  const testPath = testPaths[0]!;
  if (row.evidenceRef !== testPath) return null;

  const adequacy = row.details?.adequacy;
  if (adequacy === null || typeof adequacy !== 'object' || Array.isArray(adequacy)) return null;
  const values = adequacy as Record<string, unknown>;
  const scenarioIds = values.scenarioIds;
  if (scenarioIds !== undefined && (!Array.isArray(scenarioIds) || !scenarioIds.every((id) => typeof id === 'string'))) return null;
  const causalPairIds = values.causalPairIds;
  if (
    causalPairIds !== undefined &&
    (!Array.isArray(causalPairIds) || causalPairIds.length > 1 || !causalPairIds.every((id) => typeof id === 'string'))
  ) return null;

  const parsed = bindingSchema.safeParse({
    specId: row.specId,
    specRevision: row.specRevision,
    testPath,
    sourcePaths: measurement.sourcePaths,
    testLayer: values.testLayer,
    ...(scenarioIds && scenarioIds.length > 0 ? { scenarioIds } : {}),
    ...(causalPairIds && causalPairIds.length === 1 ? { causalPairId: causalPairIds[0] } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Pure selection over one work-item's evidence rows: the latest binding per (clause, kind,
 * test file). A stale test proof may be re-run from a stored binding or from an exact,
 * unambiguous repo-files measurement plus its recorded test layer. Other stale proofs are
 * still REPORTED (`no-recipe` / `probe-required`), never silently dropped — a silent drop
 * let the completion gate fail freshness on bindings this pass said nothing about.
 */
export function planTestEvidenceRemeasure(rows: readonly EvidenceRow[]): { selected: RemeasureSelection[]; skipped: RemeasureSkip[] } {
  const latest = new Map<string, { row: EvidenceRow; binding: Request['bindings'][number] | null; testPath: string; phase?: string }>();
  const members = new Map<string, number[]>();
  for (const row of [...rows].sort((a, b) => b.id - a.id)) {
    // Counterexample proofs assert a SPECIFIC failure against a deliberately broken
    // subject; re-running them against moved code is not the same claim.
    if (!(REMEASURE_EVIDENCE_KINDS as readonly string[]).includes(row.evidenceKind)) continue;
    const execution = row.details?.testExecution as { phase?: string; binding?: unknown } | undefined;
    const parsed = row.evidenceKind === 'test' ? bindingSchema.safeParse(execution?.binding) : null;
    const structuredBinding = parsed?.success ? parsed.data : null;
    const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details?.currentMeasurement);
    const recordedPaths = measurement.success ? measurement.data.testPaths ?? [] : [];
    const handBoundBinding =
      row.evidenceKind === 'test' && execution?.binding === undefined && measurement.success
        ? handBoundTestBinding(row, measurement.data)
        : null;
    const binding = structuredBinding ?? handBoundBinding;
    const testPath = binding?.testPath ?? recordedPaths[0] ?? '(unrecorded)';
    const identityPaths = binding ? [binding.testPath] : recordedPaths;
    const pathIdentity = identityPaths.length > 0
      ? JSON.stringify([...new Set(identityPaths)].sort())
      : `unrecorded:${row.evidenceRef}`;
    const key = `${row.specId}\0${row.evidenceKind}\0${pathIdentity}`;
    if (!latest.has(key)) latest.set(key, { row, binding, testPath, phase: execution?.phase });
    if (row.specRevision === latest.get(key)!.row.specRevision) members.set(key, [...(members.get(key) ?? []), row.id]);
  }
  const selected: RemeasureSelection[] = [];
  const skipped: RemeasureSkip[] = [];
  for (const [key, { row, binding, testPath, phase }] of latest) {
    const base = { specId: row.specId, testPath, bindingId: row.id };
    const { overall, dimensions, staleReasons } = row.currentness;
    const moved = (row as { serverMeasurement?: { movedPaths?: unknown } }).serverMeasurement?.movedPaths;
    const hasNoStoredTestBinding =
      row.evidenceKind === 'test' &&
      (row.details?.testExecution as { binding?: unknown } | undefined)?.binding === undefined;
    if (dimensions.spec === 'stale') skipped.push({ ...base, reason: 'clause-moved' });
    else if (phase === 'pending') skipped.push({ ...base, reason: 'run-in-flight' });
    else if (overall === 'current' && (phase === 'settled' || !binding || hasNoStoredTestBinding))
      skipped.push({ ...base, reason: 'current' });
    else if (!binding) {
      const why = (overall === 'unknown' ? row.currentness.unknownReasons : staleReasons).join(',') || overall;
      skipped.push(row.evidenceKind === 'mutation'
        ? {
            ...base,
            reason: 'probe-required',
            detail:
              `${why}: re-run the same copy-out/historical scripts/mutation-probe.sh recipe, then re-bind its source='mutation-probe' ledger result; this test-only route cannot reproduce a mutant.`
                .slice(0, 240),
          }
        : { ...base, reason: 'no-recipe', detail: `${why}: bound by hand, so re-prove via testing:run { evidence } (which stores the recipe)`.slice(0, 240) });
    } else if (
      (overall === 'stale' && staleReasons.every((reason) => REMEASURABLE_STALE_REASONS.has(reason))) ||
      // A completed run whose sources moved WHILE it ran is the same drift, observed early.
      (overall !== 'unknown' && phase === 'source-changed' && staleReasons.every((reason) => REMEASURABLE_STALE_REASONS.has(reason)))
    ) {
      selected.push({ ...base, staleReasons, ...(moved !== undefined ? { movedPaths: moved } : {}),
        binding: { ...binding, specRevision: row.specRevision }, supersedes: (members.get(key) ?? []).sort((a, b) => a - b) });
    } else if (overall === 'unknown') skipped.push({ ...base, reason: 'unmeasurable', detail: row.currentness.unknownReasons.join(',').slice(0, 240) });
    else skipped.push({ ...base, reason: 'not-remeasurable', detail: [...staleReasons, phase ?? 'no-phase'].join(',') });
  }
  const bySpec = (a: { specId: string; testPath: string }, b: { specId: string; testPath: string }) =>
    a.specId.localeCompare(b.specId) || a.testPath.localeCompare(b.testPath);
  selected.sort(bySpec);
  for (const over of selected.splice(MAX_REMEASURE_BINDINGS)) skipped.push({ specId: over.specId, testPath: over.testPath, bindingId: over.bindingId, reason: 'cap' });
  return { selected, skipped: skipped.sort(bySpec) };
}

/**
 * Read one work-item's live test evidence and turn the stale-but-curable proofs into an
 * ordinary `evidence` request plus the exact test files to run. `request` is null when
 * nothing needs re-measuring, and the caller then starts no process at all.
 */
export async function buildTestEvidenceRemeasure(remeasure: Remeasure, scope: Pick<Scope, 'harnessSlug'>, deps: Pick<Deps, 'list'> = defaults) {
  const rows = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [remeasure.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [remeasure.workItemId],
    ...(remeasure.specIds ? { specIds: remeasure.specIds } : {}), evidenceKinds: [...REMEASURE_EVIDENCE_KINDS], limit: 500 });
  const plan = planTestEvidenceRemeasure(rows);
  const request = plan.selected.length === 0 ? null : testEvidenceSchema.parse({
    workItemId: remeasure.workItemId, ...(remeasure.planSlug ? { planSlug: remeasure.planSlug } : {}),
    bindings: plan.selected.map((entry) => entry.binding) });
  return { request, files: [...new Set(plan.selected.map((entry) => entry.testPath))], plan,
    summary: { examined: rows.length, selected: plan.selected.length, skipped: plan.skipped.length } };
}

/**
 * After a re-measure run, withdraw the stale predecessors of each recipe whose FRESH
 * proof settled as a current pass — and nothing else. The evaluator grades every live
 * row at a revision, so a replaced stale row left live would keep failing freshness
 * beside the new passing one. A recipe whose fresh run failed, errored or is still
 * pending keeps its predecessors: the clause is then honestly red for a reason the
 * caller can read, not quietly emptied. Retraction is D-011's stamp (never a delete),
 * with a reason naming the replacement.
 */
export async function retireRemeasuredPredecessors(selected: readonly RemeasureSelection[], prepared: readonly Prepared[],
  runId: string, scope: Scope, deps: Pick<Deps, 'list'> & { retract?: typeof retractSpecEvidence } = defaults) {
  if (!deps.retract || prepared.length === 0) return [];
  const fresh = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [prepared[0]!.input.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [prepared[0]!.input.workItemId],
    evidenceRefs: prepared.map((row) => row.input.evidenceRef), limit: 200 });
  const outcomes = [];
  for (const [index, entry] of selected.entries()) {
    const ref = prepared[index]?.input.evidenceRef;
    const replacement = fresh.filter((row) => row.evidenceRef === ref).sort((a, b) => b.id - a.id)[0];
    const execution = replacement?.details?.testExecution as { phase?: string } | undefined;
    const outcome = (replacement?.details?.adequacy as { outcome?: string } | undefined)?.outcome;
    const passed = replacement !== undefined && execution?.phase === 'settled' && outcome === 'pass'
      && replacement.currentness.overall === 'current';
    if (!passed) {
      outcomes.push({ specId: entry.specId, testPath: entry.testPath, retired: [], kept: entry.supersedes,
        reason: `fresh run not a current pass (${execution?.phase ?? 'absent'}/${outcome ?? 'unknown'})` });
      continue;
    }
    const retired: number[] = [];
    for (const bindingId of entry.supersedes) {
      const result = await deps.retract({ harnessSlug: scope.harnessSlug, bindingId, actorId: scope.actorId,
        reason: `superseded by re-measured binding ${replacement.id} (testing:run remeasureEvidence run ${runId}): measured paths moved since this proof` })
        .catch(() => null);
      if (result && result.status !== 'not_found') retired.push(bindingId);
    }
    outcomes.push({ specId: entry.specId, testPath: entry.testPath, replacementId: replacement.id, retired });
  }
  return outcomes;
}

/** Rehydrate exact persisted mappings; no transcript or user-retyped fingerprints. */
export async function recoverTestEvidence(recovery: Recovery, scope: Scope, deps: Deps = defaults) {
  const evidence = await deps.list({ harnessSlug: scope.harnessSlug,
    planSlugs: [recovery.planSlug ?? ADHOC_WORK_ITEM_SPEC_SCOPE], workItemIds: [recovery.workItemId],
    evidenceRefs: Array.from({ length: 20 }, (_, index) => refFor(recovery.originRunId, index)), limit: 200 });
  const latest = new Map<string, (typeof evidence)[number]>();
  for (const row of [...evidence].sort((a, b) => b.id - a.id)) if (!latest.has(row.evidenceRef)) latest.set(row.evidenceRef, row);
  const prepared: Prepared[] = [];
  const recoveredRunIds = new Set<string>();
  // When the outer MCP request itself expires, its response may hide the
  // detachedRunId. In that case the caller only has the origin run-group id;
  // use the persisted, origin-matched execution record to recover the detached
  // handle rather than requiring the caller to reconstruct it from memory.
  const originOnlyRecovery = recovery.runId === recovery.originRunId;
  for (const row of latest.values()) {
    const execution = row.details.testExecution as { schemaVersion?: number; runId?: string; originRunId?: string; binding?: unknown } | undefined;
    if (execution?.schemaVersion !== 1 || execution.originRunId !== recovery.originRunId
      || typeof execution.runId !== 'string'
      || (!originOnlyRecovery && execution.runId !== recovery.runId && execution.runId !== recovery.originRunId)) continue;
    // An origin-only retry can discover a prior detached handle in the row. If
    // the caller already has that detached handle but the row still contains
    // its pre-timeout origin id, trust the caller's handle and let exact ledger
    // scope/file/run checks decide whether it has a measured result.
    const recoveredRunId = originOnlyRecovery || execution.runId === recovery.runId
      ? execution.runId
      : recovery.runId;
    recoveredRunIds.add(recoveredRunId);
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
  if (recoveredRunIds.size !== 1) throw new Error('evidence_recovery_ambiguous_run_id');
  return finishTestEvidence(prepared, recovery.originRunId, [...recoveredRunIds][0]!, scope, undefined, deps);
}

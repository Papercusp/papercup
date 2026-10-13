/**
 * system:rubric-rescore — re-run a rubric's executable checks on a schedule and raise an alert
 * when a criterion falls below its bar. Plan test-rubric-unification-2026-10-12 P-008 (R-8),
 * bound by D-008 (which corrects the wording of D-004 rule 3).
 *
 * Fired by a PLAN SCHEDULE, not a bespoke scheduler: plans:set-schedule { schedule: { action:
 * { system: 'rubric-rescore', input: { rubricRef } } } } + plans:arm-schedule materialize the
 * `plan-schedule-<template>` routine targeting `system:rubric-rescore` (this action is
 * registered `planSchedulable`). The routine payload is `{ templateSlug, harnessSlug, input }`.
 *
 * One fire, deterministic, no model turn:
 *   1. BEFORE — the verdict of every executable criterion from its latest ledger rows, judged by
 *      the same P-007 rules scorecards:emit { fromLedger } uses (ledgerCheckBindings +
 *      judgeLedgerRow against the criterion's CURRENT threshold; error > fail > pass).
 *   2. RUN — every registered COMMAND instrument check (P-005) and every typed probe check
 *      (P-004/P-006), each executed result written as one results-ledger row (P-006).
 *   3. AFTER — the same verdicts re-read from the ledger.
 *   4. For every criterion that moved pass → fail, emit `rubric:criterion-regressed:<rubricRef>`
 *      with { criterionKey, before, after, testRunId }. A criterion that stays at its bar, has no
 *      prior verdict, or moves to `error` (nothing measured) emits nothing: an alert means the
 *      bar was MET and now is NOT, never "we could not measure".
 *
 * The standing alert is a `watch:create { pattern: 'rubric:criterion-regressed:<rubricRef>',
 * targetKind: 'event', wake: false }` — an inbox notice on each crossing.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getRubric } from '../../rubrics';
import {
  probeCheckResults,
  readLatestRubricCheckResults,
  recordRubricCheckResults,
  runInstrumentChecks,
  type LatestRubricCheckResult,
  type RubricCheckResult,
} from '../../check-results-ledger';
import { judgeLedgerRow, ledgerCheckBindings, type LedgerFillCriterion } from '../../scorecard-ledger-fill';
import { evaluateCriterionProbeChecks, type CheckedCriterion } from '../../rubrics-criterion-checks';
import { emitAwaitedEvent } from '../../events/await/engine';
import { dispatchPaletteTarget } from '../../capabilities/invoke';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const RUBRIC_RESCORE_ACTION = 'rubric-rescore';

/** The awaitable key a crossing fires; the watch subscribes to exactly this. */
export function rubricCriterionRegressedKey(rubricRef: string): string {
  return `rubric:criterion-regressed:${rubricRef}`;
}

export type CriterionLedgerVerdict = 'pass' | 'fail' | 'error';

export interface RubricCriterionRegressedPayload {
  rubricRef: string;
  criterionKey: string;
  before: 'pass';
  after: 'fail';
  /** The results-ledger row that decided the failing verdict. */
  testRunId: number;
}

type RescoreCriterion = LedgerFillCriterion & CheckedCriterion;

/**
 * The ledger verdict of one executable criterion, or null when it is not executable or any of its
 * checks has no row yet (unknown — never a crossing endpoint).
 */
export function criterionLedgerVerdict(
  criterion: LedgerFillCriterion,
  latest: ReadonlyMap<string, LatestRubricCheckResult>,
): { verdict: CriterionLedgerVerdict; testRunId: number } | null {
  const bindings = ledgerCheckBindings(criterion);
  if (!bindings) return null;
  const judged: Array<{ verdict: CriterionLedgerVerdict; testRunId: number }> = [];
  for (const binding of bindings) {
    const row = latest.get(binding.id);
    if (!row || (binding.unit !== undefined && row.check.unit !== binding.unit)) return null;
    judged.push({ verdict: judgeLedgerRow(binding, row), testRunId: row.testRunId });
  }
  return judged.find((j) => j.verdict === 'error') ?? judged.find((j) => j.verdict === 'fail') ?? judged[0] ?? null;
}

export interface RubricRescoreDeps {
  getRubric?: (ref: string) => Promise<{
    rubricId: string;
    workspaceId?: string | null;
    subjectHarnessSlug?: string | null;
    criteria: ReadonlyArray<RescoreCriterion>;
  } | null>;
  readLatest?: typeof readLatestRubricCheckResults;
  runInstruments?: typeof runInstrumentChecks;
  evaluateProbes?: typeof evaluateCriterionProbeChecks;
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  record?: (results: ReadonlyArray<RubricCheckResult>, scope: Parameters<typeof recordRubricCheckResults>[1]) => Promise<number[]>;
  emit?: typeof emitAwaitedEvent;
}

export interface RubricRescoreOutcome {
  rubricRef: string;
  executed: number;
  testRunIds: number[];
  crossings: RubricCriterionRegressedPayload[];
  /** A probe batch that could not run; its criteria simply keep their prior rows. */
  probeError?: string;
}

/** Re-run a rubric's executable checks and emit one event per pass → fail crossing. */
export async function rescoreRubric(
  input: { rubricRef: string; workspaceId: string; harnessSlug: string | null },
  deps: RubricRescoreDeps = {},
): Promise<RubricRescoreOutcome> {
  const rubric = await (deps.getRubric ?? (getRubric as NonNullable<RubricRescoreDeps['getRubric']>))(input.rubricRef);
  if (!rubric) throw new Error(`rubric_rescore_rubric_not_found: ${input.rubricRef}`);
  const rubricRef = rubric.rubricId;
  const workspaceId = rubric.workspaceId ?? input.workspaceId;
  const readLatest = deps.readLatest ?? readLatestRubricCheckResults;
  const executable = rubric.criteria.filter((c) => ledgerCheckBindings(c) !== null);

  const latestBefore = await readLatest({ rubricRef, workspaceId });
  const before = new Map(executable.map((c) => [c.key, criterionLedgerVerdict(c, latestBefore)] as const));

  const results: RubricCheckResult[] = [
    ...(await (deps.runInstruments ?? runInstrumentChecks)({ rubricRef, criteria: executable })),
  ];
  let probeError: string | undefined;
  const probeCriteria = executable.filter((c) => (c.check as { kind?: string } | undefined)?.kind === 'probe');
  if (probeCriteria.length > 0) {
    // `unknown` ratings: run every probe without asserting any rating it could contradict.
    const ratings = Object.fromEntries(probeCriteria.map((c) => [c.key, { rating: 'unknown' }]));
    const harness = input.harnessSlug ?? rubric.subjectHarnessSlug ?? undefined;
    const dispatchTool = deps.dispatchTool ?? ((name: string, args: Record<string, unknown>) =>
      dispatchPaletteTarget({ name, args, ...(harness ? { harness } : {}) }));
    const evaluation = await (deps.evaluateProbes ?? evaluateCriterionProbeChecks)({ criteria: probeCriteria, ratings, dispatchTool });
    if (evaluation.ok) results.push(...probeCheckResults(rubricRef, evaluation.checkRuns, probeCriteria));
    else probeError = `${evaluation.error}: ${evaluation.detail}`;
  }

  const testRunIds = results.length > 0
    ? await (deps.record ?? ((r, s) => recordRubricCheckResults(r, s, getOrgPg().sql as never)))(results, {
        workspaceId,
        harnessSlug: input.harnessSlug ?? rubric.subjectHarnessSlug ?? null,
      })
    : [];

  const latestAfter = await readLatest({ rubricRef, workspaceId });
  const crossings: RubricCriterionRegressedPayload[] = [];
  for (const criterion of executable) {
    const was = before.get(criterion.key);
    const now = criterionLedgerVerdict(criterion, latestAfter);
    if (was?.verdict === 'pass' && now?.verdict === 'fail') {
      crossings.push({ rubricRef, criterionKey: criterion.key, before: 'pass', after: 'fail', testRunId: now.testRunId });
    }
  }
  const emit = deps.emit ?? emitAwaitedEvent;
  for (const crossing of crossings) {
    await emit({
      key: rubricCriterionRegressedKey(rubricRef),
      payload: crossing,
      summary: `rubric ${rubricRef}: criterion '${crossing.criterionKey}' fell below its bar (test_runs #${crossing.testRunId})`,
      source: `system:${RUBRIC_RESCORE_ACTION}`,
      workspaceId,
    });
  }
  return { rubricRef, executed: results.length, testRunIds, crossings, ...(probeError ? { probeError } : {}) };
}

/** The routine handler: payload `{ templateSlug, harnessSlug, input: { rubricRef } }`. */
export async function runRubricRescoreAction(ctx: SystemActionCtx, deps: RubricRescoreDeps = {}): Promise<SystemActionResult> {
  const payload = (ctx.payloadTemplate ?? {}) as { harnessSlug?: unknown; input?: { rubricRef?: unknown } };
  const rubricRef = typeof payload.input?.rubricRef === 'string' ? payload.input.rubricRef.trim() : '';
  if (!rubricRef) throw new Error('rubric_rescore_rubric_ref_required');
  const harnessSlug = typeof payload.harnessSlug === 'string' ? payload.harnessSlug : ctx.installSlug;
  const outcome = await rescoreRubric({ rubricRef, workspaceId: ctx.workspaceId, harnessSlug }, deps);
  return {
    diagnostics: { rubricRescore: outcome },
    ...(outcome.probeError ? { softError: `rubric-rescore probe batch: ${outcome.probeError}`.slice(0, 600) } : {}),
  };
}

registerSystemAction(RUBRIC_RESCORE_ACTION, runRubricRescoreAction, { scheduling: 'on-demand', planSchedulable: true });

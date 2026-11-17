import {
  LEG_OUTCOME_TABLE, LEG_OUTCOMES_ACTION, LEG_OUTCOMES_INSTRUMENT_KEY,
  LEG_OUTCOMES_SUBJECT_PLAN, PUSH_LEG_DESIGN_TABLE_SHA256, legOutcomeScheduleVerdict,
} from './native-adoption';
import type { Sql } from 'postgres';
import type { Rubric, RubricCriterion } from '../rubrics';

export const LEG_MEASUREMENT_HEALTH_INSTRUMENT_KEY = 'code-intel:leg-measurement-health';

export interface LegMeasurementReport {
  id: string; ts: number; action: string; subject: string; workspaceId: string; details: unknown;
}

export interface LegMeasurementHealthInput {
  workspaceId: string;
  /** Exact standing rubric bound by the outcome plan, not a search result. */
  rubricRef: string;
  rubric: { rubricId: string; kind: string; status: string; instrumentKeys: readonly string[] } | null;
  subjectPlan: string;
  schedule: unknown;
  scheduleActive: boolean | null;
  /** Complete latest attempt; never substitute an older successful report. */
  report: LegMeasurementReport | null;
  reportReadError?: string;
  now: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** Evaluate measurement existence/recurrence without grading descriptive outcomes.
 * Callers must follow the latest ledger attempt's reference to the complete audit record.
 */
export function rateLegMeasurementHealth(input: LegMeasurementHealthInput): {
  verdict: 'pass' | 'fail' | 'unknown'; detail: string; reportRef: string | null;
} {
  const reportRef = input.report?.id ? `audit-log:${input.report.id}` : null;
  const result = (verdict: 'pass' | 'fail' | 'unknown', detail: string) => ({ verdict, detail, reportRef });
  if (!input.workspaceId.trim() || !input.rubricRef.trim() || !Number.isFinite(input.now)) {
    return result('unknown', 'Exact workspace, standing rubric and observation time required.');
  }
  if (!input.rubric) return result('unknown', 'The bound standing rubric could not be read.');
  if (input.subjectPlan !== LEG_OUTCOMES_SUBJECT_PLAN || input.rubric.rubricId !== input.rubricRef
    || input.rubric.kind !== 'standard' || input.rubric.status !== 'active'
    || !input.rubric.instrumentKeys.includes(LEG_OUTCOMES_INSTRUMENT_KEY)) {
    return result('fail', 'An active separate standard rubric measuring leg outcomes must be bound.');
  }
  const report = input.report;
  const schedule = legOutcomeScheduleVerdict({ schedule: input.schedule, active: input.scheduleActive,
    latestScoreAt: report && Number.isFinite(report.ts) ? new Date(report.ts).toISOString() : null, now: input.now });
  if (schedule.status !== 'fresh') return result('fail', schedule.reason);
  if (input.reportReadError) return result('unknown', `Complete report unavailable: ${input.reportReadError}`);
  if (!report || !reportRef) return result('unknown', 'No complete report reference retained.');
  if (report.workspaceId !== input.workspaceId || report.action !== LEG_OUTCOMES_ACTION
    || report.subject !== LEG_OUTCOMES_INSTRUMENT_KEY || report.ts > input.now) {
    return result('unknown', 'Report identity, scope or completion time does not match.');
  }
  const details = record(report.details);
  const window = record(details?.window);
  const start = typeof window?.windowStart === 'string' ? Date.parse(window.windowStart) : NaN;
  const end = typeof window?.windowEnd === 'string' ? Date.parse(window.windowEnd) : NaN;
  if (!details || window?.workspaceId !== input.workspaceId || !Number.isFinite(start)
    || !Number.isFinite(end) || start >= end || end > report.ts) {
    return result('unknown', 'No valid scoped observation window in the complete report.');
  }
  if (typeof details.buildSha !== 'string' || !/^[a-f0-9]{7,64}$/.test(details.buildSha)
    || typeof details.fingerprint !== 'string'
    || !new RegExp(`^native-adoption\\.ts@[a-f0-9]{40,64}\\+design@${PUSH_LEG_DESIGN_TABLE_SHA256}$`).test(details.fingerprint)) {
    return result('unknown', 'Complete module/build/Design provenance required.');
  }
  if (details.readError !== null || !Array.isArray(details.divergence)) {
    return result('unknown', 'The report did not complete its source reads.');
  }
  if (details.divergence.length) return result('fail', 'The report records Design-table divergence.');
  const expected = Object.entries(LEG_OUTCOME_TABLE);
  const completeLegs = (legs: unknown): boolean => Array.isArray(legs)
    && legs.length === expected.length && new Set(legs).size === expected.length
    && expected.every(([leg]) => legs.includes(leg));
  if (!completeLegs(details.legs) || !Array.isArray(details.outcomes)) {
    return result('unknown', 'Complete derived leg population required.');
  }
  const outcomes = details.outcomes.map(record);
  if (!completeLegs(outcomes.map(outcome => outcome?.leg))) {
    return result('unknown', 'Every derived leg needs exactly one complete outcome record.');
  }
  for (const [leg, spec] of expected) {
    const outcome = outcomes.find(value => value?.leg === leg);
    const reading = record(outcome?.result);
    if (!reading || reading.key !== spec.resultKey
      || !['measured', 'insufficient-data', 'unmeasured', 'cannot-observe'].includes(String(reading.status))
      || (spec.resultKey === 'cannot-observe' && (reading.status !== 'cannot-observe'
        || typeof reading.reason !== 'string' || !reading.reason.trim()))
      || (spec.resultKey !== 'cannot-observe' && reading.status === 'cannot-observe')) {
      return result('unknown', `Incomplete or mismatched result identity for ${leg}.`);
    }
  }
  return result('pass', `Standing rubric ${input.rubricRef}; armed recurrence; complete report ${reportRef}.`);
}

type HealthPlan = {
  workspaceId: string; harnessSlug: string; planSlug: string;
  schedule: unknown; scheduleActive: boolean; expiresAt?: string | null;
};
type HealthRubric = Pick<Rubric, 'workspaceId' | 'rubricId' | 'kind' | 'status'> & {
  criteria: readonly Pick<RubricCriterion, 'key' | 'check' | 'instrumentKey' | 'model'>[];
};
export interface LegMeasurementHealthDeps {
  sql: Sql;
  readPlan(workspaceId: string): Promise<HealthPlan | null>;
  readRubric(rubricRef: string, workspaceId: string): Promise<HealthRubric | null>;
  now?(): number;
}

/** Follow the plan's exact schedule binding, then the latest ledger attempt's
 * retained scalar to its complete audit record. Outcome/sample quality is never
 * an input to this verdict. Missing references never fall back to an older run.
 */
export async function measureLegMeasurementHealth(workspaceId: string, deps: LegMeasurementHealthDeps) {
  const unavailable = (detail: string) => ({ verdict: 'unknown' as const, detail, reportRef: null });
  if (!workspaceId.trim()) return unavailable('Exact workspace required.');
  const now = deps.now?.() ?? Date.now();
  try {
    const plan = await deps.readPlan(workspaceId);
    if (!plan || plan.workspaceId !== workspaceId || plan.harnessSlug !== 'papercusp'
      || plan.planSlug !== LEG_OUTCOMES_SUBJECT_PLAN) return unavailable('Exact outcome plan could not be read.');
    const action = record(record(plan.schedule)?.action);
    const rubricRef = record(action?.input)?.rubricRef;
    if (action?.system !== 'rubric-rescore' || typeof rubricRef !== 'string' || !rubricRef.trim()) {
      return { verdict: 'fail' as const, detail: 'The outcome plan must schedule its exact standing rubric.', reportRef: null };
    }
    if (plan.expiresAt && (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now)) {
      return { verdict: 'fail' as const, detail: 'The outcome measurement schedule has expired.', reportRef: null };
    }
    const rubric = await deps.readRubric(rubricRef, workspaceId);
    if (!rubric || rubric.workspaceId !== workspaceId) return unavailable('The bound standing rubric could not be read.');
    const [{ effectiveCriterionInstrumentKey }, { readLatestInstrumentCheckAttempt }] = await Promise.all([
      import('../rubrics'), import('../check-results-ledger'),
    ]);
    const criteria = rubric.criteria.filter(c => effectiveCriterionInstrumentKey(c) === LEG_OUTCOMES_INSTRUMENT_KEY);
    if (!criteria.length || rubric.kind !== 'standard' || rubric.status !== 'active' || rubric.rubricId !== rubricRef) {
      return { verdict: 'fail' as const, detail: 'An active standing rubric must bind an outcome check.', reportRef: null };
    }
    const attempts = await Promise.all(criteria.map(async criterion => ({ criterion,
      attempt: await readLatestInstrumentCheckAttempt({ workspaceId, rubricRef, criterionKey: criterion.key }, deps.sql) })));
    let latest: Awaited<ReturnType<typeof readLatestInstrumentCheckAttempt>> = null;
    let criterion: (typeof criteria)[number] | undefined;
    for (const entry of attempts) if (entry.attempt && (!latest || entry.attempt.testRunId > latest.testRunId)) {
      latest = entry.attempt; criterion = entry.criterion;
    }
    const check = latest?.check;
    const provenance = check?.provenance;
    if (!check || check.rubricRef !== rubricRef || check.criterionKey !== criterion?.key || check.kind !== 'instrument'
      || check.subject || !provenance || provenance.redacted || provenance.gaps.includes('procedure-truncated')) {
      return unavailable('Latest outcome attempt has no usable complete-report provenance.');
    }
    const procedure = record(JSON.parse(provenance.procedure.snapshot));
    if (procedure?.kind !== 'platform-instrument' || procedure.instrumentKey !== LEG_OUTCOMES_INSTRUMENT_KEY
      || record(procedure.window)?.workspaceId !== workspaceId || !['pass', 'fail', 'error'].includes(latest!.status)) {
      return unavailable('Latest outcome attempt has mismatched identity or is unfinished.');
    }
    const refs = provenance.diagnostics.filter(d => d.path === '$["reportRef"]');
    const ref = refs.length === 1 ? refs[0]!.value : null;
    if (typeof ref !== 'string' || !/^audit-log:ci-leg-outcomes-[a-z0-9]+-[a-z0-9]{1,6}$/.test(ref)) {
      return unavailable('Latest outcome attempt has no intact complete-report reference.');
    }
    const reportId = ref.substring('audit-log:'.length);
    const [row] = await deps.sql<Array<{ id: string; ts: number | string; action: string; subject: string;
      workspace_id: string; details: unknown }>>`
      SELECT id, ts, action, subject, workspace_id, details FROM harness_shared.audit_log
       WHERE workspace_id = ${workspaceId} AND id = ${reportId}`;
    if (!row) return unavailable(`Complete report ${ref} could not be read.`);
    const reportWindow = record(record(row.details)?.window);
    const measuredWindow = record(procedure.window);
    if (['windowStart', 'windowEnd'].some(key => typeof reportWindow?.[key] !== 'string'
      || typeof measuredWindow?.[key] !== 'string'
      || Date.parse(reportWindow[key]) !== Date.parse(measuredWindow[key]))
      || Number(row.ts) > Date.parse(provenance.finishedAt)) {
      return unavailable(`Complete report ${ref} does not match the latest attempt's window or completion.`);
    }
    const rating = rateLegMeasurementHealth({ workspaceId, rubricRef,
      rubric: { ...rubric, instrumentKeys: [LEG_OUTCOMES_INSTRUMENT_KEY] }, subjectPlan: plan.planSlug,
      schedule: plan.schedule, scheduleActive: plan.scheduleActive, now,
      report: { ...row, ts: Number(row.ts), workspaceId: row.workspace_id } });
    return rating;
  } catch (error) {
    return unavailable(`Measurement health unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function codeIntelLegMeasurementHealthRescore() {
  return { windowMs: 86_400_000, unit: 'count' as const, scope: 'workspace' as const,
    resolve: async (window: { workspaceId: string }) => {
      if (!window.workspaceId.trim()) return { verdict: 'unknown' as const, detail: 'Exact workspace required.' };
      const [{ getOrgPg }, { getPlanRow }, { readRubricWithoutSeeding }] = await Promise.all([
        import('@papercusp/db-org'), import('../agent-tools/plans/source'), import('../rubrics'),
      ]);
      const sql = getOrgPg().sql;
      return measureLegMeasurementHealth(window.workspaceId, { sql,
        readPlan: workspaceId => getPlanRow(LEG_OUTCOMES_SUBJECT_PLAN, { workspaceId, harnessSlug: 'papercusp' }),
        readRubric: async (rubricRef, workspaceId) => {
          const result = await readRubricWithoutSeeding(rubricRef, { sql, workspaceId });
          if (result.kind === 'found') return result.rubric;
          if (result.kind === 'missing') return null;
          throw new Error('The bound standing rubric is ambiguous or unreadable.');
        } });
    } };
}

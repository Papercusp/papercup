import {
  LEG_OUTCOME_TABLE, LEG_OUTCOMES_ACTION, LEG_OUTCOMES_INSTRUMENT_KEY,
  LEG_OUTCOMES_SUBJECT_PLAN, PUSH_LEG_DESIGN_TABLE_SHA256, legOutcomeScheduleVerdict,
} from './native-adoption';

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

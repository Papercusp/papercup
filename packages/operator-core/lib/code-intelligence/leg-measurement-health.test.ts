import { describe, expect, it, vi } from 'vitest';
import {
  LEG_OUTCOME_TABLE, LEG_OUTCOMES_ACTION, LEG_OUTCOMES_INSTRUMENT_KEY, LEG_OUTCOMES_SUBJECT_PLAN,
  PUSH_LEG_DESIGN_TABLE_SHA256, computeLegOutcomes, rateLegOutcomes,
} from './native-adoption';
import { measureLegMeasurementHealth, rateLegMeasurementHealth, type LegMeasurementHealthDeps, type LegMeasurementHealthInput } from './leg-measurement-health';

const now = Date.parse('2026-11-17T10:00:00Z');
const window = { workspaceId: 'health-test', windowStart: '2026-11-16T08:00:00Z', windowEnd: '2026-11-17T08:00:00Z' };
const fixture = (): LegMeasurementHealthInput => ({
  workspaceId: window.workspaceId, rubricRef: 'standing-leg-outcomes',
  rubric: { rubricId: 'standing-leg-outcomes', kind: 'standard', status: 'active', instrumentKeys: [LEG_OUTCOMES_INSTRUMENT_KEY] },
  subjectPlan: LEG_OUTCOMES_SUBJECT_PLAN, now,
  schedule: { kind: 'interval', intervalSec: 86400, action: { system: 'rubric-rescore' } }, scheduleActive: true,
  report: { id: 'complete-report', ts: now - 3600000, workspaceId: window.workspaceId,
    action: LEG_OUTCOMES_ACTION, subject: LEG_OUTCOMES_INSTRUMENT_KEY,
    details: { buildSha: 'b'.repeat(40), fingerprint: `native-adoption.ts@${'a'.repeat(40)}+design@${PUSH_LEG_DESIGN_TABLE_SHA256}`,
      legs: Object.keys(LEG_OUTCOME_TABLE), window, divergence: [], readError: null,
      outcomes: computeLegOutcomes({ ...window, triggers: [], actions: [], unmeasured: { clone: 'not observed yet' } }) } },
});

describe('R1 measurement health is separate from outcome quality', () => {
  it('accepts a complete recurring measurement while historical quality stays unknown (H1/H2)', () => {
    const outcomes = computeLegOutcomes({ ...window, triggers: [], actions: [], unmeasured: { clone: 'not observed yet' } });
    expect(rateLegOutcomes(outcomes).verdict).toBe('unknown');
    expect(rateLegMeasurementHealth(fixture())).toMatchObject({ verdict: 'pass', reportRef: 'audit-log:complete-report' });
    expect(rateLegOutcomes(outcomes).verdict).toBe('unknown');
  });

  it.each(['acceptance', 'retired', 'foreign-ref', 'foreign-plan', 'missing', 'wrong-instrument'])(
    'rejects a missing or mismatched standing rubric: %s (H3)', mode => {
      const input = fixture();
      if (mode === 'missing') input.rubric = null;
      else if (mode === 'acceptance') input.rubric!.kind = 'acceptance';
      else if (mode === 'retired') input.rubric!.status = 'retired';
      else if (mode === 'foreign-ref') input.rubric!.rubricId = 'foreign';
      else if (mode === 'foreign-plan') input.subjectPlan = 'foreign';
      else input.rubric!.instrumentKeys = [];
      expect(rateLegMeasurementHealth(input).verdict).not.toBe('pass');
    });

  it.each(['missing', 'unarmed', 'unknown', 'too-long', 'stale', 'no-report'])(
    'does not infer completed recurrence from a schedule row: %s (H4/H5)', mode => {
      const input = fixture();
      if (mode === 'missing') input.schedule = null;
      if (mode === 'unarmed') input.scheduleActive = false;
      if (mode === 'unknown') input.schedule = { kind: 'cron', cron: '0 6 * * 1' };
      if (mode === 'too-long') input.schedule = { intervalSec: 172800 };
      if (mode === 'stale') input.report!.ts = now - 86400001;
      if (mode === 'no-report') input.report = null;
      expect(rateLegMeasurementHealth(input).verdict).not.toBe('pass');
    });

  it.each(['readError', 'fingerprint', 'buildSha', 'window', 'divergence'])(
    'keeps report acquisition/provenance failures unhealthy: %s (H6)', key => {
      const input = fixture();
      const details = input.report!.details as Record<string, unknown>;
      details[key] = key === 'readError' ? 'source failed' : key === 'divergence' ? ['wrong Design'] : null;
      expect(rateLegMeasurementHealth(input).verdict).not.toBe('pass');
    });

  it('checks every leg at N-1, N and N+1 and rejects duplicate identities in either order (H7)', () => {
    for (const reverse of [false, true]) {
      const input = fixture();
      const details = input.report!.details as { outcomes: unknown[] };
      const complete = reverse ? [...details.outcomes].reverse() : details.outcomes;
      details.outcomes = complete;
      expect(rateLegMeasurementHealth(input).verdict).toBe('pass');
      details.outcomes = complete.slice(0, -1);
      expect(rateLegMeasurementHealth(input).verdict).not.toBe('pass');
      details.outcomes = [...complete, complete[complete.length - 1]];
      expect(rateLegMeasurementHealth(input).verdict).not.toBe('pass');
      details.outcomes = [...complete.slice(0, -1), complete[0]];
      expect(rateLegMeasurementHealth(input).verdict).not.toBe('pass');
    }
  });

  it('keeps a newer failed report visible instead of accepting the prior healthy sample (H8 input contract)', () => {
    const input = fixture();
    expect(rateLegMeasurementHealth(input).verdict).toBe('pass');
    input.report!.id = 'newer-failed-report';
    input.report!.details = { readError: 'failed to read latest population' };
    expect(rateLegMeasurementHealth(input)).toMatchObject({ verdict: 'unknown', reportRef: 'audit-log:newer-failed-report' });
  });
});

describe('R1 exact schedule binding', () => {
  const plan = () => ({ workspaceId: window.workspaceId, harnessSlug: 'papercusp', planSlug: LEG_OUTCOMES_SUBJECT_PLAN,
    schedule: { kind: 'interval', intervalSec: 86400, action: { system: 'rubric-rescore', input: { rubricRef: 'standing-leg-outcomes' } } },
    scheduleActive: true, expiresAt: null as string | null });
  const deps = (): LegMeasurementHealthDeps => ({ sql: vi.fn() as unknown as LegMeasurementHealthDeps['sql'],
    readPlan: async () => plan(), readRubric: async () => null, now: () => now });
  it.each(['wrong-action', 'missing-ref', 'expired', 'foreign-workspace', 'foreign-plan'])(
    'refuses an unusable recurrence before reading any report: %s', async mode => {
      const input = deps(), value = plan();
      if (mode === 'wrong-action') value.schedule.action.system = 'other';
      if (mode === 'missing-ref') value.schedule.action.input.rubricRef = '';
      if (mode === 'expired') value.expiresAt = new Date(now - 1).toISOString();
      if (mode === 'foreign-workspace') value.workspaceId = 'other';
      if (mode === 'foreign-plan') value.planSlug = 'other';
      input.readPlan = async () => value;
      expect((await measureLegMeasurementHealth(window.workspaceId, input)).verdict).not.toBe('pass');
      expect(input.sql).not.toHaveBeenCalled();
    });
  it('reads only the exact schedule reference and preserves lookup failures as unknown', async () => {
    const input = deps();
    input.readRubric = vi.fn(async () => { throw new Error('source unavailable'); });
    expect(await measureLegMeasurementHealth(window.workspaceId, input)).toMatchObject({ verdict: 'unknown', detail: expect.stringContaining('source unavailable') });
    expect(input.readRubric).toHaveBeenCalledExactlyOnceWith('standing-leg-outcomes', window.workspaceId);
    expect(input.sql).not.toHaveBeenCalled();
  });
});

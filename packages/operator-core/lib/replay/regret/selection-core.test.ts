/**
 * selection-core.test.ts — bad-session scoring (self-learning-frontier
 * P-021 / FB-07): cohort percentiles, metric fallback (cost → tokens →
 * bytes), status/timeout/bounce reasons, the bar + cap.
 */
import { describe, expect, it } from 'vitest';
import { scoreBadSessions, type SelectionInputRow } from './selection-core';

let seq = 0;
function row(over: Partial<SelectionInputRow> = {}): SelectionInputRow {
  seq += 1;
  return {
    runId: over.runId ?? `run-${seq}`,
    harnessSlug: 'papercup',
    role: 'worker',
    status: 'done',
    exitCode: 0,
    durationMs: 60_000,
    startedAt: `2026-06-10T0${seq % 10}:00:00.000Z`,
    costUsd: null,
    outputTokens: null,
    transcriptBytes: null,
    featureAttempts: null,
    ...over,
  };
}

describe('scoreBadSessions', () => {
  it('flags the burn outlier within its role cohort', () => {
    const rows = [
      ...Array.from({ length: 9 }, () => row({ costUsd: 1 })),
      row({ runId: 'whale', costUsd: 40 }),
    ];
    const out = scoreBadSessions(rows, { minScore: 0.2 });
    expect(out.map((c) => c.runId)).toContain('whale');
    const whale = out.find((c) => c.runId === 'whale')!;
    expect(whale.burnPercentile).toBeGreaterThanOrEqual(0.9);
    expect(whale.reasons.some((r) => r.startsWith('burn-p'))).toBe(true);
  });

  it('cohorts by metric kind — a bytes-only row never percentiles against cost rows', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ costUsd: 1 })),
      // Only TWO bytes rows: cohort < 4 ⇒ no percentile, no false outlier.
      row({ runId: 'bytes-big', transcriptBytes: 9_000_000 }),
      row({ runId: 'bytes-small', transcriptBytes: 1000 }),
    ];
    const out = scoreBadSessions(rows, { minScore: 0 });
    const bytesBig = out.find((c) => c.runId === 'bytes-big');
    expect(bytesBig?.burnPercentile ?? null).toBeNull();
  });

  it('scores failed / cancelled / timeout / bounced sessions with stable reasons', () => {
    const rows = [
      row({ runId: 'failed', status: 'failed', exitCode: 1 }),
      row({ runId: 'rescued', status: 'cancelled' }),
      row({ runId: 'timeout', status: 'failed', exitCode: 124 }),
      row({ runId: 'bounced', featureAttempts: 3 }),
      row({ runId: 'fine' }),
    ];
    const out = scoreBadSessions(rows, { minScore: 0.2 });
    const ids = out.map((c) => c.runId);
    expect(ids).toContain('failed');
    expect(ids).toContain('rescued');
    expect(ids).toContain('bounced');
    expect(ids).not.toContain('fine');
    expect(out.find((c) => c.runId === 'timeout')!.reasons).toEqual(
      expect.arrayContaining(['status-failed', 'timeout-rc124']),
    );
    expect(out.find((c) => c.runId === 'bounced')!.reasons).toContain('validator-bounces:2');
  });

  it('ranks worst-first and honors maxSessions', () => {
    const rows = [
      row({ runId: 'mild', status: 'cancelled' }),
      row({ runId: 'awful', status: 'failed', exitCode: 124, featureAttempts: 4 }),
      row({ runId: 'bad', status: 'failed' }),
    ];
    const out = scoreBadSessions(rows, { minScore: 0.1, maxSessions: 2 });
    expect(out.map((c) => c.runId)).toEqual(['awful', 'bad']);
  });

  it('caps badness at 1.0', () => {
    const rows = [row({ runId: 'max', status: 'failed', exitCode: 124, featureAttempts: 9 })];
    const out = scoreBadSessions(rows, { minScore: 0 });
    expect(out[0].badnessScore).toBeLessThanOrEqual(1);
  });
});

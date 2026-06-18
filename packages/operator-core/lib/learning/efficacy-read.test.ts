/**
 * efficacy-read — the four learning-efficacy metrics (relight P-020). Pure
 * functions tested directly; the SQL reads tested over an injected fake `sql`.
 * The emphasis is the HONEST degradation (ok / warming / none).
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import type { ApiaryInstanceSummary } from '../iq-battery/benchmark-read';
import type { MemoryPrecisionSnapshot } from '../memory/bench/precision-read';
import {
  GEN0_BASELINE,
  championDeltaMetric,
  memoryFpAt5Metric,
  readAutoFixSurvival,
  readRecurrenceDecay,
} from './efficacy-read';

type Row = Record<string, unknown>;
function fakeSql(handler: (text: string) => Row[]): Sql {
  const fn = (strings: TemplateStringsArray) => Promise.resolve(handler(strings.join(' ? ')));
  return fn as unknown as Sql;
}

const gen = (sha: string, composite: number | null): ApiaryInstanceSummary => ({
  instanceId: `i-${sha}`,
  codeSha: sha,
  createdAt: '2026-06-15T00:00:00Z',
  totalRuns: 10,
  successfulRuns: 8,
  successRate: 0.8,
  meanComposite: composite,
  meanTimeToGreenSecs: null,
  meanTokens: null,
  escalationRate: null,
  firstAttemptRate: null,
});

const snapshot = (over: Partial<MemoryPrecisionSnapshot>): MemoryPrecisionSnapshot => ({
  latest: null,
  trend: [],
  fpAt5Delta: null,
  runCount: 0,
  ...over,
});

describe('championDeltaMetric', () => {
  it('subtracts the gen-0 baseline from the newest scored generation', () => {
    const m = championDeltaMetric([gen('newsha99', 6.4), gen('93b50cb39', 5.95)], GEN0_BASELINE.composite);
    expect(m.state).toBe('ok');
    expect(m.value).toBeCloseTo(6.4 - 5.95, 5);
    expect(m.sample).toBe(2);
  });

  it('reports a regression honestly (negative delta)', () => {
    const m = championDeltaMetric([gen('regress', 5.5)], GEN0_BASELINE.composite);
    expect(m.value).toBeLessThan(0);
  });

  it('warms when generations exist but none are scored', () => {
    const m = championDeltaMetric([gen('x', null)], GEN0_BASELINE.composite);
    expect(m.state).toBe('warming');
    expect(m.value).toBeNull();
  });

  it('is none when there are no generations at all', () => {
    const m = championDeltaMetric([], GEN0_BASELINE.composite);
    expect(m.state).toBe('none');
  });
});

describe('memoryFpAt5Metric', () => {
  it('reports the latest fp@5 when a bench has scored', () => {
    const m = memoryFpAt5Metric(
      snapshot({
        latest: {
          ranAt: 'b',
          backend: 'hybrid',
          fpAt5: 0.17,
          rAt10: 0.82,
          pAt5: 0.9,
          mrr: 0.7,
          medianTopScore: 0.6,
          floorCosine: 0.45,
          floorLex: 0.4,
          corpusN: 114,
          goldN: 150,
          latencyP50Ms: 12,
        },
        runCount: 3,
        fpAt5Delta: -0.02,
      }),
    );
    expect(m.state).toBe('ok');
    expect(m.value).toBe(0.17);
    expect(m.sample).toBe(3);
  });

  it('is none when the memory has never been benchmarked', () => {
    expect(memoryFpAt5Metric(snapshot({})).state).toBe('none');
  });
});

describe('readAutoFixSurvival', () => {
  it('computes the survival rate over matured organic fix-survival bets', async () => {
    const sql = fakeSql(() => [{ matured: 8, survived: 6, total: 12 }]);
    const m = await readAutoFixSurvival(sql, 'ws-1');
    expect(m.state).toBe('ok');
    expect(m.value).toBeCloseTo(6 / 8, 5);
    expect(m.sample).toBe(8);
  });

  it('warms when bets are placed but none matured', async () => {
    const sql = fakeSql(() => [{ matured: 0, survived: 0, total: 5 }]);
    const m = await readAutoFixSurvival(sql, 'ws-1');
    expect(m.state).toBe('warming');
    expect(m.value).toBeNull();
  });

  it('is none with no bets at all', async () => {
    const sql = fakeSql(() => [{ matured: 0, survived: 0, total: 0 }]);
    expect((await readAutoFixSurvival(sql, 'ws-1')).state).toBe('none');
  });
});

describe('readRecurrenceDecay', () => {
  it('computes verified / (verified + recurred)', async () => {
    const sql = fakeSql(() => [{ verified: 9, recurred: 1 }]);
    const m = await readRecurrenceDecay(sql, 'ws-1');
    expect(m.state).toBe('ok');
    expect(m.value).toBeCloseTo(0.9, 5);
    expect(m.sample).toBe(10);
  });

  it('warms when nothing has reached a verdict', async () => {
    const sql = fakeSql(() => [{ verified: 0, recurred: 0 }]);
    expect((await readRecurrenceDecay(sql, 'ws-1')).state).toBe('warming');
  });
});

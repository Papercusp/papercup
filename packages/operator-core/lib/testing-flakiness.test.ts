import { describe, it, expect } from 'vitest';
import { computeFlakiness, isQuarantineCandidate, type FlakinessRow } from './testing-flakiness';

/** A postgres-js-like tagged-template mock. The big aggregation query is the
 *  only call whose template text mentions `harness_shared.test_runs`; nested
 *  `sql\`TRUE\`` / `sql\`harness_slug = ...\`` condition fragments (evaluated
 *  as arguments before the outer call) return an unused placeholder. */
function makeSql(rows: Array<{ file_path: string; status: string; finished_at: string }>) {
  return ((strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('FROM harness_shared.test_runs')) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof computeFlakiness>[0] extends { sql?: infer S } ? S : never;
}

function row(filePath: string, status: string, ts: string) {
  return { file_path: filePath, status, finished_at: ts };
}

describe('computeFlakiness', () => {
  it('flags a file that flips between pass/fail every run as flipRate 1', async () => {
    const rows = [
      row('a.test.ts', 'pass', '2026-07-01T00:00:00Z'),
      row('a.test.ts', 'fail', '2026-07-01T01:00:00Z'),
      row('a.test.ts', 'pass', '2026-07-01T02:00:00Z'),
      row('a.test.ts', 'fail', '2026-07-01T03:00:00Z'),
    ];
    const out = await computeFlakiness({ minRuns: 2, sql: makeSql(rows) });
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe('a.test.ts');
    expect(out[0].totalRuns).toBe(4);
    expect(out[0].flips).toBe(3);
    expect(out[0].flipRate).toBe(1);
    expect(out[0].passCount).toBe(2);
    expect(out[0].failCount).toBe(2);
    expect(out[0].lastStatus).toBe('fail');
  });

  it('gives a consistently-green file flipRate 0', async () => {
    const rows = [
      row('b.test.ts', 'pass', '2026-07-01T00:00:00Z'),
      row('b.test.ts', 'pass', '2026-07-01T01:00:00Z'),
      row('b.test.ts', 'pass', '2026-07-01T02:00:00Z'),
    ];
    const out = await computeFlakiness({ minRuns: 2, sql: makeSql(rows) });
    expect(out[0].flipRate).toBe(0);
    expect(out[0].flips).toBe(0);
  });

  it('excludes files below minRuns', async () => {
    const rows = [
      row('short.test.ts', 'pass', '2026-07-01T00:00:00Z'),
      row('short.test.ts', 'fail', '2026-07-01T01:00:00Z'),
    ];
    const out = await computeFlakiness({ minRuns: 4, sql: makeSql(rows) });
    expect(out).toHaveLength(0);
  });

  it('a single-run file has flipRate 0 (nothing to compare)', async () => {
    const rows = [row('one.test.ts', 'fail', '2026-07-01T00:00:00Z')];
    const out = await computeFlakiness({ minRuns: 1, sql: makeSql(rows) });
    expect(out[0].totalRuns).toBe(1);
    expect(out[0].flipRate).toBe(0);
  });

  it('ranks by flipRate desc, then totalRuns desc', async () => {
    const rows = [
      // steady.test.ts: 5 runs, never flips
      ...Array.from({ length: 5 }, (_, i) => row('steady.test.ts', 'pass', `2026-07-01T0${i}:00:00Z`)),
      // flappy.test.ts: 4 runs, flips every time (flipRate 1)
      row('flappy.test.ts', 'pass', '2026-07-01T00:00:00Z'),
      row('flappy.test.ts', 'fail', '2026-07-01T01:00:00Z'),
      row('flappy.test.ts', 'pass', '2026-07-01T02:00:00Z'),
      row('flappy.test.ts', 'fail', '2026-07-01T03:00:00Z'),
    ];
    const out = await computeFlakiness({ minRuns: 2, sql: makeSql(rows) });
    expect(out.map((r) => r.filePath)).toEqual(['flappy.test.ts', 'steady.test.ts']);
  });

  it('caps recentStatuses at the last 10 runs, most-recent-last', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row('many.test.ts', i % 2 === 0 ? 'pass' : 'fail', `2026-07-01T${String(i).padStart(2, '0')}:00:00Z`));
    const out = await computeFlakiness({ minRuns: 2, sql: makeSql(rows) });
    expect(out[0].recentStatuses).toHaveLength(10);
    expect(out[0].recentStatuses[9]).toBe(rows[11].status);
  });
});

describe('isQuarantineCandidate', () => {
  const base: Pick<FlakinessRow, 'totalRuns' | 'flipRate'> = { totalRuns: 10, flipRate: 0.5 };

  it('flags a high-flip, well-sampled file', () => {
    expect(isQuarantineCandidate(base)).toBe(true);
  });

  it('does not flag a file below the run-count floor even at high flip rate', () => {
    expect(isQuarantineCandidate({ totalRuns: 2, flipRate: 0.9 })).toBe(false);
  });

  it('does not flag a well-sampled but stable file', () => {
    expect(isQuarantineCandidate({ totalRuns: 20, flipRate: 0.05 })).toBe(false);
  });

  it('respects explicit threshold/minRuns overrides', () => {
    expect(isQuarantineCandidate({ totalRuns: 5, flipRate: 0.2 }, { threshold: 0.1, minRuns: 5 })).toBe(true);
  });
});

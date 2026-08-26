import { describe, expect, it } from 'vitest';
import { summarizeStreakCause, type StreakTick } from './streak-cause-digest';

const HOUR = 3_600_000;

/** A verdict-bearing red naming `tests`. */
function red(atMs: number, tests: string[]): StreakTick {
  return { atMs, verdictBearing: true, failingTests: tests };
}
/** A non-verdict tick (skipped-locked / repair-in-progress / cancelled / record-only). */
function nonVerdict(atMs: number): StreakTick {
  return { atMs, verdictBearing: false, failingTests: [] };
}

describe('summarizeStreakCause', () => {
  it('reports STABLE when every naming verdict named the same set', () => {
    const d = summarizeStreakCause([
      red(0, ['lint:tsc']),
      red(HOUR, ['lint:tsc']),
      red(2 * HOUR, ['lint:tsc']),
    ]);
    expect(d.stability).toBe('stable');
    expect(d.persistent).toEqual(['lint:tsc']);
    expect(d.intermittent).toEqual([]);
    expect(d.namingTicks).toBe(3);
    expect(d.spanMs).toBe(2 * HOUR);
    expect(d.line).toContain('STABLE');
    expect(d.line).toContain('lint:tsc');
    expect(d.line).toContain('one unfixed break');
  });

  /**
   * THE REGRESSION GUARD (WI-42118). Most rows in a real streak are non-verdict statuses
   * naming zero tests. Counting them as verdicts turns a dead-stable streak into
   * "churning" — the exact wrong answer, and the reason `verdictBearing` is supplied by
   * the caller's `classifyGateStallStatus` rather than re-derived here.
   */
  it('does NOT let non-verdict ticks turn a STABLE streak into churn', () => {
    const withoutNoise = summarizeStreakCause([red(0, ['lint:tsc']), red(3 * HOUR, ['lint:tsc'])]);
    const withNoise = summarizeStreakCause([
      red(0, ['lint:tsc']),
      nonVerdict(HOUR),
      nonVerdict(2 * HOUR),
      red(3 * HOUR, ['lint:tsc']),
    ]);
    expect(withoutNoise.stability).toBe('stable');
    // The whole point: the noisy window must reach the SAME verdict.
    expect(withNoise.stability).toBe('stable');
    expect(withNoise.persistent).toEqual(['lint:tsc']);
    // ...and non-verdict rows must not inflate the red counts either.
    expect(withNoise.redTicks).toBe(2);
    expect(withNoise.silentRedTicks).toBe(0);
  });

  it('reports CHURNING when no test is common to all naming verdicts', () => {
    const d = summarizeStreakCause([
      red(0, ['a.test.ts', 'b.test.ts']),
      red(HOUR, ['c.test.ts']),
      red(2 * HOUR, ['d.test.ts', 'e.test.ts']),
    ]);
    expect(d.stability).toBe('churning');
    expect(d.persistent).toEqual([]);
    expect(d.intermittent).toHaveLength(5);
    expect(d.line).toContain('CHURNING');
    expect(d.line).toContain('do NOT chase');
  });

  it('reports MIXED when a persistent core coexists with churn', () => {
    const d = summarizeStreakCause([
      red(0, ['lint:tsc', 'a.test.ts']),
      red(HOUR, ['lint:tsc', 'b.test.ts']),
      red(2 * HOUR, ['lint:tsc']),
    ]);
    expect(d.stability).toBe('mixed');
    expect(d.persistent).toEqual(['lint:tsc']);
    expect(d.intermittent).toEqual(['a.test.ts', 'b.test.ts']);
    expect(d.line).toContain('MIXED');
    expect(d.line).toContain('Fix the persistent core first');
  });

  it('reports SILENT when reds happened but named nothing — the alarm is about the GATE', () => {
    const d = summarizeStreakCause([red(0, []), red(HOUR, []), red(2 * HOUR, [])]);
    expect(d.stability).toBe('silent');
    expect(d.redTicks).toBe(3);
    expect(d.namingTicks).toBe(0);
    expect(d.silentRedTicks).toBe(3);
    expect(d.line).toContain('ZERO failing tests');
    expect(d.line).toContain('about the GATE, not the code');
  });

  /** A trend needs two samples. One red must never be reported as an established break. */
  it('refuses to call a single naming verdict STABLE', () => {
    const d = summarizeStreakCause([red(0, ['lint:tsc']), nonVerdict(HOUR), red(2 * HOUR, [])]);
    expect(d.stability).toBe('unknown');
    expect(d.namingTicks).toBe(1);
    expect(d.line).toContain('too few samples');
    expect(d.line).not.toContain('STABLE');
  });

  it('reports unknown with no verdict-bearing ticks at all', () => {
    const d = summarizeStreakCause([nonVerdict(0), nonVerdict(HOUR)]);
    expect(d.stability).toBe('unknown');
    expect(d.redTicks).toBe(0);
    expect(d.spanMs).toBeNull();
  });

  it('counts reds that named nothing separately, and says so in a naming streak', () => {
    const d = summarizeStreakCause([red(0, ['lint:tsc']), red(HOUR, []), red(2 * HOUR, ['lint:tsc'])]);
    expect(d.stability).toBe('stable');
    expect(d.namingTicks).toBe(2);
    expect(d.silentRedTicks).toBe(1);
    expect(d.line).toContain('1 further red(s) named nothing');
  });

  it('is order-independent and de-duplicates names within a tick', () => {
    const forward = summarizeStreakCause([red(0, ['a', 'a', 'b']), red(HOUR, ['b', 'a'])]);
    const reversed = summarizeStreakCause([red(HOUR, ['a', 'b']), red(0, ['b', 'a', 'a'])]);
    expect(forward.stability).toBe('stable');
    expect(forward.persistent).toEqual(['a', 'b']);
    expect(reversed).toEqual(forward);
  });

  it('ignores blank and non-string test names without treating the tick as naming', () => {
    const d = summarizeStreakCause([red(0, ['', '   ']), red(HOUR, [''])]);
    expect(d.stability).toBe('silent');
    expect(d.namingTicks).toBe(0);
  });

  it('caps the rendered name list rather than pasting an unbounded wall into an alarm', () => {
    const many = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const d = summarizeStreakCause([red(0, many), red(HOUR, many)]);
    expect(d.stability).toBe('stable');
    expect(d.persistent).toHaveLength(7);
    expect(d.line).toContain('(+2 more)');
    expect(d.line).not.toContain('t7');
  });

  /**
   * Replay of the LIVE papercusp streak (measured 2026-08-26 from
   * `harness_shared.pipeline_events`, kind `green_checkpoint`): `lint:tsc` recurring alone
   * across separate verdicts spanning >33h, one 14-file outlier, and many non-verdict rows
   * between. The digest must call this MIXED-with-a-lint:tsc-core, and above all must not
   * be misled into 'churning' by the zero-test rows.
   */
  it('replays the live 2026-08-26 papercusp streak and names the real core', () => {
    const t = (iso: string) => new Date(iso).getTime();
    const d = summarizeStreakCause([
      red(t('2026-08-24T14:34:50.806Z'), ['lint:tsc']),
      red(t('2026-08-24T14:34:51.330Z'), ['lint:tsc']),
      nonVerdict(t('2026-08-24T16:16:37.220Z')), // skipped-locked
      nonVerdict(t('2026-08-24T17:15:42.466Z')), // repair-in-progress
      nonVerdict(t('2026-08-24T19:24:53.759Z')), // cancelled
      nonVerdict(t('2026-08-24T22:12:02.123Z')), // migrations-pending
      red(t('2026-08-25T15:34:43.554Z'), [
        'lint:tsc',
        '@papercusp/desktop',
        '@papercusp/operator-core',
        '@papercusp/operator-core :: gen:client-docs:check',
      ]),
      nonVerdict(t('2026-08-25T20:15:25.693Z')), // repair-in-progress
      red(t('2026-08-25T23:07:01.109Z'), ['lint:tsc']),
      red(t('2026-08-25T23:47:58.596Z'), ['lint:tsc']),
    ]);
    expect(d.stability).toBe('mixed');
    expect(d.persistent).toEqual(['lint:tsc']);
    expect(d.namingTicks).toBe(5);
    expect(d.redTicks).toBe(5);
    // >33h of the same core break — the fact no single-tick body could carry.
    expect(d.spanMs).toBeGreaterThan(33 * HOUR);
    expect(d.line).toContain('lint:tsc');
    expect(d.line).toContain('33.2h');
  });
});

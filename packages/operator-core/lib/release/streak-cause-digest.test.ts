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

  /**
   * ⚠ WHAT THE `verdictBearing` FILTER ACTUALLY BUYS — measured, not assumed.
   *
   * The first draft of this control asserted that counting non-verdict ticks as verdicts
   * would flip STABLE to CHURNING. It does not, and the control failing is what proved it:
   * a tick naming no tests never enters the naming set, so it cannot touch the
   * persistent/intermittent split at all. Empty sets are ignored by construction.
   *
   * The filter earns its place on the OTHER two outputs, both of which go straight into an
   * alarm a human reads:
   *   1. the tick COUNTS quoted in the sentence, and
   *   2. the 'silent' verdict — "N red verdicts named ZERO failing tests, so the alarm is
   *      about the GATE" is a specific, actionable claim. Asserting it about a window that
   *      produced no verdicts at all (every row skipped-locked / cancelled) is simply false,
   *      and it is exactly the sentence a responder would act on.
   */
  it('CONTROL: the verdict filter is what stops a no-verdict window claiming reds named nothing', () => {
    const window = [
      { atMs: 0, failingTests: [] },
      { atMs: HOUR, failingTests: [] },
      { atMs: 2 * HOUR, failingTests: [] },
    ];
    const correct = summarizeStreakCause(window.map((t) => ({ ...t, verdictBearing: false })));
    const corrupted = summarizeStreakCause(window.map((t) => ({ ...t, verdictBearing: true })));

    expect(correct.stability).toBe('unknown');
    expect(correct.redTicks).toBe(0);
    expect(correct.line).not.toContain('ZERO failing tests');
    // The mutant makes a claim about reds that never happened — falsifiability, demonstrated.
    expect(corrupted.stability).toBe('silent');
    expect(corrupted.redTicks).toBe(3);
    expect(corrupted.line).toContain('ZERO failing tests');
  });

  /**
   * The over-inclusion that CAN move stability is a tick that is not a verdict but still
   * NAMES tests — the `'record-only'` (proven-stale-candidate) class, whose named files
   * passed at tip. Counting it shrinks the persistent core, understating stability. This
   * pins the direction of that error, which is what the reader's docblock claims.
   */
  it('CONTROL: a non-verdict tick that NAMES tests degrades stable to mixed if counted', () => {
    const window = [
      { atMs: 0, failingTests: ['lint:tsc'] },
      { atMs: HOUR, failingTests: ['stale-only.test.ts'] }, // record-only: passed at tip
      { atMs: 2 * HOUR, failingTests: ['lint:tsc'] },
    ];
    const correct = summarizeStreakCause(
      window.map((t, i) => ({ ...t, verdictBearing: i !== 1 })),
    );
    const corrupted = summarizeStreakCause(window.map((t) => ({ ...t, verdictBearing: true })));

    expect(correct.stability).toBe('stable');
    expect(correct.persistent).toEqual(['lint:tsc']);
    // Understates stability — never manufactures a false 'stable'. Safe direction.
    expect(corrupted.stability).toBe('churning');
    expect(corrupted.persistent).toEqual([]);
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

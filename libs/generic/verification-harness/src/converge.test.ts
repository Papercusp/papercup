import { describe, expect, it } from 'vitest';
import {
  CONVERGENCE_TIMEOUT_MARKER,
  ConvergenceTimeoutError,
  requireConvergence,
  waitForConvergence,
  type WaitForConvergenceOptions,
} from './converge.js';

/** A fake clock whose sleep advances time, so every test is deterministic. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

/** Observations served in order; the last one repeats. */
function sequence<T>(values: T[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    observe: async () => {
      calls.push(i);
      const v = values[Math.min(i, values.length - 1)] as T;
      i += 1;
      return v;
    },
    calls,
  };
}

const lagUnlessOk = (v: string) => (v === 'ok' ? [] : [`state=${v}`]);

function opts(
  overrides: Partial<WaitForConvergenceOptions<string>> & Pick<WaitForConvergenceOptions<string>, 'observe'>,
): WaitForConvergenceOptions<string> {
  return { what: 'vm mirror', lagging: lagUnlessOk, budgetMs: 10_000, pollMs: 1_000, ...overrides };
}

describe('waitForConvergence', () => {
  it('reads immediately and returns on the first converged read (level-triggered)', async () => {
    const clock = fakeClock();
    const seq = sequence(['ok']);
    const r = await waitForConvergence(opts({ observe: seq.observe, now: clock.now, sleep: clock.sleep }));
    expect(r).toMatchObject({ converged: true, value: 'ok', lagging: [], reads: 1, elapsedMs: 0 });
    expect(clock.sleeps).toEqual([]);
  });

  it('keeps reading after an async action until the remote converges', async () => {
    const clock = fakeClock();
    const seq = sequence(['stale', 'stale', 'ok']);
    const r = await waitForConvergence(opts({ observe: seq.observe, now: clock.now, sleep: clock.sleep }));
    expect(r).toMatchObject({ converged: true, value: 'ok', reads: 3, elapsedMs: 2_000 });
  });

  it('on timeout keeps the LAST observation and its lagging reasons as evidence', async () => {
    const clock = fakeClock();
    const seq = sequence(['a', 'b', 'c', 'd']);
    const r = await waitForConvergence(
      opts({ observe: seq.observe, budgetMs: 2_500, now: clock.now, sleep: clock.sleep }),
    );
    expect(r.converged).toBe(false);
    expect(r.value).toBe('d');
    expect(r.lagging).toEqual(['state=d']);
    // reads at 0, 1000, 2000, 2500 (the last sleep is clipped to the remaining budget)
    expect(r.reads).toBe(4);
    expect(clock.sleeps).toEqual([1_000, 1_000, 500]);
    expect(r.elapsedMs).toBe(2_500);
  });

  it('budget 0 is an explicit single read', async () => {
    const clock = fakeClock();
    const seq = sequence(['stale', 'ok']);
    const r = await waitForConvergence(
      opts({ observe: seq.observe, budgetMs: 0, now: clock.now, sleep: clock.sleep }),
    );
    expect(r).toMatchObject({ converged: false, value: 'stale', reads: 1 });
    expect(clock.sleeps).toEqual([]);
  });

  it('runs `between` only between polls, never before the first read or past the deadline', async () => {
    const clock = fakeClock();
    const seq = sequence(['a', 'b', 'c']);
    const nudges: number[] = [];
    await waitForConvergence(
      opts({
        observe: seq.observe,
        budgetMs: 2_000,
        now: clock.now,
        sleep: clock.sleep,
        between: async (read) => {
          nudges.push(read);
        },
      }),
    );
    // reads at 0, 1000, 2000; one nudge after read 1 (t=1000 < deadline), none at t=2000 (deadline)
    expect(seq.calls.length).toBe(3);
    expect(nudges).toEqual([1]);
  });

  it('propagates a throwing read: a broken observation is not lag', async () => {
    const clock = fakeClock();
    await expect(
      waitForConvergence(
        opts({
          observe: async () => {
            throw new Error('ssh: connection refused');
          },
          now: clock.now,
          sleep: clock.sleep,
        }),
      ),
    ).rejects.toThrow('ssh: connection refused');
  });

  it('counts time spent inside a slow read against the budget', async () => {
    const clock = fakeClock();
    let n = 0;
    const r = await waitForConvergence(
      opts({
        observe: async () => {
          n += 1;
          clock.advance(6_000); // each ssh read takes 6 s
          return 'stale';
        },
        budgetMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    // read 1 ends at 6000, sleep 1000, read 2 ends at 13000 (past the 10000 deadline) -> stop
    expect(n).toBe(2);
    expect(r.converged).toBe(false);
  });

  it.each([
    ['negative budget', { budgetMs: -1 }],
    ['budget over the ceiling', { budgetMs: 25 * 60_000 }],
    ['budget over a custom ceiling', { budgetMs: 5_000, maxBudgetMs: 1_000 }],
    ['non-finite budget', { budgetMs: Number.POSITIVE_INFINITY }],
    ['zero poll', { pollMs: 0 }],
    ['missing what', { what: '' }],
  ])('rejects %s before reading', async (_label, bad) => {
    const seq = sequence(['ok']);
    await expect(waitForConvergence(opts({ observe: seq.observe, ...bad }))).rejects.toThrow(/waitForConvergence/);
    expect(seq.calls).toEqual([]);
  });
});

describe('requireConvergence', () => {
  it('returns the converged value', async () => {
    const clock = fakeClock();
    const seq = sequence(['stale', 'ok']);
    await expect(requireConvergence(opts({ observe: seq.observe, now: clock.now, sleep: clock.sleep }))).resolves.toBe(
      'ok',
    );
  });

  it('throws a marked ConvergenceTimeoutError carrying the last observation', async () => {
    const clock = fakeClock();
    const seq = sequence(['stale']);
    const err = await requireConvergence(
      opts({ observe: seq.observe, budgetMs: 1_000, now: clock.now, sleep: clock.sleep }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvergenceTimeoutError);
    const timeout = err as ConvergenceTimeoutError<string>;
    expect(timeout.message).toContain(CONVERGENCE_TIMEOUT_MARKER);
    expect(timeout.message).toContain('vm mirror');
    expect(timeout.message).toContain('state=stale');
    expect(timeout.result.value).toBe('stale');
    expect(timeout.result.reads).toBe(2);
  });
});

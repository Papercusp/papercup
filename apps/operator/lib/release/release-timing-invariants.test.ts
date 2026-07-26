/**
 * The green-gate timing chain — the recurrence guard for WI-6112.
 *
 * Four constants bound one green-checkpoint run, and they live in THREE files across
 * TWO workspaces because operator-core cannot import from apps/operator. Each file
 * carried a prose "whoever retunes one must retune the others" note, and nothing
 * enforced it — so when the suite budget was raised 55m→120m (EI-7553) the DBOS
 * reaper's no-output window stayed at 60m and silently became the TIGHTEST bound in
 * the chain: it cancelled the bookkeeping row of healthy 60–90m runs while their own
 * timeout still had 30m to go, re-arming the 2026-06-29 "reaper kills a healthy
 * checkpoint" incident that freezes `main` (→ every fleet deploy) for hours.
 *
 * This test is the missing enforcement. It is deliberately a pure-constant assertion
 * with no I/O: it is cheap enough to run in the affected-tests loop, and it fails at
 * EDIT time rather than at the next multi-hour gate freeze.
 *
 * If you are here because this test just went red: do not "fix" it by nudging one
 * number until it passes. Read the chain below, decide which link genuinely needs to
 * move, and move the OTHERS to keep the ordering — the whole point is that these four
 * numbers are one decision, not four.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS } from '@papercusp/operator-core/lib/dbos/dbos-executor-reaper';
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from '@papercusp/operator-core/lib/harness/routines/release-actions';

import { CHECKPOINT_LOCK_STALE_MS, SELF_WATCHDOG_MS } from './green-checkpoint';

const MIN = 60_000;
const m = (ms: number) => `${Math.round(ms / MIN)}m`;

type Link = readonly [name: string, ms: number];

/** The whole chain, in the order a single run passes through it. */
const CHAIN: readonly Link[] = [
  ['GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (release-actions.ts)', GREEN_CHECKPOINT_SUITE_TIMEOUT_MS],
  ['SELF_WATCHDOG_MS (green-checkpoint.ts)', SELF_WATCHDOG_MS],
  ['DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (dbos-executor-reaper.ts)', DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS],
  ['CHECKPOINT_LOCK_STALE_MS (green-checkpoint.ts)', CHECKPOINT_LOCK_STALE_MS],
];

/**
 * Returns a human-readable report of the FIRST place the chain stops increasing, or
 * null when it is strictly monotonic. Pure + exported-shaped on purpose: the test below
 * feeds it the historical BROKEN configuration, so this guard is itself guarded — an
 * always-green detector would silently stop protecting the gate.
 */
function firstInversion(chain: readonly Link[]): string | null {
  for (let i = 1; i < chain.length; i += 1) {
    const [prevName, prev] = chain[i - 1];
    const [name, cur] = chain[i];
    if (cur <= prev) {
      // Report the WHOLE chain — the link that moved is rarely the one to fix.
      const rendered = chain.map(([n, ms]) => `${n} = ${m(ms)}`).join('\n  ');
      return (
        `${name} (${m(cur)}) must be STRICTLY GREATER than ${prevName} (${m(prev)}).\n` +
        `The gate's timing chain is:\n  ${rendered}\n` +
        'See the INVARIANT comments on all four constants before changing any of them.'
      );
    }
  }
  return null;
}

describe('green-gate timing chain (WI-6112)', () => {
  it('is strictly monotonic: suite timeout < self-watchdog < reaper no-output < lock stale', () => {
    expect(firstInversion(CHAIN)).toBeNull();
  });

  it('detects the historical inversion it exists to prevent', () => {
    // The exact live configuration on 2026-07-26: the suite budget had been raised to
    // 120m but the reaper's window was still the pre-bump 60m, so the reaper was the
    // tightest link and cancelled healthy runs. If this ever returns null, the detector
    // above has been broken and the real chain is no longer protected.
    const historical: readonly Link[] = [
      ['GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (release-actions.ts)', 120 * MIN],
      ['SELF_WATCHDOG_MS (green-checkpoint.ts)', 180 * MIN],
      ['DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (dbos-executor-reaper.ts)', 60 * MIN],
      ['CHECKPOINT_LOCK_STALE_MS (green-checkpoint.ts)', 190 * MIN],
    ];
    const report = firstInversion(historical);
    expect(report).not.toBeNull();
    expect(report).toContain('DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS');
    // …and it must also catch an EQUAL pair, not just a smaller one.
    expect(firstInversion([['a', 5 * MIN], ['b', 5 * MIN]])).not.toBeNull();
  });

  it('gives the reaper a window ABOVE the whole run, not merely above the suite timeout', () => {
    // The reaper's window is a WALL-CLOCK CAP FROM WORKFLOW CREATION, not a
    // since-last-output silence timer (verified 2026-07-26 against the predicate:
    // `created_at < now - window` AND "no operation_outputs row with function_id > 0").
    // The suite writes NO DBOS step checkpoint until its single step returns, however
    // chattily it logs to disk — so a healthy run only escapes reaping by FINISHING
    // inside this window. A parent-dead run is not killed until its own self-watchdog
    // fires, so the window must clear the watchdog too, not just the suite timeout.
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThan(SELF_WATCHDOG_MS);
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThan(GREEN_CHECKPOINT_SUITE_TIMEOUT_MS);
  });

  it('frees the DBOS dedup pin before the run-lock becomes reclaimable', () => {
    // Ordering rationale for the last link: cancelling the non-terminal fire releases
    // the `routine:<id>` dedup pin, which is what lets the routine be requeued. If the
    // lock became stale-reclaimable FIRST, a peer could take the lock while the routine
    // was still dedup-pinned — a reclaimable lock with no fire able to use it.
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeLessThan(CHECKPOINT_LOCK_STALE_MS);
  });

  it('leaves the reaper enough margin to actually fire inside that gap', () => {
    // The reaper sweeps every DEFAULT_REAP_INTERVAL_MS (2m), so it observes a row up to
    // one interval AFTER the window elapses. That late observation must still land below
    // the lock-stale threshold, or the ordering above holds on paper and inverts in
    // practice. Two sweeps of headroom keeps it honest under host CPU pressure.
    const sweepHeadroom = 2 * 2 * MIN;
    expect(CHECKPOINT_LOCK_STALE_MS - DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThanOrEqual(
      sweepHeadroom,
    );
  });
});

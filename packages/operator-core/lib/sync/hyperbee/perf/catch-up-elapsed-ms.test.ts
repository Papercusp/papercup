/**
 * catch-up-elapsed-ms.test.ts — EI-20582417177742601.
 *
 * `floodCatchUpMs` / `ceilingOpsPerSec` are supposed to report the gap between the
 * writer being told to `go` and a given reader catching up. The scenarios used to
 * compute that as `Date.now() - tGo` read inside the await loop, which measures WHEN
 * THE PARENT OBSERVED the event rather than when it fired — so every reader queued
 * behind a slow one was inflated by the slow one's wait, and the distortion grew with
 * peer count and host load. p2p-perf regression reports cite floodCatchUpMs deltas, so
 * that confound landed directly in the regression signal.
 *
 * The subject here is `catchUpElapsedMs`, which the scenarios now route through.
 *
 * ⚠ These tests drive the FUNCTION with synthetic observations rather than spawning
 * children: the defect is arithmetic over (child instant, parent instant), so it is
 * fully expressible without a mesh — and a test that had to spawn real peers could not
 * pin the parent's observation lag, which is the exact quantity under test.
 *
 * The pre-fix behaviour is kept as a named local (`parentObservedElapsedMs`) so every
 * falsifier below can assert that the two implementations genuinely DISAGREE. Without
 * that control an assertion could pass because both are equal — falsifying nothing.
 */
import { describe, it, expect } from 'vitest';
import { catchUpElapsedMs, type ChildEvent } from './child-driver';

/** The pre-fix computation, retained ONLY as a control to prove the fix changes something. */
function parentObservedElapsedMs(opts: { tGo: number; tAwait: number; elapsedMs: number }): number {
  return opts.tAwait - opts.tGo + opts.elapsedMs;
}

/** A 'caught-up' event as the child emits it: `t` is bootT0-relative, `wallMs` absolute. */
function caughtUp(opts: { wallMs?: number; t?: number }): ChildEvent {
  return {
    evt: 'caught-up',
    appliedKeys: 100,
    ...(opts.t === undefined ? {} : { t: opts.t }),
    ...(opts.wallMs === undefined ? {} : { wallMs: opts.wallMs }),
  };
}

describe('catchUpElapsedMs — the reported time is the CHILD\'s, not the parent\'s (EI-20582417177742601)', () => {
  const T_GO = 1_000_000;

  it('CALIBRATION: with no parent lag, both implementations agree', () => {
    // Anchors the numbers. If this ever diverges, the falsifiers below are
    // measuring something other than the parent-lag term they claim to.
    const tAwait = T_GO; // parent began awaiting the instant it sent `go`
    const elapsedMs = 500; // and observed the event 500ms later
    const event = caughtUp({ wallMs: T_GO + 500, t: 9_999 });

    expect(catchUpElapsedMs(event, { tGo: T_GO, tAwait, elapsedMs })).toBe(500);
    expect(parentObservedElapsedMs({ tGo: T_GO, tAwait, elapsedMs })).toBe(500);
  });

  it('FALSIFIER: a deliberately-slow reader AHEAD of this one does not change its reported time', () => {
    // The defect, stated exactly. Same child, same true catch-up instant
    // (tGo + 500). The only difference is how long the PARENT took to get around
    // to observing it — which is what a slow predecessor causes.
    const event = caughtUp({ wallMs: T_GO + 500, t: 9_999 });
    const noSlowPredecessor = { tGo: T_GO, tAwait: T_GO, elapsedMs: 500 };
    const behindASlowReader = { tGo: T_GO, tAwait: T_GO, elapsedMs: 4_500 }; // observed 4s late

    expect(catchUpElapsedMs(event, noSlowPredecessor)).toBe(500);
    expect(catchUpElapsedMs(event, behindASlowReader)).toBe(500);

    // CONTROL: the pre-fix computation DOES change — so the assertion above is
    // testing a real difference, not two identical code paths.
    expect(parentObservedElapsedMs(noSlowPredecessor)).toBe(500);
    expect(parentObservedElapsedMs(behindASlowReader)).toBe(4_500);
  });

  it('ORDER-INDEPENDENCE: N readers report their own times regardless of position', () => {
    // Three readers that truly caught up at +200/+900/+300. Observed in an order
    // where the slowest resolves first, inflating everyone the parent sees after it.
    const truth = [200, 900, 300];
    const observedLag = [900, 900, 900]; // concurrent waits: all seen after the slowest
    const perReader = truth.map((trueMs, i) =>
      catchUpElapsedMs(caughtUp({ wallMs: T_GO + trueMs }), {
        tGo: T_GO,
        tAwait: T_GO,
        elapsedMs: observedLag[i]!,
      }),
    );
    expect(perReader).toEqual(truth);

    // CONTROL: the pre-fix computation collapses them into one repeated value that
    // still LOOKS like a distribution — the specific trap netem-inner.ts warns about.
    const preFix = truth.map((_, i) =>
      parentObservedElapsedMs({ tGo: T_GO, tAwait: T_GO, elapsedMs: observedLag[i]! }),
    );
    expect(preFix).toEqual([900, 900, 900]);
    expect(new Set(preFix).size).toBe(1);
  });

  it('does NOT mix epochs: the bootT0-relative `t` is never used as a time-since-go', () => {
    // `t` is measured from the CHILD's boot, which precedes `go` by however long the
    // mesh took to spawn — so using it here would silently report boot time as
    // replication time. A child that booted 30s before `go` and caught up 500ms
    // after it emits t=30_500 and wallMs=tGo+500; only the latter is correct.
    const event = caughtUp({ wallMs: T_GO + 500, t: 30_500 });
    expect(catchUpElapsedMs(event, { tGo: T_GO, tAwait: T_GO, elapsedMs: 500 })).toBe(500);
  });

  it('falls back to the concurrent parent measurement when the child sent no wallMs', () => {
    // A child predating the field (or a fake in another test) must still produce a
    // number, and it must be the shared-origin one — never `t`.
    const event = caughtUp({ t: 30_500 });
    expect(catchUpElapsedMs(event, { tGo: T_GO, tAwait: T_GO + 100, elapsedMs: 400 })).toBe(500);
  });

  it('ignores a non-finite wallMs rather than emitting NaN into the distribution', () => {
    // A single NaN would poison every percentile computed over the metric.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const event: ChildEvent = { evt: 'caught-up', wallMs: bad };
      expect(catchUpElapsedMs(event, { tGo: T_GO, tAwait: T_GO, elapsedMs: 500 })).toBe(500);
    }
  });

  it('returns null for a reader that never caught up, so it cannot score as instant', () => {
    // The failure that motivated the null: a non-convergence scored as 0ms would be
    // the FASTEST sample in the distribution and would pull the mean the wrong way.
    expect(catchUpElapsedMs(null, { tGo: T_GO, tAwait: T_GO, elapsedMs: 300_000 })).toBeNull();
  });
});

/**
 * push-nudge.test.ts — P-303 (p2p-work-distribution-2026-07-02). Proves the
 * PURE/DI-seamed push-as-nudge mechanism before any live cross-machine wiring:
 *   (1) advisory nudge build (hint is data, never a claim),
 *   (2) M9 per-grantor rate-cap (reused @papercusp/rate-limit soft bucket),
 *   (3) per-fleet coalescing of a burst,
 *   (4) fail-soft DI-seam waker (no waker ⇒ no-op; a throwing waker never rejects),
 *   (5) LATENCY-ONLY: every drop path is structured + non-throwing, so a nudge
 *       failure can never break the publisher (the puller's poll is the floor).
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  buildPullerNudge,
  nudgeRateCapKey,
  createNudgeCoalescer,
  isWithinCoalesceWindow,
  recordNudge,
  createNudgeRateLimiter,
  registerNudgeWaker,
  isNudgeWakerWired,
  requestPullerNudge,
  dispatchPullerNudge,
  DEFAULT_NUDGE_COALESCE_WINDOW_MS,
  type OfferAvailableSignal,
  type NudgeTarget,
  type NudgeWaker,
  type PullerNudge,
} from './push-nudge';

const NOW = 1_800_000_000_000;
const signal = (over?: Partial<OfferAvailableSignal>): OfferAvailableSignal => ({
  fleetSlug: 'alpha',
  grantorRef: 'grantor-1',
  offerHintId: 'offer-abc',
  availableAtMs: NOW,
  ...over,
});
const target = (ref: string): NudgeTarget => ({ ref });

/** A waker that records every wake; optionally throws. */
function recordingWaker(opts?: { throwOn?: string }): NudgeWaker & { calls: { nudge: PullerNudge; ref: string }[] } {
  const calls: { nudge: PullerNudge; ref: string }[] = [];
  return {
    calls,
    async wake(nudge, t) {
      if (opts?.throwOn && t.ref === opts.throwOn) throw new Error(`boom:${t.ref}`);
      calls.push({ nudge, ref: t.ref });
      return { delivered: true };
    },
  };
}

afterEach(() => registerNudgeWaker(null)); // never leak a registered waker across tests

describe('buildPullerNudge — advisory', () => {
  it('carries the fleet + hint, reason offer-available', () => {
    expect(buildPullerNudge(signal())).toEqual({ fleetSlug: 'alpha', offerHintId: 'offer-abc', reason: 'offer-available' });
  });
  it('null hint when absent', () => {
    expect(buildPullerNudge(signal({ offerHintId: undefined })).offerHintId).toBeNull();
    expect(buildPullerNudge(signal({ offerHintId: null })).offerHintId).toBeNull();
  });
});

describe('nudgeRateCapKey — metered per grantor (M9)', () => {
  it('keys on the grantor ref only (not the fleet)', () => {
    expect(nudgeRateCapKey('grantor-1')).toBe('nudge:grantor-1');
    // Two fleets, same grantor ⇒ same cap bucket (the grantor is the DoS subject).
    expect(nudgeRateCapKey(signal({ fleetSlug: 'a' }).grantorRef)).toBe(nudgeRateCapKey(signal({ fleetSlug: 'b' }).grantorRef));
  });
});

describe('coalescer — per-fleet burst collapse', () => {
  it('admits the first nudge, coalesces within the window, re-admits after it', () => {
    const c = createNudgeCoalescer();
    expect(isWithinCoalesceWindow(c, 'alpha', NOW, 2_000)).toBe(false); // never nudged
    recordNudge(c, 'alpha', NOW);
    expect(isWithinCoalesceWindow(c, 'alpha', NOW + 1_000, 2_000)).toBe(true); // within window
    expect(isWithinCoalesceWindow(c, 'alpha', NOW + 2_001, 2_000)).toBe(false); // window elapsed
    expect(isWithinCoalesceWindow(c, 'beta', NOW + 1_000, 2_000)).toBe(false); // other fleet independent
  });
});

describe('DI-seam waker — fail-soft', () => {
  it('is a no-op when no waker is registered', async () => {
    expect(isNudgeWakerWired()).toBe(false);
    const out = await requestPullerNudge(buildPullerNudge(signal()), target('r1'), null);
    expect(out).toEqual({ wired: false });
  });
  it('fires through a registered waker', async () => {
    const w = recordingWaker();
    registerNudgeWaker(w);
    expect(isNudgeWakerWired()).toBe(true);
    const out = await requestPullerNudge(buildPullerNudge(signal()), target('r1'));
    expect(out.wired).toBe(true);
    expect(out.result).toEqual({ delivered: true });
    expect(w.calls).toHaveLength(1);
  });
  it('swallows a throwing waker — never rejects', async () => {
    const w = recordingWaker({ throwOn: 'r1' });
    const out = await requestPullerNudge(buildPullerNudge(signal()), target('r1'), w);
    expect(out.wired).toBe(true);
    expect(out.error).toContain('boom:r1');
  });
});

describe('dispatchPullerNudge — composed', () => {
  it('drops with no receivers (nudge null)', async () => {
    const r = await dispatchPullerNudge({
      signal: signal(), receiverTargets: [], limiter: createNudgeRateLimiter(), coalescer: createNudgeCoalescer(), nowMs: NOW, waker: recordingWaker(),
    });
    expect(r.dropped).toBe('no-receivers');
    expect(r.nudge).toBeNull();
    expect(r.emitted).toEqual([]);
  });

  it('emits to every opted-in receiver on the happy path', async () => {
    const w = recordingWaker();
    const r = await dispatchPullerNudge({
      signal: signal(), receiverTargets: [target('r1'), target('r2')], limiter: createNudgeRateLimiter(), coalescer: createNudgeCoalescer(), nowMs: NOW, waker: w,
    });
    expect(r.dropped).toBeNull();
    expect(r.emitted).toEqual(['r1', 'r2']);
    expect(w.calls.map((c) => c.ref)).toEqual(['r1', 'r2']);
  });

  it('coalesces a second burst for the same fleet within the window (no token burned)', async () => {
    const w = recordingWaker();
    const limiter = createNudgeRateLimiter();
    const coalescer = createNudgeCoalescer();
    const first = await dispatchPullerNudge({ signal: signal(), receiverTargets: [target('r1')], limiter, coalescer, nowMs: NOW, waker: w });
    expect(first.dropped).toBeNull();
    const second = await dispatchPullerNudge({ signal: signal(), receiverTargets: [target('r1')], limiter, coalescer, nowMs: NOW + 500, waker: w });
    expect(second.dropped).toBe('coalesced');
    expect(w.calls).toHaveLength(1); // only the first woke
  });

  it('rate-caps a grantor past capacity (M9), independent of the fleet', async () => {
    const w = recordingWaker();
    const limiter = createNudgeRateLimiter({ windowMs: 60_000, capacity: 2 });
    const coalescer = createNudgeCoalescer();
    // Distinct fleets so coalescing never fires — only the per-GRANTOR cap gates.
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(
        await dispatchPullerNudge({
          signal: signal({ fleetSlug: `fleet-${i}`, grantorRef: 'g-shared' }),
          receiverTargets: [target('r1')], limiter, coalescer, nowMs: NOW + i * 10_000, waker: w,
        }),
      );
    }
    expect(outcomes.map((o) => o.dropped)).toEqual([null, null, 'rate-capped', 'rate-capped']);
    expect(outcomes[2].retryAfterS).toBeGreaterThan(0);
    expect(w.calls).toHaveLength(2); // only 2 wakes escaped the cap
  });

  it('LATENCY-ONLY: a no-live-waker dispatch is a structured no-op, never a throw', async () => {
    // No registered waker, explicit null ⇒ wired:false per target; still "not dropped".
    const r = await dispatchPullerNudge({
      signal: signal(), receiverTargets: [target('r1')], limiter: createNudgeRateLimiter(), coalescer: createNudgeCoalescer(), nowMs: NOW, waker: null,
    });
    expect(r.dropped).toBeNull();
    expect(r.emitted).toEqual([]); // no live waker ⇒ nobody woken, but the poll still delivers
    expect(r.wakeErrors).toEqual([]);
  });

  it('records per-target wake errors without throwing', async () => {
    const w = recordingWaker({ throwOn: 'r2' });
    const r = await dispatchPullerNudge({
      signal: signal(), receiverTargets: [target('r1'), target('r2')], limiter: createNudgeRateLimiter(), coalescer: createNudgeCoalescer(), nowMs: NOW, waker: w,
    });
    expect(r.emitted).toEqual(['r1']);
    expect(r.wakeErrors).toEqual([{ ref: 'r2', error: 'boom:r2' }]);
  });

  it('uses the default coalesce window when unspecified', () => {
    expect(DEFAULT_NUDGE_COALESCE_WINDOW_MS).toBeGreaterThan(0);
  });
});

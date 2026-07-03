/**
 * push-nudge-service.test.ts — P-303 live-wiring layer (WI-1978). Proves the
 * per-publisher orchestrator holds the M9 cap + coalescer state ACROSS offer events,
 * and the coord-backed waker factory delegates.
 */
import { describe, expect, it, vi } from 'vitest';
import { PushNudgePublisher, coordNudgeWaker } from './push-nudge-service';
import { createNudgeRateLimiter, type NudgeWaker, type OfferAvailableSignal, type PullerNudge, type NudgeTarget } from './push-nudge';

const NOW = 1_800_000_000_000;
const sig = (over?: Partial<OfferAvailableSignal>): OfferAvailableSignal => ({
  fleetSlug: 'alpha', grantorRef: 'g1', offerHintId: 'o1', availableAtMs: NOW, ...over,
});
const countingWaker = (): NudgeWaker & { count: number } => {
  const w = { count: 0, async wake() { w.count += 1; return undefined; } };
  return w;
};

describe('PushNudgePublisher', () => {
  it('emits to the opted-in receivers on an offer-available event', async () => {
    const w = countingWaker();
    const pub = new PushNudgePublisher({ now: () => NOW, waker: w });
    const r = await pub.onOfferAvailable(sig(), [{ ref: 'r1' }, { ref: 'r2' }]);
    expect(r.dropped).toBeNull();
    expect(r.emitted).toEqual(['r1', 'r2']);
    expect(w.count).toBe(2);
  });

  it('holds coalescer state across events (a same-fleet burst collapses)', async () => {
    let now = NOW;
    const w = countingWaker();
    const pub = new PushNudgePublisher({ now: () => now, waker: w, coalesceWindowMs: 5_000 });
    const first = await pub.onOfferAvailable(sig(), [{ ref: 'r1' }]);
    now += 1_000;
    const second = await pub.onOfferAvailable(sig(), [{ ref: 'r1' }]);
    expect(first.dropped).toBeNull();
    expect(second.dropped).toBe('coalesced');
    expect(w.count).toBe(1);
  });

  it('holds the M9 rate-cap state across events (per grantor)', async () => {
    let now = NOW;
    const w = countingWaker();
    // cap 2/grantor; distinct fleets so coalescing never masks the cap.
    const pub = new PushNudgePublisher({ now: () => now, waker: w, limiter: createNudgeRateLimiter({ windowMs: 60_000, capacity: 2 }) });
    const drops: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await pub.onOfferAvailable(sig({ fleetSlug: `f-${i}`, grantorRef: 'g-shared' }), [{ ref: 'r1' }]);
      drops.push(r.dropped);
      now += 10_000;
    }
    expect(drops).toEqual([null, null, 'rate-capped', 'rate-capped']);
    expect(w.count).toBe(2);
  });
});

describe('coordNudgeWaker', () => {
  it('delegates a wake to the injected coord-send fn', async () => {
    const calls: { nudge: PullerNudge; target: NudgeTarget }[] = [];
    const sendWake = vi.fn(async (nudge: PullerNudge, target: NudgeTarget) => {
      calls.push({ nudge, target });
      return { woken: 1 };
    });
    const waker = coordNudgeWaker(sendWake);
    const nudge: PullerNudge = { fleetSlug: 'alpha', offerHintId: 'o1', reason: 'offer-available' };
    const out = await waker.wake(nudge, { ref: 'r1' });
    expect(out).toEqual({ woken: 1 });
    expect(calls).toEqual([{ nudge, target: { ref: 'r1' } }]);
  });
});

/**
 * push-nudge.property.test.ts — P-303. The invariants push-as-nudge must hold:
 *   (1) M9 BOUND — for any burst of dispatches from one grantor within a window,
 *       the count of ACTUAL wakes never exceeds the per-grantor cap capacity,
 *   (2) COALESCE IDEMPOTENCE — any burst of same-fleet dispatches within the
 *       coalesce window produces exactly ONE wake,
 *   (3) LATENCY-ONLY totality — dispatch NEVER throws and always returns a
 *       structured result, whatever the receiver set / waker behaviour.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  dispatchPullerNudge,
  createNudgeRateLimiter,
  createNudgeCoalescer,
  type NudgeWaker,
  type PullerNudge,
} from './push-nudge';

const NOW = 1_800_000_000_000;

function countingWaker(): NudgeWaker & { count: number } {
  const w = {
    count: 0,
    async wake(_n: PullerNudge, _t: { ref: string }) {
      w.count += 1;
      return undefined;
    },
  };
  return w;
}

describe('property: M9 per-grantor cap bound', () => {
  it('actual wakes for one grantor never exceed the cap, however many distinct fleets fire', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // capacity
        fc.integer({ min: 0, max: 25 }), // number of dispatches
        async (capacity, n) => {
          const w = countingWaker();
          const limiter = createNudgeRateLimiter({ windowMs: 60_000, capacity });
          const coalescer = createNudgeCoalescer();
          for (let i = 0; i < n; i++) {
            // Distinct fleet per call ⇒ coalescing never fires; only the grantor cap gates.
            await dispatchPullerNudge({
              signal: { fleetSlug: `f-${i}`, grantorRef: 'g', offerHintId: null, availableAtMs: NOW },
              receiverTargets: [{ ref: 'r1' }],
              limiter,
              coalescer,
              nowMs: NOW + i,
              waker: w,
            });
          }
          expect(w.count).toBe(Math.min(n, capacity)); // exactly the cap, never more
        },
      ),
    );
  });
});

describe('property: coalescing idempotence', () => {
  it('a burst of same-fleet dispatches within the window yields exactly one wake', () => {
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (n) => {
        const w = countingWaker();
        const limiter = createNudgeRateLimiter(); // generous default cap — not the gate here
        const coalescer = createNudgeCoalescer();
        for (let i = 0; i < n; i++) {
          await dispatchPullerNudge({
            signal: { fleetSlug: 'same', grantorRef: 'g', offerHintId: null, availableAtMs: NOW },
            receiverTargets: [{ ref: 'r1' }],
            limiter,
            coalescer,
            nowMs: NOW + i, // all within the default coalesce window (2s)
            coalesceWindowMs: 10_000,
            waker: w,
          });
        }
        expect(w.count).toBe(1); // the burst collapsed to one wake
      }),
    );
  });
});

describe('property: latency-only totality', () => {
  it('never throws and always returns a structured result', () => {
    const targetsArb = fc.array(fc.record({ ref: fc.string({ minLength: 1, maxLength: 6 }) }), { maxLength: 5 });
    fc.assert(
      fc.asyncProperty(targetsArb, fc.boolean(), async (targets, wakerThrows) => {
        const waker: NudgeWaker = {
          async wake() {
            if (wakerThrows) throw new Error('nope');
            return undefined;
          },
        };
        const r = await dispatchPullerNudge({
          signal: { fleetSlug: 'alpha', grantorRef: 'g', offerHintId: null, availableAtMs: NOW },
          receiverTargets: targets,
          limiter: createNudgeRateLimiter(),
          coalescer: createNudgeCoalescer(),
          nowMs: NOW,
          waker,
        });
        // Always structured; emitted + wakeErrors partition the targets when not dropped.
        expect(typeof r.fleetSlug).toBe('string');
        if (r.dropped == null && targets.length > 0) {
          expect(r.emitted.length + r.wakeErrors.length).toBe(targets.length);
        }
      }),
    );
  });
});

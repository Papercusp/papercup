/**
 * presence-beat-throttle (EI-6797) — the per-owner in-process coalescer for
 * coord_presence liveness writes. Pins: first call always beats (mints/refresh),
 * repeats within the window are suppressed, re-fires after the window, owners
 * throttle independently, instances are fully isolated (no cross-path
 * suppression), and the Map self-GCs under size pressure.
 */
import { describe, test, expect } from 'vitest';
import {
  createPresenceBeatThrottle,
  PRESENCE_BEAT_INTERVAL_MS,
} from './presence-beat-throttle';

describe('createPresenceBeatThrottle', () => {
  test('coalesces to one beat per window per owner (the EI-6797 fix)', () => {
    const t = createPresenceBeatThrottle();
    let now = 1_000_000;

    expect(t.shouldBeat('a', now)).toBe(true); // first call → beat (mints)
    expect(t.shouldBeat('a', now)).toBe(false); // same instant → coalesced
    now += PRESENCE_BEAT_INTERVAL_MS - 1;
    expect(t.shouldBeat('a', now)).toBe(false); // still inside window → coalesced

    now += 2; // cross the window
    expect(t.shouldBeat('a', now)).toBe(true); // re-fires
  });

  test('the boundary is inclusive at exactly the interval', () => {
    const t = createPresenceBeatThrottle();
    expect(t.shouldBeat('a', 0)).toBe(true);
    expect(t.shouldBeat('a', PRESENCE_BEAT_INTERVAL_MS - 1)).toBe(false);
    // now - last === interval ⇒ NOT < interval ⇒ due again.
    expect(t.shouldBeat('a', PRESENCE_BEAT_INTERVAL_MS)).toBe(true);
  });

  test('different owners throttle independently', () => {
    const t = createPresenceBeatThrottle();
    const now = 5_000_000;
    expect(t.shouldBeat('a', now)).toBe(true);
    expect(t.shouldBeat('b', now)).toBe(true); // b is fresh even though a just beat
    expect(t.shouldBeat('a', now)).toBe(false);
    expect(t.shouldBeat('b', now)).toBe(false);
  });

  test('separate instances never suppress one another (dispatch vs inbox)', () => {
    // The whole reason each hot path gets its OWN throttle: a no-op dispatch
    // beat must not starve the row-minting inbox beat.
    const dispatch = createPresenceBeatThrottle();
    const inbox = createPresenceBeatThrottle();
    const now = 7_000_000;
    expect(dispatch.shouldBeat('a', now)).toBe(true);
    // The inbox throttle has never seen 'a' → it still beats this instant.
    expect(inbox.shouldBeat('a', now)).toBe(true);
  });

  test('custom interval is honored', () => {
    const t = createPresenceBeatThrottle(1_000);
    expect(t.shouldBeat('a', 0)).toBe(true);
    expect(t.shouldBeat('a', 999)).toBe(false);
    expect(t.shouldBeat('a', 1_000)).toBe(true);
  });

  test('reset clears all state', () => {
    const t = createPresenceBeatThrottle();
    expect(t.shouldBeat('a', 100)).toBe(true);
    expect(t.shouldBeat('a', 100)).toBe(false);
    t.reset();
    expect(t.size()).toBe(0);
    expect(t.shouldBeat('a', 100)).toBe(true); // fresh again
  });

  test('self-GCs idle owners under size pressure (bounds the Map)', () => {
    const t = createPresenceBeatThrottle();
    // Seed 2001 owners at t=0 to cross GC_SIZE_TRIGGER (2000). They are all
    // idle far past the GC cutoff, so the next beat sweeps them.
    for (let i = 0; i < 2_001; i++) t.shouldBeat(`owner-${i}`, 0);
    expect(t.size()).toBeGreaterThan(2_000);
    // A beat well past 10 windows triggers the sweep of the stale entries.
    const farFuture = PRESENCE_BEAT_INTERVAL_MS * 100;
    t.shouldBeat('fresh', farFuture);
    // Only the just-written 'fresh' survives (all seeds were idle past cutoff).
    expect(t.size()).toBe(1);
  });
});

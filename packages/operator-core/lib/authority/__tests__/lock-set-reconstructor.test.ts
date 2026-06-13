/**
 * Unit tests for the handover lock-set reconstructor (D-005, Phase 2 step 4).
 */
import { describe, expect, it } from 'vitest';
import { LockSetReconstructor } from '../lock-set-reconstructor';

const T0 = 1_700_000_000_000;
const HB = 10_000; // one heartbeat interval

function make() {
  return new LockSetReconstructor({ becameAuthorityAtMs: T0, heartbeatMs: HB });
}

describe('LockSetReconstructor — handover', () => {
  it('fails open during the rebuild gap, then is rebuilt after one heartbeat interval', () => {
    const r = make();
    expect(r.shouldFailOpen(T0 + 1)).toBe(true);
    expect(r.isRebuilt(T0 + 1)).toBe(false);
    expect(r.shouldFailOpen(T0 + HB - 1)).toBe(true);
    // at/after the full interval → rebuilt, no longer fail-open
    expect(r.isRebuilt(T0 + HB)).toBe(true);
    expect(r.shouldFailOpen(T0 + HB)).toBe(false);
  });

  it('accumulates holders re-asserting their locks (heartbeats)', () => {
    const r = make();
    r.assert('apps/a.ts', 'peer-1', 20_000, T0 + 100);
    r.assert('apps/b.ts', 'peer-2', 20_000, T0 + 200);
    const set = r.current(T0 + 300);
    expect(set.map((l) => l.path).sort()).toEqual(['apps/a.ts', 'apps/b.ts']);
    expect(set.find((l) => l.path === 'apps/a.ts')!.owner).toBe('peer-1');
  });

  it('expires an assertion the holder stopped re-asserting (TTL)', () => {
    const r = make();
    r.assert('apps/a.ts', 'peer-1', 5_000, T0); // expires at T0+5000
    expect(r.current(T0 + 4_000)).toHaveLength(1);
    expect(r.current(T0 + 6_000)).toHaveLength(0); // aged out
    r.prune(T0 + 6_000);
    expect(r.current(T0 + 6_000)).toHaveLength(0);
  });

  it('a re-assert refreshes the TTL (the holder kept its lock alive)', () => {
    const r = make();
    r.assert('apps/a.ts', 'peer-1', 5_000, T0);
    r.assert('apps/a.ts', 'peer-1', 5_000, T0 + 4_000); // re-heartbeat → expires T0+9000
    expect(r.current(T0 + 6_000)).toHaveLength(1);
  });

  it('isHeldByOther distinguishes the holder from a contender (post-rebuild check)', () => {
    const r = make();
    r.assert('apps/a.ts', 'peer-1', 20_000, T0);
    expect(r.isHeldByOther('apps/a.ts', 'peer-2', T0 + 100)).toBe(true);  // contender
    expect(r.isHeldByOther('apps/a.ts', 'peer-1', T0 + 100)).toBe(false); // the holder itself
    expect(r.isHeldByOther('apps/free.ts', 'peer-2', T0 + 100)).toBe(false); // unheld
  });

  it('an expired lock is not "held by other"', () => {
    const r = make();
    r.assert('apps/a.ts', 'peer-1', 5_000, T0);
    expect(r.isHeldByOther('apps/a.ts', 'peer-2', T0 + 6_000)).toBe(false);
  });
});

describe('LockSetReconstructor — instant handover via the lock-event stream (P-015)', () => {
  it('hydrates the lock set instantly and is rebuilt immediately (no fail-open gap)', () => {
    const r = make();
    // Before hydration: in the rebuild gap (fail-open) just like the heartbeat path.
    expect(r.shouldFailOpen(T0 + 1)).toBe(true);
    const seeded = r.hydrateFromEvents(
      [
        { path: 'apps/a.ts', owner: 'peer-1', expiresAtMs: T0 + 60_000 },
        { path: 'apps/b.ts', owner: 'peer-2', expiresAtMs: T0 + 60_000 },
      ],
      T0 + 1,
    );
    expect(seeded).toBe(true);
    // Rebuilt NOW — long before one heartbeat interval (HB) elapses.
    expect(r.isRebuilt(T0 + 1)).toBe(true);
    expect(r.shouldFailOpen(T0 + 1)).toBe(false);
    // The hydrated set is authoritative for the contended check.
    expect(r.isHeldByOther('apps/a.ts', 'peer-9', T0 + 1)).toBe(true);
    expect(r.isHeldByOther('apps/a.ts', 'peer-1', T0 + 1)).toBe(false);
    expect(r.current(T0 + 1).map((l) => l.path).sort()).toEqual(['apps/a.ts', 'apps/b.ts']);
  });

  it('an empty stream is a no-op → stays in the heartbeat-reassert fallback (fail-open floor)', () => {
    const r = make();
    expect(r.hydrateFromEvents([], T0 + 1)).toBe(false);
    // Unchanged: still fail-open until a full heartbeat interval, then rebuilt.
    expect(r.shouldFailOpen(T0 + 1)).toBe(true);
    expect(r.isRebuilt(T0 + HB - 1)).toBe(false);
    expect(r.isRebuilt(T0 + HB)).toBe(true);
  });

  it('does not seed an already-expired lock (returns false when all are stale)', () => {
    const r = make();
    const seeded = r.hydrateFromEvents([{ path: 'apps/a.ts', owner: 'peer-1', expiresAtMs: T0 - 1 }], T0);
    expect(seeded).toBe(false);
    expect(r.current(T0)).toHaveLength(0);
    // Not hydrated → still in the heartbeat fallback.
    expect(r.shouldFailOpen(T0 + 1)).toBe(true);
  });

  it('hydration composes with later holder re-asserts (stream seed + heartbeat refresh)', () => {
    const r = make();
    r.hydrateFromEvents([{ path: 'apps/a.ts', owner: 'peer-1', expiresAtMs: T0 + 5_000 }], T0);
    // A holder re-asserts (heartbeat) → refreshes the TTL on the hydrated lock.
    r.assert('apps/a.ts', 'peer-1', 60_000, T0 + 4_000);
    expect(r.current(T0 + 10_000).find((l) => l.path === 'apps/a.ts')?.expiresAtMs).toBe(T0 + 4_000 + 60_000);
  });
});

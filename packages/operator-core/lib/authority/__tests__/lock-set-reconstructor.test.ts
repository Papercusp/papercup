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

describe('LockSetReconstructor — empty-set failover (B5, zero held locks)', () => {
  it('a takeover with NO locks to reconstruct stays fail-open until the heartbeat interval, then is rebuilt', () => {
    const r = make();
    // hydrate from an empty event stream (no replica / nothing federated) → no-op.
    expect(r.hydrateFromEvents([], T0)).toBe(false);
    // The set is empty AND not yet authoritative — every read is fail-open.
    expect(r.current(T0).length).toBe(0);
    expect(r.isRebuilt(T0)).toBe(false);
    expect(r.shouldFailOpen(T0)).toBe(true);
    // Still fail-open right up to the edge of one heartbeat interval…
    expect(r.isRebuilt(T0 + HB - 1)).toBe(false);
    expect(r.shouldFailOpen(T0 + HB - 1)).toBe(true);
    // …then authoritative once the interval has fully elapsed (every live holder
    // had its chance to re-assert; an empty set is now a TRUSTED empty set).
    expect(r.isRebuilt(T0 + HB)).toBe(true);
    expect(r.shouldFailOpen(T0 + HB)).toBe(false);
    // And it is STILL empty — nothing was held, so nothing blocks post-rebuild.
    expect(r.current(T0 + HB).length).toBe(0);
    expect(r.isHeldByOther('apps/anything.ts', 'whoever', T0 + HB)).toBe(false);
  });

  it('a single heartbeat during the empty-set gap seeds the set without flipping isRebuilt early', () => {
    const r = make();
    expect(r.hydrateFromEvents([], T0)).toBe(false);
    // A holder re-asserts mid-gap. The lock is now tracked…
    r.assert('apps/a.ts', 'peer-1', 60_000, T0 + 100);
    expect(r.isHeldByOther('apps/a.ts', 'peer-2', T0 + 200)).toBe(true);
    // …but a heartbeat does NOT mark the set authoritative — only the full
    // interval (or an instant hydrate) does. Still fail-open until then.
    expect(r.isRebuilt(T0 + 200)).toBe(false);
    expect(r.shouldFailOpen(T0 + 200)).toBe(true);
    expect(r.isRebuilt(T0 + HB)).toBe(true);
  });
});

describe('LockSetReconstructor — stale-epoch heartbeat fencing (B1, D-006 split-brain)', () => {
  // A reconstructor elected under epoch 2 (the new authority after a handover).
  function makeFenced(epoch: number) {
    return new LockSetReconstructor({ becameAuthorityAtMs: T0, heartbeatMs: HB, epoch });
  }

  it('rejects a re-assertion stamped with an OLDER epoch (deposed authority split-brain)', () => {
    const r = makeFenced(2);
    // Y (epoch 2) optimistically re-granted P to peer-2 during the fail-open gap.
    expect(r.assert('apps/p.ts', 'peer-2', 60_000, T0 + 100, 2)).toBe(true);
    // A LATE heartbeat for peer-1, whose hold was granted by the deposed X under
    // epoch 1, races in. Unfenced, this would clobber the current-epoch truth.
    const applied = r.assert('apps/p.ts', 'peer-1', 60_000, T0 + 200, 1);
    expect(applied).toBe(false); // fenced out — the stale-epoch assert is dropped
    // The lock set still reflects the CURRENT-epoch holder (peer-2), not the stale one.
    expect(r.current(T0 + 300).find((l) => l.path === 'apps/p.ts')?.owner).toBe('peer-2');
    expect(r.isHeldByOther('apps/p.ts', 'peer-2', T0 + 300)).toBe(false); // peer-2 still owns it
    expect(r.isHeldByOther('apps/p.ts', 'peer-1', T0 + 300)).toBe(true);  // peer-1 is a contender
  });

  it('accepts a CURRENT-epoch re-assertion (the live holder keeps its lock)', () => {
    const r = makeFenced(2);
    expect(r.assert('apps/a.ts', 'peer-1', 60_000, T0 + 100, 2)).toBe(true);
    expect(r.current(T0 + 200).find((l) => l.path === 'apps/a.ts')?.owner).toBe('peer-1');
  });

  it('accepts a NEWER epoch (defensive: never fence out a fresher-than-mine assert)', () => {
    const r = makeFenced(2);
    expect(r.assert('apps/a.ts', 'peer-9', 60_000, T0 + 100, 3)).toBe(true);
  });

  it('is unfenced when no epoch is configured — every assert applies (single-box default)', () => {
    const r = make(); // no epoch
    expect(r.assert('apps/a.ts', 'peer-1', 60_000, T0 + 100, 1)).toBe(true);
    expect(r.assert('apps/a.ts', 'peer-2', 60_000, T0 + 200, 999)).toBe(true);
    expect(r.assert('apps/a.ts', 'peer-3', 60_000, T0 + 300)).toBe(true); // no epoch at all
  });

  it('is unfenced for an assert that omits its epoch even when the reconstructor IS fenced', () => {
    // Back-compat: the legacy heartbeat that does not carry an epoch is still
    // accepted (the fence only fires on a PROVABLY-older epoch).
    const r = makeFenced(2);
    expect(r.assert('apps/a.ts', 'peer-1', 60_000, T0 + 100)).toBe(true);
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

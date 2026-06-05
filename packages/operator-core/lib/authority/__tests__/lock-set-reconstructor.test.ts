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

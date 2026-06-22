/**
 * substrate-eviction-policy.test.ts — the PURE eviction brain for lazy/bounded
 * substrate boot (WI-147 / P-008). The correctness-critical invariant: NEVER evict
 * a harness with an active swarm peer or a pinned/hot one (evicting a syncing
 * harness = the EI-126 data-divergence class). Everything else is LRU under the
 * resident cap.
 */
import { describe, it, expect } from 'vitest';
import {
  planSubstrateEviction,
  shouldRebootOnAccess,
  type BootedHarnessFacts,
} from './substrate-eviction-policy';

const NOW = 1_800_000_000_000;
const ago = (ms: number) => NOW - ms;
const IDLE = 10 * 60_000; // 10-min idle window
const clock = (over: Partial<{ now: number; idleMs: number; maxResident: number }> = {}) => ({
  now: over.now ?? NOW,
  idleMs: over.idleMs ?? IDLE,
  maxResident: over.maxResident ?? 0,
});
const h = (over: Partial<BootedHarnessFacts> & { key: string }): BootedHarnessFacts => ({
  lastAccessMs: ago(60 * 60_000), // idle by default (1h ago)
  hasActivePeer: false,
  pinned: false,
  ...over,
});

describe('planSubstrateEviction', () => {
  it('empty input → evicts nothing', () => {
    expect(planSubstrateEviction([], clock())).toEqual({ evict: [], keep: [] });
  });

  it('NEVER evicts a harness with an ACTIVE PEER — even when long idle (D-005 correctness constraint)', () => {
    const d = planSubstrateEviction([h({ key: 'a', hasActivePeer: true, lastAccessMs: ago(99 * 60 * 60_000) })], clock());
    expect(d.evict).toEqual([]);
    expect(d.keep).toEqual([{ key: 'a', reason: 'active-peer' }]);
  });

  it('NEVER evicts a PINNED harness, even idle', () => {
    const d = planSubstrateEviction([h({ key: 'a', pinned: true })], clock());
    expect(d.evict).toEqual([]);
    expect(d.keep[0]).toMatchObject({ key: 'a', reason: 'pinned' });
  });

  it('NEVER evicts a HOT harness (accessed within idleMs)', () => {
    const d = planSubstrateEviction([h({ key: 'a', lastAccessMs: ago(60_000) })], clock());
    expect(d.evict).toEqual([]);
    expect(d.keep[0]).toMatchObject({ key: 'a', reason: 'hot' });
  });

  it('the idle boundary is exclusive — exactly idleMs old is idle (evictable), just under is hot', () => {
    expect(planSubstrateEviction([h({ key: 'a', lastAccessMs: ago(IDLE) })], clock()).evict).toEqual(['a']);
    expect(planSubstrateEviction([h({ key: 'a', lastAccessMs: ago(IDLE - 1) })], clock()).evict).toEqual([]);
  });

  it('maxResident=0 → evicts EVERY idle, peerless, unpinned engine', () => {
    const d = planSubstrateEviction([h({ key: 'a' }), h({ key: 'b' }), h({ key: 'c' })], clock({ maxResident: 0 }));
    expect(d.evict.sort()).toEqual(['a', 'b', 'c']);
  });

  it('LRU: keeps the maxResident MOST-recently-accessed idle engines, evicts the colder rest', () => {
    const d = planSubstrateEviction(
      [
        h({ key: 'cold', lastAccessMs: ago(120 * 60_000) }),
        h({ key: 'warm', lastAccessMs: ago(20 * 60_000) }),
        h({ key: 'warmer', lastAccessMs: ago(15 * 60_000) }),
      ],
      clock({ maxResident: 2 }),
    );
    expect(d.evict).toEqual(['cold']); // the 2 warmest survive under the cap
    expect(d.keep.map((k) => k.key).sort()).toEqual(['warm', 'warmer']);
    expect(d.keep.every((k) => k.reason === 'within-cap')).toBe(true);
  });

  it('protected engines do NOT consume the resident cap (cap applies only to idle candidates)', () => {
    // 1 active-peer + 1 pinned + 3 idle, cap=1 → the 2 protected stay, 1 idle stays, 2 idle evicted.
    const d = planSubstrateEviction(
      [
        h({ key: 'peer', hasActivePeer: true }),
        h({ key: 'pin', pinned: true }),
        h({ key: 'i1', lastAccessMs: ago(20 * 60_000) }),
        h({ key: 'i2', lastAccessMs: ago(30 * 60_000) }),
        h({ key: 'i3', lastAccessMs: ago(40 * 60_000) }),
      ],
      clock({ maxResident: 1 }),
    );
    expect(d.evict.sort()).toEqual(['i2', 'i3']); // i1 (warmest idle) survives under cap=1
    expect(d.keep.find((k) => k.key === 'peer')?.reason).toBe('active-peer');
    expect(d.keep.find((k) => k.key === 'pin')?.reason).toBe('pinned');
    expect(d.keep.find((k) => k.key === 'i1')?.reason).toBe('within-cap');
  });

  it('active-peer DOMINATES idle + cap — an idle peer-holding harness is never a candidate', () => {
    const d = planSubstrateEviction(
      [h({ key: 'peer-idle', hasActivePeer: true, lastAccessMs: ago(99 * 60 * 60_000) }), h({ key: 'plain' })],
      clock({ maxResident: 0 }),
    );
    expect(d.evict).toEqual(['plain']);
    expect(d.keep).toContainEqual({ key: 'peer-idle', reason: 'active-peer' });
  });

  it('is deterministic on a lastAccessMs tie (stable key tiebreak)', () => {
    const t = ago(60 * 60_000);
    const a = planSubstrateEviction([h({ key: 'b', lastAccessMs: t }), h({ key: 'a', lastAccessMs: t })], clock({ maxResident: 1 }));
    const b = planSubstrateEviction([h({ key: 'a', lastAccessMs: t }), h({ key: 'b', lastAccessMs: t })], clock({ maxResident: 1 }));
    expect(a.evict).toEqual(b.evict); // input order doesn't change the decision
  });
});

describe('shouldRebootOnAccess', () => {
  it('re-boots when not resident, no-ops when already resident', () => {
    expect(shouldRebootOnAccess(false)).toBe(true);
    expect(shouldRebootOnAccess(true)).toBe(false);
  });
});

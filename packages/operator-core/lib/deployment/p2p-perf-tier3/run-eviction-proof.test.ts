/**
 * Unit tests for the PURE eviction-proof verdict computation (P-016 of
 * shared-hive-hardening-2026-06-13, D-010). No processes, no network — the
 * orchestrator's impure gather is exercised by the integration test's $0 local-parity path.
 */
import { describe, expect, it } from 'vitest';
import {
  computeEvictionVerdict,
  pubkeyFor,
  type EvictionProofRaw,
  type PeerStateSnapshot,
} from './run-eviction-proof';

const PK = [pubkeyFor(0), pubkeyFor(1), pubkeyFor(2)];

function snap(index: number, authorityPubkey: string | null, evicted: string[], deadAge = 3_000): PeerStateSnapshot {
  return {
    index,
    devicePubkey: PK[index],
    authorityPubkey,
    isSelf: authorityPubkey === PK[index],
    evicted,
    presenceAgeMs: { [PK[0]]: deadAge, [PK[1]]: 0, [PK[2]]: 0 },
    heldPaths: [],
  };
}

function baseRaw(over: Partial<EvictionProofRaw> = {}): EvictionProofRaw {
  return {
    peerCount: 3,
    evictionEnabled: true,
    killedAuthority: { peerIndex: 0, devicePubkey: PK[0] },
    rosterPubkeys: PK,
    preKillSnapshots: [snap(0, PK[0], []), snap(1, PK[0], []), snap(2, PK[0], [])],
    finalSnapshots: [snap(1, PK[1], [PK[0]]), snap(2, PK[1], [PK[0]])],
    evictLatencyMs: 2_100,
    deadStaleAtEvictMs: 2_600,
    authorityStaleMs: 90_000,
    acquire: { fromIndex: 2, via: 'remote-authority', ok: true, authorityPubkey: PK[1] },
    ...over,
  };
}

describe('pubkeyFor', () => {
  it('orders slot 0 lowest (argmin = the initial authority)', () => {
    expect(pubkeyFor(0) < pubkeyFor(1)).toBe(true);
    expect(pubkeyFor(1) < pubkeyFor(2)).toBe(true);
    expect([pubkeyFor(2), pubkeyFor(0), pubkeyFor(1)].sort()[0]).toBe(pubkeyFor(0));
  });
});

describe('computeEvictionVerdict — eviction ON happy path', () => {
  const v = computeEvictionVerdict(baseRaw());

  it('control holds: all peers elected slot 0, nothing evicted', () => {
    expect(v.preKillAuthorityAgreed).toBe(true);
    expect(v.preKillAuthorityPubkey).toBe(PK[0]);
    expect(v.preKillNoEvictions).toBe(true);
  });

  it('both survivors evicted the corpse and agree the next LIVE peer is authority', () => {
    expect(v.survivorsEvictedDead).toBe(true);
    expect(v.survivorsAgreeNewAuthority).toBe(true);
    expect(v.newAuthorityPubkey).toBe(PK[1]);
    expect(v.newAuthorityIsLive).toBe(true);
  });

  it('eviction strictly beat the staleness floor', () => {
    expect(v.beatStalenessFloor).toBe(true); // deadStale 2.6s < 90s floor
    expect(v.evictLatencyMs).toBe(2_100);
  });

  it('the acquire landed on the promoted live authority, not fail-open', () => {
    expect(v.acquireVia).toBe('remote-authority');
    expect(v.acquireOk).toBe(true);
    expect(v.acquireAuthorityPubkey).toBe(PK[1]);
  });
});

describe('computeEvictionVerdict — eviction OFF control', () => {
  const v = computeEvictionVerdict(
    baseRaw({
      evictionEnabled: false,
      // No monitor: survivors evict nothing and keep electing the (still-fresh-by-the-floor) corpse.
      finalSnapshots: [snap(1, PK[0], []), snap(2, PK[0], [])],
      evictLatencyMs: null,
      deadStaleAtEvictMs: null,
      acquire: { fromIndex: 2, via: 'fail-open', ok: true, authorityPubkey: PK[0] },
    }),
  );

  it('nothing evicted, survivors stuck on the corpse, acquire fails open', () => {
    expect(v.survivorsEvictedDead).toBe(false);
    expect(v.survivorsAgreeNewAuthority).toBe(false);
    expect(v.newAuthorityPubkey).toBe(PK[0]); // still the dead authority
    expect(v.newAuthorityIsLive).toBe(false);
    expect(v.beatStalenessFloor).toBe(false); // no eviction → no proof
    expect(v.acquireVia).toBe('fail-open');
  });
});

describe('computeEvictionVerdict — partial / negative branches', () => {
  it('a missing survivor snapshot fails survivorsEvictedDead (incomplete proof)', () => {
    const v = computeEvictionVerdict(baseRaw({ finalSnapshots: [snap(1, PK[1], [PK[0]])] }));
    expect(v.survivorsEvictedDead).toBe(false); // only 1 of 2 survivors reported
    expect(v.survivorsAgreeNewAuthority).toBe(false);
  });

  it('a survivor that evicted but disagrees on the new authority fails agreement', () => {
    const v = computeEvictionVerdict(
      baseRaw({ finalSnapshots: [snap(1, PK[1], [PK[0]]), snap(2, PK[2], [PK[0]])] }),
    );
    expect(v.survivorsEvictedDead).toBe(true);
    expect(v.survivorsAgreeNewAuthority).toBe(false); // slot 2 wrongly elected itself
  });

  it('beatStalenessFloor is false when the dead peer was already past the floor', () => {
    const v = computeEvictionVerdict(baseRaw({ deadStaleAtEvictMs: 95_000 }));
    expect(v.beatStalenessFloor).toBe(false); // 95s ≥ 90s floor → eviction did NOT beat it
  });

  it('a pre-kill eviction (non-empty evicted set) fails the control', () => {
    const v = computeEvictionVerdict(
      baseRaw({ preKillSnapshots: [snap(0, PK[0], []), snap(1, PK[0], [PK[2]]), snap(2, PK[0], [])] }),
    );
    expect(v.preKillNoEvictions).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  compareClaims,
  reconcileClaims,
  reconcileAll,
  contestedResolutions,
  type AdvisoryClaim,
} from './work-item-claim-reconcile';

function claim(over: Partial<AdvisoryClaim> = {}): AdvisoryClaim {
  return {
    workItemId: 'F-001',
    holderPubkey: 'pk-mmm',
    owner: 'su-mmm',
    claimId: 'cid-5',
    acquiredTs: '2026-06-08T12:00:00.000Z',
    ...over,
  };
}

describe('compareClaims (total order)', () => {
  it('earliest acquiredTs wins', () => {
    const early = claim({ acquiredTs: '2026-06-08T12:00:00.000Z', holderPubkey: 'pk-zzz' });
    const late = claim({ acquiredTs: '2026-06-08T12:00:05.000Z', holderPubkey: 'pk-aaa' });
    expect(compareClaims(early, late)).toBeLessThan(0);
    expect(compareClaims(late, early)).toBeGreaterThan(0);
  });

  it('ties on timestamp → lowest holderPubkey (matches the authority election)', () => {
    const lo = claim({ holderPubkey: 'pk-aaa' });
    const hi = claim({ holderPubkey: 'pk-zzz' });
    expect(compareClaims(lo, hi)).toBeLessThan(0);
  });

  it('ties on timestamp + pubkey → lowest claimId', () => {
    const lo = claim({ claimId: 'cid-1' });
    const hi = claim({ claimId: 'cid-9' });
    expect(compareClaims(lo, hi)).toBeLessThan(0);
  });

  it('identical claims compare equal', () => {
    expect(compareClaims(claim(), claim())).toBe(0);
  });

  it('an unparseable/missing timestamp sorts LAST (least-trustworthy "I started first")', () => {
    const good = claim({ acquiredTs: '2026-06-08T23:59:59.000Z', holderPubkey: 'pk-zzz' });
    const bad = claim({ acquiredTs: 'not-a-date', holderPubkey: 'pk-aaa' });
    expect(compareClaims(good, bad)).toBeLessThan(0);
  });
});

describe('reconcileClaims', () => {
  it('empty input → null', () => {
    expect(reconcileClaims([])).toBeNull();
  });

  it('single claim → it wins, no losers', () => {
    const c = claim();
    expect(reconcileClaims([c])).toEqual({ workItemId: 'F-001', winner: c, losers: [] });
  });

  it('two partitioned claims → earliest wins, later drops', () => {
    const winner = claim({ owner: 'su-a', claimId: 'cid-a', acquiredTs: '2026-06-08T12:00:00.000Z', holderPubkey: 'pk-z' });
    const loser = claim({ owner: 'su-b', claimId: 'cid-b', acquiredTs: '2026-06-08T12:00:03.000Z', holderPubkey: 'pk-a' });
    const r = reconcileClaims([loser, winner]);
    expect(r?.winner.owner).toBe('su-a');
    expect(r?.losers.map((l) => l.owner)).toEqual(['su-b']);
  });

  it('same-instant claims → lowest pubkey wins', () => {
    const a = claim({ owner: 'su-a', claimId: 'cid-a', holderPubkey: 'pk-aaa' });
    const b = claim({ owner: 'su-b', claimId: 'cid-b', holderPubkey: 'pk-zzz' });
    expect(reconcileClaims([b, a])?.winner.owner).toBe('su-a');
  });

  it('is commutative — input order does not change the winner', () => {
    const x = claim({ owner: 'x', claimId: 'cid-x', acquiredTs: '2026-06-08T12:00:01.000Z' });
    const y = claim({ owner: 'y', claimId: 'cid-y', acquiredTs: '2026-06-08T12:00:00.000Z' });
    const z = claim({ owner: 'z', claimId: 'cid-z', acquiredTs: '2026-06-08T12:00:02.000Z' });
    const w1 = reconcileClaims([x, y, z])?.winner.owner;
    const w2 = reconcileClaims([z, x, y])?.winner.owner;
    const w3 = reconcileClaims([y, z, x])?.winner.owner;
    expect(w1).toBe('y');
    expect(w2).toBe('y');
    expect(w3).toBe('y');
  });

  it('is idempotent — feeding the winner back yields the same winner', () => {
    const a = claim({ owner: 'a', claimId: 'cid-a', acquiredTs: '2026-06-08T12:00:00.000Z' });
    const b = claim({ owner: 'b', claimId: 'cid-b', acquiredTs: '2026-06-08T12:00:09.000Z' });
    const first = reconcileClaims([a, b]);
    const again = reconcileClaims([first!.winner]);
    expect(again?.winner.owner).toBe('a');
    expect(again?.losers).toEqual([]);
  });
});

describe('reconcileAll', () => {
  it('groups by workItemId, resolves each, sorts by id', () => {
    const claims: AdvisoryClaim[] = [
      claim({ workItemId: 'F-002', owner: 'b2', claimId: 'c-b2', acquiredTs: '2026-06-08T12:00:05.000Z' }),
      claim({ workItemId: 'F-001', owner: 'a1', claimId: 'c-a1', acquiredTs: '2026-06-08T12:00:00.000Z' }),
      claim({ workItemId: 'F-001', owner: 'a2', claimId: 'c-a2', acquiredTs: '2026-06-08T12:00:02.000Z' }),
    ];
    const out = reconcileAll(claims);
    expect(out.map((r) => r.workItemId)).toEqual(['F-001', 'F-002']);
    expect(out[0].winner.owner).toBe('a1');
    expect(out[0].losers.map((l) => l.owner)).toEqual(['a2']);
    expect(out[1].winner.owner).toBe('b2');
    expect(out[1].losers).toEqual([]);
  });

  it('empty → []', () => {
    expect(reconcileAll([])).toEqual([]);
  });
});

describe('contestedResolutions', () => {
  it('returns only items with ≥1 loser (someone must drop)', () => {
    const claims: AdvisoryClaim[] = [
      claim({ workItemId: 'F-solo', owner: 'solo', claimId: 'c-solo' }),
      claim({ workItemId: 'F-dup', owner: 'd1', claimId: 'c-d1', acquiredTs: '2026-06-08T12:00:00.000Z' }),
      claim({ workItemId: 'F-dup', owner: 'd2', claimId: 'c-d2', acquiredTs: '2026-06-08T12:00:01.000Z' }),
    ];
    const out = contestedResolutions(claims);
    expect(out).toHaveLength(1);
    expect(out[0].workItemId).toBe('F-dup');
    expect(out[0].winner.owner).toBe('d1');
    expect(out[0].losers.map((l) => l.owner)).toEqual(['d2']);
  });
});

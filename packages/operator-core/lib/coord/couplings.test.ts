/**
 * couplings — declared coupling edges + the derived ∪ declared − suppressed union
 * (P-031 / D-061). Pure halves only; the PG upserts are exercised by the tool path.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePair,
  peerOf,
  resolveCoupledPeers,
  type CouplingEdge,
  type DerivedCoupling,
  type DerivedCouplingRelation,
} from './couplings';

const edge = (a: string, b: string, over: Partial<CouplingEdge> = {}): CouplingEdge => {
  const p = normalizePair(a, b)!;
  return {
    agentA: p.agentA,
    agentB: p.agentB,
    state: 'coupled',
    declaredBy: 'su-declarer',
    reason: null,
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    expiresAt: null,
    ...over,
  };
};

describe('normalizePair', () => {
  it('orders the pair, so a↔b and b↔a are the SAME row', () => {
    // Symmetry is structural (D-061 R3): "am I coupled to X" cannot answer
    // differently depending on who asks.
    expect(normalizePair('su-b', 'su-a')).toEqual({ agentA: 'su-a', agentB: 'su-b' });
    expect(normalizePair('su-a', 'su-b')).toEqual(normalizePair('su-b', 'su-a'));
  });

  it('refuses a self-pair — the one refusal in an otherwise unrestricted surface', () => {
    expect(normalizePair('su-a', 'su-a')).toBeNull();
    expect(normalizePair('  su-a  ', 'su-a')).toBeNull();
  });

  it('refuses a blank side', () => {
    expect(normalizePair('', 'su-a')).toBeNull();
    expect(normalizePair('su-a', '   ')).toBeNull();
  });
});

describe('peerOf', () => {
  it('returns the OTHER member, from either side', () => {
    const e = edge('su-a', 'su-b');
    expect(peerOf(e, 'su-a')).toBe('su-b');
    expect(peerOf(e, 'su-b')).toBe('su-a');
  });
});

/** A derived coupling, as P-013's derivation hands it to the union (D-078 (a)). */
// Typed as DerivedCoupling ON PURPOSE, not left to inference: the annotation is
// what makes a future required field fail HERE, at the fixture, instead of
// silently passing vitest (which does not typecheck) and reding the fleet gate.
// The default relation was `same-fleet` until 2026-08-09, when D-054's cut was
// finally applied to the derivation. It is only ever a stand-in for "some valid
// derived token" in this file — nothing here is ABOUT fleets — so it moved to a
// signal that still exists rather than the tests being deleted with it.
const d = (
  ownerId: string,
  because = 'both awaiting gate:1',
  relation: DerivedCouplingRelation = 'awaits',
): DerivedCoupling => ({ ownerId, relation, because });

describe('resolveCoupledPeers — derived ∪ declared − suppressed', () => {
  it('unions both sources and labels where each peer came from', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [d('su-derived'), d('su-both', 'shared lock', 'holds-a-lock-on')],
      [edge('su-me', 'su-declared', { reason: 'same file' }), edge('su-me', 'su-both')],
    );
    expect(peers).toEqual([
      {
        ownerId: 'su-both',
        source: 'both',
        reason: null,
        declaredBy: 'su-declarer',
        derivedBecause: 'shared lock',
        derivedRelations: ['holds-a-lock-on'],
      },
      // A DECLARED-only edge carries no relations: no derivation produced it, and
      // inventing one would put a computed-looking token on a human's assertion.
      { ownerId: 'su-declared', source: 'declared', reason: 'same file', declaredBy: 'su-declarer' },
      {
        ownerId: 'su-derived',
        source: 'derived',
        derivedBecause: 'both awaiting gate:1',
        derivedRelations: ['awaits'],
      },
    ]);
  });

  it('D-078 (a): accumulates EVERY distinct signal when a peer is coupled several ways', () => {
    // The whole reason the derived channel carries a reason rather than a bare id:
    // a peer can trip several derivations at once, and which ones fired is the most
    // useful half of the answer.
    const peers = resolveCoupledPeers(
      'su-me',
      [
        d('su-peer', 'both awaiting gate:1'),
        d('su-peer', 'recent coord exchange', 'coord-exchange'),
      ],
      [],
    );
    expect(peers).toEqual([
      {
        ownerId: 'su-peer',
        source: 'derived',
        derivedBecause: 'both awaiting gate:1; recent coord exchange',
        derivedRelations: ['awaits', 'coord-exchange'],
      },
    ]);
  });

  it('a derivation that states no signal still yields a true edge', () => {
    // An unlabelled derivation is still a real coupling — it must not vanish, and
    // must not render as an empty reason.
    const peers = resolveCoupledPeers(
      'su-me',
      [{ ownerId: 'su-peer', relation: 'awaits', because: '  ' }],
      [],
    );
    expect(peers).toEqual([
      { ownerId: 'su-peer', source: 'derived', derivedRelations: ['awaits'] },
    ]);
  });

  // D-087. The typed half must survive the union, because the union is where the
  // per-signal reasons are joined into ONE prose string — the exact point the
  // discriminant used to be erased, one layer after being introduced.
  it('carries the TYPED relations through the join, deduped, in emission order', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [
        { ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting gate:1' },
        { ownerId: 'su-peer', relation: 'holds-a-lock-on', because: 'you are both working in x.ts' },
        { ownerId: 'su-peer', relation: 'holds-a-lock-on', because: 'you are both working in y.ts' },
      ],
      [],
    );
    expect(peers[0]?.derivedRelations).toEqual(['awaits', 'holds-a-lock-on']);
    // Both halves, not one or the other: the prose still accumulates every signal.
    expect(peers[0]?.derivedBecause).toBe(
      'both awaiting gate:1; you are both working in x.ts; you are both working in y.ts',
    );
  });

  it('drops a relation outside the vocabulary rather than passing it to consumers', () => {
    // This function is pure and callers hand-build rows, so an unknown token is a
    // real input. Forwarding it would hand a consumer a value it cannot interpret
    // — worse than the absence, which every consumer already handles.
    const peers = resolveCoupledPeers(
      'su-me',
      [
        { ownerId: 'su-peer', relation: 'invented' as never, because: 'a signal from the future' },
        { ownerId: 'su-peer', relation: 'awaits', because: 'both awaiting g' },
      ],
      [],
    );
    expect(peers[0]?.derivedRelations).toEqual(['awaits']);
    // …but its PROSE is kept: a reader can still see the signal fired.
    expect(peers[0]?.derivedBecause).toBe('a signal from the future; both awaiting g');
  });

  it('a suppression beats a DERIVED coupling — the property decouple exists for', () => {
    // D-061 R4: a decouple cannot un-make the derivation (the shared lock is still
    // held), so if suppression lost to it the edge would silently return next tick
    // and the agent would rightly conclude decoupling is broken.
    const peers = resolveCoupledPeers('su-me', [d('su-peer', 'shared lock')], [
      edge('su-me', 'su-peer', { state: 'suppressed' }),
    ]);
    expect(peers).toEqual([]);
  });

  it('a suppression beats a DECLARED coupling too', () => {
    const peers = resolveCoupledPeers('su-me', [], [
      edge('su-me', 'su-peer', { state: 'coupled' }),
      // Later row for the same pair, as the store would return after a decouple.
      edge('su-me', 'su-peer', { state: 'suppressed' }),
    ]);
    expect(peers).toEqual([]);
  });

  it('resolves edges from EITHER side of the stored pair', () => {
    // The reader may be agent_a or agent_b — the union must not care.
    const asA = resolveCoupledPeers('su-aaa', [], [edge('su-aaa', 'su-zzz')]);
    const asB = resolveCoupledPeers('su-zzz', [], [edge('su-aaa', 'su-zzz')]);
    expect(asA.map((p) => p.ownerId)).toEqual(['su-zzz']);
    expect(asB.map((p) => p.ownerId)).toEqual(['su-aaa']);
  });

  it('never returns the reader itself, and dedupes a repeated derivation', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [d('su-me'), d('su-peer'), d('su-peer'), d('  ')],
      [],
    );
    expect(peers.map((p) => p.ownerId)).toEqual(['su-peer']);
  });

  it('is stable-ordered, so a caller diffing two reads sees real changes only', () => {
    const peers = resolveCoupledPeers('su-me', [d('su-c'), d('su-a')], [edge('su-me', 'su-b')]);
    expect(peers.map((p) => p.ownerId)).toEqual(['su-a', 'su-b', 'su-c']);
  });

  it('carries a THIRD-PARTY declared edge — the pair need not include the declarer', () => {
    // D-061 R1: a third agent may couple two peers it is not part of; the coupled
    // agents must still see each other, with WHO declared it visible.
    const peers = resolveCoupledPeers('su-x', [], [
      edge('su-x', 'su-y', { declaredBy: 'su-observer', reason: 'both heading for the sync resolver' }),
    ]);
    expect(peers).toEqual([
      {
        ownerId: 'su-y',
        source: 'declared',
        reason: 'both heading for the sync resolver',
        declaredBy: 'su-observer',
      },
    ]);
  });
});

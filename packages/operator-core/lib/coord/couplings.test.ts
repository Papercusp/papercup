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

/**
 * ── P-008: OBLIGATIONS SORT FIRST ────────────────────────────────────────────────────
 *
 * Every other derived relation says "we are both near this". An obligation says someone
 * is WAITING. Sorted alphabetically among dozens of symmetric peers — one live leader in
 * this workspace supervises 234 — a four-hour-old unanswered consult from a counterpart
 * who has since died carries the same visual weight as "recent coord exchange", and reads
 * as "as expected". Ordering is what makes it unmissable.
 *
 * ⚠ EVERY CASE BELOW PUTS THE OBLIGATION PEER LATER IN THE ALPHABET ON PURPOSE. An
 * assertion where the obligation peer also happens to sort first alphabetically would
 * pass against the OLD purely-alphabetical sort, and would therefore prove nothing — the
 * vacuous-green shape this file's own fixtures warn about. `su-zzz` before `su-aaa` can
 * only be produced by the obligation hoist.
 */
describe('P-008 — obligations sort above symmetric relations', () => {
  it('hoists an `owes-me` peer above a symmetric peer that sorts EARLIER alphabetically', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [
        d('su-aaa', 'recent coord exchange', 'coord-exchange'),
        d('su-zzz', 'they owe you a consult reply, open 14m, counterpart ended (conv-1)', 'owes-me'),
      ],
      [],
    );
    // Alphabetically this is backwards, which is exactly the point.
    expect(peers.map((p) => p.ownerId)).toEqual(['su-zzz', 'su-aaa']);
  });

  it('hoists `i-owe` too — a debt YOU owe is equally unmissable', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [
        d('su-aaa', 'both awaiting gate:1', 'awaits'),
        d('su-zzz', 'you owe them a grade, open 2h, counterpart live (EI-1)', 'i-owe'),
      ],
      [],
    );
    expect(peers.map((p) => p.ownerId)).toEqual(['su-zzz', 'su-aaa']);
  });

  it('keeps ownerId as the tiebreaker WITHIN each group, so the order stays total', () => {
    // A partial sort would let identical state render differently between reads, which
    // the roster etag and every caller depend on not happening.
    const peers = resolveCoupledPeers(
      'su-me',
      [
        d('su-sym-b', 'recent coord exchange', 'coord-exchange'),
        d('su-ob-b', 'they owe you a consult reply, open 1h, counterpart live (c2)', 'owes-me'),
        d('su-sym-a', 'both awaiting gate:1', 'awaits'),
        d('su-ob-a', 'you owe them a grade, open 3h, counterpart live (c1)', 'i-owe'),
      ],
      [],
    );
    expect(peers.map((p) => p.ownerId)).toEqual(['su-ob-a', 'su-ob-b', 'su-sym-a', 'su-sym-b']);
  });

  it('hoists a peer carrying an obligation ALONGSIDE symmetric signals', () => {
    // A peer can trip several derivations at once; carrying any obligation is enough.
    const peers = resolveCoupledPeers(
      'su-me',
      [
        d('su-aaa', 'shared lock', 'holds-a-lock-on'),
        d('su-zzz', 'recent coord exchange', 'coord-exchange'),
        d('su-zzz', 'they owe you a consult reply, open 9m, counterpart unknown (c3)', 'owes-me'),
      ],
      [],
    );
    expect(peers[0]?.ownerId).toBe('su-zzz');
    expect(peers[0]?.derivedRelations).toEqual(['coord-exchange', 'owes-me']);
  });

  it('leaves a purely symmetric set in plain alphabetical order', () => {
    // The hoist must not perturb the ordering everyone already relies on when no
    // obligation is present.
    const peers = resolveCoupledPeers(
      'su-me',
      [
        d('su-c', 'recent coord exchange', 'coord-exchange'),
        d('su-a', 'shared lock', 'holds-a-lock-on'),
        d('su-b', 'both awaiting gate:1', 'awaits'),
      ],
      [],
    );
    expect(peers.map((p) => p.ownerId)).toEqual(['su-a', 'su-b', 'su-c']);
  });

  it('sorts an UNTYPED declared peer below an obligation', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [d('su-zzz', 'they owe you a grade, open 5m, counterpart live (c4)', 'i-owe')],
      [edge('su-me', 'su-aaa', { reason: 'same file' })],
    );
    expect(peers.map((p) => p.ownerId)).toEqual(['su-zzz', 'su-aaa']);
  });
});

/**
 * ── P-009: A DECLARED EDGE CAN CARRY THE TYPED VOCABULARY (migration 954) ─────────────
 *
 * Until now a declared coupling carried only prose, so it was invisible to every typed
 * consumer — the P-008 obligation sort and the P-010 concentration census both read
 * `derivedRelations`. The column exists so a declared edge participates in both.
 *
 * ⚠ The relation stays NULLABLE and most live rows have none (D-017): across 101 real
 * declared reasons, ~26% fit only shapes with no vocabulary member and ~30% do not
 * classify at all. An untyped declared edge is the COMMON case, not a defect, so the
 * untyped path is asserted here as deliberately as the typed one.
 */
describe('P-009 — a declared edge carries the typed relation', () => {
  it('hoists a declared-ONLY obligation above symmetric derived peers', () => {
    // su-zzz sorts LAST alphabetically, so this can only pass via the relation.
    const peers = resolveCoupledPeers(
      'su-me',
      [d('su-aaa', 'recent coord exchange', 'coord-exchange')],
      [edge('su-me', 'su-zzz', { reason: 'they owe me the grade', relation: 'owes-me' })],
    );
    expect(peers.map((p) => p.ownerId)).toEqual(['su-zzz', 'su-aaa']);
    expect(peers[0]?.derivedRelations).toEqual(['owes-me']);
  });

  it('an UNTYPED declared edge emits no relations at all — the common case', () => {
    const peers = resolveCoupledPeers('su-me', [], [edge('su-me', 'su-x', { reason: 'same file' })]);
    expect(peers[0]?.derivedRelations).toBeUndefined();
  });

  it('DEDUPES when declared and derived carry the same relation', () => {
    // Listing it twice would double-count that relation's share in the P-010 census —
    // inflating exactly the number the concentration guard measures.
    const peers = resolveCoupledPeers(
      'su-me',
      [d('su-p', 'they owe you a consult reply, open 1h, counterpart live (c1)', 'owes-me')],
      [edge('su-me', 'su-p', { reason: 'declared the same debt', relation: 'owes-me' })],
    );
    expect(peers[0]?.derivedRelations).toEqual(['owes-me']);
    expect(peers[0]?.source).toBe('both');
  });

  it('UNIONS a declared relation with a DIFFERENT derived one', () => {
    const peers = resolveCoupledPeers(
      'su-me',
      [d('su-p', 'recent coord exchange', 'coord-exchange')],
      [edge('su-me', 'su-p', { reason: 'and they owe me a grade', relation: 'owes-me' })],
    );
    expect(peers[0]?.derivedRelations).toEqual(['coord-exchange', 'owes-me']);
  });
});

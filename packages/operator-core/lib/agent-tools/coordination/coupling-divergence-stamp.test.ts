/**
 * coupling-divergence-stamp.test.ts — the CONSUMER side of `forYouBecause`
 * (D-089, WI-6685).
 *
 * These assert the properties that make the stamp trustworthy rather than the
 * plumbing: that it does ZERO IO for a message it cannot score, that a failing
 * coupling read degrades to no measurement instead of a failed send, and that a
 * broadcast is never scored.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveCouplingDivergenceStamps,
  scoreCouplingDivergence,
  comparableClaims,
  COUPLING_DIVERGENCE_STAMPS_MAX,
  divergentStamps,
  type PeerRelationsReader,
} from './coupling-divergence-stamp';
import type { DerivedCouplingRelation } from '../../coord/couplings';

const PEER = 'su-peer';
const SELF = 'su-me';

const relations = (o: Record<string, DerivedCouplingRelation[]>) =>
  new Map<string, readonly DerivedCouplingRelation[]>(Object.entries(o));

const readerReturning = (o: Record<string, DerivedCouplingRelation[]>) => {
  const fn = vi.fn(async () => relations(o));
  return fn as unknown as PeerRelationsReader & ReturnType<typeof vi.fn>;
};

describe('the cost gate — an unscoreable message must not touch the database', () => {
  it('does ZERO IO when every asserted relation is uncomparable', async () => {
    // `owns` is 53% of live asserted uses and can never be compared, so the
    // common case must not pay for a presence snapshot. The gate and the
    // scoring rule are the SAME table, so this cannot drift from the verdict.
    const read = readerReturning({ [PEER]: ['same-fleet'] });
    const stamps = await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: SELF,
        to: [PEER],
        sections: [
          { forYouBecause: { relation: 'owns', ref: 'WI-1' } },
          { forYouBecause: { relation: 'other', note: 'n' } },
        ],
      },
      read,
    );
    expect(stamps).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('does ZERO IO for a message with no forYouBecause at all', async () => {
    const read = readerReturning({});
    expect(
      await resolveCouplingDivergenceStamps(
        { selfOwnerId: SELF, to: [PEER], sections: [{}, {}] },
        read,
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('comparableClaims keeps section INDICES, not just the claims', () => {
    // The stamp is useless without knowing WHICH section made the claim — a
    // message can assert different relations in different sections.
    const claims = comparableClaims([
      { forYouBecause: { relation: 'owns' } },
      {},
      { forYouBecause: { relation: 'same-fleet' } },
    ]);
    expect(claims.map((c) => c.section)).toEqual([2]);
  });
});

describe('never scored against a SET', () => {
  it('drops broadcast and audience-selector recipients, doing no IO', async () => {
    // The sender addressed a set, not a person, so "why THIS recipient" has no
    // subject to be right or wrong about. Scoring it would invent divergence.
    const read = readerReturning({ [PEER]: [] });
    for (const to of [['*'], ['human'], ['@fleet:alpha'], [SELF]]) {
      expect(
        await resolveCouplingDivergenceStamps(
          {
            selfOwnerId: SELF,
            to,
            sections: [{ forYouBecause: { relation: 'same-fleet' } }],
          },
          read,
        ),
      ).toEqual([]);
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe('fail-soft — a measurement must never be able to eat a message', () => {
  it('returns no stamps when the coupling read throws', async () => {
    const stamps = await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: SELF,
        to: [PEER],
        sections: [{ forYouBecause: { relation: 'same-fleet' } }],
      },
      async () => {
        throw new Error('presence store down');
      },
    );
    expect(stamps).toEqual([]);
  });

  it('returns no stamps for an unresolvable sender', async () => {
    const read = readerReturning({ [PEER]: ['same-fleet'] });
    expect(
      await resolveCouplingDivergenceStamps(
        {
          selfOwnerId: '   ',
          to: [PEER],
          sections: [{ forYouBecause: { relation: 'same-fleet' } }],
        },
        read,
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('scoring against the graph', () => {
  it('agrees when the graph carries the asserted relation', async () => {
    const stamps = await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: SELF,
        to: [PEER],
        sections: [{ forYouBecause: { relation: 'same-fleet' } }],
      },
      readerReturning({ [PEER]: ['same-fleet', 'coord-exchange'] }),
    );
    expect(stamps).toEqual([
      {
        section: 0,
        recipient: PEER,
        asserted: 'same-fleet',
        verdict: 'agrees',
        computed: ['same-fleet', 'coord-exchange'],
      },
    ]);
  });

  it('records DIVERGENCE with the graph contents that produced it', async () => {
    // The `computed` array is the evidence: a bare verdict would be unauditable.
    const stamps = await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: SELF,
        to: [PEER],
        sections: [{ forYouBecause: { relation: 'same-fleet' } }],
      },
      readerReturning({ [PEER]: ['coord-exchange'] }),
    );
    expect(stamps[0]?.verdict).toBe('diverges');
    expect(stamps[0]?.computed).toEqual(['coord-exchange']);
    expect(divergentStamps(stamps)).toHaveLength(1);
  });

  it('a recipient absent from the graph is scored the same as one with no edges', () => {
    // Both mean "the graph holds nothing for this pair" — and the per-relation
    // rule, not this module, decides whether that is silence or contradiction.
    const missing = scoreCouplingDivergence(
      [{ section: 0, f: { relation: 'awaits' } }],
      [PEER],
      relations({}),
    );
    const empty = scoreCouplingDivergence(
      [{ section: 0, f: { relation: 'awaits' } }],
      [PEER],
      relations({ [PEER]: [] }),
    );
    expect(missing).toEqual(empty);
    // one-sided relation ⇒ absence is silence, never divergence
    expect(missing[0]?.verdict).toBe('not-comparable');
  });

  it('scores every (section, recipient) pair — the field is per-recipient', async () => {
    const stamps = await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: SELF,
        to: ['su-a', 'su-b'],
        sections: [
          { forYouBecause: { relation: 'same-fleet' } },
          { forYouBecause: { relation: 'is-blocked-on' } },
        ],
      },
      readerReturning({ 'su-a': ['same-fleet'], 'su-b': ['blocked-by-me'] }),
    );
    expect(stamps.map((s) => [s.section, s.recipient, s.verdict])).toEqual([
      [0, 'su-a', 'agrees'],
      [0, 'su-b', 'diverges'],
      [1, 'su-a', 'diverges'],
      // direction-insensitive: blocked-by-me satisfies the one asserted token
      [1, 'su-b', 'agrees'],
    ]);
  });

  it('is BOUNDED — sections × recipients is quadratic in principle', () => {
    const claims = Array.from({ length: 20 }, (_, i) => ({
      section: i,
      f: { relation: 'same-fleet' as const },
    }));
    const recipients = Array.from({ length: 20 }, (_, i) => `su-${i}`);
    expect(scoreCouplingDivergence(claims, recipients, relations({}))).toHaveLength(
      COUPLING_DIVERGENCE_STAMPS_MAX,
    );
  });
});

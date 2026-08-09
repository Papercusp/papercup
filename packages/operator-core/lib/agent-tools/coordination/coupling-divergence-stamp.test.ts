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
    const read = readerReturning({ [PEER]: ['coord-exchange'] });
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
      { forYouBecause: { relation: 'holds-a-lock-on' } },
    ]);
    expect(claims.map((c) => c.section)).toEqual([2]);
  });
});

describe('never scored against a SET', () => {
  it('drops broadcast and audience-selector recipients, doing no IO', async () => {
    // The sender addressed a set, not a person, so "why THIS recipient" has no
    // subject to be right or wrong about. Scoring it would invent divergence.
    // ⚠ The asserted relation must be a COMPARABLE one, or the claim is dropped
    // by the cost gate before the audience rule is ever reached and this passes
    // without testing anything. It was `same-fleet`, which stopped being
    // comparable on 2026-08-09 (D-054) — the same silent-vacuum this file's
    // fail-soft cases below also had to be rescued from.
    const read = readerReturning({ [PEER]: [] });
    for (const to of [['*'], ['human'], ['@fleet:alpha'], [SELF]]) {
      expect(
        await resolveCouplingDivergenceStamps(
          {
            selfOwnerId: SELF,
            to,
            sections: [{ forYouBecause: { relation: 'holds-a-lock-on' } }],
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
        // Comparable ON PURPOSE — an uncomparable relation would short-circuit
        // before the reader is ever called, and the throw would go untested.
        sections: [{ forYouBecause: { relation: 'holds-a-lock-on' } }],
      },
      async () => {
        throw new Error('presence store down');
      },
    );
    expect(stamps).toEqual([]);
  });

  it('returns no stamps for an unresolvable sender', async () => {
    const read = readerReturning({ [PEER]: ['holds-a-lock-on'] });
    expect(
      await resolveCouplingDivergenceStamps(
        {
          selfOwnerId: '   ',
          to: [PEER],
          sections: [{ forYouBecause: { relation: 'holds-a-lock-on' } }],
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
        sections: [{ forYouBecause: { relation: 'holds-a-lock-on' } }],
      },
      readerReturning({ [PEER]: ['holds-a-lock-on', 'coord-exchange'] }),
    );
    expect(stamps).toEqual([
      {
        section: 0,
        recipient: PEER,
        asserted: 'holds-a-lock-on',
        verdict: 'agrees',
        computed: ['holds-a-lock-on', 'coord-exchange'],
      },
    ]);
  });

  it('records DIVERGENCE with the graph contents that produced it', async () => {
    // The `computed` array is the evidence: a bare verdict would be unauditable.
    // `is-blocked-on` is the asserted relation here because it is the two-sided
    // one — the only kind whose ABSENCE from the graph is a contradiction rather
    // than silence, and therefore the only kind that can produce this verdict.
    const stamps = await resolveCouplingDivergenceStamps(
      {
        selfOwnerId: SELF,
        to: [PEER],
        sections: [{ forYouBecause: { relation: 'is-blocked-on' } }],
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
          { forYouBecause: { relation: 'holds-a-lock-on' } },
          { forYouBecause: { relation: 'is-blocked-on' } },
        ],
      },
      readerReturning({ 'su-a': ['holds-a-lock-on'], 'su-b': ['blocked-by-me'] }),
    );
    // All THREE verdicts appear in one matrix, which the `same-fleet` version of
    // this fixture could not produce — the pairing of a one-sided relation with a
    // two-sided one is what makes `not-comparable` distinguishable from a miss.
    expect(stamps.map((s) => [s.section, s.recipient, s.verdict])).toEqual([
      [0, 'su-a', 'agrees'],
      // one-sided ⇒ the graph's silence about su-b is not a contradiction
      [0, 'su-b', 'not-comparable'],
      [1, 'su-a', 'diverges'],
      // direction-insensitive: blocked-by-me satisfies the one asserted token
      [1, 'su-b', 'agrees'],
    ]);
  });

  it('is BOUNDED — sections × recipients is quadratic in principle', () => {
    const claims = Array.from({ length: 20 }, (_, i) => ({
      section: i,
      // A COMPARABLE relation: an uncomparable one is filtered upstream by
      // `comparableClaims`, so bounding it here would bound an unreachable input.
      f: { relation: 'is-blocked-on' as const },
    }));
    const recipients = Array.from({ length: 20 }, (_, i) => `su-${i}`);
    expect(scoreCouplingDivergence(claims, recipients, relations({}))).toHaveLength(
      COUPLING_DIVERGENCE_STAMPS_MAX,
    );
  });
});

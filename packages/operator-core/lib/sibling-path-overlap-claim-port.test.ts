/**
 * EI-19329513980117751 — the claim-time sibling-path-overlap guard.
 *
 * ⚠ SCOPE. The parity test (`claim-time-enrichment-parity.test.ts`) proves every claim
 * surface ATTACHES this leg; it deliberately proves nothing about whether the leg is
 * right. This file is the other half: the pure predicates and the rendered warning,
 * plus the two no-PG paths that must stay silent.
 *
 * The falsifiability controls below are PERMANENT deliberately-wrong implementations
 * kept in the test file, per the repo rule — never a mutation of the shared tree, which
 * git-sync can commit mid-probe.
 */
import { describe, expect, it } from 'vitest';
import {
  DISCARDED_WORK_ITEM_STATES,
  MAX_SIBLINGS,
  getClaimTimeSiblingPathOverlap,
  implementedWorkItemStates,
  siblingCoordinationOffers,
  siblingPathOverlapWarning,
  type ClaimTimeSiblingPathOverlapHint,
  type PathOverlapSibling,
} from './sibling-path-overlap-claim-port';
import { SETTLED_WORK_ITEM_STATES } from './work-items';

describe('implementedWorkItemStates', () => {
  it('keeps the states that mean the work LANDED', () => {
    const implemented = implementedWorkItemStates(SETTLED_WORK_ITEM_STATES);
    expect(implemented).toContain('done');
    expect(implemented).toContain('resolved');
    expect(implemented).toContain('passed');
  });

  it('drops the DISCARD states — they mean the work was explicitly not done', () => {
    const implemented = implementedWorkItemStates(SETTLED_WORK_ITEM_STATES);
    // Announcing a dropped sibling as "already implemented" would send an agent to read
    // a decision to SKIP the work as though it were the work.
    expect(implemented).not.toContain('dropped');
    expect(implemented).not.toContain('closed');
    expect(implemented).not.toContain('deprecated');
  });

  it('is derived by subtraction, so a new settled state lands in the warned set', () => {
    // The direction that matters: over-warning is recoverable (this is advisory),
    // silence is the defect the module exists to stop. A state the upstream list gains
    // must therefore be INCLUDED by default, not excluded.
    const withNewState = [...SETTLED_WORK_ITEM_STATES, 'ratified'];
    expect(implementedWorkItemStates(withNewState)).toContain('ratified');
  });

  it('partitions the settled list exactly — nothing is invented or lost', () => {
    const implemented = implementedWorkItemStates(SETTLED_WORK_ITEM_STATES);
    const discarded = SETTLED_WORK_ITEM_STATES.filter((s) => DISCARDED_WORK_ITEM_STATES.includes(s));
    expect(implemented.length + discarded.length).toBe(SETTLED_WORK_ITEM_STATES.length);
    expect(implemented.every((s) => SETTLED_WORK_ITEM_STATES.includes(s))).toBe(true);
  });

  describe('falsifiability controls (permanent wrong implementations)', () => {
    /** The bug this guard exists to prevent: treating every settled state as landed. */
    const allSettled = (settled: readonly string[]) => [...settled];
    /** The other plausible weakening: a hand-listed set that silently drifts. */
    const handListed = (_settled: readonly string[]) => ['done'];

    it('the controls accept what the real function rejects', () => {
      // If this ever fails, the controls have stopped being wrong and the tests above
      // prove nothing.
      expect(allSettled(SETTLED_WORK_ITEM_STATES)).toContain('dropped');
      expect(implementedWorkItemStates(SETTLED_WORK_ITEM_STATES)).not.toContain('dropped');
    });

    it('the hand-listed control misses states the real function keeps', () => {
      expect(handListed(SETTLED_WORK_ITEM_STATES)).not.toContain('resolved');
      expect(implementedWorkItemStates(SETTLED_WORK_ITEM_STATES)).toContain('resolved');
    });

    it('calibration: the real function is not simply empty', () => {
      // Without this, an implementation hard-coded to [] would pass every test above.
      expect(implementedWorkItemStates(SETTLED_WORK_ITEM_STATES).length).toBeGreaterThan(0);
    });
  });
});

describe('getClaimTimeSiblingPathOverlap', () => {
  it('returns null without touching PG when the item stores no paths', async () => {
    // The overwhelmingly common claim, which must be completely unaffected by this leg
    // (and must not require a database).
    await expect(getClaimTimeSiblingPathOverlap({ workItemId: 'WI-1', payload: {} })).resolves.toBeNull();
  });

  it('returns null when payload.paths is present but not a usable list', async () => {
    await expect(
      getClaimTimeSiblingPathOverlap({ workItemId: 'WI-1', payload: { paths: [] } }),
    ).resolves.toBeNull();
    await expect(
      getClaimTimeSiblingPathOverlap({ workItemId: 'WI-1', payload: { paths: 'not-an-array' } }),
    ).resolves.toBeNull();
  });

  it('returns null when the work-item id is missing', async () => {
    await expect(
      getClaimTimeSiblingPathOverlap({ workItemId: '', payload: { paths: ['a.ts'] } }),
    ).resolves.toBeNull();
  });
});

describe('siblingPathOverlapWarning', () => {
  /** The measured real duplicate: WI-6992 landed the fix WI-6994 was filed to build. */
  const landed: ClaimTimeSiblingPathOverlapHint = {
    claimedPaths: [
      'packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json',
      'scripts/lib/identity-leak-patterns.mjs',
    ],
    ratedPaths: ['packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json'],
    siblings: [
      {
        workItemId: 'WI-6992',
        title: 'add redaction at the fixture-write choke point',
        state: 'done',
        inFlight: false,
        holder: null,
        sharedPaths: ['packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json'],
        rarestSharedPathSharers: 3,
      },
    ],
    coordinationOffers: [],
    totalMatched: 1,
    implementedCount: 1,
    inFlightCount: 0,
  };

  it('returns null for no hint — saying nothing asserts nothing', () => {
    expect(siblingPathOverlapWarning(null, 'WI-1')).toBeNull();
  });

  it('returns null for a hint with no siblings', () => {
    expect(
      siblingPathOverlapWarning(
        {
          claimedPaths: ['a.ts'],
          ratedPaths: [],
          siblings: [],
          coordinationOffers: [],
          totalMatched: 0,
          implementedCount: 0,
          inFlightCount: 0,
        },
        'WI-1',
      ),
    ).toBeNull();
  });

  it('names the sibling, its state and the SHARED PATHS — the evidence, not a score', () => {
    const msg = siblingPathOverlapWarning(landed, 'WI-6994');
    expect(msg).toContain('WI-6992');
    expect(msg).toContain('prose-corpus.v1.json');
    expect(msg).toContain('done');
    expect(msg).toContain('WI-6994');
    // The actionable half: what to do instead of re-implementing.
    expect(msg).toContain('ALREADY LANDED');
    expect(msg).toContain('duplicate');
  });

  it('states how RARE the shared path is — that is what makes it evidence', () => {
    // Without the rarity figure the reader cannot tell a 3-sharer match (real signal)
    // from a 98-sharer hub-file coincidence. See the module note's measured table.
    const msg = siblingPathOverlapWarning(landed, 'WI-6994') ?? '';
    expect(msg).toContain('only 3 settled item(s)');
    expect(msg).toContain('RARE PATHS');
  });

  it('calls itself a FILTER, not a verdict', () => {
    // The honest framing. Overselling this as duplicate detection is what would get an
    // agent to close a non-duplicate.
    expect(siblingPathOverlapWarning(landed, 'WI-6994')).toContain('FILTER, not');
  });

  it('distinguishes an IN-FLIGHT peer from an already-landed sibling', () => {
    // These are different problems with different responses: coordinate vs. do not
    // rebuild. Collapsing them would make the warning unactionable.
    const inFlight: ClaimTimeSiblingPathOverlapHint = {
      claimedPaths: ['a.ts'],
      ratedPaths: ['a.ts'],
      siblings: [
        {
          workItemId: 'WI-2',
          title: 't',
          state: 'open',
          inFlight: true,
          holder: null,
          sharedPaths: ['a.ts'],
          rarestSharedPathSharers: 2,
        },
      ],
      coordinationOffers: [],
      totalMatched: 1,
      implementedCount: 0,
      inFlightCount: 1,
    };
    const msg = siblingPathOverlapWarning(inFlight, 'WI-1');
    expect(msg).toContain('IN FLIGHT');
    expect(msg).toContain('held by a peer');
    expect(msg).not.toContain('ALREADY LANDED');

    const landedMsg = siblingPathOverlapWarning(landed, 'WI-1');
    expect(landedMsg).not.toContain('held by a peer');
  });

  it('reports the TRUE total and marks the list as capped', () => {
    // The repo's bounded-measurement rule: a count computed over a capped fetch must
    // say so ON the aggregate, or a floor gets quoted as a total.
    const capped: ClaimTimeSiblingPathOverlapHint = {
      ...landed,
      siblings: Array.from({ length: MAX_SIBLINGS }, (_, i) => ({
        ...landed.siblings[0],
        workItemId: `WI-${100 + i}`,
      })),
      totalMatched: 23,
      implementedCount: MAX_SIBLINGS,
    };
    const msg = siblingPathOverlapWarning(capped, 'WI-1') ?? '';
    expect(msg).toContain('23 other work-item(s)');
    expect(msg).toContain(`${MAX_SIBLINGS} of 23 shown`);
  });

  it('does not announce a cap when nothing was capped', () => {
    const msg = siblingPathOverlapWarning(landed, 'WI-1') ?? '';
    expect(msg).toContain('1 other work-item(s)');
    expect(msg).not.toContain('shown, strongest first');
  });
});

/**
 * lateral-fleet-coordination-2026-09-02 P-003 / D-005 — the offer half.
 *
 * WHY THESE ASSERTIONS AND NOT A VOLUME TEST. D-005 clears this mechanism under D-001
 * (the owner's ruling that low fleet-wide traffic is deliberate, protecting member
 * context) on two grounds: it fires rarely, and each send is DIRECTED to one peer.
 * Rarity is a property of live data and is pinned by D-006's re-runnable population
 * query, not by a unit test. What a unit test CAN pin — and what D-006 explicitly
 * assigns here — is that the offer is addressed to the ACTUAL holder. An offer sent to
 * the wrong agent is wrong at any volume, and it is the one failure that would still
 * look correct in the rendered string.
 */
describe('siblingCoordinationOffers (P-003)', () => {
  const heldByPeer: PathOverlapSibling = {
    workItemId: 'WI-6992',
    title: 'add redaction at the fixture-write choke point',
    state: 'open',
    inFlight: true,
    holder: 'su-peer-1',
    sharedPaths: ['scripts/lib/identity-leak-patterns.mjs'],
    rarestSharedPathSharers: 2,
  };
  const settledSibling: PathOverlapSibling = {
    ...heldByPeer,
    workItemId: 'WI-6991',
    state: 'done',
    inFlight: false,
    holder: null,
  };
  const argsOf = (o: { send: { args: Record<string, unknown> } }) =>
    o.send.args as {
      to: string[];
      expects: string;
      summary: string;
      body: Array<{
        text: string;
        forYouBecause?: { relation: string; ref?: string };
        couldNotDetermine?: Array<{ what: string }>;
      }>;
    };

  it('addresses the HOLDER, not the claiming agent', () => {
    // The property D-006 pins by test rather than by measurement.
    const [offer] = siblingCoordinationOffers([heldByPeer], 'WI-6994');
    expect(offer.holder).toBe('su-peer-1');
    expect(argsOf(offer).to).toEqual(['su-peer-1']);
    expect(argsOf(offer).to).not.toContain('WI-6994');
  });

  it('offers nothing for a settled sibling — that is a do-not-rebuild, not a peer', () => {
    // A settled item's taken_by is a historical assignee. Messaging them would spend
    // the budget D-001 protects on someone who has already finished.
    expect(siblingCoordinationOffers([settledSibling], 'WI-6994')).toEqual([]);
  });

  it('stays silent when an in-flight sibling has no known holder', () => {
    // Silence beats an offer addressed to nobody: a rendered but unaddressable offer
    // reads as a coordination step already available, which is worse than none.
    const holderless: PathOverlapSibling = { ...heldByPeer, holder: null };
    expect(siblingCoordinationOffers([holderless], 'WI-6994')).toEqual([]);
  });

  it('builds a coord:send the recipient can actually accept', () => {
    // coord:send REQUIRES `expects`, and REQUIRES forYouBecause on at least one section
    // of a directed message expecting an answer. A handle that would be rejected on
    // paste is not a handle.
    const [offer] = siblingCoordinationOffers([heldByPeer], 'WI-6994');
    expect(offer.send.tool).toBe('coord:send');
    const args = argsOf(offer);
    expect(args.expects).toBe('answer');
    expect(Array.isArray(args.body)).toBe(true);
    expect(args.body[0].forYouBecause?.relation).toBe('owns');
    expect(args.body[0].forYouBecause?.ref).toBe('WI-6992');
    // The honest field: what the sender genuinely cannot establish alone. Its absence
    // would render the ask as more certain than the evidence supports.
    expect(args.body[0].couldNotDetermine?.[0].what).toContain('WI-6992');
  });

  it('names both the shared paths and both work-item ids, so the ask is self-contained', () => {
    const [offer] = siblingCoordinationOffers([heldByPeer], 'WI-6994');
    expect(offer.sharedPaths).toEqual(['scripts/lib/identity-leak-patterns.mjs']);
    const args = argsOf(offer);
    expect(args.summary).toContain('WI-6992');
    expect(args.summary).toContain('WI-6994');
    expect(args.summary).toContain('identity-leak-patterns.mjs');
  });

  it('offers one send per in-flight holder and skips the settled ones in the same list', () => {
    const second: PathOverlapSibling = { ...heldByPeer, workItemId: 'WI-7000', holder: 'su-peer-2' };
    const offers = siblingCoordinationOffers([settledSibling, heldByPeer, second], 'WI-6994');
    expect(offers.map((o) => o.holder)).toEqual(['su-peer-1', 'su-peer-2']);
  });

  it('returns nothing without a claiming work-item id', () => {
    expect(siblingCoordinationOffers([heldByPeer], '')).toEqual([]);
  });

  describe('falsifiability controls (permanent wrong implementations)', () => {
    /** The bug the addressing test exists to catch: replying to yourself. */
    const addressTheClaimer = (s: PathOverlapSibling, claimer: string) => ({ to: [claimer] });
    /** The other plausible weakening: offer on every sibling, settled ones included. */
    const offerOnEverySibling = (siblings: readonly PathOverlapSibling[]) => siblings.map((s) => s.workItemId);

    it('the claimer-addressed control fails the assertion the real builder passes', () => {
      expect(addressTheClaimer(heldByPeer, 'WI-6994').to).toEqual(['WI-6994']);
      expect(argsOf(siblingCoordinationOffers([heldByPeer], 'WI-6994')[0]).to).toEqual(['su-peer-1']);
    });

    it('the offer-on-everything control includes the settled sibling the real builder drops', () => {
      expect(offerOnEverySibling([settledSibling, heldByPeer])).toContain('WI-6991');
      expect(siblingCoordinationOffers([settledSibling, heldByPeer], 'WI-6994').map((o) => o.workItemId)).not.toContain(
        'WI-6991',
      );
    });

    it('calibration: the real builder is not simply empty', () => {
      // Without this, an implementation hard-coded to [] would pass both controls above.
      expect(siblingCoordinationOffers([heldByPeer], 'WI-6994').length).toBe(1);
    });
  });
});

describe('siblingPathOverlapWarning + the P-003 offer', () => {
  const withOffer = (holder: string | null): ClaimTimeSiblingPathOverlapHint => {
    const siblings: PathOverlapSibling[] = [
      {
        workItemId: 'WI-6992',
        title: 't',
        state: 'open',
        inFlight: true,
        holder,
        sharedPaths: ['scripts/lib/identity-leak-patterns.mjs'],
        rarestSharedPathSharers: 2,
      },
    ];
    return {
      claimedPaths: ['scripts/lib/identity-leak-patterns.mjs'],
      ratedPaths: ['scripts/lib/identity-leak-patterns.mjs'],
      siblings,
      coordinationOffers: siblingCoordinationOffers(siblings, 'WI-6994'),
      totalMatched: 1,
      implementedCount: 0,
      inFlightCount: 1,
    };
  };

  it('NAMES the holder inline, so coordinating does not need a second lookup', () => {
    // The whole point of P-003: before this, the warning said "held by a peer RIGHT NOW"
    // and the reader had to go find out who.
    const msg = siblingPathOverlapWarning(withOffer('su-peer-1'), 'WI-6994') ?? '';
    expect(msg).toContain('su-peer-1');
    expect(msg).toContain('su-peer-1 holds WI-6992');
  });

  it('points at the structured handle rather than inlining the call', () => {
    // The warning renders on every qualifying claim, so it pays for an id and a pointer,
    // not for a JSON payload — the dev:pipeline_position `plane` split.
    const msg = siblingPathOverlapWarning(withOffer('su-peer-1'), 'WI-6994') ?? '';
    expect(msg).toContain('coordinationOffers');
    expect(msg).not.toContain('forYouBecause');
  });

  it('says plainly that NOTHING was sent — it is an offer, not a dispatch', () => {
    // D-005 clears this under D-001 precisely because the agent still decides. A reader
    // who thinks the message already went is the one failure that would silently spend
    // the budget the ruling protects.
    const msg = siblingPathOverlapWarning(withOffer('su-peer-1'), 'WI-6994') ?? '';
    expect(msg).toContain('NOTHING WAS SENT');
  });

  it('falls back to the pre-P-003 sentence when no holder is known', () => {
    const msg = siblingPathOverlapWarning(withOffer(null), 'WI-6994') ?? '';
    expect(msg).toContain('held by a peer');
    expect(msg).not.toContain('coordinationOffers');
    expect(msg).not.toContain('NOTHING WAS SENT');
  });

  it('degrades instead of throwing when the hint predates coordinationOffers', () => {
    // The hint crosses an `unknown`-typed enrichment boundary, so an older serialized
    // shape must render the old sentence rather than crash a warning renderer.
    const legacy = withOffer('su-peer-1') as Partial<ClaimTimeSiblingPathOverlapHint>;
    delete legacy.coordinationOffers;
    const msg = siblingPathOverlapWarning(legacy as ClaimTimeSiblingPathOverlapHint, 'WI-6994') ?? '';
    expect(msg).toContain('held by a peer');
    expect(msg).not.toContain('coordinationOffers');
  });
});

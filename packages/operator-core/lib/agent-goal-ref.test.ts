/**
 * agent-goal-ref.test.ts — P-016's resolver, pinned at the behaviours that
 * MEASUREMENT (not the item text) established.
 *
 * The item states a flat precedence. The live fleet showed it is under-determined
 * — 3 of 19 owners hold two work-items at once — and that a `coord_links`
 * `implements` edge is the disambiguator. The corroboration tests below are the
 * ones that would go red if someone "simplified" this back to the item's wording.
 */
import { describe, it, expect } from 'vitest';
import {
  asGoalRef,
  fleetMissionRef,
  goalRefSchema,
  planItemRef,
  resolveAgentGoal,
  type GoalCandidates,
} from './agent-goal-ref';

describe('asGoalRef', () => {
  it('passes refs a reader can act on', () => {
    expect(asGoalRef('WI-6407')).toBe('WI-6407');
    expect(asGoalRef('  EI-18810823481386446  ')).toBe('EI-18810823481386446');
    expect(asGoalRef('unified-agent-state-plane-2026-07-27#P-016')).toBe(
      'unified-agent-state-plane-2026-07-27#P-016',
    );
  });

  it('rejects a bare bigint and a blank — D-046: a bigint is not a read surface', () => {
    expect(asGoalRef('184073')).toBeNull();
    expect(asGoalRef('')).toBeNull();
    expect(asGoalRef('   ')).toBeNull();
    expect(asGoalRef(null)).toBeNull();
    expect(asGoalRef(undefined)).toBeNull();
  });
});

describe('goalRefSchema', () => {
  it('accepts generated goal slugs and work-item refs while normalizing whitespace', () => {
    expect(goalRefSchema.parse(' work-on-everything-070565 ')).toBe('work-on-everything-070565');
    expect(goalRefSchema.parse(' WI-6407 ')).toBe('WI-6407');
    expect(goalRefSchema.parse(' EI-18810823481386446 ')).toBe('EI-18810823481386446');
  });

  it('rejects blank and bare numeric values at the wire boundary', () => {
    for (const value of ['', '   ', '184073']) {
      expect(() => goalRefSchema.parse(value)).toThrow(/goal ref required/);
    }
  });
});

describe('ref forms', () => {
  it('mints the plan-item ref in coord_links.dst_ref form — the join depends on it', () => {
    expect(planItemRef('unified-agent-state-plane-2026-07-27', 'P-016')).toBe(
      'unified-agent-state-plane-2026-07-27#P-016',
    );
  });

  it('namespaces a fleet mission so a reader can tell it from a task', () => {
    expect(fleetMissionRef('nonp2p-bug-drain-0727')).toBe('fleet:nonp2p-bug-drain-0727');
  });

  it('refuses to mint a ref from incomplete input rather than emitting a broken one', () => {
    expect(planItemRef('', 'P-016')).toBeNull();
    expect(planItemRef('slug', '')).toBeNull();
    expect(fleetMissionRef('  ')).toBeNull();
  });
});

describe('resolveAgentGoal — precedence', () => {
  it('returns null for an agent holding nothing — an honest unknown, not a placeholder', () => {
    expect(resolveAgentGoal({})).toBeNull();
    expect(resolveAgentGoal({ workItems: [], planItems: [], fleet: null })).toBeNull();
  });

  it('prefers a work-item over a plan item over a fleet mission', () => {
    const all: GoalCandidates = {
      workItems: [{ id: 'WI-6407' }],
      planItems: [{ planSlug: 'plan-a', itemId: 'P-001' }],
      fleet: { slug: 'real-fleet' },
    };
    expect(resolveAgentGoal(all)!.source).toBe('work-item');
    expect(resolveAgentGoal({ ...all, workItems: [] })!.source).toBe('plan-item');
    expect(resolveAgentGoal({ ...all, workItems: [], planItems: [] })!.source).toBe('fleet-mission');
  });

  it('an author override outranks every derived leg (D-011)', () => {
    const g = resolveAgentGoal({
      override: { ref: 'WI-9999', declaredAt: '2026-07-27T15:00:00Z' },
      workItems: [{ id: 'WI-6407' }],
      planItems: [{ planSlug: 'plan-a', itemId: 'P-001' }],
    })!;
    expect(g.ref).toBe('WI-9999');
    expect(g.source).toBe('author-override');
    expect(g.declaredAt).toBe('2026-07-27T15:00:00Z');
    // An override is authored BECAUSE purpose differs from the lane, so the lane
    // is disclosed rather than dropped — that divergence IS the signal.
    expect(g.agreement).toBe('divergent');
    expect(g.competing).toEqual(['WI-6407', 'plan-a#P-001']);
  });

  it('ignores an unusable override rather than emitting it — falls through to the lane', () => {
    const g = resolveAgentGoal({ override: { ref: '184073' }, workItems: [{ id: 'WI-6407' }] })!;
    expect(g.ref).toBe('WI-6407');
    expect(g.source).toBe('work-item');
  });

  it('a lone leg reports `sole` — nothing to disagree with', () => {
    const g = resolveAgentGoal({ workItems: [{ id: 'WI-6407' }] })!;
    expect(g.agreement).toBe('sole');
    expect(g.competing).toEqual([]);
    expect(g.corroboratedBy).toBeNull();
  });
});

describe('resolveAgentGoal — corroboration (the measured finding)', () => {
  /** The live shape on 2026-07-27: WI-6407 implements the very plan item its
   *  holder separately claims. Two declarations, ONE goal. */
  const live: GoalCandidates = {
    workItems: [{ id: 'WI-6407', takenAt: '2026-07-27T15:56:00Z' }],
    planItems: [{ planSlug: 'unified-agent-state-plane-2026-07-27', itemId: 'P-016' }],
    links: [
      { workItemId: 'WI-6407', planItemRef: 'unified-agent-state-plane-2026-07-27#P-016' },
    ],
  };

  it('joins the two legs into one corroborated goal instead of discarding the plan item', () => {
    const g = resolveAgentGoal(live)!;
    expect(g.ref).toBe('WI-6407');
    expect(g.source).toBe('work-item');
    expect(g.agreement).toBe('corroborated');
    expect(g.corroboratedBy).toBe('unified-agent-state-plane-2026-07-27#P-016');
    // The corroborating partner is NOT also listed as competing — it is the same goal.
    expect(g.competing).toEqual([]);
  });

  it('THE TIEBREAK: picks the work-item that implements the claimed plan item, not the newest', () => {
    // su-e6ac4eb7's live shape — two held work-items, only one linked to the claim.
    const g = resolveAgentGoal({
      workItems: [
        { id: 'WI-6395', takenAt: '2026-07-27T15:50:00Z' }, // newer, but unlinked
        { id: 'WI-6390', takenAt: '2026-07-27T10:00:00Z' }, // older, but implements the claim
      ],
      planItems: [{ planSlug: 'learning-tab-surface-public-release-2026-07-27', itemId: 'P-007' }],
      links: [
        {
          workItemId: 'WI-6390',
          planItemRef: 'learning-tab-surface-public-release-2026-07-27#P-007',
        },
      ],
    })!;
    expect(g.ref).toBe('WI-6390');
    expect(g.agreement).toBe('corroborated');
    // The other held work-item is still DISCLOSED — the agent really does hold it.
    expect(g.competing).toEqual(['WI-6395']);
  });

  it('an edge to a plan item the agent does NOT claim corroborates nothing', () => {
    // WI-684's live shape: linked to a plan item, but its holder claims none.
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-684' }],
      planItems: [],
      links: [{ workItemId: 'WI-684', planItemRef: 'data-scoping-audit-2026-06-22#P-007' }],
    })!;
    expect(g.corroboratedBy).toBeNull();
    expect(g.agreement).toBe('sole');
  });

  it('an edge naming a DIFFERENT plan item than the one claimed does not corroborate', () => {
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-1' }],
      planItems: [{ planSlug: 'plan-a', itemId: 'P-001' }],
      links: [{ workItemId: 'WI-1', planItemRef: 'plan-b#P-999' }],
    })!;
    expect(g.corroboratedBy).toBeNull();
    expect(g.agreement).toBe('divergent');
    expect(g.competing).toEqual(['plan-a#P-001']);
  });
});

describe('resolveAgentGoal — a losing leg is disclosed, never dropped', () => {
  it('discloses the outranked plan-item claim when no edge joins them', () => {
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-6401' }],
      planItems: [{ planSlug: 'unified-agent-state-plane-2026-07-27', itemId: 'P-026' }],
    })!;
    expect(g.ref).toBe('WI-6401');
    expect(g.agreement).toBe('divergent');
    expect(g.competing).toEqual(['unified-agent-state-plane-2026-07-27#P-026']);
  });

  /**
   * ⚠ THE MEASURED EXCEPTION. Running the resolver over the live fleet returned
   * `divergent` for 12 of 16 owners — and NINE were nothing but "holds a
   * work-item AND is in a fleet", i.e. every ordinary fleet member. A mission is
   * the container the work happens in, not a rival goal, so counting it as
   * divergence would make the signal fire constantly and carry no information.
   */
  it('does NOT treat a fleet mission as a competing claim — it is the container', () => {
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-5624' }],
      fleet: { slug: 'nonp2p-bug-drain-0727' },
    })!;
    expect(g.ref).toBe('WI-5624');
    expect(g.competing).toEqual([]);
    expect(g.agreement).toBe('sole');
  });

  it('still reports the fleet mission as the GOAL when nothing more specific is held', () => {
    const g = resolveAgentGoal({ fleet: { slug: 'nonp2p-bug-drain-0727' } })!;
    expect(g.ref).toBe('fleet:nonp2p-bug-drain-0727');
    expect(g.source).toBe('fleet-mission');
    expect(g.agreement).toBe('sole');
  });

  it('a fleet mission never dilutes a genuine item-level divergence', () => {
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-6404', takenAt: '2026-07-27T15:00:00Z' }, { id: 'WI-6402' }],
      fleet: { slug: 'some-fleet' },
    })!;
    expect(g.competing).toEqual(['WI-6402']);
    expect(g.agreement).toBe('divergent');
  });

  it('two unlinked work-items: newest wins and the other is disclosed', () => {
    const g = resolveAgentGoal({
      workItems: [
        { id: 'WI-A', takenAt: '2026-07-27T10:00:00Z' },
        { id: 'WI-B', takenAt: '2026-07-27T15:00:00Z' },
      ],
    })!;
    expect(g.ref).toBe('WI-B');
    expect(g.competing).toEqual(['WI-A']);
  });
});

describe('resolveAgentGoal — total by construction (P-026 rule f)', () => {
  it('is deterministic for undated and tied claims — two readers see one answer', () => {
    const a = resolveAgentGoal({ workItems: [{ id: 'WI-B' }, { id: 'WI-A' }] })!;
    const b = resolveAgentGoal({ workItems: [{ id: 'WI-A' }, { id: 'WI-B' }] })!;
    expect(a.ref).toBe('WI-A');
    expect(b.ref).toBe('WI-A');
  });

  it('an unparseable timestamp degrades ordering, never the result', () => {
    const g = resolveAgentGoal({
      workItems: [
        { id: 'WI-A', takenAt: 'not-a-date' },
        { id: 'WI-B', takenAt: '2026-07-27T15:00:00Z' },
      ],
    })!;
    expect(g.ref).toBe('WI-B');
    expect(g.declaredAt).toBe('2026-07-27T15:00:00Z');
  });

  it('drops unusable rows without failing the whole derivation', () => {
    const g = resolveAgentGoal({
      workItems: [{ id: '184073' }, { id: '  ' }, { id: 'WI-6407' }],
      planItems: [{ planSlug: '', itemId: 'P-001' }],
    })!;
    expect(g.ref).toBe('WI-6407');
    expect(g.agreement).toBe('sole');
  });

  it('never throws on malformed link rows', () => {
    expect(() =>
      resolveAgentGoal({
        workItems: [{ id: 'WI-1' }],
        planItems: [{ planSlug: 'plan-a', itemId: 'P-001' }],
        links: [{ workItemId: undefined as unknown as string, planItemRef: undefined as unknown as string }],
      }),
    ).not.toThrow();
  });

  it('carries no clock of its own — declaredAt is passed through verbatim', () => {
    const g = resolveAgentGoal({ workItems: [{ id: 'WI-1', takenAt: '2026-07-27T15:00:00Z' }] })!;
    expect(g.declaredAt).toBe('2026-07-27T15:00:00Z');
    expect(resolveAgentGoal({ workItems: [{ id: 'WI-1' }] })!.declaredAt).toBeNull();
  });
});

/**
 * EI-20073149682963544. The self lens reads plan-item claims whose TTL has lapsed
 * (so an agent stops losing its own goal 20 minutes in), which is only safe
 * because the lapse can be SAID. These pin the saying.
 *
 * The three-state input is the subtle part: `leaseValid` is `true` (measured warm),
 * `false` (measured cold), or ABSENT (never measured — the peer lens filters in
 * SQL). Collapsing absent into cold would mark every peer goal cold, the exact
 * inversion of the honesty this field exists for.
 */
describe('leaseCold — a lapsed lease is disclosed, never silently dropped or overstated', () => {
  const cold = { planSlug: 'plan-a', itemId: 'P-001', leaseValid: false };
  const warm = { planSlug: 'plan-a', itemId: 'P-002', leaseValid: true };
  const unmeasured = { planSlug: 'plan-a', itemId: 'P-003' };

  it('true when the goal IS the cold claim', () => {
    expect(resolveAgentGoal({ planItems: [cold] })!.leaseCold).toBe(true);
  });

  it('false for a measured-warm claim', () => {
    expect(resolveAgentGoal({ planItems: [warm] })!.leaseCold).toBe(false);
  });

  it('ABSENT IS NOT COLD — an unmeasured lease reads warm, not stale', () => {
    // This is the peer lens's shape. It filtered lapsed rows out in SQL, so every
    // row it produces is live by construction and carries no flag.
    expect(resolveAgentGoal({ planItems: [unmeasured] })!.leaseCold).toBe(false);
  });

  it('false when the answer names no plan-item claim at all', () => {
    const g = resolveAgentGoal({ workItems: [{ id: 'WI-1' }], planItems: [cold] })!;
    // The work-item outranks the claim, so the cold claim is not what the reader
    // would act on — it lands in `competing`, and the goal itself is not cold.
    expect(g.ref).toBe('WI-1');
    expect(g.leaseCold).toBe(false);
    expect(g.competing).toContain('plan-a#P-001');
  });

  it('TRUE through the corroboration edge — the claim named by the answer is cold', () => {
    // The headline is a work-item, but the plan-item claim is part of THIS answer
    // (`corroboratedBy`), and it is the one a reader would re-take before editing.
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-1' }],
      planItems: [cold],
      links: [{ workItemId: 'WI-1', planItemRef: 'plan-a#P-001' }],
    })!;
    expect(g.corroboratedBy).toBe('plan-a#P-001');
    expect(g.leaseCold).toBe(true);
  });

  it('a warm corroborating claim leaves the goal warm', () => {
    const g = resolveAgentGoal({
      workItems: [{ id: 'WI-1' }],
      planItems: [warm],
      links: [{ workItemId: 'WI-1', planItemRef: 'plan-a#P-002' }],
    })!;
    expect(g.corroboratedBy).toBe('plan-a#P-002');
    expect(g.leaseCold).toBe(false);
  });

  it('a LIVE claim outranks a cold one that was acquired later', () => {
    // `ttl_sec` is per-claim, so acquired-later does not mean expires-later; a
    // recency-only sort would answer with the weaker hold.
    const g = resolveAgentGoal({
      planItems: [
        { ...cold, acquiredTs: '2026-08-10T12:00:00Z' },
        { ...warm, acquiredTs: '2026-08-09T12:00:00Z' },
      ],
    })!;
    expect(g.ref).toBe('plan-a#P-002');
    expect(g.leaseCold).toBe(false);
  });

  it('falls back to the cold claim when EVERY lease is cold — a cold goal beats no goal', () => {
    const g = resolveAgentGoal({
      planItems: [
        { planSlug: 'plan-a', itemId: 'P-001', leaseValid: false, acquiredTs: '2026-08-09T12:00:00Z' },
        { planSlug: 'plan-a', itemId: 'P-009', leaseValid: false, acquiredTs: '2026-08-10T12:00:00Z' },
      ],
    })!;
    expect(g.ref).toBe('plan-a#P-009'); // newest of the cold set
    expect(g.leaseCold).toBe(true);
  });

  it('stays clock-free: the SAME input gives the SAME answer regardless of when it runs', () => {
    // `leaseCold` is derived from an INPUT boolean, never from a clock read here.
    const input = { planItems: [cold] };
    const a = resolveAgentGoal(input)!;
    const b = resolveAgentGoal(input)!;
    expect(a).toEqual(b);
    expect(a.leaseCold).toBe(true);
  });
});

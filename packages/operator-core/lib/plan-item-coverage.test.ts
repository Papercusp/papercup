/**
 * Unit tests for the pure plan-item coverage classifier + compactor.
 *
 * The PG read (getAllPlanItemCoverage — the coord_links join + fleet view) is
 * covered against real PG by the fleet/plan integration suites. This file pins the
 * I/O-free decision logic the plans:items / fleet:assignments readers depend on:
 * how linked work-items + a direct claim roll up into one coverage level.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCoverage,
  compactCoverage,
  coverageCollisions,
  duplicateCoverage,
  isCoverageDivergent,
  isLiveHeldCoverage,
  COVERAGE_LEVELS,
  LIVE_HELD_COVERAGE_LEVELS,
  type CoverageLevel,
  type CoverageWorkLink,
  type PlanItemCoverage,
} from './plan-item-coverage';
import type { ItemActivity } from './item-activity';

const link = (terminal: boolean, activity: ItemActivity): Pick<CoverageWorkLink, 'terminal' | 'activity'> => ({
  terminal,
  activity,
});

describe('classifyCoverage', () => {
  it('none — no links and no direct claim', () => {
    expect(classifyCoverage([], false)).toBe('none');
  });

  it('full — a bare direct plan-item claim with no links', () => {
    expect(classifyCoverage([], true)).toBe('full');
  });

  it('complete — every linked work-item is terminal (work done)', () => {
    expect(classifyCoverage([link(true, 'free'), link(true, 'free')], false)).toBe('complete');
    // a leftover live claim doesn't matter once all the work is done
    expect(classifyCoverage([link(true, 'free')], true)).toBe('complete');
  });

  it('unclaimed — open links that NO ONE has ever held', () => {
    expect(classifyCoverage([link(false, 'free')], false)).toBe('unclaimed');
    expect(classifyCoverage([link(false, 'free'), link(false, 'free')], false)).toBe('unclaimed');
    // a terminal sibling doesn't make the still-open, never-held link look held
    expect(classifyCoverage([link(true, 'free'), link(false, 'free')], false)).toBe('unclaimed');
  });

  // P-005 (trap-guards-followups-2026-08-01). A claim row can outlive its holder,
  // and so can the work-item ledger's `assignee`. Keep the reclaimable
  // dead/reserved band separate from the live-but-stalled band: a stalled holder
  // has a claim but no item-scoped progress, so plans:items must invite coordination,
  // not reclaim.
  it('held-not-live — open links whose holder is gone or liveness is unknown (RECLAIMABLE)', () => {
    expect(classifyCoverage([link(false, 'dead')], false)).toBe('held-not-live');
    expect(classifyCoverage([link(false, 'reserved')], false)).toBe('held-not-live');
    // one never-held link + one dead-held link ⇒ still a recorded holder to explain
    expect(classifyCoverage([link(false, 'free'), link(false, 'dead')], false)).toBe('held-not-live');
  });

  it('held-stalled — a live holder with stale/missing progress is not a reclaim signal', () => {
    expect(classifyCoverage([link(false, 'stalled')], false)).toBe('held-stalled');
    expect(classifyCoverage([link(false, 'free'), link(false, 'stalled')], false)).toBe('held-stalled');
  });

  it('held-not-live — a DIRECT plan-item claim whose holder died, with no links', () => {
    // The pre-P-005 gap this closes: `directlyClaimed` is already narrowed to LIVE
    // holders by the caller, so a dead direct claim arrived as `false` and read as
    // 'none' — "genuinely unworked" — while a claim row and a holder id sat on it.
    expect(classifyCoverage([], false, 'dead')).toBe('held-not-live');
    expect(classifyCoverage([], false, 'stalled')).toBe('held-stalled');
    expect(classifyCoverage([], false, 'reserved')).toBe('held-not-live');
    // and a dead direct claim over never-held links is still explained by a holder
    expect(classifyCoverage([link(false, 'free')], false, 'dead')).toBe('held-not-live');
  });

  it('none — nothing held it, not even a lapsed claim', () => {
    expect(classifyCoverage([], false, 'free')).toBe('none');
    expect(classifyCoverage([], false, null)).toBe('none');
    expect(classifyCoverage([], false, undefined)).toBe('none');
  });

  it('a live holder still outranks any lapsed one', () => {
    // a live direct claim wins over dead links…
    expect(classifyCoverage([link(false, 'dead')], true)).toBe('partial');
    // …and a live link wins over a dead direct claim
    expect(classifyCoverage([link(false, 'progressing')], false, 'dead')).toBe('full');
    // completion still short-circuits: the work is done, the ghost claim is moot
    expect(classifyCoverage([link(true, 'free')], false, 'dead')).toBe('complete');
  });

  it('full — every still-open linked work-item is live-held', () => {
    expect(classifyCoverage([link(false, 'progressing')], false)).toBe('full');
    expect(classifyCoverage([link(false, 'alive')], false)).toBe('full');
    // a terminal sibling doesn't drag it down — only non-terminal links must be live
    expect(classifyCoverage([link(true, 'free'), link(false, 'progressing')], false)).toBe('full');
  });

  it('partial — some open links live-held, others not', () => {
    expect(classifyCoverage([link(false, 'progressing'), link(false, 'free')], false)).toBe('partial');
    // a direct claim covers the item but an open linked sub-item is still unworked
    expect(classifyCoverage([link(false, 'free')], true)).toBe('partial');
  });

  it('treats stalled as not active coverage without calling the live holder dead', () => {
    // one progressing + one stalled = partial (the stalled one isn't covered)
    expect(classifyCoverage([link(false, 'progressing'), link(false, 'stalled')], false)).toBe('partial');
  });
});

describe('compactCoverage', () => {
  const base: PlanItemCoverage = {
    ref: 'my-plan#P-003',
    links: [
      { workItemId: 'WI-10', rel: 'fixes', terminal: false, activity: 'progressing', holder: 'su-aaa' },
      { workItemId: 'EI-9', rel: 'relates', terminal: true, activity: 'free', holder: null },
    ],
    directlyClaimed: false,
    directHolder: null,
    directActivity: null,
    holder: null,
    level: 'full',
    workers: ['su-aaa'],
    lastActivityAt: null,
  };

  it('projects level + workers + lean links', () => {
    expect(compactCoverage(base)).toEqual({
      level: 'full',
      workers: ['su-aaa'],
      links: [
        { id: 'WI-10', rel: 'fixes', activity: 'progressing', terminal: false },
        { id: 'EI-9', rel: 'relates', activity: 'free', terminal: true },
      ],
    });
  });

  it('omits empty workers + links arrays to keep the payload small', () => {
    const lean: PlanItemCoverage = { ...base, links: [], workers: [], level: 'none' };
    expect(compactCoverage(lean)).toEqual({ level: 'none' });
  });

  it('carries the direct holder + their declared goal (P-029/D-060)', () => {
    // The item's whole point: a reader browsing what is taken sees WHY, without
    // having to attempt a claim and be refused.
    const held: PlanItemCoverage = {
      ...base,
      directlyClaimed: true,
      directHolder: 'su-bbb',
      holder: {
        ownerId: 'su-bbb',
        ownerLabel: 'su · su-bbb',
        goalText: 'Land the auth refactor',
        declaredAt: '2026-07-27T11:58:00.000Z',
        stale: false,
      },
    };
    expect(compactCoverage(held).holder).toEqual({
      ownerId: 'su-bbb',
      ownerLabel: 'su · su-bbb',
      goalText: 'Land the auth refactor',
      declaredAt: '2026-07-27T11:58:00.000Z',
      stale: false,
    });
  });

  it('omits `holder` entirely when nothing is directly claimed — but never drops the row', () => {
    // D-056: an absent holder must not be inferable as a missing ROW, or peer
    // visibility leaks through the shape of the list.
    const out = compactCoverage(base);
    expect('holder' in out).toBe(false);
    expect(out.level).toBe('full');
  });
});

describe('isCoverageDivergent (EI-18679411140143743)', () => {
  it('flags the reported shape: every linked work-item done but the plan item is still todo', () => {
    expect(isCoverageDivergent('todo', 'complete')).toBe(true);
  });

  it('flags wip / blocked / needs-human the same way — any non-terminal status', () => {
    expect(isCoverageDivergent('wip', 'complete')).toBe(true);
    expect(isCoverageDivergent('blocked', 'complete')).toBe(true);
    expect(isCoverageDivergent('needs-human', 'complete')).toBe(true);
  });

  it('not diverged once the plan item itself lands done or dropped', () => {
    expect(isCoverageDivergent('done', 'complete')).toBe(false);
    expect(isCoverageDivergent('dropped', 'complete')).toBe(false);
  });

  it('not diverged for any non-complete coverage level, regardless of status', () => {
    expect(isCoverageDivergent('todo', 'none')).toBe(false);
    expect(isCoverageDivergent('todo', 'unclaimed')).toBe(false);
    expect(isCoverageDivergent('todo', 'partial')).toBe(false);
    expect(isCoverageDivergent('todo', 'full')).toBe(false);
  });
});

describe('coverageCollisions (EI-6074)', () => {
  /** Build a PlanItemCoverage with a direct claim + linked live work-items. */
  const cov = (
    over: Partial<PlanItemCoverage> & { ref: string },
  ): PlanItemCoverage => ({
    links: [],
    directlyClaimed: false,
    directHolder: null,
    directActivity: null,
    holder: null,
    level: 'none',
    workers: [],
    lastActivityAt: null,
    ...over,
  });

  const liveLink = (workItemId: string, holder: string): CoverageWorkLink => ({
    workItemId,
    rel: 'relates',
    terminal: false,
    activity: 'progressing',
    holder,
  });

  it('flags the reported case: a direct plan-item claim + a linked live work-item held by a DIFFERENT principal', () => {
    // The exact EI-6074 shape: bee-A holds the P-004 plan-item claim ("Implement
    // WI-1347"), bee-B is actively implementing the linked WI-1347.
    const map = [
      cov({
        ref: 'presence-coord-unification#P-004',
        directlyClaimed: true,
        directHolder: 's-A',
        directActivity: 'alive',
        links: [liveLink('WI-1347', 's-B')],
        level: 'full',
        workers: ['s-A', 's-B'],
      }),
    ];
    expect(coverageCollisions(map)).toEqual([
      {
        ref: 'presence-coord-unification#P-004',
        directHolder: 's-A',
        workItemHolders: [{ workItemId: 'WI-1347', holder: 's-B' }],
        principals: ['s-A', 's-B'],
      },
    ]);
  });

  it('no collision when the SAME principal holds the direct claim and its linked work-item', () => {
    const map = [
      cov({
        ref: 'p#P-1',
        directlyClaimed: true,
        directHolder: 's-A',
        directActivity: 'progressing',
        links: [liveLink('WI-9', 's-A')],
        level: 'full',
        workers: ['s-A'],
      }),
    ];
    expect(coverageCollisions(map)).toEqual([]);
  });

  it('no collision for legitimate parallel decomposition — several distinct linked work-items, NO direct plan-item claim', () => {
    // Two bees on two DIFFERENT work-items under one plan item is parallel work,
    // not a duplicate: without a direct plan-item claim there is no cross-table dup.
    const map = [
      cov({
        ref: 'p#P-2',
        directlyClaimed: false,
        directHolder: null,
        links: [liveLink('WI-1', 's-A'), liveLink('WI-2', 's-B')],
        level: 'full',
        workers: ['s-A', 's-B'],
      }),
    ];
    expect(coverageCollisions(map)).toEqual([]);
  });

  it('no collision when the linked work-item is stalled/dead (holder null — reclaimable, not a live duplicate)', () => {
    const map = [
      cov({
        ref: 'p#P-3',
        directlyClaimed: true,
        directHolder: 's-A',
        directActivity: 'alive',
        // getAllPlanItemCoverage leaves holder null for a non-live (stalled/dead) link.
        links: [{ workItemId: 'WI-3', rel: 'relates', terminal: false, activity: 'stalled', holder: null }],
        level: 'partial',
        workers: ['s-A'],
      }),
    ];
    expect(coverageCollisions(map)).toEqual([]);
  });

  it('collects distinct principals across multiple colliding links + dedups the direct holder', () => {
    const map = [
      cov({
        ref: 'p#P-4',
        directlyClaimed: true,
        directHolder: 's-A',
        directActivity: 'alive',
        links: [liveLink('WI-1', 's-B'), liveLink('WI-2', 's-C'), liveLink('WI-3', 's-A')],
        level: 'full',
        workers: ['s-A', 's-B', 's-C'],
      }),
    ];
    // s-A's own linked work-item is NOT a collision; s-B and s-C are.
    expect(coverageCollisions(map)).toEqual([
      {
        ref: 'p#P-4',
        directHolder: 's-A',
        workItemHolders: [
          { workItemId: 'WI-1', holder: 's-B' },
          { workItemId: 'WI-2', holder: 's-C' },
        ],
        principals: ['s-A', 's-B', 's-C'],
      },
    ]);
  });

  it('empty coverage map → no collisions', () => {
    expect(coverageCollisions([])).toEqual([]);
  });
});

describe('duplicateCoverage (EI-21188799646985672)', () => {
  const cov = (
    over: Partial<PlanItemCoverage> & { ref: string },
  ): PlanItemCoverage => ({
    links: [],
    directlyClaimed: false,
    directHolder: null,
    directActivity: null,
    holder: null,
    level: 'none',
    workers: [],
    lastActivityAt: null,
    ...over,
  });

  const liveLink = (workItemId: string, holder: string, terminal = false): CoverageWorkLink => ({
    workItemId,
    rel: 'relates',
    terminal,
    activity: terminal ? 'free' : 'progressing',
    holder: terminal ? null : holder,
  });

  it('flags two distinct live linked work-items held by the same principal', () => {
    expect(
      duplicateCoverage([
        cov({
          ref: 'plan#P-007',
          links: [liveLink('WI-1', 'su-A'), liveLink('WI-2', 'su-A')],
        }),
      ]),
    ).toEqual([{ ref: 'plan#P-007', holder: 'su-A', workItemIds: ['WI-1', 'WI-2'] }]);
  });

  it('deduplicates repeated edges and ignores terminal links, direct claims, and different holders', () => {
    expect(
      duplicateCoverage([
        cov({
          ref: 'plan#P-008',
          directlyClaimed: true,
          directHolder: 'su-A',
          links: [
            liveLink('WI-1', 'su-A'),
            { ...liveLink('WI-1', 'su-A'), rel: 'fixes' },
            liveLink('WI-done', 'su-A', true),
            liveLink('WI-2', 'su-B'),
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it('does not treat stalled/dead links as live duplicate coverage', () => {
    expect(
      duplicateCoverage([
        cov({
          ref: 'plan#P-009',
          links: [
            { workItemId: 'WI-stalled', rel: 'relates', terminal: false, activity: 'stalled', holder: null },
            { workItemId: 'WI-dead', rel: 'relates', terminal: false, activity: 'dead', holder: null },
          ],
        }),
      ]),
    ).toEqual([]);
  });
});

/**
 * EI-22174704695369849 — `plans:items { actionable: true }` offered an item that
 * the SAME result object reported as `working: 'partial'`: held and actively
 * edited by a live peer (measured 2026-09-02, plan silent-wrong-answers-2026-08-01,
 * item P-023, holder su-da016d95 `sessionState: live`).
 *
 * The filter is deliberately NARROW. Every band it does not withhold is one a
 * caller may legitimately pick, and over-withholding trades this bug for the
 * strictly worse inverse — EI-20043747805764486, where `actionable` returned `[]`
 * while items were pickable, reading as a drained plan. So the exhaustive map
 * below is the real assertion: a NEW coverage band cannot silently default into
 * "pickable" (or into "withheld"); adding one fails this test until it is
 * classified on purpose.
 */
describe('isLiveHeldCoverage — the actionable floor', () => {
  /** Every band, classified explicitly. Keys are pinned to COVERAGE_LEVELS below. */
  const EXPECTED: Record<CoverageLevel, boolean> = {
    none: false, // nobody ever took it
    unclaimed: false, // filed, never taken
    'held-not-live': false, // holder dead/unknown — documented as THE reclaimable band
    'held-stalled': false, // live holder, no progress; item-activity's reaper auto-frees these
    partial: true, // ← the measured incident
    full: true, // every open link live-held
    complete: false, // work is done; hiding it would be the auto-heal isCoverageDivergent refuses
  };

  it('classifies EVERY band in COVERAGE_LEVELS — a new band must be decided, not defaulted', () => {
    // Both directions: no band missing from the map, and no stale key left in it.
    expect(Object.keys(EXPECTED).sort()).toEqual([...COVERAGE_LEVELS].sort());
  });

  for (const level of COVERAGE_LEVELS) {
    it(`${level} → ${EXPECTED[level] ? 'WITHHELD from actionable' : 'still offered'}`, () => {
      expect(isLiveHeldCoverage(level)).toBe(EXPECTED[level]);
    });
  }

  /**
   * Calibration control, kept permanently: a predicate that is accidentally
   * always-false (the pre-fix behaviour — the filter consulted nothing) or
   * always-true (which would drain every plan) would satisfy a suite that only
   * ever asserted one polarity. This states the requirement directly, so these
   * tests cannot quietly degrade into asserting a constant.
   */
  it('is not a constant — it both withholds and offers at least one real band', () => {
    const withheld = COVERAGE_LEVELS.filter((l) => isLiveHeldCoverage(l));
    const offered = COVERAGE_LEVELS.filter((l) => !isLiveHeldCoverage(l));
    expect(withheld.length).toBeGreaterThan(0);
    expect(offered.length).toBeGreaterThan(0);
    expect(withheld).toEqual([...LIVE_HELD_COVERAGE_LEVELS]);
  });

  it('treats a missing coverage entry as offerable — no coverage is not a claim', () => {
    // An item with no coverage row at all is the ordinary unworked case. Failing
    // this open is what keeps a coverage-read outage from draining every plan
    // (getAllPlanItemCoverage is non-fatal in items.ts and degrades to no overlay).
    expect(isLiveHeldCoverage(null)).toBe(false);
    expect(isLiveHeldCoverage(undefined)).toBe(false);
  });

  it('withholds the measured incident: a live-held link beside an open one (P-023)', () => {
    // One open link held by a live peer + one open link nobody is on → 'partial'.
    const level = classifyCoverage([link(false, 'progressing'), link(false, 'free')], false);
    expect(level).toBe('partial');
    expect(isLiveHeldCoverage(level)).toBe(true);
  });

  it('withholds a bare direct plan-item claim by a live holder', () => {
    const level = classifyCoverage([], true);
    expect(level).toBe('full');
    expect(isLiveHeldCoverage(level)).toBe(true);
  });

  it('KEEPS offering an item whose holder died — the reclaimable band', () => {
    const level = classifyCoverage([link(false, 'dead')], false);
    expect(level).toBe('held-not-live');
    expect(isLiveHeldCoverage(level)).toBe(false);
  });

  it('KEEPS offering a stalled holder — the claim reaper re-surfaces these', () => {
    // item-activity's isReclaimable() counts 'stalled' as auto-freeable, so
    // withholding it would suppress work the system is in the middle of freeing.
    const level = classifyCoverage([link(false, 'stalled')], false);
    expect(level).toBe('held-stalled');
    expect(isLiveHeldCoverage(level)).toBe(false);
  });

  it('KEEPS offering an untouched item — the ordinary pickable case', () => {
    expect(isLiveHeldCoverage(classifyCoverage([], false))).toBe(false);
    expect(isLiveHeldCoverage(classifyCoverage([link(false, 'free')], false))).toBe(false);
  });
});

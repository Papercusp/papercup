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

  it('unclaimed — open links but nobody live on them', () => {
    expect(classifyCoverage([link(false, 'free')], false)).toBe('unclaimed');
    // stalled / dead claims are reclaimable → NOT covered
    expect(classifyCoverage([link(false, 'stalled')], false)).toBe('unclaimed');
    expect(classifyCoverage([link(false, 'dead')], false)).toBe('unclaimed');
    expect(classifyCoverage([link(false, 'reserved')], false)).toBe('unclaimed');
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

  it('treats stalled/dead exactly like the fleet view: not live → drops coverage', () => {
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
    level: 'full',
    workers: ['su-aaa'],
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
    level: 'none',
    workers: [],
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

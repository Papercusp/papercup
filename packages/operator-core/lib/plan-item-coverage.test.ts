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

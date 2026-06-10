/**
 * Unit coverage for plan-sorting.ts — the `pSort` comparator family the
 * rail applies (selected-plan pinning is PlanRail's, not tested here).
 *
 * Pins the two invariants that are easy to regress:
 *   1. `default` reproduces PlanRail's original smart order exactly
 *      (buckets → running-priority → updated desc).
 *   2. Missing values (no date / no priority / no items) sort LAST in
 *      every order and direction — never first.
 */
import { describe, expect, it } from 'vitest';
import type { PlanListRow } from './plans-api';
import { comparePlans, planProgress, PLAN_SORTS, PLAN_SORT_IDS } from './plan-sorting';

function row(slug: string, over: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug,
    title: slug,
    status: 'draft',
    updated: null,
    created: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'papercup',
    startStatus: null,
    priority: null,
    ...over,
  };
}

const slugsBy = (sort: Parameters<typeof comparePlans>[0], rows: PlanListRow[]) =>
  [...rows].sort(comparePlans(sort)).map((r) => r.slug);

describe('PLAN_SORTS', () => {
  it('ids list matches the option list (the nuqs enum is derived from it)', () => {
    expect(PLAN_SORT_IDS).toEqual(PLAN_SORTS.map((s) => s.id));
    expect(new Set(PLAN_SORT_IDS).size).toBe(PLAN_SORT_IDS.length);
  });
});

describe('comparePlans(default) — the original smart order', () => {
  it('orders buckets running → ready → draft → shipped → rejected', () => {
    const rows = [
      row('shipped', { status: 'shipped' }),
      row('draft', { status: 'draft' }),
      row('running', { status: 'active', startStatus: 'started' }),
      row('rejected', { status: 'superseded' }),
      row('ready', { status: 'ready' }),
    ];
    expect(slugsBy('default', rows)).toEqual([
      'running',
      'ready',
      'draft',
      'shipped',
      'rejected',
    ]);
  });

  it('within running: explicit priority first (lower wins), null priority last', () => {
    const rows = [
      row('no-prio', { status: 'active', startStatus: 'started', updated: '2026-06-09' }),
      row('p2', { status: 'active', startStatus: 'started', priority: 2 }),
      row('p1', { status: 'active', startStatus: 'started', priority: 1 }),
    ];
    expect(slugsBy('default', rows)).toEqual(['p1', 'p2', 'no-prio']);
  });

  it('falls back to updated desc, undated last', () => {
    const rows = [
      row('old', { updated: '2026-01-01' }),
      row('undated'),
      row('new', { updated: '2026-06-01' }),
    ];
    expect(slugsBy('default', rows)).toEqual(['new', 'old', 'undated']);
  });
});

describe('date sorts', () => {
  const rows = [
    row('mid', { updated: '2026-03-01', created: '2026-02-01' }),
    row('new', { updated: '2026-06-01', created: '2026-05-01' }),
    row('undated'),
    row('old', { updated: '2026-01-01', created: '2026-01-01' }),
  ];

  it('updated-desc: newest first, undated last', () => {
    expect(slugsBy('updated-desc', rows)).toEqual(['new', 'mid', 'old', 'undated']);
  });

  it('updated-asc: oldest first, undated STILL last (unknown ≠ oldest)', () => {
    expect(slugsBy('updated-asc', rows)).toEqual(['old', 'mid', 'new', 'undated']);
  });

  it('created-desc / created-asc sort on the created date', () => {
    expect(slugsBy('created-desc', rows)).toEqual(['new', 'mid', 'old', 'undated']);
    expect(slugsBy('created-asc', rows)).toEqual(['old', 'mid', 'new', 'undated']);
  });

  it('tolerates rows from a server predating `created` (undefined ≡ null)', () => {
    const legacy = { ...row('legacy', { updated: '2026-04-01' }) } as PlanListRow & {
      created?: string | null;
    };
    delete (legacy as { created?: string | null }).created;
    expect(slugsBy('created-desc', [legacy, row('dated', { created: '2026-01-01' })])).toEqual([
      'dated',
      'legacy',
    ]);
  });
});

describe('priority sort', () => {
  it('lower rank first, unranked last regardless of recency', () => {
    const rows = [
      row('unranked', { updated: '2026-06-09' }),
      row('p3', { priority: 3 }),
      row('p1', { priority: 1 }),
    ];
    expect(slugsBy('priority', rows)).toEqual(['p1', 'p3', 'unranked']);
  });
});

describe('progress sort', () => {
  it('planProgress mirrors the progress bar (done / all items incl. dropped)', () => {
    expect(planProgress(null)).toBeNull();
    expect(planProgress({})).toBeNull();
    expect(planProgress({ done: 3, todo: 1 })).toBe(0.75);
    expect(planProgress({ done: 1, dropped: 1 })).toBe(0.5);
  });

  it('closest-to-done first, item-less plans last', () => {
    const rows = [
      row('empty'),
      row('half', { itemCounts: { done: 1, todo: 1 } }),
      row('done', { itemCounts: { done: 4 } }),
      row('fresh', { itemCounts: { todo: 5 } }),
    ];
    expect(slugsBy('progress', rows)).toEqual(['done', 'half', 'fresh', 'empty']);
  });
});

describe('title sort', () => {
  it('case-insensitive A–Z, falling back to slug for untitled plans', () => {
    const rows = [
      row('z-slug', { title: 'alpha' }),
      row('beta-slug', { title: null }),
      row('a-slug', { title: 'Gamma' }),
    ];
    expect(slugsBy('title', rows)).toEqual(['z-slug', 'beta-slug', 'a-slug']);
  });
});

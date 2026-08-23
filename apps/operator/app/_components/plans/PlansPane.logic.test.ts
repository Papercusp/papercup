// PlansPane pure logic (owner-plans-single-pane-2026-07-17 P-002/P-007):
// buildGlanceRows (active-only filter, search, needs-you-then-recency sort),
// progressOf (item done/total), agoLabel (compact recency). No jsdom / no
// mocks — pure functions, the highest-value least-brittle coverage.
import { describe, expect, it } from 'vitest';
import {
  buildGlanceRows,
  progressOf,
  agoLabel,
  agoLabelMs,
  isStale,
  STALE_MS,
  PLANS_PANE_SORTS,
  PLANS_PANE_SORT_IDS,
  DEFAULT_PLANS_PANE_SORT,
  plansPaneSortLabel,
} from './PlansPane';
import type { PlanListRow } from '@/app/admin/plans/plans-api';

/** Minimal PlanListRow factory — only the fields the pure logic reads. */
function plan(over: Partial<PlanListRow> & { slug: string }): PlanListRow {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    status: over.status ?? 'active',
    updated: over.updated,
    created: over.created,
    archived: over.archived ?? false,
    isLegacy: over.isLegacy ?? false,
    itemCounts: over.itemCounts,
    harness: over.harness ?? 'papercusp',
    startStatus: over.startStatus,
    triggered: over.triggered,
    triggerSources: over.triggerSources,
  } as PlanListRow;
}

const EMPTY = new Map<string, number>();

describe('buildGlanceRows', () => {
  it('keeps only active buckets by default (draft/ready/running), hides shipped/superseded', () => {
    const plans = [
      plan({ slug: 'a-draft', status: 'draft' }),
      plan({ slug: 'b-active', status: 'active', startStatus: 'started' }),
      plan({ slug: 'c-shipped', status: 'shipped' }),
      plan({ slug: 'd-superseded', status: 'superseded' }),
    ];
    const rows = buildGlanceRows({ plans, query: '', showFinished: false, needsYouByPlan: EMPTY, liveByPlan: EMPTY });
    expect(rows.map((r) => r.plan.slug).sort()).toEqual(['a-draft', 'b-active']);
  });

  it('includes finished plans when showFinished is set', () => {
    const plans = [
      plan({ slug: 'b-active', status: 'active' }),
      plan({ slug: 'c-shipped', status: 'shipped' }),
    ];
    const rows = buildGlanceRows({ plans, query: '', showFinished: true, needsYouByPlan: EMPTY, liveByPlan: EMPTY });
    expect(rows.map((r) => r.plan.slug).sort()).toEqual(['b-active', 'c-shipped']);
  });

  it('always drops archived + legacy plans, even with showFinished', () => {
    const plans = [
      plan({ slug: 'keep', status: 'active' }),
      plan({ slug: 'arch', status: 'active', archived: true }),
      plan({ slug: 'leg', status: 'active', isLegacy: true }),
    ];
    const rows = buildGlanceRows({ plans, query: '', showFinished: true, needsYouByPlan: EMPTY, liveByPlan: EMPTY });
    expect(rows.map((r) => r.plan.slug)).toEqual(['keep']);
  });

  it('filters by search across title and slug (case-insensitive)', () => {
    const plans = [
      plan({ slug: 'inbox-single-pane', title: 'Unified owner Inbox' }),
      plan({ slug: 'plans-tab', title: 'Plans tracking' }),
    ];
    expect(
      buildGlanceRows({ plans, query: 'INBOX', showFinished: false, needsYouByPlan: EMPTY, liveByPlan: EMPTY }).map((r) => r.plan.slug),
    ).toEqual(['inbox-single-pane']);
    // matches on title text too
    expect(
      buildGlanceRows({ plans, query: 'tracking', showFinished: false, needsYouByPlan: EMPTY, liveByPlan: EMPTY }).map((r) => r.plan.slug),
    ).toEqual(['plans-tab']);
  });

  it('sorts needs-you desc, then most-recently-updated', () => {
    const plans = [
      plan({ slug: 'old-hot', status: 'active', updated: '2026-07-10T00:00:00Z' }),
      plan({ slug: 'new-cold', status: 'active', updated: '2026-07-17T00:00:00Z' }),
      plan({ slug: 'new-hot', status: 'active', updated: '2026-07-16T00:00:00Z' }),
    ];
    const needs = new Map<string, number>([
      ['old-hot', 2],
      ['new-hot', 5],
    ]);
    const rows = buildGlanceRows({ plans, query: '', showFinished: false, needsYouByPlan: needs, liveByPlan: EMPTY });
    // new-hot (5) > old-hot (2) > new-cold (0); ties broken by recency
    expect(rows.map((r) => r.plan.slug)).toEqual(['new-hot', 'old-hot', 'new-cold']);
  });

  it('decorates each row with its needs-you and live-agent counts (0 when absent)', () => {
    const plans = [plan({ slug: 'p1', status: 'active' }), plan({ slug: 'p2', status: 'active' })];
    const rows = buildGlanceRows({
      plans,
      query: '',
      showFinished: false,
      needsYouByPlan: new Map([['p1', 3]]),
      liveByPlan: new Map([['p1', 1], ['p2', 2]]),
    });
    const byslug = Object.fromEntries(rows.map((r) => [r.plan.slug, r]));
    expect(byslug.p1.needsYou).toBe(3);
    expect(byslug.p1.liveAgents).toBe(1);
    expect(byslug.p2.needsYou).toBe(0);
    expect(byslug.p2.liveAgents).toBe(2);
  });

  it('filters the derived one-time / triggered classification without changing the active-bucket rules', () => {
    const plans = [
      plan({ slug: 'plain', status: 'active', triggered: false }),
      plan({ slug: 'event', status: 'active', triggered: true }),
      plan({ slug: 'old-server', status: 'active' }),
    ];
    const common = { plans, query: '', showFinished: false, needsYouByPlan: EMPTY, liveByPlan: EMPTY };
    expect(buildGlanceRows({ ...common, triggerFilter: 'triggered' }).map((r) => r.plan.slug)).toEqual(['event']);
    expect(buildGlanceRows({ ...common, triggerFilter: 'one-time' }).map((r) => r.plan.slug).sort()).toEqual([
      'old-server',
      'plain',
    ]);
  });
});

describe('plan sort orders (WI-40982)', () => {
  const plans = [
    plan({ slug: 'alpha', title: 'Alpha', updated: '2026-08-01T00:00:00Z', created: '2026-01-01', itemCounts: { done: 1, todo: 9 } }),
    plan({ slug: 'bravo', title: 'Bravo', updated: '2026-08-03T00:00:00Z', created: '2026-03-01', itemCounts: { done: 9, todo: 1 } }),
    plan({ slug: 'charlie', title: 'Charlie', updated: '2026-08-02T00:00:00Z', created: '2026-02-01', itemCounts: { done: 5, todo: 5 } }),
  ];
  const needs = new Map<string, number>([['alpha', 3]]);
  const live = new Map<string, number>([['charlie', 4], ['alpha', 1]]);
  const base = { plans, query: '', showFinished: false, needsYouByPlan: needs, liveByPlan: live };
  const order = (sort?: Parameters<typeof buildGlanceRows>[0]['sort']) =>
    buildGlanceRows({ ...base, sort }).map((r) => r.plan.slug);

  it('defaults to needs-you first, then most recently updated', () => {
    // Omitting `sort` and passing the default id must be the SAME order — the
    // pane relies on that equivalence when it clears ?plSort back to null.
    expect(order()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(order(DEFAULT_PLANS_PANE_SORT)).toEqual(order());
  });

  it('ranks busiest plans first under "live", tie-breaking on needs-you', () => {
    expect(order('live')).toEqual(['charlie', 'alpha', 'bravo']);
  });

  it('orders by activity in both directions', () => {
    expect(order('updated-desc')).toEqual(['bravo', 'charlie', 'alpha']);
    expect(order('updated-asc')).toEqual(['alpha', 'charlie', 'bravo']);
  });

  it('orders by creation date and by title', () => {
    expect(order('created-desc')).toEqual(['bravo', 'charlie', 'alpha']);
    expect(order('title')).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('orders by completion fraction, closest to done first', () => {
    expect(order('progress')).toEqual(['bravo', 'charlie', 'alpha']);
  });

  it('SORTS THE FILTERED SET — no order can re-admit a row the filters dropped', () => {
    // The owner's contract: sort acts on the current result set, after filters.
    // Asserting it for EVERY order (not one sampled order) is the point — a
    // comparator that reached past the filter would show up on exactly one id.
    for (const id of PLANS_PANE_SORT_IDS) {
      const rows = buildGlanceRows({ ...base, query: 'bravo', sort: id });
      expect(rows.map((r) => r.plan.slug), `sort=${id}`).toEqual(['bravo']);
    }
    // …and the finished filter likewise stays authoritative under every order.
    const withShipped = [...plans, plan({ slug: 'shipped-one', status: 'shipped', updated: '2026-08-09T00:00:00Z' })];
    for (const id of PLANS_PANE_SORT_IDS) {
      const slugs = buildGlanceRows({ ...base, plans: withShipped, sort: id }).map((r) => r.plan.slug);
      expect(slugs, `sort=${id}`).not.toContain('shipped-one');
    }
  });

  it('exposes a label for every offered order, and no duplicate ids', () => {
    expect(new Set(PLANS_PANE_SORT_IDS).size).toBe(PLANS_PANE_SORT_IDS.length);
    expect(PLANS_PANE_SORT_IDS).toContain(DEFAULT_PLANS_PANE_SORT);
    for (const s of PLANS_PANE_SORTS) {
      expect(plansPaneSortLabel(s.id)).toBe(s.label);
      expect(s.label.trim()).not.toBe('');
    }
  });
});

describe('progressOf', () => {
  it('returns done/total from itemCounts, excluding "unknown"', () => {
    expect(progressOf({ itemCounts: { done: 3, todo: 2, wip: 1, unknown: 9 } })).toEqual({ done: 3, total: 6 });
  });
  it('returns null when there are no counted items', () => {
    expect(progressOf({ itemCounts: undefined })).toBeNull();
    expect(progressOf({ itemCounts: { unknown: 4 } })).toBeNull();
  });
});

describe('isStale (dual-clock — plan-visibility-revamp P-002 / D-003)', () => {
  const now = Date.parse('2026-07-17T00:00:00Z');
  it('flags an active plan when NEITHER clock moved for ≥14d', () => {
    expect(isStale({ updated: '2026-07-01T00:00:00Z', now })).toBe(true); // 16d, never worked
    expect(isStale({ updated: '2026-07-10T00:00:00Z', now })).toBe(false); // 7d
    expect(isStale({ updated: null, now })).toBe(false);
    expect(isStale({ updated: 'not-a-date', now })).toBe(false);
    expect(isStale({ now })).toBe(false); // no clocks at all → never stale
  });
  it('recent WORK keeps an unedited plan un-stale (the D-003 false-positive fix)', () => {
    const oldEdit = '2026-06-01T00:00:00Z'; // 46d before `now`
    expect(isStale({ updated: oldEdit, lastWorkAtMs: now - 3_600_000, now })).toBe(false);
    // …and work alone going stale still reads stale when the edit is old too.
    expect(isStale({ updated: oldEdit, lastWorkAtMs: now - STALE_MS - 1, now })).toBe(true);
    // work clock with NO edit clock at all
    expect(isStale({ lastWorkAtMs: now - 3_600_000, now })).toBe(false);
    expect(isStale({ lastWorkAtMs: now - STALE_MS - 1, now })).toBe(true);
  });
  it('a recent EDIT keeps a long-unworked plan un-stale (symmetric)', () => {
    expect(
      isStale({ updated: new Date(now - 3_600_000).toISOString(), lastWorkAtMs: now - STALE_MS * 3, now }),
    ).toBe(false);
  });
  it('uses a 14-day threshold over the NEWEST clock', () => {
    expect(STALE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(isStale({ updated: new Date(now - STALE_MS - 1).toISOString(), now })).toBe(true);
    expect(isStale({ updated: new Date(now - STALE_MS + 60_000).toISOString(), now })).toBe(false);
  });
});

describe('agoLabel', () => {
  it('formats recency compactly and guards bad input', () => {
    const now = Date.now();
    expect(agoLabel(null)).toBe('—');
    expect(agoLabel(new Date(now - 30_000).toISOString())).toBe('now');
    expect(agoLabel(new Date(now - 5 * 60_000).toISOString())).toBe('5m');
    expect(agoLabel(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h');
    expect(agoLabel(new Date(now - 5 * 86_400_000).toISOString())).toBe('5d');
    expect(agoLabel('not-a-date')).toBe('—');
  });
});

describe('agoLabelMs (the planWorkActivity.list epoch-ms form)', () => {
  const now = Date.parse('2026-07-17T00:00:00Z');
  it('matches agoLabel buckets over epoch ms', () => {
    expect(agoLabelMs(now - 30_000, now)).toBe('now');
    expect(agoLabelMs(now - 5 * 60_000, now)).toBe('5m');
    expect(agoLabelMs(now - 3 * 3_600_000, now)).toBe('3h');
    expect(agoLabelMs(now - 5 * 86_400_000, now)).toBe('5d');
  });
  it('renders the em-dash for absent / junk values', () => {
    expect(agoLabelMs(null, now)).toBe('—');
    expect(agoLabelMs(undefined, now)).toBe('—');
    expect(agoLabelMs(Number.NaN, now)).toBe('—');
    expect(agoLabelMs(now + 60_000, now)).toBe('—'); // future = clock skew, not "-1m"
  });
});

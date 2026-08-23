// PlansPane pure logic (owner-plans-single-pane-2026-07-17 P-002/P-007):
// buildGlanceRows (active-only filter, search, needs-you-then-recency sort),
// progressOf (item done/total), agoLabel (compact recency). No jsdom / no
// mocks — pure functions, the highest-value least-brittle coverage.
import { describe, expect, it } from 'vitest';
import { buildGlanceRows, progressOf, agoLabel, isStale, STALE_MS } from './PlansPane';
import type { PlanListRow } from '@/app/admin/plans/plans-api';

/** Minimal PlanListRow factory — only the fields the pure logic reads. */
function plan(over: Partial<PlanListRow> & { slug: string }): PlanListRow {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    status: over.status ?? 'active',
    updated: over.updated,
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

describe('progressOf', () => {
  it('returns done/total from itemCounts, excluding "unknown"', () => {
    expect(progressOf({ itemCounts: { done: 3, todo: 2, wip: 1, unknown: 9 } })).toEqual({ done: 3, total: 6 });
  });
  it('returns null when there are no counted items', () => {
    expect(progressOf({ itemCounts: undefined })).toBeNull();
    expect(progressOf({ itemCounts: { unknown: 4 } })).toBeNull();
  });
});

describe('isStale', () => {
  const now = Date.parse('2026-07-17T00:00:00Z');
  it('flags an active plan with no activity for ≥14d', () => {
    expect(isStale('2026-07-01T00:00:00Z', now)).toBe(true); // 16d
    expect(isStale('2026-07-10T00:00:00Z', now)).toBe(false); // 7d
    expect(isStale(null, now)).toBe(false);
    expect(isStale('not-a-date', now)).toBe(false);
  });
  it('uses a 14-day threshold', () => {
    expect(STALE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(isStale(new Date(now - STALE_MS - 1).toISOString(), now)).toBe(true);
    expect(isStale(new Date(now - STALE_MS + 60_000).toISOString(), now)).toBe(false);
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

/**
 * Unit coverage for the lifecycle bucketing + shared filter predicate
 * that back the Plans-tab status tabs.
 *
 *  - `bucketOf` (plans-api): total function — every plan maps to exactly
 *    one of draft / ready / running / shipped / rejected, with terminal
 *    statuses winning over the operational started-state.
 *  - `applyPlanFilters` (plan-filtering): the search/filter predicate the
 *    rail and the tab count-badges share; it must NOT filter by bucket.
 */
import { describe, expect, it } from 'vitest';
import { bucketOf, type PlanListRow, type PlanStartStatus } from './plans-api';
import { applyPlanFilters, type PlanFilterState } from './plan-filtering';

function row(overrides: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug: 'demo-plan',
    title: 'Demo Plan',
    status: 'draft',
    updated: '2026-05-20',
    created: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'papercup',
    startStatus: null,
    priority: null,
    maxImportance: null,
    ...overrides,
  };
}

const NO_FILTERS: PlanFilterState = {
  date: null,
  owner: null,
  archived: false,
  legacy: false,
  inbox: false,
  actionable: false,
};

describe('bucketOf', () => {
  it('maps the forward lifecycle', () => {
    expect(bucketOf(row({ status: 'draft' }))).toBe('draft');
    expect(bucketOf(row({ status: 'ready' }))).toBe('ready');
    expect(bucketOf(row({ status: 'ready', startStatus: 'started' }))).toBe('running');
    expect(bucketOf(row({ status: 'shipped' }))).toBe('shipped');
    expect(bucketOf(row({ status: 'superseded' }))).toBe('rejected');
  });

  it('treats legacy `active` as approved (ready, or running once started)', () => {
    expect(bucketOf(row({ status: 'active' }))).toBe('ready');
    expect(bucketOf(row({ status: 'active', startStatus: 'started' }))).toBe('running');
  });

  it('blocked / unhandled statuses fold into draft', () => {
    expect(bucketOf(row({ status: 'blocked' }))).toBe('draft');
  });

  it('terminal status wins over the started-state (precedence)', () => {
    // A shipped or rejected plan that still carries startStatus:'started'
    // must bucket as shipped/rejected, never running.
    expect(bucketOf(row({ status: 'shipped', startStatus: 'started' }))).toBe('shipped');
    expect(bucketOf(row({ status: 'superseded', startStatus: 'started' }))).toBe('rejected');
  });

  it('paused (not started) approved plan is ready, not running', () => {
    expect(bucketOf(row({ status: 'ready', startStatus: 'paused' as PlanStartStatus }))).toBe('ready');
  });
});

describe('applyPlanFilters', () => {
  it('does NOT filter by bucket/status — every status survives a no-op filter', () => {
    const plans = [
      row({ slug: 'a', status: 'draft' }),
      row({ slug: 'b', status: 'ready' }),
      row({ slug: 'c', status: 'shipped' }),
      row({ slug: 'd', status: 'superseded' }),
    ];
    expect(applyPlanFilters(plans, NO_FILTERS, '').map((p) => p.slug)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hides archived plans by default, shows only archived when toggled', () => {
    const plans = [row({ slug: 'live', archived: false }), row({ slug: 'old', archived: true })];
    expect(applyPlanFilters(plans, NO_FILTERS, '').map((p) => p.slug)).toEqual(['live']);
    expect(
      applyPlanFilters(plans, { ...NO_FILTERS, archived: true }, '').map((p) => p.slug),
    ).toEqual(['old']);
  });

  it('search matches title, slug, or a server-side body hit', () => {
    const plans = [
      row({ slug: 'auth-rework', title: 'Auth rework' }),
      row({ slug: 'billing', title: 'Billing' }),
      row({ slug: 'mem0-recall', title: 'Memory recall' }),
    ];
    expect(applyPlanFilters(plans, NO_FILTERS, 'auth').map((p) => p.slug)).toEqual(['auth-rework']);
    expect(applyPlanFilters(plans, NO_FILTERS, 'billing').map((p) => p.slug)).toEqual(['billing']);
    // body-only hit surfaced via searchHitSlugs
    expect(
      applyPlanFilters(plans, NO_FILTERS, 'engram', new Set(['mem0-recall'])).map((p) => p.slug),
    ).toEqual(['mem0-recall']);
  });

  it('inbox/actionable filter on item counts; owner filters exactly', () => {
    const plans = [
      row({ slug: 'has-human', itemCounts: { 'needs-human': 2 }, owner: 'a@x.com' }),
      row({ slug: 'has-todo', itemCounts: { todo: 1 }, owner: 'b@x.com' }),
      row({ slug: 'empty', itemCounts: {}, owner: 'a@x.com' }),
    ];
    expect(applyPlanFilters(plans, { ...NO_FILTERS, inbox: true }, '').map((p) => p.slug)).toEqual(['has-human']);
    expect(applyPlanFilters(plans, { ...NO_FILTERS, actionable: true }, '').map((p) => p.slug)).toEqual(['has-todo']);
    expect(applyPlanFilters(plans, { ...NO_FILTERS, owner: 'a@x.com' }, '').map((p) => p.slug)).toEqual([
      'has-human',
      'empty',
    ]);
  });
});

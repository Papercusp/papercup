// @vitest-environment jsdom
/**
 * PlanBucketTabs — plan lifecycle filter chips with live count badges.
 *
 * Verifies the two contracts that make the chips trustworthy:
 *  1. Each bucket's count badge equals the number of plans that land in that
 *     bucket via applyPlanFilters → bucketOf — i.e. the badge tracks the live
 *     filtered view, not the raw list. We assert against the SAME functions the
 *     component uses so the test can't drift from the production count.
 *  2. Toggling a chip is additive multi-select: clicking adds the bucket id to
 *     `?pBuckets`; clicking an active chip removes it. aria-pressed mirrors it.
 *
 * Renders under withNuqsTestingAdapter so the nuqs URL params (pBuckets +
 * the 6 shared plan filters) are seeded + observable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withNuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';
import PlanBucketTabs from './PlanBucketTabs';
import {
  applyPlanFilters,
  type PlanFilterState,
} from './plan-filtering';
import {
  bucketOf,
  PLAN_BUCKETS,
  type PlanBucket,
  type PlanListRow,
  type PlanStatus,
  type PlanStartStatus,
} from './plans-api';

afterEach(() => cleanup());

function plan(
  slug: string,
  status: PlanStatus,
  startStatus: PlanStartStatus = null,
  over: Partial<PlanListRow> = {},
): PlanListRow {
  return {
    slug,
    title: slug,
    status,
    updated: '2026-06-01T00:00:00.000Z',
    created: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'h',
    startStatus,
    priority: null,
    maxImportance: null,
    ...over,
  };
}

// One plan per bucket, plus extras so several buckets have count > 1.
const PLANS: PlanListRow[] = [
  plan('draft-a-2026-01-01', 'draft'),
  plan('draft-b-2026-01-02', 'blocked'), // bucketOf → draft (catch-all)
  plan('ready-a-2026-01-03', 'ready'),
  plan('ready-b-2026-01-04', 'active'), // legacy-approved → ready
  plan('running-a-2026-01-05', 'active', 'started'), // startStatus wins → running
  plan('shipped-a-2026-01-06', 'shipped'),
  plan('rejected-a-2026-01-07', 'superseded'),
];

// Mirror the component's DEFAULT (no filters) filter state.
const DEFAULT_FILTERS: PlanFilterState = {
  date: null,
  owner: null,
  view: 'all',
  viewerEmail: null,
  initiative: null,
  archived: false,
  legacy: false,
  inbox: false,
  actionable: false,
  scout: false,
  scheduled: false,
};

/** Ground-truth bucket counts — exactly what the component computes. */
function expectedCounts(
  plans: PlanListRow[],
  filters: PlanFilterState,
  query: string,
): Record<PlanBucket, number> {
  const filtered = applyPlanFilters(plans, filters, query);
  const acc: Record<PlanBucket, number> = {
    draft: 0,
    ready: 0,
    running: 0,
    shipped: 0,
    rejected: 0,
  };
  for (const p of filtered) acc[bucketOf(p)] += 1;
  return acc;
}

function chipFor(id: PlanBucket): HTMLElement {
  const label = PLAN_BUCKETS.find((b) => b.id === id)!.label;
  // Each chip is a <button> with a label span + a count span.
  const group = screen.getByRole('group', { name: /plan status filters/i });
  const btns = within(group).getAllByRole('button');
  const match = btns.find((b) => within(b).queryByText(label));
  if (!match) throw new Error(`no chip for bucket ${id} (${label})`);
  return match;
}

function countText(id: PlanBucket): number {
  const chip = chipFor(id);
  // The count span carries the class pc-plans__view-count.
  const countEl = chip.querySelector('.pc-plans__view-count')!;
  return Number(countEl.textContent);
}

describe('PlanBucketTabs — count badges', () => {
  it('each badge equals the applyPlanFilters→bucketOf count (no filters)', () => {
    render(<PlanBucketTabs plans={PLANS} query="" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    const expected = expectedCounts(PLANS, DEFAULT_FILTERS, '');
    // Sanity: every bucket has at least one plan in this fixture.
    expect(expected).toEqual({ draft: 2, ready: 2, running: 1, shipped: 1, rejected: 1 });
    for (const { id } of PLAN_BUCKETS) {
      expect(countText(id)).toBe(expected[id]);
    }
  });

  it('badges reflect the live search query (q narrows the counts)', () => {
    render(<PlanBucketTabs plans={PLANS} query="draft" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    const expected = expectedCounts(PLANS, DEFAULT_FILTERS, 'draft');
    // Only the two draft-slug plans match "draft" → draft bucket = 2, rest 0.
    expect(expected.draft).toBe(2);
    expect(countText('draft')).toBe(2);
    expect(countText('ready')).toBe(0);
    expect(countText('running')).toBe(0);
    expect(countText('shipped')).toBe(0);
    expect(countText('rejected')).toBe(0);
  });

  it('badges reflect a seeded shared filter param (?pArchived shows only archived)', () => {
    const plansWithArchived = [
      ...PLANS,
      plan('archived-ready-2026-02-01', 'ready', null, { archived: true }),
    ];
    render(<PlanBucketTabs plans={plansWithArchived} query="" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '?pArchived=true' }),
    });
    const expected = expectedCounts(
      plansWithArchived,
      { ...DEFAULT_FILTERS, archived: true },
      '',
    );
    // Archived view: only the single archived ready plan survives the filter.
    expect(expected).toEqual({ draft: 0, ready: 1, running: 0, shipped: 0, rejected: 0 });
    for (const { id } of PLAN_BUCKETS) {
      expect(countText(id)).toBe(expected[id]);
    }
  });
});

describe('PlanBucketTabs — toggle writes ?pBuckets', () => {
  it('clicking an inactive chip adds its id to pBuckets and flips aria-pressed', async () => {
    let lastSearch: URLSearchParams | null = null;
    const onUrlUpdate = (e: UrlUpdateEvent) => {
      lastSearch = e.searchParams;
    };
    render(<PlanBucketTabs plans={PLANS} query="" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '', onUrlUpdate }),
    });
    const runningChip = chipFor('running');
    expect(runningChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(runningChip);

    // The nuqs update queue flushes asynchronously — wait for it.
    await waitFor(() => expect(lastSearch).not.toBeNull());
    // nuqs serialises the array param under key `pBuckets`.
    expect(lastSearch!.get('pBuckets')).toBe('running');
    expect(chipFor('running').getAttribute('aria-pressed')).toBe('true');
  });

  it('a second chip is unioned into the array (additive multi-select)', async () => {
    let lastSearch: URLSearchParams | null = null;
    render(<PlanBucketTabs plans={PLANS} query="" />, {
      wrapper: withNuqsTestingAdapter({
        searchParams: '?pBuckets=draft',
        onUrlUpdate: (e) => {
          lastSearch = e.searchParams;
        },
      }),
    });
    // Seeded active: draft on, ready off.
    expect(chipFor('draft').getAttribute('aria-pressed')).toBe('true');
    expect(chipFor('ready').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(chipFor('ready'));

    await waitFor(() => expect(lastSearch).not.toBeNull());
    const value = lastSearch!.get('pBuckets')!;
    // Both ids present (order = existing then appended).
    expect(value.split(',').sort()).toEqual(['draft', 'ready']);
    expect(chipFor('ready').getAttribute('aria-pressed')).toBe('true');
    expect(chipFor('draft').getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking an active chip removes it from the array', async () => {
    let lastSearch: URLSearchParams | null = null;
    render(<PlanBucketTabs plans={PLANS} query="" />, {
      wrapper: withNuqsTestingAdapter({
        searchParams: '?pBuckets=draft,ready',
        onUrlUpdate: (e) => {
          lastSearch = e.searchParams;
        },
      }),
    });
    expect(chipFor('draft').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(chipFor('draft'));

    await waitFor(() => expect(lastSearch).not.toBeNull());
    // draft removed → only ready remains.
    expect(lastSearch!.get('pBuckets')).toBe('ready');
    expect(chipFor('draft').getAttribute('aria-pressed')).toBe('false');
    expect(chipFor('ready').getAttribute('aria-pressed')).toBe('true');
  });
});

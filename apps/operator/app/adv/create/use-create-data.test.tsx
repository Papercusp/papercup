// @vitest-environment jsdom
/**
 * use-create-data — the /adv Create dock's shared data hooks (lifted from
 * the PlansClient monolith; the panels must derive identically).
 *
 * Covers:
 *  - `useCreateScope` precedence: `?h` filter wins → `?scope=all` (registry
 *    slugs, or undefined while the registry hasn't loaded) → no active slug →
 *    undefined → `?scope=self` → [slug] → expanded → resolveHarnessScope
 *    union (slug + transitive sub-harnesses); a failed registry fetch falls
 *    back to [advActiveSlug];
 *  - `useResolvedHarnessSlug`: `?slug` wins; localStorage fallback otherwise;
 *  - `usePlanListMaps`: sorted unique harnessOptions, `?h` row filter,
 *    bucket/title maps built with the REAL bucketOf;
 *  - `useInboxData`: the three status queries tagged + deduped (first tag
 *    wins), istatus × pBuckets filtering, itemStatusCounts incl. attention
 *    ("Other") kinds, inboxTotal, the showOther/showPlanItems facet split,
 *    and refresh() fanning out to all four sources.
 *
 * plans-api's fetch hooks are mocked (fixtures); bucketOf stays REAL. nuqs
 * runs under withNuqsTestingAdapter; the registry fetch is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

// ── plans-api mock (fetch hooks only; pure helpers stay real) ───────────────

type HookState = { data: unknown; loading: boolean; error: string | null; refresh: () => void };
const hookFixtures = {
  planList: { data: undefined as unknown, loading: false, error: null as string | null },
  needsHuman: { items: [] as unknown[] },
  actionable: { items: [] as unknown[] },
  blocked: { items: [] as unknown[] },
  attention: { groups: [] as unknown[] },
};
const refreshSpies = {
  needsHuman: vi.fn(),
  actionable: vi.fn(),
  blocked: vi.fn(),
  attention: vi.fn(),
};

vi.mock('@/app/admin/plans/plans-api', async () => {
  const actual = await vi.importActual<typeof import('@/app/admin/plans/plans-api')>(
    '@/app/admin/plans/plans-api',
  );
  return {
    ...actual,
    usePlanList: (): HookState => ({
      data: hookFixtures.planList.data,
      loading: hookFixtures.planList.loading,
      error: hookFixtures.planList.error,
      refresh: vi.fn(),
    }),
    usePlanItems: (params: { needsHuman?: boolean; actionable?: boolean; status?: string }): HookState => {
      if (params?.needsHuman) {
        return { data: hookFixtures.needsHuman, loading: false, error: null, refresh: refreshSpies.needsHuman };
      }
      if (params?.actionable) {
        return { data: hookFixtures.actionable, loading: false, error: null, refresh: refreshSpies.actionable };
      }
      return { data: hookFixtures.blocked, loading: false, error: null, refresh: refreshSpies.blocked };
    },
    usePlanAttention: (): HookState => ({
      data: hookFixtures.attention,
      loading: false,
      error: null,
      refresh: refreshSpies.attention,
    }),
  };
});

import {
  useCreateScope,
  useResolvedHarnessSlug,
  usePlanListMaps,
  useInboxData,
  type CreateScope,
  type ItemStatusFilter,
} from './use-create-data';
import type { PlanBucket, PlanItemRow, PlanListRow } from '@/app/admin/plans/plans-api';

// ── fetch stub (the /api/harness/projects/lite registry read) ───────────────

const mockFetch = vi.fn<typeof fetch>();

// This env's window.localStorage is Node's --localstorage-file object with NO
// Storage methods (getItem/setItem/removeItem all undefined) — stub a real one.
const lsStore = new Map<string, string>();
const lsStub = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
  removeItem: (k: string) => void lsStore.delete(k),
  clear: () => lsStore.clear(),
};
function stubRegistry(projects: Array<{ slug: string; parent_slug?: string | null }> | 'fail') {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain('/api/harness/projects/lite');
    if (projects === 'fail') return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ projects }) } as unknown as Response;
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  stubRegistry([]);
  vi.stubGlobal('fetch', mockFetch);
  hookFixtures.planList = { data: undefined, loading: false, error: null };
  hookFixtures.needsHuman = { items: [] };
  hookFixtures.actionable = { items: [] };
  hookFixtures.blocked = { items: [] };
  hookFixtures.attention = { groups: [] };
  for (const s of Object.values(refreshSpies)) s.mockReset();
  lsStore.clear();
  vi.stubGlobal('localStorage', lsStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const wrap = (searchParams: string) => ({ wrapper: withNuqsTestingAdapter({ searchParams }) });

// ── useCreateScope ──────────────────────────────────────────────────────────

describe('useCreateScope', () => {
  it('?h user filter wins over everything', async () => {
    stubRegistry([{ slug: 'a' }, { slug: 'b' }]);
    const { result } = renderHook(() => useCreateScope(), wrap('?h=picked&slug=active&scope=all'));
    await waitFor(() => expect(result.current.harnessSlugsForFetch).toEqual(['picked']));
    expect(result.current.harnessFilter).toBe('picked');
  });

  it('scope=all fetches across every registry slug once loaded (undefined before)', async () => {
    stubRegistry([{ slug: 'a' }, { slug: 'b' }]);
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active&scope=all'));
    expect(result.current.harnessSlugsForFetch).toBeUndefined(); // registry not yet loaded
    await waitFor(() => expect(result.current.harnessSlugsForFetch).toEqual(['a', 'b']));
  });

  it('no active slug → undefined (ctx-harness-only)', async () => {
    const { result } = renderHook(() => useCreateScope(), wrap(''));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(result.current.harnessSlugsForFetch).toBeUndefined();
    expect(result.current.scopeMode).toBe('expanded'); // the default
  });

  it('scope=self pins to the active slug alone', async () => {
    stubRegistry([{ slug: 'active' }, { slug: 'child', parent_slug: 'active' }]);
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active&scope=self'));
    await waitFor(() => expect(result.current.harnessSlugsForFetch).toEqual(['active']));
  });

  it('expanded unions the active slug with its transitive sub-harnesses', async () => {
    stubRegistry([
      { slug: 'active' },
      { slug: 'child', parent_slug: 'active' },
      { slug: 'grandchild', parent_slug: 'child' },
      { slug: 'unrelated' },
    ]);
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active'));
    await waitFor(() =>
      expect([...(result.current.harnessSlugsForFetch ?? [])].sort()).toEqual(
        ['active', 'child', 'grandchild'],
      ),
    );
  });

  it('a failed registry fetch falls back to the active slug', async () => {
    stubRegistry('fail');
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(result.current.harnessSlugsForFetch).toEqual(['active']);
  });
});

// ── useResolvedHarnessSlug ──────────────────────────────────────────────────

describe('useResolvedHarnessSlug', () => {
  it('prefers ?slug', () => {
    window.localStorage.setItem('harness.activeProject', 'stale');
    const { result } = renderHook(() => useResolvedHarnessSlug(), wrap('?slug=fresh'));
    expect(result.current).toBe('fresh');
  });

  it('falls back to the AdvShell localStorage key', async () => {
    window.localStorage.setItem('harness.activeProject', 'stored');
    const { result } = renderHook(() => useResolvedHarnessSlug(), wrap(''));
    await waitFor(() => expect(result.current).toBe('stored'));
  });

  it('is null with neither source', () => {
    const { result } = renderHook(() => useResolvedHarnessSlug(), wrap(''));
    expect(result.current).toBeNull();
  });
});

// ── usePlanListMaps ─────────────────────────────────────────────────────────

const PLAN = (over: Partial<PlanListRow>): PlanListRow =>
  ({
    slug: 'p',
    title: 'T',
    status: 'active',
    startStatus: 'started',
    harness: 'sheets',
    owner: null,
    updated: '2026-06-07',
    archived: false,
    isLegacy: false,
    itemCounts: {},
    ...over,
  }) as PlanListRow;

const SCOPE = (over: Partial<CreateScope> = {}): CreateScope => ({
  harnessFilter: null,
  advActiveSlug: null,
  scopeMode: 'expanded',
  harnessSlugsForFetch: undefined,
  ...over,
});

describe('usePlanListMaps', () => {
  it('derives sorted unique harnessOptions and the bucket/title maps via the real bucketOf', () => {
    hookFixtures.planList = {
      data: {
        plans: [
          PLAN({ slug: 'p1', title: 'One', harness: 'zeta', status: 'active', startStatus: 'started' }),
          PLAN({ slug: 'p2', title: null as never, harness: 'alpha', status: 'draft', startStatus: null }),
          PLAN({ slug: 'p3', title: 'Three', harness: 'zeta', status: 'shipped', startStatus: 'done' }),
        ],
      },
      loading: false,
      error: null,
    };
    const { result } = renderHook(() => usePlanListMaps(SCOPE()), wrap(''));
    expect(result.current.harnessOptions).toEqual(['alpha', 'zeta']);
    expect(result.current.planBucketBySlug.get('p1')).toBe('running');
    expect(result.current.planBucketBySlug.get('p2')).toBe('draft');
    expect(result.current.planBucketBySlug.get('p3')).toBe('shipped');
    expect(result.current.planTitleBySlug.has('p2')).toBe(false); // null titles dropped
    expect(result.current.planMetaBySlug.get('p2')).toEqual({ title: null, bucket: 'draft' });
  });

  it('visiblePlans applies the ?h filter; without it all plans show', () => {
    hookFixtures.planList = {
      data: { plans: [PLAN({ slug: 'p1', harness: 'a' }), PLAN({ slug: 'p2', harness: 'b' })] },
      loading: false,
      error: null,
    };
    const all = renderHook(() => usePlanListMaps(SCOPE()), wrap(''));
    expect(all.result.current.visiblePlans.map((p) => p.slug)).toEqual(['p1', 'p2']);
    const filtered = renderHook(() => usePlanListMaps(SCOPE({ harnessFilter: 'b' })), wrap(''));
    expect(filtered.result.current.visiblePlans.map((p) => p.slug)).toEqual(['p2']);
  });
});

// ── useInboxData ────────────────────────────────────────────────────────────

const ITEM = (plan: string, id: string): PlanItemRow =>
  ({ plan, harness: 'sheets', item: { id, text: id, storedStatus: 'todo' } }) as unknown as PlanItemRow;

function inboxArgs(over: {
  istatus?: ItemStatusFilter[];
  pBuckets?: PlanBucket[];
  buckets?: Array<[string, PlanBucket]>;
  scope?: CreateScope;
}) {
  return {
    istatus: over.istatus ?? [],
    pBuckets: over.pBuckets ?? [],
    planBucketBySlug: new Map<string, PlanBucket>(over.buckets ?? []),
    scope: over.scope ?? SCOPE(),
  };
}

describe('useInboxData', () => {
  it('tags + dedups the three status queries (first tag wins)', () => {
    hookFixtures.needsHuman = { items: [ITEM('plan-a', 'P-001')] };
    hookFixtures.actionable = { items: [ITEM('plan-a', 'P-001'), ITEM('plan-a', 'P-002')] };
    hookFixtures.blocked = { items: [ITEM('plan-b', 'P-001')] };
    const { result } = renderHook(() => useInboxData(inboxArgs({})), wrap(''));
    // P-001@plan-a deduped (needs-human wins); P-001@plan-b is a distinct key
    expect(result.current.filteredItems).toHaveLength(3);
    expect(result.current.itemStatusCounts['needs-human']).toBe(1);
    expect(result.current.itemStatusCounts.todo).toBe(1);
    expect(result.current.itemStatusCounts.blocked).toBe(1);
    expect(result.current.inboxTotal).toBe(3);
  });

  it('filters by istatus and by plan bucket', () => {
    hookFixtures.needsHuman = { items: [ITEM('plan-a', 'P-001')] };
    hookFixtures.actionable = { items: [ITEM('plan-b', 'P-002')] };
    const { result } = renderHook(
      () =>
        useInboxData(
          inboxArgs({
            istatus: ['todo'],
            pBuckets: ['running'],
            buckets: [
              ['plan-a', 'running'],
              ['plan-b', 'draft'],
            ],
          }),
        ),
      wrap(''),
    );
    // istatus excludes needs-human; pBuckets excludes plan-b (draft)
    expect(result.current.filteredItems).toHaveLength(0);
    // counts honor the bucket filter too: only plan-a (running) rows counted
    expect(result.current.itemStatusCounts['needs-human']).toBe(1);
    expect(result.current.itemStatusCounts.todo).toBe(0);
  });

  it('counts attention ("Other") kinds and splits the facet flags', () => {
    hookFixtures.attention = {
      groups: [
        {
          items: [
            { kind: 'coord-escalation', id: 'e1' },
            { kind: 'plan-item', id: 'x' }, // excluded from otherItems
            { kind: 'smoke-fail', id: 's1' },
          ],
        },
      ],
    };
    const all = renderHook(() => useInboxData(inboxArgs({})), wrap(''));
    expect(all.result.current.otherItems.map((i) => (i as { kind: string }).kind)).toEqual([
      'coord-escalation',
      'smoke-fail',
    ]);
    expect(all.result.current.itemStatusCounts['coord-escalation']).toBe(1);
    expect(all.result.current.itemStatusCounts['smoke-fail']).toBe(1);
    // no facets → both sections show
    expect(all.result.current.showOther).toBe(true);
    expect(all.result.current.showPlanItems).toBe(true);

    const otherOnly = renderHook(
      () => useInboxData(inboxArgs({ istatus: ['coord-escalation'] })),
      wrap(''),
    );
    expect(otherOnly.result.current.showOther).toBe(true);
    expect(otherOnly.result.current.showPlanItems).toBe(false);
    expect(otherOnly.result.current.otherFacets).toEqual(['coord-escalation']);

    const planOnly = renderHook(() => useInboxData(inboxArgs({ istatus: ['todo'] })), wrap(''));
    expect(planOnly.result.current.showOther).toBe(false);
    expect(planOnly.result.current.showPlanItems).toBe(true);
  });

  it('refresh() fans out to all four sources', () => {
    const { result } = renderHook(() => useInboxData(inboxArgs({})), wrap(''));
    result.current.refresh();
    expect(refreshSpies.needsHuman).toHaveBeenCalledTimes(1);
    expect(refreshSpies.actionable).toHaveBeenCalledTimes(1);
    expect(refreshSpies.blocked).toHaveBeenCalledTimes(1);
    expect(refreshSpies.attention).toHaveBeenCalledTimes(1);
  });
});

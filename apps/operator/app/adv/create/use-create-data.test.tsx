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
 *  - `useQueueData`: the three status queries tagged + deduped (first tag
 *    wins), istatus × pBuckets filtering, itemStatusCounts incl. attention
 *    ("Other") kinds, queueTotal, the showOther/showPlanItems facet split,
 *    and refresh() fanning out to all four sources.
 *
 * plans-api's fetch hooks are mocked (fixtures); bucketOf stays REAL. nuqs
 * runs under withNuqsTestingAdapter; the LIVE harness registry
 * (harnessProjects.lite via useSyncQuery — data-sync-push-completion P-010,
 * replacing the old one-shot /api/harness/projects/lite fetch) is mocked as a
 * queryName dispatcher.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

// ── @papercusp/sync mock (the harnessProjects.lite registry query) ──────────
// useSyncQuery dispatches by queryName; harnessProjects.lite resolves to the
// `registryRows` fixture (the resolver returns the ProjectsLiteEntry array
// directly — the same rows the old REST endpoint put under `d.projects`).
let registryRows: unknown[] | undefined;
let registryQueryArgs: unknown;
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args }: { queryName: string; args?: unknown }) => {
    if (queryName === 'harnessProjects.lite') {
      registryQueryArgs = args;
      return { data: registryRows, error: null, loading: false, invalidate: vi.fn() };
    }
    return { data: undefined, error: null, loading: false, invalidate: vi.fn() };
  },
}));

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
  useQueueData,
  type CreateScope,
  type ItemStatusFilter,
} from './use-create-data';
import type { PlanBucket, PlanItemRow, PlanListRow } from '@/app/admin/plans/plans-api';

// ── registry stub (the harnessProjects.lite live query) ─────────────────────

// This env's window.localStorage is Node's --localstorage-file object with NO
// Storage methods (getItem/setItem/removeItem all undefined) — stub a real one.
const lsStore = new Map<string, string>();
const lsStub = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
  removeItem: (k: string) => void lsStore.delete(k),
  clear: () => lsStore.clear(),
};

// Set the harnessProjects.lite query result. 'fail' (a dead registry read)
// surfaces to the hook as an empty registry, so the scope falls back to the
// active slug exactly like the old fetch-rejection .catch() did.
function stubRegistry(projects: unknown[] | 'fail') {
  registryRows = projects === 'fail' ? [] : projects;
}

beforeEach(() => {
  stubRegistry([]);
  registryQueryArgs = undefined;
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
  it('requests hive homes from the live registry so standalone hives appear in Create', () => {
    renderHook(() => useCreateScope(), wrap('?slug=oddsmith-ops&scope=self'));
    expect(registryQueryArgs).toEqual({ includeHiveHomes: true });
  });

  it('?h user filter wins over everything', async () => {
    stubRegistry([{ slug: 'a' }, { slug: 'b' }]);
    const { result } = renderHook(() => useCreateScope(), wrap('?h=picked&slug=active&scope=all'));
    await waitFor(() => expect(result.current.harnessSlugsForFetch).toEqual(['picked']));
    expect(result.current.harnessFilter).toBe('picked');
  });

  it('scope=all fans out across every registry slug', async () => {
    stubRegistry([{ slug: 'a' }, { slug: 'b' }]);
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active&scope=all'));
    await waitFor(() => expect(result.current.harnessSlugsForFetch).toEqual(['a', 'b']));
  });

  it('scope=all is undefined (ctx-harness-only) until the registry resolves', () => {
    registryRows = undefined; // query unresolved (data === undefined)
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active&scope=all'));
    expect(result.current.harnessSlugsForFetch).toBeUndefined();
  });

  it('no active slug → undefined (ctx-harness-only)', () => {
    const { result } = renderHook(() => useCreateScope(), wrap(''));
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

  it('a failed registry read falls back to the active slug', () => {
    stubRegistry('fail');
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active'));
    expect(result.current.harnessSlugsForFetch).toEqual(['active']);
  });

  it('ignores malformed registry rows instead of crashing the ADV shell', () => {
    stubRegistry([
      null,
      { parent_slug: 'active' },
      { slug: 42, parent_slug: 'active' },
      { slug: 'child', parent_slug: 'active' },
    ]);
    const { result } = renderHook(() => useCreateScope(), wrap('?slug=active'));
    expect(result.current.harnessSlugsForFetch).toEqual(['active', 'child']);
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

// ── useQueueData ────────────────────────────────────────────────────────────

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

describe('useQueueData', () => {
  it('tags + dedups the three status queries (first tag wins)', () => {
    hookFixtures.needsHuman = { items: [ITEM('plan-a', 'P-001')] };
    hookFixtures.actionable = { items: [ITEM('plan-a', 'P-001'), ITEM('plan-a', 'P-002')] };
    hookFixtures.blocked = { items: [ITEM('plan-b', 'P-001')] };
    const { result } = renderHook(() => useQueueData(inboxArgs({})), wrap(''));
    // P-001@plan-a deduped (needs-human wins); P-001@plan-b is a distinct key
    expect(result.current.filteredItems).toHaveLength(3);
    expect(result.current.itemStatusCounts['needs-human']).toBe(1);
    expect(result.current.itemStatusCounts.todo).toBe(1);
    expect(result.current.itemStatusCounts.blocked).toBe(1);
    expect(result.current.queueTotal).toBe(3);
    // tierCounts (B1 QueueSummary): needs-human→decision, blocked→alert, todo→activity
    expect(result.current.tierCounts.decision).toBe(1);
    expect(result.current.tierCounts.alert).toBe(1);
    expect(result.current.tierCounts.activity).toBe(1);
    expect(result.current.tierCounts.handled).toBe(0);
  });

  it('ignores malformed plan-item rows instead of crashing the ADV shell', () => {
    hookFixtures.needsHuman = {
      items: [null, { plan: 'plan-a' }, { plan: 'plan-a', item: null }, ITEM('plan-a', 'P-001')],
    };
    hookFixtures.actionable = { items: [{ item: { id: 'P-002' } }, ITEM('plan-a', 'P-002')] };
    const { result } = renderHook(() => useQueueData(inboxArgs({})), wrap(''));
    expect(result.current.filteredItems.map((row) => row.item.id)).toEqual(['P-001', 'P-002']);
    expect(result.current.queueTotal).toBe(2);
  });

  it('filters by istatus and by plan bucket', () => {
    hookFixtures.needsHuman = { items: [ITEM('plan-a', 'P-001')] };
    hookFixtures.actionable = { items: [ITEM('plan-b', 'P-002')] };
    const { result } = renderHook(
      () =>
        useQueueData(
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
    const all = renderHook(() => useQueueData(inboxArgs({})), wrap(''));
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
      () => useQueueData(inboxArgs({ istatus: ['coord-escalation'] })),
      wrap(''),
    );
    expect(otherOnly.result.current.showOther).toBe(true);
    expect(otherOnly.result.current.showPlanItems).toBe(false);
    expect(otherOnly.result.current.otherFacets).toEqual(['coord-escalation']);

    const planOnly = renderHook(() => useQueueData(inboxArgs({ istatus: ['todo'] })), wrap(''));
    expect(planOnly.result.current.showOther).toBe(false);
    expect(planOnly.result.current.showPlanItems).toBe(true);
  });

  it('refresh() fans out to all four sources', () => {
    const { result } = renderHook(() => useQueueData(inboxArgs({})), wrap(''));
    result.current.refresh();
    expect(refreshSpies.needsHuman).toHaveBeenCalledTimes(1);
    expect(refreshSpies.actionable).toHaveBeenCalledTimes(1);
    expect(refreshSpies.blocked).toHaveBeenCalledTimes(1);
    expect(refreshSpies.attention).toHaveBeenCalledTimes(1);
  });
});

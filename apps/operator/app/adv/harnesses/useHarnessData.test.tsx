// @vitest-environment jsdom
/**
 * useHarnessData — the /adv Harness-tab data hooks (REST bootstrap + Zero
 * overlay; no polling).
 *
 * Covers:
 *  - `parseWorkingUsers` (exported): number[] / string[] / JSON-string /
 *    Postgres array-literal "{1,2}" normalization, junk → undefined,
 *    non-positive + non-integer ids dropped;
 *  - `useHarnessFeatures`: REST row mapping (needs_human_review →
 *    needsReview, non-array tags dropped), REST error → error + loading
 *    false, the Zero overlay applied only when NON-EMPTY (an empty Zero
 *    result never clobbers the REST baseline), the overlay's defensive
 *    mappings (claims JSON parse, attempts Number-coercion, snake/camel
 *    needs-review fallback, workingUsers literal parse), and patchFeature's
 *    optimistic merge;
 *  - `useHarnessIssues`: pendingCount = live pending rows when present,
 *    REST `pending` fallback otherwise; overlay foundAt epoch→ISO mapping;
 *  - `useHarnessAgents`: refresh() re-pulls REST.
 *
 * `@papercusp/sync` is mocked with a per-queryName fixture map; fetch is
 * stubbed per-URL. setup-fail-on-console is active — renders must be clean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

// ── @papercusp/sync mock ────────────────────────────────────────────────────

type SyncState = { data: unknown; loading: boolean };
const syncState = new Map<string, SyncState>();

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    syncState.get(queryName) ?? { data: undefined, loading: false },
}));

import {
  parseWorkingUsers,
  useHarnessAgents,
  useHarnessFeatures,
  useHarnessIssues,
} from './useHarnessData';

// ── fetch stub ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errStatus(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

/** Route fetches by URL substring. Unrouted URLs reject loudly. */
function routeFetch(routes: Record<string, () => Response>) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

beforeEach(() => {
  syncState.clear();
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ── parseWorkingUsers ───────────────────────────────────────────────────────

describe('parseWorkingUsers', () => {
  it('passes through a number[]', () => {
    expect(parseWorkingUsers([1, 2])).toEqual([1, 2]);
  });

  it('parses string ids (transport-stringified bigints)', () => {
    expect(parseWorkingUsers(['3', ' 4 '])).toEqual([3, 4]);
  });

  it('parses a JSON array string', () => {
    expect(parseWorkingUsers('[5,6]')).toEqual([5, 6]);
  });

  it('parses a Postgres array literal', () => {
    expect(parseWorkingUsers('{7,8}')).toEqual([7, 8]);
  });

  it('returns undefined for empties', () => {
    expect(parseWorkingUsers(null)).toBeUndefined();
    expect(parseWorkingUsers(undefined)).toBeUndefined();
    expect(parseWorkingUsers('')).toBeUndefined();
    expect(parseWorkingUsers('{}')).toBeUndefined();
    expect(parseWorkingUsers('[]')).toBeUndefined();
    expect(parseWorkingUsers([])).toBeUndefined();
  });

  it('drops non-positive and non-integer ids; all-dropped → undefined', () => {
    expect(parseWorkingUsers([0, -1, 2.5, 9])).toEqual([9]);
    expect(parseWorkingUsers([0, -1])).toBeUndefined();
  });

  it('returns undefined for junk', () => {
    expect(parseWorkingUsers('not json')).toBeUndefined();
    expect(parseWorkingUsers(42)).toBeUndefined();
    expect(parseWorkingUsers({})).toBeUndefined();
  });
});

// ── useHarnessFeatures ──────────────────────────────────────────────────────

const REST_FEATURE = {
  id: 'F-001',
  title: 'Auth',
  status: 'todo',
  attempts: 2,
  summary: 'sum',
  needs_human_review: true,
  tags: ['auth'],
};

describe('useHarnessFeatures', () => {
  it('maps the REST bootstrap (needs_human_review → needsReview; non-array tags dropped)', async () => {
    routeFetch({
      '/status': () => okJson({ features: [REST_FEATURE, { ...REST_FEATURE, id: 'F-002', tags: 'nope' }] }),
    });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.features).not.toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.features![0]).toEqual({
      id: 'F-001',
      title: 'Auth',
      status: 'todo',
      attempts: 2,
      summary: 'sum',
      needsReview: true,
      tags: ['auth'],
    });
    expect(result.current.features![1].tags).toBeUndefined();
  });

  it('surfaces a REST failure as error (and stops loading)', async () => {
    routeFetch({ '/status': () => errStatus(500) });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    await waitFor(() => expect(result.current.error).toBe('status 500'));
    expect(result.current.features).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('returns null features without fetching when slug is empty', () => {
    const { result } = renderHook(() => useHarnessFeatures(''));
    expect(result.current.features).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies a NON-EMPTY Zero overlay with the defensive row mappings', async () => {
    routeFetch({ '/status': () => okJson({ features: [] }) });
    syncState.set('featuresConsolidated.bySlug', {
      loading: false,
      data: [
        {
          featureId: 'F-010',
          title: 'Zero row',
          status: 'validating',
          attempts: '3', // string → Number
          claims: '["VAL-1"]', // JSON string → string[]
          needs_human_review: true, // snake-case fallback
          tags: ['a', 'b'],
          working_users: '{12,34}', // PG literal → number[]
        },
      ],
    });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    await waitFor(() => expect(result.current.features).not.toBeNull());
    expect(result.current.features![0]).toEqual({
      id: 'F-010',
      title: 'Zero row',
      summary: undefined,
      status: 'validating',
      attempts: 3,
      claims: ['VAL-1'],
      sourcePlanSlug: undefined,
      needsReview: true,
      tags: ['a', 'b'],
      workingUsers: [12, 34],
    });
  });

  it('never clobbers the REST baseline with an empty Zero result', async () => {
    routeFetch({ '/status': () => okJson({ features: [REST_FEATURE] }) });
    syncState.set('featuresConsolidated.bySlug', { loading: false, data: [] });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    await waitFor(() => expect(result.current.features).not.toBeNull());
    expect(result.current.features![0].id).toBe('F-001');
  });

  it('patchFeature merges a partial into the matching feature only', async () => {
    routeFetch({
      '/status': () => okJson({ features: [REST_FEATURE, { ...REST_FEATURE, id: 'F-002' }] }),
    });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    await waitFor(() => expect(result.current.features).not.toBeNull());
    act(() => result.current.patchFeature('F-002', { status: 'passed' }));
    expect(result.current.features!.find((f) => f.id === 'F-002')!.status).toBe('passed');
    expect(result.current.features!.find((f) => f.id === 'F-001')!.status).toBe('todo');
    // unknown id → no-op, no throw
    act(() => result.current.patchFeature('F-404', { status: 'failing' }));
    expect(result.current.features).toHaveLength(2);
  });
});

// ── useHarnessIssues ────────────────────────────────────────────────────────

const REST_ISSUE = {
  id: 'I-1',
  title: 'Broken',
  severity: 'major',
  source: 'validator',
  status: 'open',
  foundAt: '2026-06-01T00:00:00.000Z',
  attempts: 0,
  notes: [],
};

describe('useHarnessIssues', () => {
  it('bootstraps from REST and uses the REST pending count as the fallback', async () => {
    routeFetch({
      '/issues-list': () => okJson({ issues: [REST_ISSUE], pending: [{ title: 'p1' }, { title: 'p2' }] }),
    });
    const { result } = renderHook(() => useHarnessIssues('sheets'));
    await waitFor(() => expect(result.current.issues).not.toBeNull());
    expect(result.current.issues![0].id).toBe('I-1');
    expect(result.current.pendingCount).toBe(2);
  });

  it('prefers the live pending stream over the REST count when it is an array', async () => {
    routeFetch({ '/issues-list': () => okJson({ issues: [], pending: [{ title: 'stale' }] }) });
    syncState.set('harnessPendingIssues.byHarness', {
      loading: false,
      data: [{ issueId: 'p-a' }, { issueId: 'p-b' }, { issueId: 'p-c' }],
    });
    const { result } = renderHook(() => useHarnessIssues('sheets'));
    await waitFor(() => expect(result.current.issues).not.toBeNull());
    expect(result.current.pendingCount).toBe(3);
  });

  it('maps a Zero issue overlay row (epoch foundAt → ISO; invalid → empty string)', async () => {
    routeFetch({ '/issues-list': () => okJson({ issues: [] }) });
    syncState.set('issuesConsolidated.bySlug', {
      loading: false,
      data: [
        {
          issueId: 'I-9',
          title: 'Z',
          severity: 'minor',
          source: 'watchdog',
          status: 'open',
          foundAt: Date.UTC(2026, 5, 6),
          attempts: '4',
          notes: 'not-an-array',
        },
        {
          issueId: 'I-10',
          title: 'Bad ts',
          severity: 'minor',
          source: 'watchdog',
          status: 'open',
          foundAt: 'garbage',
          notes: [],
        },
      ],
    });
    const { result } = renderHook(() => useHarnessIssues('sheets'));
    await waitFor(() => expect((result.current.issues ?? []).length).toBe(2));
    const [a, b] = result.current.issues!;
    expect(a.foundAt).toBe('2026-06-06T00:00:00.000Z');
    expect(a.attempts).toBe(4);
    expect(a.notes).toEqual([]); // non-array coerced
    expect(b.foundAt).toBe(''); // unparseable ts
  });
});

// ── useHarnessAgents ────────────────────────────────────────────────────────

describe('useHarnessAgents', () => {
  it('bootstraps from REST and refresh() re-pulls', async () => {
    let calls = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/agents');
      calls += 1;
      return okJson({ runs: [{ runId: `r-${calls}`, role: 'worker', sizeBytes: 1, running: false }] });
    });
    const { result } = renderHook(() => useHarnessAgents('sheets'));
    await waitFor(() => expect(result.current.agents).not.toBeNull());
    expect(result.current.agents![0].runId).toBe('r-1');
    act(() => result.current.refresh());
    await waitFor(() => expect(calls).toBe(2));
  });

  it('applies the Zero overlay with ts coercion', async () => {
    routeFetch({ '/agents': () => okJson({ runs: [] }) });
    syncState.set('agentRunsConsolidated.bySlug', {
      loading: false,
      data: [
        {
          runId: 'r-z',
          role: 'validator',
          ts: '2026-06-06T12:00:00.000Z', // string → Date.parse ms
          sizeBytes: '2048',
          running: true,
          costUsd: '0.5',
        },
      ],
    });
    const { result } = renderHook(() => useHarnessAgents('sheets'));
    await waitFor(() => expect(result.current.agents).not.toBeNull());
    expect(result.current.agents![0]).toEqual({
      runId: 'r-z',
      role: 'validator',
      ts: Date.UTC(2026, 5, 6, 12),
      sizeBytes: 2048,
      running: true,
      lastEventTs: undefined,
      costUsd: 0.5,
      featureId: undefined,
    });
  });
});

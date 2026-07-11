// @vitest-environment jsdom
/**
 * useHarnessData — authoritative shared-sync hooks for the /adv Harness tab.
 *
 * Covers:
 *  - `parseWorkingUsers` (exported): number[] / string[] / JSON-string /
 *    Postgres array-literal "{1,2}" normalization, junk → undefined,
 *    non-positive + non-integer ids dropped;
 *  - empty sync arrays are authoritative (last-row deletion never resurrects
 *    a stale REST bootstrap);
 *  - defensive feature/issue/agent row mapping;
 *  - optimistic local patches; and
 *  - refresh invalidates the same shared agent-run cache entry.
 *
 * `@papercusp/sync` is mocked with a per-queryName fixture map; fetch is
 * stubbed per-URL. setup-fail-on-console is active — renders must be clean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

// ── @papercusp/sync mock ────────────────────────────────────────────────────

type SyncState = { data: unknown; loading: boolean; error?: unknown };
const syncState = new Map<string, SyncState>();
const invalidates = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    ...(syncState.get(queryName) ?? { data: undefined, loading: false }),
    error: syncState.get(queryName)?.error ?? null,
    invalidate: invalidates.get(queryName) ?? vi.fn(),
  }),
}));

import {
  parseWorkingUsers,
  useHarnessAgents,
  useHarnessFeatures,
  useHarnessIssues,
} from './useHarnessData';

// ── fetch stub ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  syncState.clear();
  invalidates.clear();
  mockFetch.mockReset();
  mockFetch.mockRejectedValue(new Error('durable harness reads must not fetch REST'));
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

describe('useHarnessFeatures', () => {
  it('surfaces a sync failure without issuing a REST fallback', async () => {
    syncState.set('featuresConsolidated.bySlug', { data: undefined, loading: false, error: new Error('sync unavailable') });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    await waitFor(() => expect(result.current.error).toBe('sync unavailable'));
    expect(result.current.features).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null features without fetching when slug is empty', () => {
    const { result } = renderHook(() => useHarnessFeatures(''));
    expect(result.current.features).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps sync rows defensively', async () => {
    syncState.set('featuresConsolidated.bySlug', {
      loading: false,
      data: [
        {
          featureId: 'F-010',
          title: 'Sync row',
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
      title: 'Sync row',
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

  it('treats an empty sync result as authoritative', async () => {
    syncState.set('featuresConsolidated.bySlug', { loading: false, data: [] });
    const { result } = renderHook(() => useHarnessFeatures('sheets'));
    await waitFor(() => expect(result.current.features).not.toBeNull());
    expect(result.current.features).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('patchFeature merges a partial into the matching feature only', async () => {
    syncState.set('featuresConsolidated.bySlug', { loading: false, data: [
      { featureId: 'F-001', title: 'One', status: 'todo', attempts: 0 },
      { featureId: 'F-002', title: 'Two', status: 'todo', attempts: 0 },
    ] });
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

describe('useHarnessIssues', () => {
  it('uses the live pending stream and has no REST count fallback', async () => {
    syncState.set('issuesConsolidated.bySlug', { loading: false, data: [] });
    syncState.set('harnessPendingIssues.byHarness', {
      loading: false,
      data: [{ issueId: 'p-a' }, { issueId: 'p-b' }, { issueId: 'p-c' }],
    });
    const { result } = renderHook(() => useHarnessIssues('sheets'));
    await waitFor(() => expect(result.current.issues).not.toBeNull());
    expect(result.current.pendingCount).toBe(3);
  });

  it('maps a sync issue row (epoch foundAt → ISO; invalid → empty string)', async () => {
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
  it('refresh() invalidates the authoritative agent-run query', async () => {
    const invalidate = vi.fn();
    invalidates.set('agentRunsConsolidated.bySlug', invalidate);
    syncState.set('agentRunsConsolidated.bySlug', { loading: false, data: [] });
    const { result } = renderHook(() => useHarnessAgents('sheets'));
    await waitFor(() => expect(result.current.agents).not.toBeNull());
    act(() => result.current.refresh());
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps sync rows with timestamp coercion', async () => {
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

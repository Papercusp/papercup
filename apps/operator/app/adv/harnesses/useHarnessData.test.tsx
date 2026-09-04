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

type SyncState = { data: unknown; loading: boolean; fetching?: boolean; error?: unknown };
const syncState = new Map<string, SyncState>();
const invalidates = new Map<string, ReturnType<typeof vi.fn>>();
const seenQueryArgs = new Map<string, unknown>();

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName, args }: { queryName: string; args?: unknown }) => {
    seenQueryArgs.set(queryName, args);
    return ({
    ...(syncState.get(queryName) ?? { data: undefined, loading: false }),
    error: syncState.get(queryName)?.error ?? null,
    invalidate: invalidates.get(queryName) ?? vi.fn(),
    });
  },
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'workspace-test' }));

import {
  parseWorkingUsers,
  useHarnessAgents,
  useHarnessFeature,
  useHarnessIssues,
  useHarnessHookLogs,
} from './useHarnessData';

// ── fetch stub ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  syncState.clear();
  invalidates.clear();
  seenQueryArgs.clear();
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

// ── useHarnessFeature ───────────────────────────────────────────────────────

describe('useHarnessFeature', () => {
  it('surfaces a sync failure without issuing a REST fallback', async () => {
    syncState.set('featuresConsolidated.detail', { data: undefined, loading: false, error: new Error('sync unavailable') });
    const { result } = renderHook(() => useHarnessFeature('sheets', 'F-010'));
    await waitFor(() => expect(result.current.error).toBe('sync unavailable'));
    expect(result.current.feature).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a disabled null feature without fetching when slug is empty', () => {
    const { result } = renderHook(() => useHarnessFeature('', 'F-010'));
    expect(result.current.feature).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps the selected detail row defensively', async () => {
    syncState.set('featuresConsolidated.detail', {
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
    const { result } = renderHook(() => useHarnessFeature('sheets', 'F-010'));
    await waitFor(() => expect(result.current.feature).not.toBeNull());
    expect(result.current.feature).toEqual({
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
    expect(seenQueryArgs.get('featuresConsolidated.detail')).toEqual({
      harnessSlug: 'sheets',
      featureId: 'F-010',
      workspaceId: 'workspace-test',
    });
  });

  it('treats an empty sync result as authoritative', async () => {
    syncState.set('featuresConsolidated.detail', { loading: false, data: [] });
    const { result } = renderHook(() => useHarnessFeature('sheets', 'F-404'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.feature).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('patchFeature merges a partial only when the selected id matches', async () => {
    syncState.set('featuresConsolidated.detail', { loading: false, data: [
      { featureId: 'F-002', title: 'Two', status: 'todo', attempts: 0 },
    ] });
    const { result } = renderHook(() => useHarnessFeature('sheets', 'F-002'));
    await waitFor(() => expect(result.current.feature).not.toBeNull());
    act(() => result.current.patchFeature('F-002', { status: 'passed' }));
    expect(result.current.feature!.status).toBe('passed');
    // unknown id → no-op, no throw
    act(() => result.current.patchFeature('F-404', { status: 'failing' }));
    expect(result.current.feature!.status).toBe('passed');
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
  it('refresh() invalidates the paired row and summary queries', async () => {
    const invalidateRows = vi.fn();
    const invalidateSummary = vi.fn();
    invalidates.set('agentRunsConsolidated.bySlug', invalidateRows);
    invalidates.set('agentRunsConsolidated.summary', invalidateSummary);
    syncState.set('agentRunsConsolidated.bySlug', { loading: false, data: [] });
    syncState.set('agentRunsConsolidated.summary', {
      loading: false,
      data: [{ total: 0, matched: 0, facets: [] }],
    });
    const { result } = renderHook(() => useHarnessAgents('sheets'));
    await waitFor(() => expect(result.current.agents).not.toBeNull());
    act(() => result.current.refresh());
    expect(invalidateRows).toHaveBeenCalledTimes(1);
    expect(invalidateSummary).toHaveBeenCalledTimes(1);
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
    syncState.set('agentRunsConsolidated.summary', {
      loading: false,
      data: [{
        total: 2_051,
        matched: 7,
        facets: [{
          key: 'state',
          values: [{ value: 'running', count: 7 }],
          hiddenValueCount: 0,
          distinctCount: 2,
        }],
      }],
    });
    const { result } = renderHook(() => useHarnessAgents('sheets', {
      runningOnly: true,
      cursor: 'cursor-1',
      limit: 25,
    }));
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
    expect(result.current).toMatchObject({ total: 2_051, matched: 7, running: 7 });
    expect(seenQueryArgs.get('agentRunsConsolidated.bySlug')).toMatchObject({
      harnessSlug: 'sheets',
      workspaceId: 'workspace-test',
      runningOnly: true,
      cursor: 'cursor-1',
      limit: 25,
    });
    expect(seenQueryArgs.get('agentRunsConsolidated.summary')).toEqual({
      harnessSlug: 'sheets',
      workspaceId: 'workspace-test',
      runningOnly: true,
    });
  });

  it('keeps an exact zero-running summary when the row page is empty', async () => {
    syncState.set('agentRunsConsolidated.bySlug', { loading: false, data: [] });
    syncState.set('agentRunsConsolidated.summary', {
      loading: false,
      data: [{
        total: 2_051,
        matched: 0,
        facets: [{
          key: 'state',
          values: [{ value: 'running', count: 0 }],
          hiddenValueCount: 0,
          distinctCount: 1,
        }],
      }],
    });
    const { result } = renderHook(() => useHarnessAgents('sheets', { runningOnly: true }));
    await waitFor(() => expect(result.current.agents).toEqual([]));
    expect(result.current).toMatchObject({ total: 2_051, matched: 0, running: 0 });
  });
});

// ── useHarnessHookLogs ──────────────────────────────────────────────────────

describe('useHarnessHookLogs', () => {
  it('returns null logs until sync data loads', () => {
    syncState.set('harnessHookLogs.byHarness', { data: undefined, loading: true });
    const { result } = renderHook(() => useHarnessHookLogs('test-harness'));
    expect(result.current.logs).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('maps sync rows to HarnessHookLogEvent[], normalizing field names', async () => {
    const invalidate = vi.fn();
    invalidates.set('harnessHookLogs.byHarness', invalidate);
    syncState.set('harnessHookLogs.byHarness', {
      loading: false,
      data: [
        {
          log_id: 'log-1',
          harness_slug: 'test',
          ts: '2026-07-12T10:00:00.000Z',
          event_kind: 'feature_created',
          target_id: 'f-123',
          target_type: 'feature',
          status: 'success',
          metadata: { version: 1 },
        },
      ],
    });
    const { result } = renderHook(() => useHarnessHookLogs('test'));
    await waitFor(() => expect(result.current.logs).not.toBeNull());
    expect(result.current.logs).toEqual([
      {
        logId: 'log-1',
        harnessSlug: 'test',
        ts: '2026-07-12T10:00:00.000Z',
        eventKind: 'feature_created',
        targetId: 'f-123',
        targetType: 'feature',
        status: 'success',
        metadata: { version: 1 },
      },
    ]);
  });

  it('returns authoritative empty array (no REST fallback)', async () => {
    invalidates.set('harnessHookLogs.byHarness', vi.fn());
    syncState.set('harnessHookLogs.byHarness', { loading: false, data: [] });
    const { result } = renderHook(() => useHarnessHookLogs('test'));
    await waitFor(() => expect(result.current.logs).not.toBeNull());
    expect(result.current.logs).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled(); // no REST fallback
  });

  it('invalidate() calls the sync query invalidator', async () => {
    const invalidate = vi.fn();
    invalidates.set('harnessHookLogs.byHarness', invalidate);
    syncState.set('harnessHookLogs.byHarness', { loading: false, data: [] });
    const { result } = renderHook(() => useHarnessHookLogs('test'));
    await waitFor(() => expect(result.current.logs).not.toBeNull());
    act(() => {
      result.current.refresh();
    });
    expect(invalidate).toHaveBeenCalled();
  });

  it('handles sync error gracefully', async () => {
    invalidates.set('harnessHookLogs.byHarness', vi.fn());
    syncState.set('harnessHookLogs.byHarness', {
      loading: false,
      data: undefined,
      error: new Error('sync failed'),
    });
    const { result } = renderHook(() => useHarnessHookLogs('test'));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('sync failed');
    expect(result.current.logs).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { loadQueueMembership } from '../load-queue-membership';

// Cast to the injectable runQuery field's generic signature (the bare vi.fn is a 0-arg,
// non-generic Mock that doesn't assign to `<T>(query, params) => Promise<T[]>`).
function fakeRunQuery(rows: unknown[]) {
  return vi.fn(async () => rows) as unknown as <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

describe('loadQueueMembership', () => {
  it('returns empty map when workspace_id is missing', async () => {
    const out = await loadQueueMembership({
      workspace_id: '',
      harness_slug: 'p',
      runQuery: fakeRunQuery([]),
    });
    expect(out).toEqual({});
  });

  it('returns empty map when harness_slug is missing', async () => {
    const out = await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: '',
      runQuery: fakeRunQuery([]),
    });
    expect(out).toEqual({});
  });

  it('groups rows by feature_id', async () => {
    const runQuery = fakeRunQuery([
      {
        feature_id: 'F-1',
        github_user_id: 1,
        github_username: 'alice',
        display_name: 'Alice',
        avatar_url: 'https://a.png',
        queued_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        feature_id: 'F-1',
        github_user_id: 2,
        github_username: 'bob',
        display_name: null,
        avatar_url: null,
        queued_at: new Date('2026-01-01T01:00:00Z'),
      },
      {
        feature_id: 'F-2',
        github_user_id: 1,
        github_username: 'alice',
        display_name: 'Alice',
        avatar_url: 'https://a.png',
        queued_at: new Date('2026-01-02T00:00:00Z'),
      },
    ]);
    const out = await loadQueueMembership({
      workspace_id: 'ws',
      harness_slug: 'h',
      runQuery,
    });
    expect(Object.keys(out).sort()).toEqual(['F-1', 'F-2']);
    expect(out['F-1']).toHaveLength(2);
    expect(out['F-1'][0].github_username).toBe('alice');
    expect(out['F-1'][1].github_username).toBe('bob');
    expect(out['F-2']).toHaveLength(1);
  });

  it('passes workspace_id + harness_slug as $1 and $2', async () => {
    const runQuery = fakeRunQuery([]);
    await loadQueueMembership({
      workspace_id: 'ws-1',
      harness_slug: 'sheets',
      runQuery,
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
    const [, params] = runQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[0]).toBe('ws-1');
    expect(params[1]).toBe('sheets');
  });

  it('appends feature_ids as IN clause when provided', async () => {
    const runQuery = fakeRunQuery([]);
    await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      feature_ids: ['F-1', 'F-2', 'F-3'],
      runQuery,
    });
    const [sql, params] = runQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/q\.feature_id IN \(\$3, \$4, \$5\)/);
    expect(params.slice(2)).toEqual(['F-1', 'F-2', 'F-3']);
  });

  it('does NOT append IN clause when feature_ids is empty array', async () => {
    const runQuery = fakeRunQuery([]);
    await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      feature_ids: [],
      runQuery,
    });
    const [sql] = runQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toMatch(/feature_id IN/);
  });

  it('filters out tombstones via WHERE removed_at IS NULL', async () => {
    const runQuery = fakeRunQuery([]);
    await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      runQuery,
    });
    const [sql] = runQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/removed_at IS NULL/);
  });

  it('joins LEFT to contributors so unjoined queue rows still surface', async () => {
    const runQuery = fakeRunQuery([
      {
        feature_id: 'F-1',
        github_user_id: 99,
        github_username: null,
        display_name: null,
        avatar_url: null,
        queued_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const out = await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      runQuery,
    });
    expect(out['F-1']).toHaveLength(1);
    expect(out['F-1'][0].github_username).toBe('');
    expect(out['F-1'][0].avatar_url).toBeNull();
  });

  it('coerces github_user_id from string (pg may return BIGINT as string)', async () => {
    const runQuery = fakeRunQuery([
      {
        feature_id: 'F-1',
        github_user_id: '12345',
        github_username: 'x',
        display_name: null,
        avatar_url: null,
        queued_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const out = await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      runQuery,
    });
    expect(out['F-1'][0].github_user_id).toBe(12345);
  });

  it('drops rows with invalid user id (defensive)', async () => {
    const runQuery = fakeRunQuery([
      {
        feature_id: 'F-1',
        github_user_id: 0,
        github_username: 'x',
        display_name: null,
        avatar_url: null,
        queued_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        feature_id: 'F-1',
        github_user_id: 'not-a-number',
        github_username: 'x',
        display_name: null,
        avatar_url: null,
        queued_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const out = await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      runQuery,
    });
    expect(out['F-1']).toBeUndefined();
  });

  it('returns {} when feature_queue table does not exist (substrate not booted)', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('relation "harness_shared.feature_queue" does not exist');
    });
    const out = await loadQueueMembership({
      workspace_id: 'w',
      harness_slug: 'h',
      runQuery,
    });
    expect(out).toEqual({});
  });

  it('rethrows non-missing-table errors', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('connection lost');
    });
    await expect(
      loadQueueMembership({
        workspace_id: 'w',
        harness_slug: 'h',
        runQuery,
      }),
    ).rejects.toThrow(/connection/);
  });
});

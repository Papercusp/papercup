import { describe, expect, it, vi } from 'vitest';
import { loadWorkingSet } from '../load-working-set';

// Cast to the injectable runQuery field's generic signature (the bare vi.fn is a 0-arg,
// non-generic Mock that doesn't assign to `<T>(query, params) => Promise<T[]>`).
function fakeRunQuery(rows: unknown[]) {
  return vi.fn(async () => rows) as unknown as <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

describe('loadWorkingSet', () => {
  it('returns {} when workspace_id or harness_slug missing', async () => {
    expect(await loadWorkingSet({ workspace_id: '', harness_slug: 'h', runQuery: fakeRunQuery([]) })).toEqual({});
    expect(await loadWorkingSet({ workspace_id: 'w', harness_slug: '', runQuery: fakeRunQuery([]) })).toEqual({});
  });

  it('groups rows by feature_id', async () => {
    const runQuery = fakeRunQuery([
      { feature_id: 'F-1', github_user_id: 1, github_username: 'a', display_name: 'A', avatar_url: null, started_at: new Date('2026-01-01T00:00:00Z') },
      { feature_id: 'F-1', github_user_id: 2, github_username: 'b', display_name: null, avatar_url: null, started_at: new Date('2026-01-01T01:00:00Z') },
      { feature_id: 'F-2', github_user_id: 1, github_username: 'a', display_name: 'A', avatar_url: null, started_at: new Date('2026-01-02T00:00:00Z') },
    ]);
    const out = await loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', runQuery });
    expect(Object.keys(out).sort()).toEqual(['F-1', 'F-2']);
    expect(out['F-1']).toHaveLength(2);
    expect(out['F-2']).toHaveLength(1);
  });

  it('filters tombstones via cleared_at IS NULL', async () => {
    const runQuery = fakeRunQuery([]);
    await loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', runQuery });
    const [sql] = runQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/cleared_at IS NULL/);
  });

  it('appends feature_ids IN clause when provided', async () => {
    const runQuery = fakeRunQuery([]);
    await loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', feature_ids: ['F-1', 'F-2'], runQuery });
    const [sql, params] = runQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/w\.feature_id IN \(\$3, \$4\)/);
    expect(params.slice(2)).toEqual(['F-1', 'F-2']);
  });

  it('coerces stringified bigint user id', async () => {
    const runQuery = fakeRunQuery([
      { feature_id: 'F-1', github_user_id: '12345', github_username: 'x', display_name: null, avatar_url: null, started_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const out = await loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', runQuery });
    expect(out['F-1'][0].github_user_id).toBe(12345);
  });

  it('drops invalid user ids', async () => {
    const runQuery = fakeRunQuery([
      { feature_id: 'F-1', github_user_id: 0, github_username: 'x', display_name: null, avatar_url: null, started_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const out = await loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', runQuery });
    expect(out['F-1']).toBeUndefined();
  });

  it('returns {} when the table does not exist', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('relation "harness_shared.feature_working_set" does not exist');
    });
    expect(await loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', runQuery })).toEqual({});
  });

  it('rethrows non-missing-table errors', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('connection lost');
    });
    await expect(loadWorkingSet({ workspace_id: 'w', harness_slug: 'h', runQuery })).rejects.toThrow(/connection/);
  });
});

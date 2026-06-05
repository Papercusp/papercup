import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bumpLastSurfaced,
  bumpLastSurfacedSql,
  recentlySurfacedIds,
  _resetForTests,
} from './bump-last-surfaced';

const fakeClient = (queryImpl?: (sql: string, params?: unknown[]) => Promise<unknown>) => ({
  query: vi.fn(queryImpl ?? (async () => ({ rowCount: 1 }))),
});

beforeEach(() => {
  _resetForTests();
});

describe('bumpLastSurfaced', () => {
  it('no-ops on empty ids', async () => {
    const c = fakeClient();
    expect(await bumpLastSurfaced(c, [])).toBe(true);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('filters out non-uuid ids', async () => {
    const c = fakeClient();
    expect(await bumpLastSurfaced(c, ['not-a-uuid', 'also bad'])).toBe(true);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('runs UPDATE for valid uuid ids', async () => {
    const c = fakeClient();
    const ok = await bumpLastSurfaced(c, [
      '123e4567-e89b-12d3-a456-426614174000',
      '00000000-0000-0000-0000-000000000001',
    ]);
    expect(ok).toBe(true);
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(c.query.mock.calls[0][0]).toContain('UPDATE harness_shared.memory_canonical');
    expect(c.query.mock.calls[0][0]).toContain('last_surfaced_at = now()');
    expect(c.query.mock.calls[0][1]).toEqual([[
      '123e4567-e89b-12d3-a456-426614174000',
      '00000000-0000-0000-0000-000000000001',
    ]]);
  });

  it('returns false + caches when column is missing (migration not applied)', async () => {
    const c = fakeClient(async () => {
      throw new Error('column "last_surfaced_at" does not exist');
    });
    const ok1 = await bumpLastSurfaced(c, ['123e4567-e89b-12d3-a456-426614174000']);
    expect(ok1).toBe(false);
    // Second call should not even hit the client (cached)
    const ok2 = await bumpLastSurfaced(c, ['123e4567-e89b-12d3-a456-426614174000']);
    expect(ok2).toBe(false);
    expect(c.query).toHaveBeenCalledTimes(1); // only the first call hit the client
  });

  it('returns false on transient PG error but does NOT cache', async () => {
    const c = fakeClient(async () => {
      throw new Error('connection terminated');
    });
    const ok1 = await bumpLastSurfaced(c, ['123e4567-e89b-12d3-a456-426614174000']);
    expect(ok1).toBe(false);
    const ok2 = await bumpLastSurfaced(c, ['123e4567-e89b-12d3-a456-426614174000']);
    expect(ok2).toBe(false);
    // BOTH calls hit the client — not cached
    expect(c.query).toHaveBeenCalledTimes(2);
  });
});

describe('bumpLastSurfacedSql (postgres-js template variant)', () => {
  it('no-ops on empty', async () => {
    const sql = vi.fn(async (..._args: unknown[]) => undefined);
    expect(await bumpLastSurfacedSql(sql as unknown as Parameters<typeof bumpLastSurfacedSql>[0], [])).toBe(true);
    expect(sql).not.toHaveBeenCalled();
  });

  it('runs UPDATE for valid uuid ids', async () => {
    const sql = vi.fn(async (..._args: unknown[]) => undefined);
    const ok = await bumpLastSurfacedSql(
      sql as unknown as Parameters<typeof bumpLastSurfacedSql>[0],
      ['123e4567-e89b-12d3-a456-426614174000'],
    );
    expect(ok).toBe(true);
    expect(sql).toHaveBeenCalledTimes(1);
    // Template strings carry the SQL fragments
    const tpl = sql.mock.calls[0][0] as TemplateStringsArray;
    expect(tpl.join('')).toContain('UPDATE harness_shared.memory_canonical');
    expect(tpl.join('')).toContain('last_surfaced_at = now()');
  });

  it('returns false + caches when column missing', async () => {
    const sql = vi.fn(async () => {
      throw new Error('column "last_surfaced_at" does not exist');
    });
    const ok1 = await bumpLastSurfacedSql(
      sql as unknown as Parameters<typeof bumpLastSurfacedSql>[0],
      ['123e4567-e89b-12d3-a456-426614174000'],
    );
    expect(ok1).toBe(false);
    const ok2 = await bumpLastSurfacedSql(
      sql as unknown as Parameters<typeof bumpLastSurfacedSql>[0],
      ['123e4567-e89b-12d3-a456-426614174000'],
    );
    expect(ok2).toBe(false);
    expect(sql).toHaveBeenCalledTimes(1); // cached
  });
});

describe('recentlySurfacedIds (the D-006 dedup watermark)', () => {
  const ID = '123e4567-e89b-12d3-a456-426614174000';

  it('no-ops on empty ids / non-positive window', async () => {
    const sql = vi.fn(async (..._args: unknown[]) => [{ id: ID }]);
    const tag = sql as unknown as Parameters<typeof recentlySurfacedIds>[0];
    expect((await recentlySurfacedIds(tag, [], 120_000)).size).toBe(0);
    expect((await recentlySurfacedIds(tag, [ID], 0)).size).toBe(0);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns the set of ids the query reports as recently surfaced', async () => {
    const sql = vi.fn(async (..._args: unknown[]) => [{ id: ID }]);
    const tag = sql as unknown as Parameters<typeof recentlySurfacedIds>[0];
    const recent = await recentlySurfacedIds(tag, [ID, '00000000-0000-0000-0000-000000000009'], 120_000);
    expect(recent.has(ID)).toBe(true);
    expect(recent.size).toBe(1);
    const tpl = sql.mock.calls[0][0] as TemplateStringsArray;
    expect(tpl.join('')).toContain('last_surfaced_at');
  });

  it('filters out non-uuid ids before querying', async () => {
    const sql = vi.fn(async () => []);
    const tag = sql as unknown as Parameters<typeof recentlySurfacedIds>[0];
    expect((await recentlySurfacedIds(tag, ['nope', 'bad id'], 120_000)).size).toBe(0);
    expect(sql).not.toHaveBeenCalled();
  });

  it('degrades to an empty set on error (never drops the whole injection)', async () => {
    const sql = vi.fn(async () => { throw new Error('connection terminated'); });
    const tag = sql as unknown as Parameters<typeof recentlySurfacedIds>[0];
    expect((await recentlySurfacedIds(tag, [ID], 120_000)).size).toBe(0);
  });
});

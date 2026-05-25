import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bumpLastSurfaced, _resetForTests } from './bump-last-surfaced';

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

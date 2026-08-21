/**
 * shared-snapshot.test — the cross-process shared-snapshot read/write semantics
 * (precompute-sync-reads-phase2 P-001). The recurrence guard for the cache that
 * lets a reader process serve SystemHealth from a plain SELECT instead of a
 * blocking 1.6-2.0s recompute. Only `@papercusp/db-org` is mocked; the sql tagged
 * template is a plain function that returns the canned rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

import { readSharedSnapshot, writeSharedSnapshot } from './shared-snapshot';

beforeEach(() => {
  h.sql.mockReset();
});

describe('readSharedSnapshot', () => {
  it('returns null on a miss (no row)', async () => {
    h.sql.mockResolvedValue([]);
    expect(await readSharedSnapshot('system.health', 'ws-1', 1, 60_000)).toBeNull();
  });

  it('returns null on a producer_version mismatch — a stale SHAPE is never fed to a reader', async () => {
    h.sql.mockResolvedValue([{ payload: { a: 1 }, computed_at: Date.now(), producer_version: 2 }]);
    expect(await readSharedSnapshot('system.health', 'ws-1', 1, 60_000)).toBeNull();
  });

  it('returns null when the row is older than maxAgeMs (a dead writer forces a local recompute)', async () => {
    h.sql.mockResolvedValue([{ payload: { a: 1 }, computed_at: Date.now() - 120_000, producer_version: 1 }]);
    expect(await readSharedSnapshot('system.health', 'ws-1', 1, 60_000)).toBeNull();
  });

  it('returns null when computed_at is 0/absent', async () => {
    h.sql.mockResolvedValue([{ payload: { a: 1 }, computed_at: 0, producer_version: 1 }]);
    expect(await readSharedSnapshot('system.health', 'ws-1', 1, 60_000)).toBeNull();
  });

  it('returns the payload + age on a fresh, version-matched hit', async () => {
    const computedAt = Date.now() - 5_000;
    h.sql.mockResolvedValue([{ payload: { hive: 'x' }, computed_at: computedAt, producer_version: 1 }]);
    const r = await readSharedSnapshot<{ hive: string }>('system.health', 'ws-1', 1, 60_000);
    expect(r?.payload).toEqual({ hive: 'x' });
    expect(r?.computedAt).toBe(computedAt);
    expect(r?.ageMs).toBeGreaterThanOrEqual(0);
    expect(r?.ageMs).toBeLessThan(60_000);
  });

  it('accepts a string epoch (postgres bigint marshals as text)', async () => {
    const computedAt = Date.now() - 1_000;
    h.sql.mockResolvedValue([{ payload: { hive: 'y' }, computed_at: String(computedAt), producer_version: 1 }]);
    const r = await readSharedSnapshot<{ hive: string }>('system.health', 'ws-1', 1, 60_000);
    expect(r?.payload).toEqual({ hive: 'y' });
    expect(r?.computedAt).toBe(computedAt);
  });
});

describe('writeSharedSnapshot', () => {
  it('upserts via a single sql call', async () => {
    h.sql.mockResolvedValue([]);
    await writeSharedSnapshot('system.health', 'ws-1', { hive: 'x' }, 1);
    expect(h.sql).toHaveBeenCalledTimes(1);
  });
});

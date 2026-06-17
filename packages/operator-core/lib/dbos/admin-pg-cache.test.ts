/**
 * Unit coverage for the shared admin-client LRU cache
 * (operator-scalability-event-loop P4-1 / app-wide-load-traps F-B1). The point of
 * the cache is to STOP opening a fresh `postgres()` pool per orchestrator tick +
 * per pipeline settle, so the tests assert: (a) a repeated (url, harness) reuses
 * the open client and never re-opens (the churn fix); (b) distinct harnesses /
 * urls key distinct clients; (c) the per-harness search_path; (d) LRU eviction
 * `.end()`s the least-recently-used client and recency is refreshed on access.
 *
 * The client factory is injected so the LRU logic is exercised with no live
 * Postgres — exactly the "pool-open counter for the churn fixes" the plan asks for.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  adminClientForHarness,
  _resetAdminPgCache,
  _adminPgCacheSize,
  ADMIN_PG_CACHE_MAX,
  type AdminPgFactory,
} from './admin-pg-cache';

type PgClientT = ReturnType<AdminPgFactory>;
interface FakeClient {
  id: string;
  end: ReturnType<typeof vi.fn>;
}

/** A fake factory that records every "pool open" so we can count churn. */
function makeFactory() {
  const created: Array<{ url: string; searchPath: string; client: FakeClient }> = [];
  const factory: AdminPgFactory = (url, searchPath) => {
    const client: FakeClient = { id: `c${created.length}`, end: vi.fn().mockResolvedValue(undefined) };
    created.push({ url, searchPath, client });
    return client as unknown as PgClientT;
  };
  return { factory, created };
}

beforeEach(() => {
  _resetAdminPgCache();
});

describe('adminClientForHarness', () => {
  it('reuses the open client for a repeated (url, harness) — no per-tick churn', () => {
    const { factory, created } = makeFactory();
    const a1 = adminClientForHarness('alpha', 'postgres://x', factory);
    const a2 = adminClientForHarness('alpha', 'postgres://x', factory);
    const a3 = adminClientForHarness('alpha', 'postgres://x', factory);
    expect(a1).toBe(a2);
    expect(a2).toBe(a3);
    expect(created).toHaveLength(1); // opened exactly once, then reused
  });

  it('keys distinct clients per harness, with a per-harness search_path', () => {
    const { factory, created } = makeFactory();
    const a = adminClientForHarness('alpha', 'postgres://x', factory);
    const b = adminClientForHarness('beta', 'postgres://x', factory);
    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);
    expect(created[0].searchPath).toBe('harness_alpha,harness_shared,public');
    expect(created[1].searchPath).toBe('harness_beta,harness_shared,public');
  });

  it('builds a fresh client when the url changes (embedded-pg port change on restart)', () => {
    const { factory, created } = makeFactory();
    const oldClient = adminClientForHarness('alpha', 'postgres://old', factory);
    const newClient = adminClientForHarness('alpha', 'postgres://new', factory);
    expect(oldClient).not.toBe(newClient);
    expect(created).toHaveLength(2);
  });

  it('evicts + ends the least-recently-used client once the cache is full', () => {
    const { factory, created } = makeFactory();
    for (let i = 0; i < ADMIN_PG_CACHE_MAX; i++) adminClientForHarness(`h${i}`, 'u', factory);
    expect(_adminPgCacheSize()).toBe(ADMIN_PG_CACHE_MAX);

    const oldest = created[0].client; // h0 — least recently used
    adminClientForHarness('overflow', 'u', factory); // evicts h0
    expect(_adminPgCacheSize()).toBe(ADMIN_PG_CACHE_MAX); // still capped
    expect(oldest.end).toHaveBeenCalledTimes(1);

    // h0 was evicted → a fresh open, not a cache hit.
    const before = created.length;
    adminClientForHarness('h0', 'u', factory);
    expect(created.length).toBe(before + 1);
  });

  it('refreshes LRU recency on access so a touched client survives eviction', () => {
    const { factory, created } = makeFactory();
    for (let i = 0; i < ADMIN_PG_CACHE_MAX; i++) adminClientForHarness(`h${i}`, 'u', factory);

    // Touch h0 → it becomes most-recently-used; h1 is now the LRU.
    const h0 = adminClientForHarness('h0', 'u', factory);
    adminClientForHarness('overflow', 'u', factory); // should evict h1, not h0

    expect(created[0].client.end).not.toHaveBeenCalled(); // h0 survived
    expect(created[1].client.end).toHaveBeenCalledTimes(1); // h1 evicted
    expect(adminClientForHarness('h0', 'u', factory)).toBe(h0); // still cached, same instance
  });
});

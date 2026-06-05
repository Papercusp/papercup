/**
 * Unit coverage for user-actions-data.ts (listUserActions + InvalidSlugError).
 *
 * Pure unit: `@papercusp/db-org` is mocked so `getOrgPg().db.select(...)`
 * resolves a fixed row set without a live Postgres. `generated` is kept real
 * (importActual) so the source's drizzle expression builders
 * (`eq(t.harnessSlug, …)`, `gte(t.startedAt, …)`, `desc(t.startedAt)`) resolve
 * against real columns — they're just ignored by the fluent stub.
 *
 * The fluent chain under test is:
 *   db.select({...}).from(t).where(...).orderBy(...).limit(N)
 * `.limit()` is the terminal awaitable that resolves the rows. We count how
 * many times it resolves (`dbHits`) to assert cache HIT / single-flight
 * COALESCED / LRU eviction behavior — each real DB round-trip increments it.
 *
 * The module's cache + inflight maps live on `globalThis`, so they survive
 * across tests in-process. `beforeEach` clears them for hermeticity, and the
 * captured limit value lets us assert the `min(500, max(1, …))` clamp.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mutable per-test controls, read inside the mock factory (hoisted, so these
// must be declared before the factory references them at call time).
let dbHits = 0;
let rowsToReturn: unknown[] = [];
let lastLimit: number | undefined;
let resolveGate: ((rows: unknown[]) => void) | null = null;

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as object;
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              lastLimit = n;
              dbHits++;
              // If a manual gate is armed, hand the resolver to the test so it
              // can control timing (for single-flight coalescing). Otherwise
              // resolve immediately with the configured rows.
              if (resolveGate) {
                const gate = resolveGate;
                return new Promise<unknown[]>((res) => {
                  gate(rowsToReturn);
                  // gate() above is the *signal*; the actual resolution is
                  // driven by the test calling the captured releaser.
                  releaser = (rows: unknown[]) => res(rows);
                });
              }
              return Promise.resolve(rowsToReturn);
            },
          }),
        }),
      }),
    }),
  };
  return { ...actual, getOrgPg: () => ({ db: fakeDb }) };
});

// Set by the gated-resolve path so a test can release the pending query.
let releaser: ((rows: unknown[]) => void) | null = null;

import { listUserActions, InvalidSlugError } from './user-actions-data';

// Reset the module-global cache + inflight maps so each test starts clean.
function clearGlobalCaches() {
  const g = globalThis as unknown as {
    __userActionsCache?: Map<string, unknown>;
    __userActionsInFlight?: Map<string, unknown>;
  };
  g.__userActionsCache?.clear();
  g.__userActionsInFlight?.clear();
}

beforeEach(() => {
  dbHits = 0;
  rowsToReturn = [];
  lastLimit = undefined;
  resolveGate = null;
  releaser = null;
  clearGlobalCaches();
});

describe('InvalidSlugError / SLUG_RE validation', () => {
  it('throws InvalidSlugError before hitting the DB for a slug that fails SLUG_RE', async () => {
    await expect(listUserActions({ slug: 'has spaces' })).rejects.toBeInstanceOf(InvalidSlugError);
    // No DB round-trip should have occurred.
    expect(dbHits).toBe(0);
  });

  it('rejects an empty slug, a leading-dot slug, and an over-long slug', async () => {
    await expect(listUserActions({ slug: '' })).rejects.toBeInstanceOf(InvalidSlugError);
    await expect(listUserActions({ slug: '.starts-with-dot' })).rejects.toBeInstanceOf(InvalidSlugError);
    await expect(listUserActions({ slug: 'a'.repeat(65) })).rejects.toBeInstanceOf(InvalidSlugError);
    expect(dbHits).toBe(0);
  });

  it('the thrown error carries the offending slug in its message', async () => {
    await expect(listUserActions({ slug: 'bad/slug' })).rejects.toThrow('invalid slug: bad/slug');
  });

  it('accepts a valid slug (alphanumerics, dot, underscore, hyphen) and queries the DB', async () => {
    await expect(listUserActions({ slug: 'my-app_v2.0' })).resolves.toBeTruthy();
    expect(dbHits).toBe(1);
  });
});

describe('limit clamp: min(500, max(1, n))', () => {
  it('defaults to 50 when limit is omitted', async () => {
    await listUserActions({ slug: 'def' });
    expect(lastLimit).toBe(50);
  });

  it('treats 0 as the default 50 (falsy → `|| 50` short-circuits before the max(1,…) floor)', async () => {
    // Math.min(500, Math.max(1, Number(0 ?? 50) || 50)) === Math.min(500, Math.max(1, 50)) === 50.
    // The `|| 50` consumes the falsy 0, so the max(1,…) floor never sees it — 0 maps to 50, not 1.
    await listUserActions({ slug: 'zero', limit: 0 });
    expect(lastLimit).toBe(50);
  });

  it('clamps a huge value down to 500', async () => {
    await listUserActions({ slug: 'huge', limit: 9999 });
    expect(lastLimit).toBe(500);
  });

  it('clamps a negative value up to 1', async () => {
    await listUserActions({ slug: 'neg', limit: -5 });
    expect(lastLimit).toBe(1);
  });

  it('coerces a NaN/non-numeric limit to the default 50', async () => {
    await listUserActions({ slug: 'nan', limit: Number.NaN });
    expect(lastLimit).toBe(50);
  });

  it('passes a normal in-range limit through unchanged', async () => {
    await listUserActions({ slug: 'mid', limit: 123 });
    expect(lastLimit).toBe(123);
  });
});

describe('row mapping', () => {
  it('maps the DbRow snake_case shape into the UserActionRow camelCase shape', async () => {
    rowsToReturn = [
      {
        id: '42',
        harness_slug: 'app',
        kind: 'deploy',
        status: 'ok',
        summary: 'did a thing',
        detail_url: '/x',
        error_text: null,
        invocation_id: 'inv-1',
        started_at: '1700000000000',
        finished_at: '1700000005000',
        actor: 'user',
      },
    ];
    const res = await listUserActions({ slug: 'app' });
    expect(res.actions).toEqual([
      {
        id: 42,
        kind: 'deploy',
        status: 'ok',
        summary: 'did a thing',
        detailUrl: '/x',
        errorText: null,
        invocationId: 'inv-1',
        startedAt: 1700000000000,
        finishedAt: 1700000005000,
        actor: 'user',
      },
    ]);
  });

  it('maps a null finished_at to null (not 0)', async () => {
    rowsToReturn = [
      {
        id: '7',
        harness_slug: 'app',
        kind: 'k',
        status: 's',
        summary: null,
        detail_url: null,
        error_text: null,
        invocation_id: null,
        started_at: '100',
        finished_at: null,
        actor: null,
      },
    ];
    const res = await listUserActions({ slug: 'app' });
    expect(res.actions[0].finishedAt).toBeNull();
    expect(res.actions[0].startedAt).toBe(100);
  });
});

describe('cache behavior', () => {
  it('first call is a MISS, an identical call within TTL is a HIT with no second DB hit', async () => {
    rowsToReturn = [];
    const first = await listUserActions({ slug: 'cached', limit: 10 });
    expect(first.cacheStatus).toBe('MISS');
    expect(dbHits).toBe(1);

    const second = await listUserActions({ slug: 'cached', limit: 10 });
    expect(second.cacheStatus).toBe('HIT');
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(dbHits).toBe(1); // still 1 — served from cache
    // HIT returns the same payload reference stored on MISS.
    expect(second.actions).toBe(first.actions);
  });

  it('different cache keys (slug / limit / since) each trigger their own DB hit', async () => {
    await listUserActions({ slug: 'a', limit: 10 });
    await listUserActions({ slug: 'b', limit: 10 }); // different slug
    await listUserActions({ slug: 'a', limit: 20 }); // different limit
    await listUserActions({ slug: 'a', limit: 10, since: 5 }); // different since
    expect(dbHits).toBe(4);
    // Re-issuing the very first key is now a cache HIT.
    const again = await listUserActions({ slug: 'a', limit: 10 });
    expect(again.cacheStatus).toBe('HIT');
    expect(dbHits).toBe(4);
  });

  it('coalesces concurrent identical calls into a single DB round-trip (single-flight)', async () => {
    // Arm the gate so the query promise stays pending until we release it.
    let signalled = false;
    resolveGate = () => {
      signalled = true;
    };
    rowsToReturn = [];

    const p1 = listUserActions({ slug: 'coalesce', limit: 10 });
    // Yield so p1 registers itself in the inflight map before p2 starts.
    await Promise.resolve();
    const p2 = listUserActions({ slug: 'coalesce', limit: 10 });

    // Both are in flight; exactly one DB round-trip was started.
    expect(signalled).toBe(true);
    expect(dbHits).toBe(1);

    // Release the single underlying query.
    releaser?.([]);

    const [r1, r2] = await Promise.all([p1, p2]);
    // Still exactly one DB hit despite two concurrent callers.
    expect(dbHits).toBe(1);
    // One of them is the MISS owner, the other is COALESCED.
    const statuses = [r1.cacheStatus, r2.cacheStatus].sort();
    expect(statuses).toEqual(['COALESCED', 'MISS']);
  });

  it('evicts the oldest entry once the cache grows past 64 entries (LRU floor)', async () => {
    // Fill 65 distinct cache keys. The cache caps at 64 by evicting the oldest.
    rowsToReturn = [];
    for (let i = 0; i < 65; i++) {
      await listUserActions({ slug: `lru-${i}`, limit: 10 });
    }
    const g = globalThis as unknown as { __userActionsCache?: Map<string, unknown> };
    expect(g.__userActionsCache?.size).toBe(64);
    // The very first inserted key (oldest) was evicted, so re-requesting it
    // is a fresh MISS (a new DB hit), while a recent key is still a HIT.
    const beforeHits = dbHits;
    const evicted = await listUserActions({ slug: 'lru-0', limit: 10 });
    expect(evicted.cacheStatus).toBe('MISS');
    expect(dbHits).toBe(beforeHits + 1);

    const recent = await listUserActions({ slug: 'lru-64', limit: 10 });
    expect(recent.cacheStatus).toBe('HIT');
  });
});

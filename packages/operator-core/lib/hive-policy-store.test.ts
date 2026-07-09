/**
 * hive-policy-store — unit tests for {@link getHivePolicyCached} (EI-8685: p2p-perf
 * `merge.delta-tick` regression — deltaTick1Ms 0.137ms → 33.483ms, +24340%).
 *
 * Root cause: `boot.ts`'s `mergeOnePass` read the owner-signed Hive policy via
 * `getHivePolicy` (a raw, uncached PG round-trip) ONCE per non-idle merge pass — but a
 * bg-host driving back-to-back cheap ticks (P-013) pays that PG round-trip on EVERY tick.
 * `getHivePolicyCached` wraps it with a short-TTL in-memory cache. These tests lock in the
 * caching contract directly (no PG — a stubbed `Sql.unsafe`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { _resetHivePolicyCacheForTests, getHivePolicyCached } from './hive-policy-store';

const WS = 'ws';
const HOME = 'home';

function makeSqlStub(rows: unknown[]) {
  let calls = 0;
  const sql = {
    unsafe: async (_query: string, _params: unknown[]) => {
      calls += 1;
      return rows;
    },
  } as unknown as Sql;
  return { sql, getCalls: () => calls };
}

describe('getHivePolicyCached (EI-8685)', () => {
  beforeEach(() => {
    _resetHivePolicyCacheForTests();
  });

  it('caches within the TTL window — a second call does NOT re-query PG', async () => {
    const { sql, getCalls } = makeSqlStub([]);
    const first = await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 });
    const second = await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(getCalls()).toBe(1);
  });

  it('re-queries once the TTL has elapsed', async () => {
    const { sql, getCalls } = makeSqlStub([]);
    await getHivePolicyCached(WS, HOME, { sql, ttlMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    await getHivePolicyCached(WS, HOME, { sql, ttlMs: 5 });
    expect(getCalls()).toBe(2);
  });

  it('caches per (workspaceId, potHomeSlug) — different scopes query independently', async () => {
    const { sql, getCalls } = makeSqlStub([]);
    await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 });
    await getHivePolicyCached(WS, 'other-home', { sql, ttlMs: 2000 });
    await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 }); // still within TTL, hits cache
    expect(getCalls()).toBe(2);
  });

  it('_resetHivePolicyCacheForTests clears the cache — forces a re-query', async () => {
    const { sql, getCalls } = makeSqlStub([]);
    await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 });
    _resetHivePolicyCacheForTests();
    await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 });
    expect(getCalls()).toBe(2);
  });

  it('returns the same resolved-policy shape an uncached read would', async () => {
    const row = {
      workspace_id: WS,
      harness_slug: HOME,
      policy_json: '{}',
      owner_pubkey: 'pk',
      signature: 'sig',
      policy_version: 3,
      fed_hlc: 'h1',
      updated_at: 123,
    };
    const { sql } = makeSqlStub([row]);
    const resolved = await getHivePolicyCached(WS, HOME, { sql, ttlMs: 2000 });
    expect(resolved?.policyVersion).toBe(3);
    expect(resolved?.policy).toEqual({});
    expect(resolved?.ownerPubkey).toBe('pk');
  });

  it('defaults ttlMs to 2000ms when not supplied', async () => {
    const { sql, getCalls } = makeSqlStub([]);
    await getHivePolicyCached(WS, HOME, { sql });
    await getHivePolicyCached(WS, HOME, { sql });
    expect(getCalls()).toBe(1); // still within the default 2s TTL
  });
});

/**
 * operator-state-cache.test.ts — the readOperatorState cache
 * (infra-perf-robustness-audit-2026-06-18 P-004). harness_registry is read on hot
 * paths (~13.8M seq-scans/window) but written rarely; a tiny per-(table,ws) TTL
 * cache cuts the round-trips. These pin: (a) a cache HIT avoids a 2nd SELECT,
 * (b) a write INVALIDATES so the same process never reads stale (read-after-write),
 * (c) only the allowlist (harness_registry) is cached, (d) PAPERCUSP_OPSTATE_CACHE_MS=0
 * is the kill-switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const counters = { selects: 0 };

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('./db-encryption', () => ({ ENCRYPTED_TABLES: new Set<string>(), getDbEncryptionKey: () => 'unused' }));
vi.mock('@papercusp/db-org', () => {
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    const tableName = (values[0] as { _table?: string })?._table ?? null;
    const ws = typeof values[1] === 'string' ? values[1] : 'ws';
    const key = `${tableName}:${ws}`;
    if (/SELECT payload FROM/.test(sqlText)) {
      counters.selects += 1;
      const row = store.get(key);
      return Promise.resolve(row !== undefined ? [{ payload: row }] : []);
    }
    if (/INSERT INTO/.test(sqlText)) {
      const raw = values[2];
      store.set(key, typeof raw === 'string' ? JSON.parse(raw) : raw);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }
  function sqlCallable(strs: TemplateStringsArray | string, ..._rest: unknown[]): unknown {
    if (typeof strs === 'string') return { _table: /harness_shared\.([a-zA-Z0-9_]+)/.exec(strs)?.[1] ?? null };
    return tagged(strs as TemplateStringsArray, ..._rest);
  }
  const wrapped = sqlCallable as unknown as typeof tagged;
  (wrapped as unknown as { begin: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> }).begin = async <T>(
    cb: (tx: unknown) => Promise<T>,
  ) => cb(wrapped);
  return { getOrgPg: () => ({ sql: wrapped, db: {} }) };
});

import { readOperatorState, writeOperatorState, invalidateOperatorStateCache } from './operator-state-pg';

beforeEach(() => {
  store.clear();
  counters.selects = 0;
  delete process.env.PAPERCUSP_OPSTATE_CACHE_MS;
  // Start each test with a clean cache for the keys it uses.
  invalidateOperatorStateCache('harness_registry' as never, 'ws');
  invalidateOperatorStateCache('operator_budget' as never, 'ws');
});
afterEach(() => {
  delete process.env.PAPERCUSP_OPSTATE_CACHE_MS;
});

describe('readOperatorState cache (P-004)', () => {
  it('caches an allowlisted table: a 2nd read within TTL hits the cache (no 2nd SELECT)', async () => {
    store.set('harness_registry:ws', { projects: [{ slug: 'a' }] });
    const first = await readOperatorState<{ projects: unknown[] }>('harness_registry');
    const second = await readOperatorState<{ projects: unknown[] }>('harness_registry');
    expect(first).toEqual({ projects: [{ slug: 'a' }] });
    expect(second).toEqual(first);
    expect(counters.selects).toBe(1); // 2nd served from cache
  });

  it('a write invalidates: the next read re-SELECTs and sees the new value (read-after-write)', async () => {
    store.set('harness_registry:ws', { projects: [] });
    await readOperatorState('harness_registry'); // populates cache (select #1)
    await writeOperatorState('harness_registry', { projects: [{ slug: 'new' }] }); // invalidates
    const after = await readOperatorState<{ projects: { slug: string }[] }>('harness_registry'); // select #2
    expect(after).toEqual({ projects: [{ slug: 'new' }] });
    expect(counters.selects).toBe(2); // not served stale from cache
  });

  it('does NOT cache a non-allowlisted table (always SELECTs)', async () => {
    store.set('operator_budget:ws', { spent: 1 });
    await readOperatorState('operator_budget');
    await readOperatorState('operator_budget');
    expect(counters.selects).toBe(2); // every read hits PG
  });

  it('PAPERCUSP_OPSTATE_CACHE_MS=0 is the kill-switch (caching disabled)', async () => {
    process.env.PAPERCUSP_OPSTATE_CACHE_MS = '0';
    store.set('harness_registry:ws', { projects: [] });
    await readOperatorState('harness_registry');
    await readOperatorState('harness_registry');
    expect(counters.selects).toBe(2); // no caching with TTL=0
  });
});

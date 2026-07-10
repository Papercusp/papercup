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

// WI-1383 companion test seam: joinerPotHomeSlug's registry-not-hive fallback would
// otherwise reach real ./hive-store / ./hive-directory-meta modules (org-PG-backed) —
// neither is exercised by the registry-only scenario below (potHomeSlugForHarness
// answers from the registry entry directly), so these are trivial stand-ins purely to
// let the import graph resolve without a real DB, mirroring hive-federation.test.ts.
vi.mock('./hive-store', () => ({ getHiveBySlug: async () => null }));
vi.mock('./hive-directory-meta', () => ({ getOwnedHiveMeta: async () => null }));

import { readOperatorState, writeOperatorState, invalidateOperatorStateCache } from './operator-state-pg';
import { loadHarnessRegistry } from './harness-registry';
import { joinerPotHomeSlug } from './hive-federation';

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

/**
 * WI-1383 — in-process regression for the WI-1378 federation roster-empty bug
 * (companion to owner-roster-rebind-race.repro.integration.test.ts, which reproduces
 * the SAME symptom via a full real-swarm boot; this file reproduces the actual ROOT
 * CAUSE — the cross-process opStateCache staleness itself — with no PG/swarm needed).
 *
 * ## The bug
 * `resolveHiveHomeProjectionSlug` (boot.ts) runs on the in-place rekey INSIDE the
 * substrate SIDECAR process (SUBSTRATE_SIDECAR) — a DIFFERENT process from join-hive's
 * registry WRITE. `invalidateOperatorStateCache` only clears the CACHE OF THE PROCESS
 * THAT WROTE — it can't reach the sidecar's own in-memory `opStateCache`. So if the
 * sidecar had already warmed its cache with the pre-join registry (any earlier
 * `loadHarnessRegistry` call, e.g. at boot), a DEFAULT (non-`fresh`) read after the
 * join still returns the STALE pre-join registry: `joinerPotHomeSlug` sees no
 * `hive_slug`/`remote_hive` yet → resolves null → the rekey rebind block skips →
 * `forceReFold` never fires → the member-slug projection binding latches → the
 * owner's `hive_members` rows drop forever (roster empty until a restart cold-read).
 *
 * ## The fix
 * `resolveHiveHomeProjectionSlug` passes `{ fresh: true }` through
 * `joinerPotHomeSlug` → `potHomeSlugForHarness` → `loadHarnessRegistry` →
 * `readOperatorState`, bypassing the cache READ (while still refreshing the cache
 * entry) so the sidecar sees the just-committed cross-process write immediately.
 *
 * ## Teeth
 * Dropping `{ fresh: true }` anywhere on that call chain (or reverting the
 * `!opts?.fresh` cache-bypass gate in `readOperatorState`) makes the "default resolve
 * stays stale" assertions below pass but the "`{ fresh: true }` sees the join"
 * assertions FAIL — pinning the fix's teeth without needing a live 2-process rig.
 */
describe('WI-1378/WI-1383: cross-process opStateCache staleness — the no-restart federation roster-empty repro', () => {
  it('readOperatorState: a default (cached) read stays stale after a cross-process write; { fresh:true } sees it immediately and refreshes the cache', async () => {
    // "Process A" (this test) warms the cache with the PRE-join registry — mirrors the
    // sidecar's own hot loadHarnessRegistry() call at boot, before the join happens.
    store.set('harness_registry:ws', { projects: [{ slug: 'member-a' }] });
    const primed = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
    );
    expect(primed?.projects[0]?.hive_slug).toBeUndefined();
    expect(counters.selects).toBe(1);

    // "Process B" (the main operator's join-hive flow, in production) commits the join
    // DIRECTLY on the backing store — simulating a write from a DIFFERENT process,
    // which never invalidates THIS process's in-memory opStateCache (that
    // invalidation is same-process only; see readOperatorState's WI-1378 comment).
    store.set('harness_registry:ws', {
      projects: [{ slug: 'member-a', hive_slug: 'the-hive' }],
    });

    // BUG repro: a default (cached) read is still served from the warm cache and does
    // NOT see the just-committed cross-process join.
    const staleRead = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
    );
    expect(
      staleRead?.projects[0]?.hive_slug,
      'a default (cached) read must still see the PRE-join registry — else this test no ' +
        'longer reproduces the cross-process staleness the WI-1378 bug depended on',
    ).toBeUndefined();
    expect(counters.selects, 'served from cache — no 2nd SELECT').toBe(1);

    // FIX: { fresh:true } (as boot.ts's sidecar rekey resolve now passes) bypasses the
    // stale cache and sees the committed join immediately.
    const freshRead = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
      undefined,
      { fresh: true },
    );
    expect(freshRead?.projects[0]?.hive_slug).toBe('the-hive');
    expect(counters.selects, 'fresh:true forces a real SELECT').toBe(2);

    // The fresh read also REFRESHES the cache entry, so a subsequent default reader
    // (e.g. the hot loadHarnessRegistry() callers that never pass fresh) now sees it too.
    const afterFresh = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
    );
    expect(afterFresh?.projects[0]?.hive_slug).toBe('the-hive');
    expect(counters.selects, 'served from the now-refreshed cache — no 3rd SELECT').toBe(2);
  });

  it('joinerPotHomeSlug: the joiner-home gate stays null on the stale cache (the live "roster stays empty" symptom); { fresh:true } resolves it', async () => {
    // Pre-join: member-a is a plain (non-member) harness. Prime the cache via a
    // loadHarnessRegistry() call, mirroring a hot boot-time read.
    store.set('harness_registry:ws', { projects: [{ slug: 'member-a' }] });
    await loadHarnessRegistry('ws');

    // The join commits from a DIFFERENT process (see the test above) — member-a
    // becomes a member of the-hive, a remote_hive (joined) view.
    store.set('harness_registry:ws', {
      projects: [
        { slug: 'the-hive', harness_kind: 'hive', remote_hive: true },
        { slug: 'member-a', hive_slug: 'the-hive' },
      ],
    });

    // BUG repro: the default resolve (no fresh) — what boot.ts's rekey resolve did
    // BEFORE the WI-1378 fix — still reads the stale pre-join registry, so the
    // joiner-home rebind gate stays null. This is the exact live symptom: the rekey
    // rebind block skips, forceReFold never fires, the owner's roster rows drop
    // forever.
    expect(
      await joinerPotHomeSlug('ws', 'member-a'),
      'a default (non-fresh) resolve must reproduce the stale-cache null — the ' +
        'pre-WI-1378 behavior that left the joiner roster empty',
    ).toBeNull();

    // FIX: { fresh:true } (boot.ts resolveHiveHomeProjectionSlug's WI-1378 fix) sees
    // the committed join immediately and resolves the hive-home slug — the rebind can
    // now engage.
    expect(await joinerPotHomeSlug('ws', 'member-a', { fresh: true })).toBe('the-hive');
  });
});

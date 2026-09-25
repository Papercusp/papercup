/**
 * read-merge-stored-order-prefetch.test.ts — p2p-join-catchup-speed-2026-09-23 P-002
 * (WI-10002479).
 *
 * The incremental merge may look up the STORED PG order of upcoming keys and skip an
 * op that is strictly older than its stored row, instead of paying an apply the
 * projection's LWW guard would reject. This file pins the contract:
 *
 *   1. Equivalence: with or without the prefetch, the final store is identical.
 *   2. Only STRICTLY-older ops are skipped; equal clocks and newer ops still apply.
 *   3. A delete with neither hlc nor ts (unguarded in SQL) is never skipped.
 *   4. Look-ahead reads are consumed by the fold (one read per position).
 *   5. A failing lookup degrades to today's behavior.
 *   6. A failing apply holds the cursor at that op's position, prefetch or not.
 *
 * The fake store below mirrors the SQL guards: put wins when its order key is
 * greater or equal (the SQL tie-break is modeled as "apply"), a guarded del deletes
 * when its key is >= the stored key, and an unguarded del always deletes.
 */

import { describe, expect, it, vi } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import type { StoredFedOrder, StoredOrderLookupEntry } from './projection';
import { mulberry32 } from './perf/corpus';

interface Row {
  hlc: string | null;
  ts: number | null;
  value: unknown;
}

function orderKey(hlc: string | null | undefined, ts: number | null | undefined): string {
  return hlc ?? encodeHlc({ ms: ts ?? 0, count: 0 });
}

/** A PG-shaped LWW store keyed by `${table}::${key}`. */
function fakeStore(initial?: Map<string, Row>) {
  const rows = new Map<string, Row>(initial ?? []);
  const applied: string[] = [];
  const apply = async (env: OpEnvelope): Promise<boolean> => {
    const gk = `${env.table}::${env.hbKey}`;
    applied.push(gk);
    const stored = rows.get(gk);
    const hlc = env.hlc ?? null;
    const ts = env.ts ?? null;
    if (env.type === 'del') {
      if (!stored) return false;
      if ((hlc == null && ts == null) || orderKey(hlc, ts) >= orderKey(stored.hlc, stored.ts)) {
        rows.delete(gk);
        return true;
      }
      return false;
    }
    if (stored && orderKey(hlc, ts) < orderKey(stored.hlc, stored.ts)) return false;
    rows.set(gk, { hlc, ts, value: env.value });
    return true;
  };
  const prefetch = async (entries: readonly StoredOrderLookupEntry[]) => {
    const out = new Map<string, StoredFedOrder>();
    for (const { table, key } of entries) {
      const r = rows.get(`${table}::${key}`);
      if (r) out.set(`${table}::${key}`, { hlc: r.hlc, ts: r.ts });
    }
    return out;
  };
  return { rows, applied, apply, prefetch };
}

function memLog(keyHex: string, ops: PeerLogOp[]) {
  const reads: number[] = [];
  const log: AdmittedLog & { reads: number[] } = {
    keyHex,
    reads,
    get length() {
      return ops.length;
    },
    async get(i: number) {
      reads.push(i);
      return ops[i] ?? null;
    },
  };
  return log;
}

function put(key: string, ts: number, value: unknown = { v: ts }): PeerLogOp {
  return { type: 'put', table: 'engineer-issues', hbKey: key, value, ts, schema_version: 1, author_pubkey: 'a'.repeat(64) };
}

function del(key: string, ts: number | undefined): PeerLogOp {
  return { type: 'del', table: 'engineer-issues', hbKey: key, ts: ts as number, schema_version: 1, author_pubkey: 'a'.repeat(64) };
}

async function drain(logs: AdmittedLog[], apply: (e: OpEnvelope) => Promise<boolean>, prefetch?: ReturnType<typeof fakeStore>['prefetch']) {
  const cursor = createMergeCursor();
  let skips = 0;
  for (let guard = 0; guard < 500; guard++) {
    const res = await mergeAdmittedLogsIncremental(logs, cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
      maxOpsPerPass: 97,
      ...(prefetch ? { prefetchStoredOrder: prefetch, storedOrderPrefetchWindow: 31 } : {}),
    });
    skips += res.storedOrderSkips ?? 0;
    if (res.caughtUp) break;
  }
  return skips;
}

describe('stored-order prefetch (P-002)', () => {
  it('lands on the identical store with and without the prefetch (fuzz, pre-populated store)', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rnd = mulberry32(seed);
      const keys = Array.from({ length: 40 }, (_, i) => `papercusp/WI-${i}`);
      const mkOps = (n: number): PeerLogOp[] =>
        Array.from({ length: n }, () => {
          const key = keys[Math.floor(rnd() * keys.length)]!;
          const ts = 1_000 + Math.floor(rnd() * 5_000);
          // Guarded deletes only: with those, LWW is order-independent and the plain
          // fold is an exact oracle. The unguarded delete is pinned separately below.
          return rnd() < 0.1 ? del(key, ts) : put(key, ts);
        });
      const opsA = mkOps(400);
      const opsB = mkOps(400);
      // A database cloned "later": half the keys already hold a row, some newer than
      // everything in the logs, some older, some at an exactly equal ts.
      const initial = new Map<string, Row>();
      for (const k of keys) {
        const r = rnd();
        if (r < 0.2) initial.set(`engineer-issues::${k}`, { hlc: null, ts: 10_000, value: 'newer' });
        else if (r < 0.4) initial.set(`engineer-issues::${k}`, { hlc: null, ts: 500, value: 'older' });
        else if (r < 0.5) initial.set(`engineer-issues::${k}`, { hlc: null, ts: 3_000, value: 'mid' });
      }

      const plain = fakeStore(initial);
      await drain([memLog('a'.repeat(64), opsA), memLog('b'.repeat(64), opsB)], plain.apply);

      const fast = fakeStore(initial);
      const skips = await drain([memLog('a'.repeat(64), opsA), memLog('b'.repeat(64), opsB)], fast.apply, fast.prefetch);

      expect([...fast.rows.entries()].sort()).toEqual([...plain.rows.entries()].sort());
      expect(fast.applied.length).toBeLessThan(plain.applied.length);
      expect(skips).toBeGreaterThan(0);
    }
  });

  it('skips an op strictly older than its stored row without calling apply', async () => {
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 1_000, value: 'stored' }]]));
    const skips = await drain([memLog('a'.repeat(64), [put('papercusp/WI-1', 500)])], store.apply, store.prefetch);
    expect(store.applied).toEqual([]);
    expect(skips).toBe(1);
    expect(store.rows.get('engineer-issues::papercusp/WI-1')?.value).toBe('stored');
  });

  it('still applies an op whose clock EQUALS the stored row (the SQL tie-break decides)', async () => {
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 1_000, value: 'stored' }]]));
    await drain([memLog('a'.repeat(64), [put('papercusp/WI-1', 1_000, 'incoming')])], store.apply, store.prefetch);
    expect(store.applied).toEqual(['engineer-issues::papercusp/WI-1']);
  });

  it('still applies a newer op', async () => {
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 1_000, value: 'stored' }]]));
    await drain([memLog('a'.repeat(64), [put('papercusp/WI-1', 2_000, 'incoming')])], store.apply, store.prefetch);
    expect(store.rows.get('engineer-issues::papercusp/WI-1')?.value).toBe('incoming');
  });

  it('never skips an unguarded delete (no hlc, no ts), even against a newer stored row', async () => {
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 9_000, value: 'stored' }]]));
    await drain([memLog('a'.repeat(64), [del('papercusp/WI-1', undefined)])], store.apply, store.prefetch);
    expect(store.applied).toEqual(['engineer-issues::papercusp/WI-1']);
    expect(store.rows.has('engineer-issues::papercusp/WI-1')).toBe(false);
  });

  it('matches serial PG application when an unguarded delete sits between stale puts', async () => {
    // Oracle: every op applied to the store in log order, which is what PG does
    // with no in-memory gate at all.
    const initial = new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 10_000, value: 'stored' } as Row]]);
    const ops = [put('papercusp/WI-1', 2_000, 'p2000'), del('papercusp/WI-1', undefined), put('papercusp/WI-1', 1_500, 'p1500')];
    const oracle = fakeStore(initial);
    for (const op of ops) {
      await oracle.apply({ ...op, writerPubkey: op.author_pubkey, sourceLogKeyHex: 'a'.repeat(64) } as OpEnvelope);
    }
    const fast = fakeStore(initial);
    await drain([memLog('a'.repeat(64), ops)], fast.apply, fast.prefetch);
    expect(oracle.rows.get('engineer-issues::papercusp/WI-1')?.value).toBe('p1500');
    expect([...fast.rows.entries()]).toEqual([...oracle.rows.entries()]);
  });

  it('compares by hlc when the stored row carries one, exactly like fed_order_key', async () => {
    const storedHlc = encodeHlc({ ms: 2_000, count: 3 });
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: storedHlc, ts: 1, value: 'stored' }]]));
    const older = { ...put('papercusp/WI-1', 99_999), hlc: encodeHlc({ ms: 2_000, count: 2 }) };
    const newer = { ...put('papercusp/WI-1', 1, 'incoming'), hlc: encodeHlc({ ms: 2_000, count: 4 }) };
    await drain([memLog('a'.repeat(64), [older, newer])], store.apply, store.prefetch);
    expect(store.applied).toEqual(['engineer-issues::papercusp/WI-1']);
    expect(store.rows.get('engineer-issues::papercusp/WI-1')?.value).toBe('incoming');
  });

  it('reads each log position once: look-ahead reads are consumed by the fold', async () => {
    const ops = Array.from({ length: 200 }, (_, i) => put(`papercusp/WI-${i % 17}`, 1_000 + i));
    const log = memLog('a'.repeat(64), ops);
    const store = fakeStore();
    await drain([log], store.apply, store.prefetch);
    expect(log.reads.length).toBe(ops.length);
    expect(new Set(log.reads).size).toBe(ops.length);
  });

  it('degrades to the plain fold when the lookup throws', async () => {
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 1_000, value: 'stored' }]]));
    const failing = async () => {
      throw new Error('lookup unavailable');
    };
    const skips = await drain([memLog('a'.repeat(64), [put('papercusp/WI-1', 500)])], store.apply, failing);
    expect(skips).toBe(0);
    expect(store.applied).toEqual(['engineer-issues::papercusp/WI-1']);
    expect(store.rows.get('engineer-issues::papercusp/WI-1')?.value).toBe('stored');
  });

  it('holds the cursor at a failing apply in a prefetched window', async () => {
    // WI-1 is stale against its stored row (the seed skips it), WI-2 applies, WI-3's apply throws.
    const store = fakeStore(new Map([['engineer-issues::papercusp/WI-1', { hlc: null, ts: 1_000, value: 'stored' }]]));
    const apply = async (env: OpEnvelope): Promise<boolean> => {
      if (env.hbKey === 'papercusp/WI-3') throw new Error('apply failed');
      return store.apply(env);
    };
    const log = memLog('a'.repeat(64), [
      put('papercusp/WI-1', 500),
      put('papercusp/WI-2', 1_001),
      put('papercusp/WI-3', 1_002),
      put('papercusp/WI-4', 1_003),
    ]);
    const cursor = createMergeCursor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: apply,
        getTimeoutMs: 0,
        prefetchStoredOrder: store.prefetch,
        storedOrderPrefetchWindow: 31,
      });
      expect(res.storedOrderSkips).toBe(1);
      expect(res.caughtUp).toBe(false);
      expect(cursor.positions.get(log.keyHex)).toBe(2);
      expect(cursor.applyFailures?.get(log.keyHex)).toMatchObject({ position: 2 });
      expect(store.applied).not.toContain('engineer-issues::papercusp/WI-1');
      expect(store.rows.get('engineer-issues::papercusp/WI-2')?.ts).toBe(1_001);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('omits storedOrderSkips when the option is absent (result shape unchanged)', async () => {
    const store = fakeStore();
    const res = await mergeAdmittedLogsIncremental([memLog('a'.repeat(64), [put('papercusp/WI-1', 1)])], createMergeCursor(), {
      applyImpl: store.apply,
      getTimeoutMs: 0,
    });
    // `snapshotChunksJumped` (P-533) is always reported; only the P-002 counter is optional.
    expect(res).toEqual({ applied: 1, decoded: 1, caughtUp: true, truncated: false, snapshotChunksJumped: 0 });
  });
});

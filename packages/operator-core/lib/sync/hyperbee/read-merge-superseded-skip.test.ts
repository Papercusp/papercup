/**
 * read-merge-superseded-skip.test.ts — p2p-join-catchup-speed-2026-09-23 P-528 (D-018 #3).
 *
 * The incremental merge may skip a put that a later put on the same key, in the same
 * look-ahead window, beats under LWW. This file pins the contract:
 *
 *   1. Equivalence: over randomized op streams (deletes, declined puts, deferred puts,
 *      budgets and windows that cut passes mid-stream) the final store equals the plain
 *      fold's, with and without the stored-order prefetch.
 *   2. No persisted position ever passes a skipped put whose superseder has not applied
 *      and committed, including the intra-pass persist.
 *   3. A superseder that does not apply (declined, deferred, lost batch) makes its group
 *      replay in log order from the skipped put, so the row shows what the plain fold
 *      shows while the superseder waits.
 *   4. A delete, an unread look-ahead position, or a key the projection does not allow
 *      stops a skip.
 *
 * The fake store mirrors the SQL guards: a put wins when its order key is greater or
 * equal, a guarded delete deletes when its key is greater or equal. A put whose value
 * says `decline` is refused (the sink resolves false, writing nothing), and one whose
 * value says `deferFor: n` is deferred (dependency-waiting) on its first n attempts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { encodeHlc } from '@papercusp/locks-core';
import { buildSnapshotOps } from './log-snapshot';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  MERGE_PERSIST_EVERY_OPS,
  type AdmittedLog,
  type IncrementalMergeOpts,
  type MergeApplyOutcome,
  type MergeCursor,
} from './read-merge';
import { projectionSql, type StoredFedOrder, type StoredOrderLookupEntry } from './projection';
import { mulberry32 } from './perf/corpus';

const TABLE = 'engineer-issues';
const AUTHOR = 'a'.repeat(64);

interface Row {
  hlc: string | null;
  ts: number | null;
  value: unknown;
}

interface OpValue {
  id: string;
  v: number;
  decline?: true;
  deferFor?: number;
}

function orderKey(hlc: string | null | undefined, ts: number | null | undefined): string {
  return hlc ?? encodeHlc({ ms: ts ?? 0, count: 0 });
}

/** A PG-shaped LWW store keyed by `${table}::${key}`, with refusals and deferrals. */
function fakeStore() {
  const rows = new Map<string, Row>();
  const applied: string[] = [];
  const attempts = new Map<string, number>();
  const apply = async (env: OpEnvelope): Promise<boolean | MergeApplyOutcome> => {
    const gk = `${env.table}::${env.hbKey}`;
    const value = env.value as OpValue | undefined;
    const id = value?.id ?? `${gk}@${env.ts}`;
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    if (value?.deferFor !== undefined && n <= value.deferFor) {
      return { kind: 'dependency-waiting', reason: `waiting on ${id}` };
    }
    applied.push(id);
    if (value?.decline) return false;
    // Like `applyOpVia`: a write the SQL guard rejects is still a handled op (true).
    const stored = rows.get(gk);
    const hlc = env.hlc ?? null;
    const ts = env.ts ?? null;
    if (env.type === 'del') {
      if (stored && orderKey(hlc, ts) >= orderKey(stored.hlc, stored.ts)) rows.delete(gk);
      return true;
    }
    if (!stored || orderKey(hlc, ts) >= orderKey(stored.hlc, stored.ts)) rows.set(gk, { hlc, ts, value: env.value });
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
  const valueOf = (key: string) => (rows.get(`${TABLE}::${key}`)?.value as OpValue | undefined)?.id;
  return { rows, applied, apply, prefetch, valueOf };
}

function memLog(keyHex: string, ops: PeerLogOp[], slow?: { at: number; ms: number }): AdmittedLog {
  return {
    keyHex,
    get length() {
      return ops.length;
    },
    async get(i: number) {
      if (slow && i === slow.at) await new Promise((r) => setTimeout(r, slow.ms));
      return ops[i] ?? null;
    },
  };
}

let seq = 0;
function put(key: string, ts: number, extra: Partial<OpValue> = {}): PeerLogOp {
  const value: OpValue = { id: extra.id ?? `${key}@${ts}#${seq++}`, v: ts, ...extra };
  return { type: 'put', table: TABLE, hbKey: key, value, ts, schema_version: 1, author_pubkey: AUTHOR };
}

function del(key: string, ts: number): PeerLogOp {
  return { type: 'del', table: TABLE, hbKey: key, ts, schema_version: 1, author_pubkey: AUTHOR };
}

const ALL = (): boolean => true;

type PassOpts = Omit<IncrementalMergeOpts, 'applyImpl'>;

async function pass(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  apply: IncrementalMergeOpts['applyImpl'],
  opts: PassOpts = {},
) {
  return mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: apply, getTimeoutMs: 0, batchApply: false, ...opts });
}

async function drain(
  logs: AdmittedLog[],
  apply: IncrementalMergeOpts['applyImpl'],
  opts: PassOpts = {},
): Promise<{ cursor: MergeCursor; skips: number; passes: number }> {
  const cursor = createMergeCursor();
  let skips = 0;
  for (let passes = 1; passes <= 500; passes++) {
    const res = await pass(logs, cursor, apply, opts);
    skips += res.supersededSkips ?? 0;
    if (res.caughtUp) return { cursor, skips, passes };
  }
  throw new Error('fold did not converge in 500 passes');
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('P-528: skip superseded puts in the tail fold', () => {
  it('applies only the newest put of a key in the window and counts the rest', async () => {
    const K = 'papercusp/WI-1';
    const J = 'papercusp/WI-2';
    const ops = [put(K, 100, { id: 'K1' }), put(K, 200, { id: 'K2' }), put(J, 150, { id: 'J1' }), put(K, 300, { id: 'K3' })];
    const store = fakeStore();
    const cursor = createMergeCursor();
    const res = await pass([memLog('A', ops)], cursor, store.apply, { skipSuperseded: ALL });

    expect(store.applied).toEqual(['J1', 'K3']);
    expect(store.valueOf(K)).toBe('K3');
    expect(res.supersededSkips).toBe(2);
    expect(res.caughtUp).toBe(true);
    expect(cursor.positions.get('A')).toBe(4);
    expect(cursor.supersededNoSkip?.size ?? 0).toBe(0);
  });

  it('never skips across a delete of the key, and a delete never supersedes', async () => {
    const K = 'papercusp/WI-1';
    const ops = [put(K, 100, { id: 'K1' }), del(K, 200), put(K, 300, { id: 'K3' }), put(K, 400, { id: 'K4' }), del(K, 500)];
    const store = fakeStore();
    const res = await pass([memLog('A', ops)], createMergeCursor(), store.apply, { skipSuperseded: ALL });

    // K1 sits before the delete, so it applies; K3 is superseded by K4; K4 is followed
    // only by a delete, which does not supersede it.
    expect(store.applied).toEqual(['K1', `${TABLE}::${K}@200`, 'K4', `${TABLE}::${K}@500`]);
    expect(res.supersededSkips).toBe(1);
    expect(store.rows.has(`${TABLE}::${K}`)).toBe(false);
  });

  it('skips nothing for a key the projection does not allow', async () => {
    const ops = [put('WI-1', 100, { id: 'K1' }), put('WI-1', 200, { id: 'K2' })];
    const store = fakeStore();
    const res = await pass([memLog('A', ops)], createMergeCursor(), store.apply, {
      skipSuperseded: (_table, key) => key.includes('/'),
    });
    expect(store.applied).toEqual(['K1', 'K2']);
    expect(res.supersededSkips).toBe(0);
  });

  it('does not skip across a look-ahead position it could not read in time', async () => {
    const K = 'papercusp/WI-1';
    const ops = [put(K, 100, { id: 'K1' }), put('papercusp/WI-9', 150, { id: 'X' }), put(K, 200, { id: 'K2' })];
    const store = fakeStore();
    const res = await pass([memLog('A', ops, { at: 1, ms: 60 })], createMergeCursor(), store.apply, {
      skipSuperseded: ALL,
      storedOrderPeekTimeoutMs: 10,
    });
    expect(store.applied).toEqual(['K1', 'X', 'K2']);
    expect(res.supersededSkips).toBe(0);
  });

  it('P-532: the look-ahead never keeps a snapshot chunk; the main loop reads each chunk itself', async () => {
    const prefix = [put('papercusp/WI-1', 100, { id: 'P1' }), put('papercusp/WI-2', 110, { id: 'P2' })];
    // A 1-byte chunk budget puts each row in its own chunk: a 2-chunk set over the prefix.
    const set = buildSnapshotOps({
      ops: prefix,
      coversUpTo: prefix.length,
      author_pubkey: AUTHOR,
      ts: 120,
      schema_version: 1,
      maxChunkBytes: 1,
    });
    expect(set).toHaveLength(2);
    const ops = [...prefix, ...set, put('papercusp/WI-1', 200, { id: 'P3' })];
    const reads = new Map<number, number>();
    const base = memLog('A', ops);
    const counted: AdmittedLog = {
      keyHex: base.keyHex,
      get length() {
        return base.length;
      },
      async get(i: number) {
        reads.set(i, (reads.get(i) ?? 0) + 1);
        return base.get(i);
      },
    };
    const store = fakeStore();
    await drain([counted], store.apply, { skipSuperseded: ALL });
    // The look-ahead read each chunk and dropped it, so the main loop read it again.
    // Before P-532 the chunk stayed decoded in the window until the main loop took it:
    // a window over a 478-chunk set held 3.6 GB on the P-007 VM (plan D-027).
    for (let p = prefix.length; p < prefix.length + set.length; p++) expect(reads.get(p)).toBe(2);
    // A plain op is still read once: the main loop takes it from the look-ahead.
    expect(reads.get(0)).toBe(1);
    expect(reads.get(ops.length - 1)).toBe(1);
    const plain = fakeStore();
    await drain([memLog('A', ops)], plain.apply);
    expect(store.valueOf('papercusp/WI-1')).toBe(plain.valueOf('papercusp/WI-1'));
    expect(store.valueOf('papercusp/WI-2')).toBe(plain.valueOf('papercusp/WI-2'));
  });

  it('a declined superseder has its skipped put applied in order, landing where the plain fold lands', async () => {
    const K = 'papercusp/WI-1';
    const ops = [put(K, 100, { id: 'K1' }), put(K, 200, { id: 'K2', decline: true })];
    const plain = fakeStore();
    const plainRun = await drain([memLog('A', ops)], plain.apply);
    expect(plain.valueOf(K)).toBe('K1');

    const store = fakeStore();
    const cursor = createMergeCursor();
    const persisted: number[] = [];
    const res = await pass([memLog('A', ops)], cursor, store.apply, {
      skipSuperseded: ALL,
      onCursorAdvance: (p) => {
        persisted.push(p.get('A') ?? -1);
      },
    });
    // K1 was skipped, K2 was declined, so K1 was applied right after it.
    expect(res.supersededSkips).toBe(1);
    expect(res.caughtUp).toBe(true);
    expect(store.applied).toEqual(['K2', 'K1']);
    expect(store.valueOf(K)).toBe('K1');
    expect(persisted).toEqual([2]);
    expect(cursor.supersededNoSkip?.size ?? 0).toBe(0);
    // The winner is the plain fold's: the declined K2, not the replayed K1.
    expect(cursor.winners.get(`${TABLE}::${K}`)).toEqual(plainRun.cursor.winners.get(`${TABLE}::${K}`));
  });

  it('a declined superseder hides an older put from another log exactly as the plain fold does', async () => {
    // Log A: K1 then K5 (declined). Log B, folded after A: K3. The plain fold records the
    // declined K5 as the winner, so B's older K3 is skipped as stale and the row stays K1.
    const K = 'papercusp/WI-1';
    const opsA = [put(K, 100, { id: 'K1' }), put(K, 500, { id: 'K5', decline: true })];
    const opsB = [put(K, 300, { id: 'K3' })];
    const logs = () => [memLog('a'.repeat(64), opsA), memLog('b'.repeat(64), opsB)];
    const plain = fakeStore();
    await drain(logs(), plain.apply);
    const fast = fakeStore();
    await drain(logs(), fast.apply, { skipSuperseded: ALL });
    expect(plain.valueOf(K)).toBe('K1');
    expect(fast.valueOf(K)).toBe('K1');
  });

  it('a deferred superseder leaves the skipped put visible, as the plain fold does, while it waits', async () => {
    const K = 'papercusp/WI-1';
    const J = 'papercusp/WI-2';
    const ops = [put(K, 100, { id: 'K1' }), put(J, 100, { id: 'J1' }), put(K, 200, { id: 'K2', deferFor: 2 })];
    const store = fakeStore();
    const cursor = createMergeCursor();
    const logs = [memLog('A', ops)];
    const opts: PassOpts = { skipSuperseded: ALL };

    const first = await pass(logs, cursor, store.apply, opts);
    // Pass 1: K1 skipped for K2; K2 deferred, so K1 was applied after it and K2 holds
    // the cursor, exactly where the plain fold holds it.
    expect(first.supersededSkips).toBe(1);
    expect(store.valueOf(K)).toBe('K1');
    expect(cursor.positions.get('A')).toBe(2);

    await pass(logs, cursor, store.apply, opts);
    expect(store.valueOf(K)).toBe('K1');
    expect(cursor.positions.get('A')).toBe(2);

    const third = await pass(logs, cursor, store.apply, opts);
    expect(third.caughtUp).toBe(true);
    expect(store.valueOf(K)).toBe('K2');
    expect(store.valueOf(J)).toBe('J1');
    expect(cursor.positions.get('A')).toBe(3);
  });

  it('the intra-pass persist never passes a skip whose superseder has not applied yet', async () => {
    const K = 'papercusp/WI-K';
    const filler = Array.from({ length: MERGE_PERSIST_EVERY_OPS + 100 }, (_, i) => put(`papercusp/F-${i}`, 1000 + i, { id: `F${i}` }));
    const ops = [put(K, 100, { id: 'K1' }), ...filler, put(K, 200, { id: 'K2', deferFor: 1 })];
    const store = fakeStore();
    const cursor = createMergeCursor();
    const persisted: number[] = [];
    await pass([memLog('A', ops)], cursor, store.apply, {
      skipSuperseded: ALL,
      storedOrderPrefetchWindow: ops.length,
      onCursorAdvance: (p) => {
        persisted.push(p.get('A') ?? -1);
      },
    });
    // The intra-pass persist (after MERGE_PERSIST_EVERY_OPS ops) came while K1's skip was
    // pending, so it held at K1. At pass end K2 has deferred, K1 was replayed, and the
    // cursor holds at K2.
    expect(persisted).toEqual([0, ops.length - 1]);
    expect(store.valueOf(K)).toBe('K1');
    expect(store.valueOf(`papercusp/F-${filler.length - 1}`)).toBe(`F${filler.length - 1}`);
  });

  it('a lost batch rolls the superseder back, so the skip replays and nothing past it persists', async () => {
    const K = 'papercusp/WI-1';
    const J = 'papercusp/WI-2';
    const ops = [put(K, 100, { id: 'K1' }), put(J, 100, { id: 'J1' }), put(K, 200, { id: 'K2' })];
    const db = new BatchDb();
    db.failCommits = 1;
    const cursor = createMergeCursor();
    const logs = [memLog('A', ops)];
    const opts: PassOpts = { skipSuperseded: ALL, batchApply: { maxOps: 50, maxMs: 60_000 } };
    const first = await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: db.sink, getTimeoutMs: 0, ...opts });

    expect(first.supersededSkips).toBe(1);
    expect(db.committed.size).toBe(0);
    expect(cursor.positions.get('A')).toBe(0);
    expect(cursor.winners.has(`${TABLE}::${K}`)).toBe(false);

    for (let i = 0; i < 5; i++) {
      const res = await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: db.sink, getTimeoutMs: 0, ...opts });
      if (res.caughtUp) break;
    }
    expect(cursor.positions.get('A')).toBe(3);
    expect(db.committed.get(K)).toMatchObject({ id: 'K2' });
    expect(db.committed.get(J)).toMatchObject({ id: 'J1' });
    // The replay applied K1 in order before K2 (the group was not skipped a second time).
    expect(db.writes.filter((w) => w === K)).toEqual([K, K, K]);
  });

  // Declines and deferrals are fuzzed in separate streams here, where the plain fold is an
  // exact oracle. Together they reach a quirk of the plain fold itself: a declined put is
  // still recorded as its key's winner, so an older op of that key (from either log, or a
  // deferred retry) is dropped as stale if it is folded after the declined one. Which ops
  // that hits depends on where passes end, and P-528 moves pass ends (the position holds
  // at a pending skip), so the combined mix is bounded by the next test instead.
  it.each([
    ['declines', { decline: 0.12, defer: 0 }],
    ['deferrals', { decline: 0, defer: 0.12 }],
  ])('lands on the plain fold store over randomized streams (deletes, %s, cut passes)', async (_name, mix) => {
    let totalSkips = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rnd = mulberry32(seed);
      const keys = Array.from({ length: 40 }, (_, i) => `papercusp/WI-${i}`);
      // Like a real tail: an author's clock mostly rises along its log, with some jitter
      // so a later op is sometimes older than an earlier one on the same key.
      const mkOps = (log: string, n: number): PeerLogOp[] =>
        Array.from({ length: n }, (_, i) => {
          const key = keys[Math.floor(rnd() * keys.length)]!;
          const ts = 1_000 + i * 10 + Math.floor(rnd() * 40);
          const r = rnd();
          if (r < 0.1) return del(key, ts);
          const extra: Partial<OpValue> = { id: `${log}${i}` };
          if (r < 0.1 + mix.decline) extra.decline = true;
          else if (r < 0.1 + mix.decline + mix.defer) extra.deferFor = 1 + Math.floor(rnd() * 2);
          return put(key, ts, extra);
        });
      const opsA = mkOps('A', 220);
      const opsB = mkOps('B', 220);
      const logs = () => [memLog('a'.repeat(64), opsA), memLog('b'.repeat(64), opsB)];
      const cut: PassOpts = { maxOpsPerPass: 37, storedOrderPrefetchWindow: 23 };

      const plain = fakeStore();
      await drain(logs(), plain.apply, cut);

      const fast = fakeStore();
      const skipped = await drain(logs(), fast.apply, { ...cut, skipSuperseded: ALL });
      expect([...fast.rows].sort(), `seed ${seed}`).toEqual([...plain.rows].sort());
      expect(skipped.cursor.supersededNoSkip?.size ?? 0, `seed ${seed}`).toBe(0);

      const seeded = fakeStore();
      const both = await drain(logs(), seeded.apply, { ...cut, skipSuperseded: ALL, prefetchStoredOrder: seeded.prefetch });
      expect([...seeded.rows].sort(), `seed ${seed} + prefetch`).toEqual([...plain.rows].sort());
      totalSkips += skipped.skips + both.skips;
    }
    expect(totalSkips).toBeGreaterThan(100);
  });

  it('with declines and deferrals together, differs from the plain fold only where a newer declined put decides', async () => {
    // The plain fold records a declined put as its key's winner, so whether an older op
    // (from either log) lands depends on whether it is folded before or after the declined
    // one. P-528 moves pass ends, so that order can differ. Every other key must match,
    // and a key that differs must have a declined put newer than both results.
    const unexplained: string[] = [];
    let differing = 0;
    for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
      const rnd = mulberry32(seed);
      const keys = Array.from({ length: 40 }, (_, i) => `papercusp/WI-${i}`);
      const mkOps = (log: string, n: number): PeerLogOp[] =>
        Array.from({ length: n }, (_, i) => {
          const key = keys[Math.floor(rnd() * keys.length)]!;
          const ts = 1_000 + i * 10 + Math.floor(rnd() * 40);
          const r = rnd();
          if (r < 0.1) return del(key, ts);
          const extra: Partial<OpValue> = { id: `${log}${i}` };
          if (r < 0.2) extra.decline = true;
          else if (r < 0.3) extra.deferFor = 1 + Math.floor(rnd() * 2);
          return put(key, ts, extra);
        });
      const opsA = mkOps('A', 220);
      const opsB = mkOps('B', 220);
      const logs = () => [memLog('a'.repeat(64), opsA), memLog('b'.repeat(64), opsB)];
      const cut: PassOpts = { maxOpsPerPass: 37, storedOrderPrefetchWindow: 23 };
      const plain = fakeStore();
      await drain(logs(), plain.apply, cut);
      const fast = fakeStore();
      await drain(logs(), fast.apply, { ...cut, skipSuperseded: ALL });
      for (const key of keys) {
        const gk = `${TABLE}::${key}`;
        const a = plain.rows.get(gk);
        const b = fast.rows.get(gk);
        if ((a?.value as OpValue | undefined)?.id === (b?.value as OpValue | undefined)?.id) continue;
        differing++;
        const floor = Math.max(a?.ts ?? 0, b?.ts ?? 0);
        const decided = [...opsA, ...opsB].some(
          (o) => o.hbKey === key && o.type === 'put' && (o.value as OpValue).decline && (o.ts ?? 0) > floor,
        );
        if (!decided) unexplained.push(`seed ${seed} ${key}: plain=${a?.ts} fast=${b?.ts}`);
      }
    }
    expect(unexplained).toEqual([]);
    // The quirk is reachable in this mix, so the bound above is not vacuous.
    expect(differing).toBeGreaterThan(0);
  });
});

type FakeSql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;

/**
 * A key/value store speaking the statement subset the fold batch uses (compare
 * read-merge-batch-apply.test.ts), with a batchable sink that writes through
 * `projectionSql`. `failCommits` makes the next COMMITs come back as rollbacks.
 */
class BatchDb {
  readonly committed = new Map<string, unknown>();
  readonly writes: string[] = [];
  failCommits = 0;
  readonly target: postgres.Sql;
  private stack: Map<string, unknown>[] | null = null;

  constructor() {
    const autocommit = this.connection(false);
    this.target = Object.assign(autocommit, { reserve: async () => this.connection(true) }) as unknown as postgres.Sql;
  }

  readonly sink = async (op: OpEnvelope): Promise<boolean> => {
    const sql = (await projectionSql(this.target)) as unknown as FakeSql;
    await sql`WRITE ${op.hbKey} ${op.value}`;
    return true;
  };

  private connection(reserved: boolean) {
    let chain: Promise<unknown> = Promise.resolve();
    const run = (text: string, vals: unknown[]) => {
      const p = chain.then(() => this.exec(text, vals, reserved));
      chain = p.catch(() => {});
      return Object.assign(p, { execute: () => p });
    };
    const fn = (strings: TemplateStringsArray, ...vals: unknown[]) => run(strings.join('$').trim(), vals);
    return Object.assign(fn, { unsafe: (text: string) => run(text, []), release: () => {} });
  }

  private async exec(text: string, vals: unknown[], reserved: boolean): Promise<{ command: string }> {
    const top = () => this.stack![this.stack!.length - 1]!;
    if (text === 'BEGIN') {
      this.stack = [new Map()];
      return { command: 'BEGIN' };
    }
    if (text === 'SAVEPOINT read_merge_op') {
      this.stack!.push(new Map());
      return { command: 'SAVEPOINT' };
    }
    if (text === 'RELEASE SAVEPOINT read_merge_op') {
      const done = this.stack!.pop()!;
      for (const [k, v] of done) top().set(k, v);
      return { command: 'RELEASE' };
    }
    if (text === 'ROLLBACK TO SAVEPOINT read_merge_op') {
      this.stack![this.stack!.length - 1] = new Map();
      return { command: 'ROLLBACK' };
    }
    if (text === 'COMMIT') {
      const stack = this.stack;
      this.stack = null;
      if (this.failCommits > 0) {
        this.failCommits--;
        return { command: 'ROLLBACK' };
      }
      for (const level of stack ?? []) for (const [k, v] of level) this.committed.set(k, v);
      return { command: 'COMMIT' };
    }
    if (text === 'ROLLBACK') {
      this.stack = null;
      return { command: 'ROLLBACK' };
    }
    if (text.startsWith('SELECT set_config')) return { command: 'SELECT' };
    if (!text.startsWith('WRITE')) throw new Error(`unexpected statement ${text}`);
    const key = String(vals[0]);
    this.writes.push(key);
    if (reserved && this.stack) top().set(key, vals[1]);
    else this.committed.set(key, vals[1]);
    return { command: 'INSERT' };
  }
}

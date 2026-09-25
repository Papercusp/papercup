/**
 * P-002 step 2 (p2p-join-catchup-speed D-002): batched fold commits.
 *
 * A fake transactional store stands in for PG. Like a real connection, it runs
 * one connection's statements strictly in order, so a hung statement holds up
 * everything sent behind it. That lets these tests pin the batch's statement
 * protocol and every failure path: a lost COMMIT, a per-op deferral inside the
 * batch, and an apply that times out mid-transaction. The real-PG proof that the
 * batched fold leaves the same rows as the serial one lives in
 * projections/engineer-issues.integration.test.ts ("P-002 step 2: batched fold
 * commits leave the same rows as the serial fold (real PG)").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog, type MergeCursor } from './read-merge';
import { projectionSql } from './projection';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}

type Result = { command: string };

const COALESCE_ON = "SELECT set_config('papercusp.sync_notify_coalesce', 'on', true)";

/** A key/value store speaking the statement subset the batch and the test sink use. */
class FakeDb {
  readonly committed = new Map<string, unknown>();
  readonly statements: string[] = [];
  failCommits = 0;
  readonly failWrites = new Set<string>();
  readonly hangs = new Map<string, Promise<void>>();
  reserves = 0;
  releases = 0;
  readonly target: postgres.Sql;
  private stack: Map<string, unknown>[] | null = null;

  constructor() {
    const autocommit = this.connection(false);
    this.target = Object.assign(autocommit, {
      reserve: async () => {
        this.reserves++;
        return this.connection(true);
      },
    }) as unknown as postgres.Sql;
  }

  private connection(reserved: boolean) {
    let chain: Promise<unknown> = Promise.resolve();
    const run = (text: string, vals: unknown[]) => {
      const p = chain.then(() => this.exec(text, vals, reserved));
      chain = p.catch(() => {});
      return Object.assign(p, { execute: () => p });
    };
    const fn = (strings: TemplateStringsArray, ...vals: unknown[]) => run(strings.join('$').trim(), vals);
    return Object.assign(fn, {
      unsafe: (text: string) => run(text, []),
      release: () => {
        this.releases++;
      },
    });
  }

  private async exec(text: string, vals: unknown[], reserved: boolean): Promise<Result> {
    this.statements.push(text.startsWith('WRITE') ? `WRITE ${String(vals[0])}` : text);
    const verb = text.split(' ')[0];
    const top = () => this.stack![this.stack!.length - 1]!;
    switch (text) {
      case 'BEGIN':
        this.stack = [new Map()];
        return { command: 'BEGIN' };
      case 'SAVEPOINT read_merge_op':
        this.stack!.push(new Map());
        return { command: 'SAVEPOINT' };
      case 'RELEASE SAVEPOINT read_merge_op': {
        const done = this.stack!.pop()!;
        for (const [k, v] of done) top().set(k, v);
        return { command: 'RELEASE' };
      }
      case 'ROLLBACK TO SAVEPOINT read_merge_op':
        this.stack![this.stack!.length - 1] = new Map();
        return { command: 'ROLLBACK' };
      case 'COMMIT': {
        const stack = this.stack;
        this.stack = null;
        if (this.failCommits > 0) {
          this.failCommits--;
          return { command: 'ROLLBACK' };
        }
        for (const level of stack ?? []) for (const [k, v] of level) this.committed.set(k, v);
        return { command: 'COMMIT' };
      }
      case 'ROLLBACK':
        this.stack = null;
        return { command: 'ROLLBACK' };
      case COALESCE_ON:
        return { command: 'SELECT' };
    }
    if (verb !== 'WRITE') throw new Error(`unexpected statement ${text}`);
    const key = String(vals[0]);
    const hang = this.hangs.get(key);
    if (hang) await hang;
    if (this.failWrites.has(key)) throw Object.assign(new Error(`fk violation on ${key}`), { code: '23503' });
    if (reserved && this.stack) top().set(key, vals[1]);
    else this.committed.set(key, vals[1]);
    return { command: 'INSERT' };
  }

  count(statement: string): number {
    return this.statements.filter((s) => s === statement).length;
  }
}

type FakeSql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;

/** A batchable sink: every statement goes through projectionSql, like engineer-issues. */
function sink(db: FakeDb, extraWriteFor?: string) {
  return async (op: OpEnvelope): Promise<boolean> => {
    const sql = (await projectionSql(db.target)) as unknown as FakeSql;
    await sql`WRITE ${op.hbKey} ${op.value}`;
    if (op.hbKey === extraWriteFor) await sql`WRITE ${`${op.hbKey}-extra`} ${op.value}`;
    return true;
  };
}

function winnersOf(cursor: MergeCursor): Record<string, unknown> {
  return Object.fromEntries([...cursor.winners].map(([k, v]) => [k, { ts: v.ts, hlc: v.hlc }]));
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

const NO_AGE_BOUND = { maxMs: 60_000 };

describe('P-002 step 2: batched fold commits', () => {
  it('leaves the same rows, cursor and winners as the serial fold, including LWW losers', async () => {
    // 40 keys, 3 versions each, written newest-first for every third key so the
    // older versions are LWW losers that must be skipped inside a batch too.
    const ops: PeerLogOp[] = [];
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 40; k++) {
        const ts = k % 3 === 0 ? 3000 - v * 100 + k : 1000 + v * 100 + k;
        ops.push(put(`k${k}`, ts, { k, v }));
      }
    }
    const serialDb = new FakeDb();
    const serialCursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog('A', ops)], serialCursor, {
      applyImpl: sink(serialDb),
      getTimeoutMs: 0,
      batchApply: false,
    });
    const batchDb = new FakeDb();
    const batchCursor = createMergeCursor();
    const res = await mergeAdmittedLogsIncremental([memLog('A', ops)], batchCursor, {
      applyImpl: sink(batchDb),
      getTimeoutMs: 0,
      batchApply: { maxOps: 25, ...NO_AGE_BOUND },
    });

    expect(serialDb.statements.some((s) => s === 'BEGIN')).toBe(false);
    expect([...batchDb.committed].sort()).toEqual([...serialDb.committed].sort());
    expect(batchCursor.positions.get('A')).toBe(ops.length);
    expect(batchCursor.positions.get('A')).toBe(serialCursor.positions.get('A'));
    expect(winnersOf(batchCursor)).toEqual(winnersOf(serialCursor));

    // Protocol: one savepoint per applied op, all released, commits in windows of 25.
    const writes = batchDb.statements.filter((s) => s.startsWith('WRITE')).length;
    expect(writes).toBe(serialDb.statements.filter((s) => s.startsWith('WRITE')).length);
    expect(batchDb.count('SAVEPOINT read_merge_op')).toBe(writes);
    expect(batchDb.count('RELEASE SAVEPOINT read_merge_op')).toBe(writes);
    expect(batchDb.count('COMMIT')).toBe(Math.ceil(writes / 25));
    // P-536: the tail's batch never groups; only snapshot lanes do.
    expect(res.batch).toEqual({ commits: Math.ceil(writes / 25), ops: writes, rewinds: 0, grouped: 0, groupReplays: 0 });
    expect(batchDb.releases).toBe(batchDb.reserves);
  });

  it('P-525: a batch opened 256+ ops behind asks for coalesced change notifications; one opened closer does not', async () => {
    // mig 1213: under the GUC, emit_change_notify sends one table-scoped notification per
    // table per transaction, so a far-behind fold does not echo one notification per row.
    const ops = Array.from({ length: 300 }, (_, i) => put(`k${i}`, 1000 + i, { i }));
    const db = new FakeDb();
    await mergeAdmittedLogsIncremental([memLog('A', ops)], createMergeCursor(), {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { maxOps: 50, ...NO_AGE_BOUND },
    });
    const begins = db.statements.flatMap((s, i) => (s === 'BEGIN' ? [i] : []));
    expect(begins).toHaveLength(6);
    // Opened at #0 (300 behind): coalesced. Opened at #50 (250 behind) and later: per row.
    expect(begins.map((i) => db.statements[i + 1] === COALESCE_ON)).toEqual([true, false, false, false, false, false]);
    expect(db.count(COALESCE_ON)).toBe(1);
    expect(db.committed.size).toBe(300);
  });

  it('a lost COMMIT rewinds the cursor to the batch start and records no winner for its ops', async () => {
    const ops = Array.from({ length: 12 }, (_, i) => put(`k${i}`, 1000 + i, { i }));
    const db = new FakeDb();
    db.failCommits = 1;
    const cursor = createMergeCursor();
    const first = await mergeAdmittedLogsIncremental([memLog('A', ops)], cursor, {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { maxOps: 5, ...NO_AGE_BOUND },
    });

    // The first window (k0..k4) came back as ROLLBACK: nothing is durable, so the
    // cursor must not pass position 0 and no winner may claim those ops.
    expect(db.committed.size).toBe(0);
    expect(cursor.positions.get('A')).toBe(0);
    expect(cursor.winners.size).toBe(0);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: 0, kind: 'retryable' });
    expect(cursor.applyFailures?.get('A')?.reason).toContain('batch transaction lost');
    expect(first.batch).toEqual({ commits: 0, ops: 0, rewinds: 1, grouped: 0, groupReplays: 0 });

    // The lost window [0, 5) is marked for a SERIAL replay, so whatever lost it
    // cannot lose the replay the same way.
    expect(cursor.batchSerialUntil?.get('A')).toBe(5);

    // The next pass replays the window and everything lands: k0..k4 autocommit one
    // by one, then k5..k9 and k10..k11 commit as two batches.
    const beginsBefore = db.count('BEGIN');
    const second = await mergeAdmittedLogsIncremental([memLog('A', ops)], cursor, {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { maxOps: 5, ...NO_AGE_BOUND },
    });
    expect(db.committed.size).toBe(12);
    expect(cursor.positions.get('A')).toBe(12);
    expect(cursor.applyFailures?.get('A')).toBeUndefined();
    expect(second.batch?.commits).toBe(2);
    expect(db.count('BEGIN') - beginsBefore).toBe(2);
    expect(cursor.batchSerialUntil?.has('A') ?? false).toBe(false);
    expect(db.releases).toBe(db.reserves);
  });

  it('a deferred op rolls back to its savepoint while the rest of the batch commits', async () => {
    const ops = Array.from({ length: 6 }, (_, i) => put(`k${i}`, 1000 + i, { i }));
    const db = new FakeDb();
    db.failWrites.add('k3');
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog('A', ops)], cursor, {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { maxOps: 50, ...NO_AGE_BOUND },
    });

    expect([...db.committed.keys()].sort()).toEqual(['k0', 'k1', 'k2', 'k4', 'k5']);
    expect(db.count('ROLLBACK TO SAVEPOINT read_merge_op')).toBe(1);
    expect(db.count('COMMIT')).toBe(1);
    // Same hold as the serial path: the cursor stays on the deferred op.
    expect(cursor.positions.get('A')).toBe(3);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: 3, kind: 'dependency-waiting' });
    expect(cursor.winners.has('features-by-id::k3')).toBe(false);
    expect(cursor.winners.has('features-by-id::k4')).toBe(true);

    db.failWrites.delete('k3');
    await mergeAdmittedLogsIncremental([memLog('A', ops)], cursor, {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { maxOps: 50, ...NO_AGE_BOUND },
    });
    expect([...db.committed.keys()].sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
    expect(cursor.positions.get('A')).toBe(6);
  });

  it('an apply that times out inside the batch loses the batch, and its late statements cannot land', async () => {
    const ops = Array.from({ length: 5 }, (_, i) => put(`k${i}`, 1000 + i, { i }));
    const db = new FakeDb();
    let releaseHang: () => void = () => {};
    db.hangs.set(
      'k2',
      new Promise<void>((resolve) => {
        releaseHang = resolve;
      }),
    );
    const cursor = createMergeCursor();
    const res = await mergeAdmittedLogsIncremental([memLog('A', ops)], cursor, {
      applyImpl: sink(db, 'k2'),
      getTimeoutMs: 0,
      applyTimeoutMs: 50,
      batchApply: { maxOps: 50, ...NO_AGE_BOUND },
    });

    expect(res.batch?.rewinds).toBe(1);
    expect(cursor.positions.get('A')).toBe(0);
    expect(cursor.winners.size).toBe(0);
    expect(db.committed.size).toBe(0);

    // The hung write now finishes. The ROLLBACK queued behind it discards it, and the
    // op's follow-up statement is refused instead of landing on a released connection.
    db.hangs.delete('k2');
    releaseHang();
    await vi.waitFor(() => expect(db.releases).toBe(db.reserves));
    expect(db.committed.size).toBe(0);
    expect(db.statements).not.toContain('WRITE k2-extra');

    // A clean replay then lands every op, the second write included.
    await mergeAdmittedLogsIncremental([memLog('A', ops)], cursor, {
      applyImpl: sink(db, 'k2'),
      getTimeoutMs: 0,
      applyTimeoutMs: 50,
      batchApply: { maxOps: 50, ...NO_AGE_BOUND },
    });
    expect([...db.committed.keys()].sort()).toEqual(['k0', 'k1', 'k2', 'k2-extra', 'k3', 'k4']);
    expect(cursor.positions.get('A')).toBe(5);
  });

  it('a sink that never asks for the batch handle runs exactly as the serial path', async () => {
    const ops = Array.from({ length: 4 }, (_, i) => put(`k${i}`, 1000 + i, { i }));
    const applied: string[] = [];
    const res = await mergeAdmittedLogsIncremental([memLog('A', ops)], createMergeCursor(), {
      applyImpl: async (op) => {
        applied.push(op.hbKey ?? '');
        return true;
      },
      getTimeoutMs: 0,
    });
    expect(applied).toEqual(['k0', 'k1', 'k2', 'k3']);
    expect(res).toEqual({ applied: 4, decoded: 4, caughtUp: true, truncated: false, snapshotChunksJumped: 0 });
  });
});

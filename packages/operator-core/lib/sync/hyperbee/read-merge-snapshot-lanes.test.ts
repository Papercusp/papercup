/**
 * read-merge-snapshot-lanes.test.ts — p2p-join-catchup-speed-2026-09-23 P-527 (D-014).
 *
 * A snapshot-set chunk is applied on parallel lanes, each with its own batch transaction.
 * Measured on the P-007 VM (run #4), a set crossing used about 1.4 of 8 cores at ~259
 * rows/s and did not speed up with synchronous_commit off, so every row was waiting on
 * one serial chain of round trips.
 *
 * The fake database gives every reserved connection its OWN transaction stack, so two
 * lanes' transactions stay apart the way two PG backends do. It also counts writes in
 * flight, which is what shows the lanes overlap. The `snapshotLanes: 1` run of the same
 * chunk is the permanent control: the same rows, one at a time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog, type MergeCursor } from './read-merge';
import { projectionDefer, projectionSql, projectionStatementFailed, type ProjectionGroupWriter } from './projection';
import { buildEpochKeySeek } from './hive-epoch-op-gate';
import { SNAPSHOT_TABLE_TAG, type SnapshotPayload, type SnapshotRow } from './log-snapshot';
import type { MergeApplyOutcome } from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

const LOG = 'a'.repeat(64);
const DEVICE = 'dev-lanes';

function memLog(ops: PeerLogOp[]): AdmittedLog {
  return { keyHex: LOG, length: ops.length, get: async (i) => ops[i] ?? null };
}

/** `wi` rows keyed WI-N (work items), then `notes` rows. Distinct keys, as in one set. */
function setRows(wi: number, notes: number): SnapshotRow[] {
  return [
    ...Array.from({ length: wi }, (_, i) => ({
      table: 'engineer-issues',
      hbKey: `WI-${1000 + i}`,
      value: { i },
      ts: 5000 + i,
      schema_version: 1,
    })),
    ...Array.from({ length: notes }, (_, i) => ({
      table: 'notes',
      hbKey: `N-${i}`,
      value: { n: i },
      ts: 6000 + i,
      schema_version: 1,
    })),
  ];
}

/** One snapshot chunk at position 0. coversUpTo 0 makes it never skip-eligible, so it applies. */
function chunk(rows: SnapshotRow[]): PeerLogOp {
  return {
    type: 'put',
    table: SNAPSHOT_TABLE_TAG,
    hbKey: 'snapshot/0/0-of-1',
    value: { coversUpTo: 0, chunkIdx: 0, chunkCount: 1, rows } satisfies SnapshotPayload,
    ts: 9000,
    schema_version: 1,
    author_pubkey: '',
  };
}

type Result = { command: string };

/** One connection's transaction: savepoint levels (named), and whether a failed statement aborted it. */
interface FakeTx {
  stack: Map<string, unknown>[] | null;
  names: string[];
  aborted: boolean;
  /** Keys this connection wrote, in the order it wrote them (P-536). */
  order: string[];
}

/**
 * A key/value store where each reserved connection holds its own transaction.
 * Like PG, a failed statement aborts the transaction until ROLLBACK TO SAVEPOINT, and a
 * savepoint is released or rolled back to only from the innermost level (the fake refuses
 * anything else, so a protocol slip fails the test instead of passing silently).
 */
class LaneDb {
  readonly committed = new Map<string, unknown>();
  readonly statements: string[] = [];
  failCommits = 0;
  /** P-536: a WRITEMANY holding any of these keys fails whole with a 23505. */
  readonly failGroupKeys = new Set<string>();
  /** P-536: a WRITE of one of these keys fails once with a 23505. */
  readonly failWriteOnce = new Set<string>();
  /** P-536: every reserved connection's write order. */
  readonly connections: FakeTx[] = [];
  reserves = 0;
  releases = 0;
  /** The reserve call (1-based) that is not granted until {@link grantStalled}; 0 = none. */
  stallReserve = 0;
  grantStalled: () => void = () => {};
  active = 0;
  maxActive = 0;
  /** Writes in flight per key prefix (`WI`, `EI`, `N`), and the peak of each. */
  private readonly activeBy = new Map<string, number>();
  readonly maxActiveBy = new Map<string, number>();
  readonly target: postgres.Sql;

  constructor() {
    const autocommit = this.connection(false);
    this.target = Object.assign(autocommit, {
      reserve: async () => {
        this.reserves++;
        if (this.reserves === this.stallReserve) {
          await new Promise<void>((resolve) => {
            this.grantStalled = resolve;
          });
        }
        return this.connection(true);
      },
    }) as unknown as postgres.Sql;
  }

  resetOverlap(): void {
    this.maxActive = 0;
    this.maxActiveBy.clear();
  }

  count(statement: string): number {
    return this.statements.filter((s) => s === statement).length;
  }

  private connection(reserved: boolean) {
    let chain: Promise<unknown> = Promise.resolve();
    const tx: FakeTx = { stack: null, names: [], aborted: false, order: [] };
    if (reserved) this.connections.push(tx);
    const run = (text: string, vals: unknown[]) => {
      const p = chain.then(() => this.exec(text, vals, reserved, tx));
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

  private async exec(text: string, vals: unknown[], reserved: boolean, tx: FakeTx): Promise<Result> {
    this.statements.push(
      text.startsWith('WRITEMANY')
        ? `WRITEMANY ${(vals[0] as string[]).join(',')}`
        : text.startsWith('WRITE')
          ? `WRITE ${String(vals[0])}`
          : text,
    );
    try {
      return await this.execIn(text, vals, reserved, tx);
    } catch (err) {
      if (reserved && tx.stack) tx.aborted = true;
      throw err;
    }
  }

  private async execIn(text: string, vals: unknown[], reserved: boolean, tx: FakeTx): Promise<Result> {
    const top = () => tx.stack![tx.stack!.length - 1]!;
    const savepoint = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) (\w+)$/.exec(text);
    if (tx.aborted && text !== 'COMMIT' && text !== 'ROLLBACK' && savepoint?.[1] !== 'ROLLBACK TO SAVEPOINT') {
      throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    }
    if (savepoint) {
      const [, verb, name] = savepoint;
      if (verb === 'SAVEPOINT') {
        tx.stack!.push(new Map());
        tx.names.push(name!);
        return { command: 'SAVEPOINT' };
      }
      if (tx.names[tx.names.length - 1] !== name) throw new Error(`${verb} ${name} is not the innermost savepoint`);
      if (verb === 'RELEASE SAVEPOINT') {
        tx.names.pop();
        const done = tx.stack!.pop()!;
        for (const [k, v] of done) top().set(k, v);
        return { command: 'RELEASE' };
      }
      tx.stack![tx.stack!.length - 1] = new Map();
      tx.aborted = false;
      return { command: 'ROLLBACK' };
    }
    switch (text) {
      case 'BEGIN':
        tx.stack = [new Map()];
        tx.names = [];
        return { command: 'BEGIN' };
      case 'COMMIT': {
        const stack = tx.stack;
        const aborted = tx.aborted;
        tx.stack = null;
        tx.aborted = false;
        if (aborted) return { command: 'ROLLBACK' };
        if (this.failCommits > 0) {
          this.failCommits--;
          return { command: 'ROLLBACK' };
        }
        for (const level of stack ?? []) for (const [k, v] of level) this.committed.set(k, v);
        return { command: 'COMMIT' };
      }
      case 'ROLLBACK':
        tx.stack = null;
        tx.aborted = false;
        return { command: 'ROLLBACK' };
    }
    if (text.startsWith('SELECT set_config')) return { command: 'SELECT' };
    if (text.startsWith('WRITEMANY')) {
      const keys = vals[0] as string[];
      const values = vals[1] as unknown[];
      await new Promise((r) => setImmediate(r));
      const bad = keys.find((k) => this.failGroupKeys.has(k));
      if (bad) throw Object.assign(new Error(`duplicate identity at ${bad}`), { code: '23505' });
      keys.forEach((k, i) => {
        if (reserved && tx.stack) top().set(k, values[i]);
        else this.committed.set(k, values[i]);
        tx.order.push(k);
      });
      return { command: 'INSERT' };
    }
    if (!text.startsWith('WRITE')) throw new Error(`unexpected statement ${text}`);
    const key = String(vals[0]);
    if (this.failWriteOnce.delete(key)) throw Object.assign(new Error(`duplicate identity at ${key}`), { code: '23505' });
    tx.order.push(key);
    const prefix = key.split('-')[0]!;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const mine = (this.activeBy.get(prefix) ?? 0) + 1;
    this.activeBy.set(prefix, mine);
    this.maxActiveBy.set(prefix, Math.max(this.maxActiveBy.get(prefix) ?? 0, mine));
    try {
      // Yield past the other lanes' queued work, as a PG round trip does.
      await new Promise((r) => setImmediate(r));
      if (reserved && tx.stack) top().set(key, vals[1]);
      else this.committed.set(key, vals[1]);
      return { command: 'INSERT' };
    } finally {
      this.active--;
      this.activeBy.set(prefix, this.activeBy.get(prefix)! - 1);
    }
  }
}

type FakeSql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;

interface SinkOpts {
  /** Keys whose first apply throws a plain error (a retryable outcome). */
  failOnce?: Set<string>;
  /** Keys whose apply reports a structural deferral. */
  defer?: Set<string>;
  /** Called before a row's write, e.g. to record a key miss. */
  before?: (op: OpEnvelope) => void;
  /** Every applied key, in apply order. */
  timeline?: string[];
}

/** A batchable sink: every statement goes through projectionSql, like engineer-issues. */
function sink(db: LaneDb, opts: SinkOpts = {}) {
  return async (op: OpEnvelope): Promise<boolean | MergeApplyOutcome> => {
    opts.before?.(op);
    if (opts.failOnce?.delete(op.hbKey ?? '')) throw new Error(`transient failure on ${op.hbKey}`);
    if (opts.defer?.has(op.hbKey ?? '')) return { kind: 'dependency-waiting', reason: `parent of ${op.hbKey} missing` };
    const sql = (await projectionSql(db.target)) as unknown as FakeSql;
    await sql`WRITE ${op.hbKey} ${op.value}`;
    opts.timeline?.push(`${op.table}::${op.hbKey}`);
    return true;
  };
}

interface GroupSinkOpts {
  /** Keys written straight away, never handed to the group (a projection with no group writer). */
  direct?: (key: string) => boolean;
  /** Keys whose op hands its record over and then reports a structural deferral. */
  deferAfterHandover?: Set<string>;
  /** A per-record 23505 the record's own write swallows (a coalesced identity conflict). */
  coalesce?: Set<string>;
  /** Every op's key, in the order the ops ran. */
  timeline?: string[];
}

/**
 * P-536: a sink whose rows join the lane's group write, like engineer-issues. `writeOne`
 * is the per-op write; `writeMany` writes a whole group as one WRITEMANY statement.
 */
function groupSink(db: LaneDb, opts: GroupSinkOpts = {}) {
  type Rec = { key: string; value: unknown };
  const writeOne = async (r: Rec): Promise<void | false> => {
    const sql = (await projectionSql(db.target)) as unknown as FakeSql;
    try {
      await sql`WRITE ${r.key} ${r.value}`;
    } catch (err) {
      if (!opts.coalesce?.has(r.key)) throw err;
      await projectionStatementFailed();
      return false;
    }
  };
  const writer: ProjectionGroupWriter<Rec> = {
    name: 'test-group',
    rowOf: (r) => r.key,
    writeMany: async (sql, records) => {
      await (sql as unknown as FakeSql)`WRITEMANY ${records.map((r) => r.key)} ${records.map((r) => r.value)}`;
    },
    writeOne,
  };
  return async (op: OpEnvelope): Promise<boolean | MergeApplyOutcome> => {
    const record = { key: op.hbKey ?? '', value: op.value };
    opts.timeline?.push(record.key);
    if (!opts.direct?.(record.key) && (await projectionDefer(db.target, writer, record))) {
      if (opts.deferAfterHandover?.has(record.key)) {
        return { kind: 'dependency-waiting', reason: `parent of ${record.key} missing` };
      }
      return true;
    }
    return (await writeOne(record)) !== false;
  };
}

function winnersOf(cursor: MergeCursor): Record<string, unknown> {
  return Object.fromEntries([...cursor.winners].map(([k, v]) => [k, { ts: v.ts, hlc: v.hlc }]));
}

const BATCH = { maxOps: 25, maxMs: 60_000 };

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  info.mockRestore();
});

describe('P-527: snapshot chunks apply on parallel lanes', () => {
  it('leaves the same rows, cursor and winners as the serial path, with writes overlapping', async () => {
    const ops = [chunk(setRows(40, 160))];
    const serialDb = new LaneDb();
    const serialCursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog(ops)], serialCursor, {
      applyImpl: sink(serialDb),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 1 },
    });
    const laneDb = new LaneDb();
    const laneCursor = createMergeCursor();
    const res = await mergeAdmittedLogsIncremental([memLog(ops)], laneCursor, {
      applyImpl: sink(laneDb),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });

    // CONTROL: one lane never has two writes in flight.
    expect(serialDb.maxActive).toBe(1);
    expect(laneDb.maxActive).toBeGreaterThan(1);
    expect(laneDb.maxActive).toBeLessThanOrEqual(4);

    expect([...laneDb.committed].sort()).toEqual([...serialDb.committed].sort());
    expect(laneDb.committed.size).toBe(200);
    expect(laneCursor.positions.get(LOG)).toBe(1);
    expect(laneCursor.positions.get(LOG)).toBe(serialCursor.positions.get(LOG));
    expect(winnersOf(laneCursor)).toEqual(winnersOf(serialCursor));
    expect(laneCursor.applyFailures?.get(LOG)).toBeUndefined();
    // Every lane committed before the chunk ended, and every connection went back.
    expect(res.batch?.ops).toBe(200);
    expect(res.batch?.rewinds).toBe(0);
    expect(laneDb.releases).toBe(laneDb.reserves);
    expect(laneDb.count('BEGIN')).toBe(laneDb.count('COMMIT'));
  });

  it('spreads WI-N rows over the lanes like any other row', async () => {
    // P-007 run #5: pinned to one lane, the WI-N part of a set ran at ~1.0x. Migration
    // 1218 takes the id-sequence floor lock only for a row that raises the floor.
    const eiRows: SnapshotRow[] = Array.from({ length: 80 }, (_, i) => ({
      table: 'engineer-issues',
      hbKey: `EI-${2000 + i}`,
      value: { i },
      ts: 7000 + i,
      schema_version: 1,
    }));
    const db = new LaneDb();
    await mergeAdmittedLogsIncremental([memLog([chunk([...setRows(80, 0), ...eiRows])])], createMergeCursor(), {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(db.committed.size).toBe(160);
    expect(db.maxActiveBy.get('EI')).toBeGreaterThan(1);
    expect(db.maxActiveBy.get('WI')).toBeGreaterThan(1);
  });

  it('commits a drained lane before a slower sibling finishes', async () => {
    // A lane holding the floor lock must not sit on it until every sibling is done.
    // 40 rows go round-robin over 4 lanes, 10 each (under maxOps, so no mid-queue
    // commit); every row of lane 1 (N-1, N-5, ... N-37) is slow.
    const slow = new Set(Array.from({ length: 10 }, (_, j) => `N-${1 + 4 * j}`));
    const db = new LaneDb();
    const apply = sink(db);
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog([chunk(setRows(0, 40))])], cursor, {
      applyImpl: async (op) => {
        if (slow.has(op.hbKey ?? '')) await new Promise((r) => setTimeout(r, 5));
        return apply(op);
      },
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(db.committed.size).toBe(40);
    expect(cursor.positions.get(LOG)).toBe(1);
    const firstCommit = db.statements.indexOf('COMMIT');
    const lastSlowWrite = db.statements.lastIndexOf('WRITE N-37');
    expect(lastSlowWrite).toBeGreaterThan(-1);
    expect(firstCommit).toBeGreaterThan(-1);
    expect(firstCommit).toBeLessThan(lastSlowWrite);
    expect(db.count('BEGIN')).toBe(db.count('COMMIT'));
  });

  it('a lost lane COMMIT holds the cursor at the chunk and replays it outside any batch', async () => {
    const ops = [chunk(setRows(0, 120))];
    const db = new LaneDb();
    db.failCommits = 1;
    const cursor = createMergeCursor();
    const first = await mergeAdmittedLogsIncremental([memLog(ops)], cursor, {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(cursor.positions.get(LOG) ?? 0).toBe(0);
    expect(cursor.applyFailures?.get(LOG)).toMatchObject({ position: 0, kind: 'retryable' });
    expect(cursor.applyFailures?.get(LOG)?.reason).toContain('snapshot lane batch lost');
    expect(cursor.batchSerialUntil?.get(LOG)).toBe(1);
    expect(first.batch?.rewinds).toBeGreaterThan(0);
    // No winner claims a row whose write rolled back.
    expect([...cursor.winners.keys()].every((k) => db.committed.has(k.split('::')[1]!))).toBe(true);

    const beginsBefore = db.count('BEGIN');
    db.resetOverlap();
    await mergeAdmittedLogsIncremental([memLog(ops)], cursor, {
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(db.committed.size).toBe(120);
    expect(cursor.positions.get(LOG)).toBe(1);
    expect(cursor.applyFailures?.get(LOG)).toBeUndefined();
    // The replay autocommitted row by row: no batch, no lanes.
    expect(db.count('BEGIN') - beginsBefore).toBe(0);
    expect(db.maxActive).toBe(1);
    await vi.waitFor(() => expect(db.releases).toBe(db.reserves));
  });

  it('a batch connection that is never granted: the lane autocommits and the chunk still ends (P-007 run #6)', async () => {
    const ops = [chunk(setRows(40, 160))];
    const opts = (db: LaneDb, reserveTimeoutMs: number) => ({
      applyImpl: sink(db),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4, reserveTimeoutMs },
    });

    // CONTROL: unbounded, the same stalled grant wedges the chunk (run #6 sat 47 min).
    const stuckDb = new LaneDb();
    stuckDb.stallReserve = 2;
    const stuck = mergeAdmittedLogsIncremental([memLog(ops)], createMergeCursor(), opts(stuckDb, 0));
    const settled = await Promise.race([
      stuck.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(settled).toBe(false);
    stuckDb.grantStalled();
    await stuck;

    const db = new LaneDb();
    db.stallReserve = 2;
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog(ops)], cursor, opts(db, 50));
    expect(db.committed.size).toBe(200);
    expect(cursor.positions.get(LOG)).toBe(1);
    expect(cursor.applyFailures?.get(LOG)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('batch connection not granted'));
    expect(db.count('BEGIN')).toBe(db.count('COMMIT'));
    // The grant that comes after the deadline goes straight back to the pool.
    db.grantStalled();
    await vi.waitFor(() => expect(db.releases).toBe(db.reserves));
  });

  it('a retryable row stops the lanes, holds the cursor at the chunk, and the retry runs serially', async () => {
    const ops = [chunk(setRows(0, 120))];
    const db = new LaneDb();
    const failOnce = new Set(['N-37']);
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog(ops)], cursor, {
      applyImpl: sink(db, { failOnce }),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(failOnce.size).toBe(0);
    expect(db.committed.has('N-37')).toBe(false);
    expect(cursor.positions.get(LOG) ?? 0).toBe(0);
    expect(cursor.applyFailures?.get(LOG)).toMatchObject({ position: 0, kind: 'retryable', groupKey: 'notes::N-37' });
    expect(cursor.laneSerialUntil?.get(LOG)).toBe(1);

    db.resetOverlap();
    await mergeAdmittedLogsIncremental([memLog(ops)], cursor, {
      applyImpl: sink(db, { failOnce }),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(db.committed.size).toBe(120);
    expect(cursor.positions.get(LOG)).toBe(1);
    expect(cursor.applyFailures?.get(LOG)).toBeUndefined();
    // The retry took the serial batched path.
    expect(db.maxActive).toBe(1);
    expect(db.releases).toBe(db.reserves);
  });

  it('a deferred row holds the cursor at the chunk while the lanes apply every other row', async () => {
    const db = new LaneDb();
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog([chunk(setRows(0, 120))])], cursor, {
      applyImpl: sink(db, { defer: new Set(['N-5']) }),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(db.committed.size).toBe(119);
    expect(db.maxActive).toBeGreaterThan(1);
    expect(cursor.positions.get(LOG) ?? 0).toBe(0);
    expect(cursor.applyFailures?.get(LOG)).toMatchObject({ position: 0, kind: 'dependency-waiting' });
    // A deferral is the serial path's behaviour too, so it does not demote the chunk.
    expect(cursor.laneSerialUntil?.has(LOG) ?? false).toBe(false);
  });

  it('a key miss stops the lanes, seeks the key once, and the lanes resume where they stopped', async () => {
    const keyRowOp: PeerLogOp = {
      type: 'put',
      table: 'hive-epoch-keys',
      hbKey: `1:${DEVICE}`,
      value: { epoch: 1, member_device_pubkey: DEVICE },
      ts: 9500,
      schema_version: 1,
      author_pubkey: '',
    };
    const ops = [chunk(setRows(0, 120)), keyRowOp];
    const seeker = buildEpochKeySeek(DEVICE);
    const timeline: string[] = [];
    let missesRecorded = 0;
    const db = new LaneDb();
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([memLog(ops)], cursor, {
      applyImpl: sink(db, {
        timeline,
        before: (op) => {
          // Until the key row lands, every row of epoch 1 misses its key.
          if (op.table === 'notes' && !timeline.includes(`hive-epoch-keys::1:${DEVICE}`)) {
            missesRecorded++;
            seeker.onKeyMissing('pot', 1);
          }
        },
      }),
      getTimeoutMs: 0,
      keySeek: seeker.keySeek,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    const keyAt = timeline.indexOf(`hive-epoch-keys::1:${DEVICE}`);
    expect(keyAt).toBeGreaterThan(0);
    // The lanes stopped within one row each of the first miss; the rest applied after the seek.
    expect(missesRecorded).toBeLessThanOrEqual(4);
    expect(timeline.slice(keyAt + 1).filter((k) => k.startsWith('notes::')).length).toBeGreaterThanOrEqual(116);
    expect(timeline.filter((k) => k.startsWith('notes::')).length).toBe(120);
    expect(info.mock.calls.filter((c: unknown[]) => String(c[0]).includes('P-524 key seek')).length).toBe(1);
    expect(cursor.positions.get(LOG)).toBe(2);
    expect(db.releases).toBe(db.reserves);
  });
});

/**
 * p2p-join-catchup-speed-2026-09-23 P-536 (D-034 #1): inside a snapshot lane a projection
 * with a group writer hands its record to the lane batch, which writes the batch's records
 * in one statement before it commits. Each case runs the per-op `sink` (or the same sink
 * with groups off) as the control, so "same rows" is measured, not assumed.
 */
describe('P-536: snapshot lanes write rows in groups', () => {
  async function foldChunk(rows: SnapshotRow[], applyImpl: ReturnType<typeof groupSink>) {
    const cursor = createMergeCursor();
    const res = await mergeAdmittedLogsIncremental([memLog([chunk(rows)])], cursor, {
      applyImpl,
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    return { cursor, res };
  }

  it('leaves the same rows, cursor and winners as per-op writes, in one statement per lane transaction', async () => {
    const rows = setRows(40, 160);
    const perOpDb = new LaneDb();
    const perOp = await foldChunk(rows, sink(perOpDb));
    const db = new LaneDb();
    const grouped = await foldChunk(rows, groupSink(db));

    expect([...db.committed].sort()).toEqual([...perOpDb.committed].sort());
    expect(db.committed.size).toBe(200);
    expect(grouped.cursor.positions.get(LOG)).toBe(1);
    expect(winnersOf(grouped.cursor)).toEqual(winnersOf(perOp.cursor));
    expect(grouped.cursor.applyFailures?.get(LOG)).toBeUndefined();
    // CONTROL: the per-op sink writes a statement and a savepoint per row.
    expect(perOpDb.count('SAVEPOINT read_merge_op')).toBe(200);
    // 4 lanes x 50 rows, committed every 25 ops: 8 transactions, one group write each.
    expect(db.statements.filter((s) => s.startsWith('WRITE ')).length).toBe(0);
    expect(db.statements.filter((s) => s.startsWith('WRITEMANY ')).length).toBe(8);
    expect(db.count('SAVEPOINT read_merge_op')).toBe(0);
    expect(db.count('SAVEPOINT read_merge_group')).toBe(8);
    expect(db.count('RELEASE SAVEPOINT read_merge_group')).toBe(8);
    expect(grouped.res.batch).toMatchObject({ ops: 200, grouped: 200, groupReplays: 0, rewinds: 0 });
    expect(db.releases).toBe(db.reserves);
    expect(db.count('BEGIN')).toBe(db.count('COMMIT'));
  });

  it('a failed group write rolls back to its savepoint and writes its rows one at a time', async () => {
    const db = new LaneDb();
    db.failGroupKeys.add('N-7');
    const { cursor, res } = await foldChunk(setRows(0, 120), groupSink(db));

    expect(db.committed.size).toBe(120);
    expect(cursor.positions.get(LOG)).toBe(1);
    expect(cursor.applyFailures?.get(LOG)).toBeUndefined();
    expect(db.count('ROLLBACK TO SAVEPOINT read_merge_group')).toBe(1);
    expect(db.count('WRITE N-7')).toBe(1);
    expect(res.batch).toMatchObject({ groupReplays: 1, rewinds: 0 });
    // The replayed group's records each got their own savepoint, all released.
    const replayed = db.count('SAVEPOINT read_merge_group_row');
    expect(replayed).toBeGreaterThan(0);
    expect(db.count('RELEASE SAVEPOINT read_merge_group_row')).toBe(replayed);
    expect(res.batch?.grouped).toBe(120 - replayed);
  });

  it('a replayed record that is refused on its own is refused exactly as its op would refuse it', async () => {
    // The per-op write swallows this 23505 (an identity coalesce) after rolling back to
    // its savepoint; replayed from a group it must do the same, and the chunk still lands.
    const db = new LaneDb();
    db.failGroupKeys.add('N-7');
    db.failWriteOnce.add('N-7');
    const { cursor, res } = await foldChunk(setRows(0, 120), groupSink(db, { coalesce: new Set(['N-7']) }));

    expect(db.committed.has('N-7')).toBe(false);
    expect(db.committed.size).toBe(119);
    expect(cursor.positions.get(LOG)).toBe(1);
    expect(cursor.applyFailures?.get(LOG)).toBeUndefined();
    expect(db.count('ROLLBACK TO SAVEPOINT read_merge_group_row')).toBe(1);
    expect(res.batch).toMatchObject({ groupReplays: 1, rewinds: 0 });
  });

  it('a record that fails on its own too loses the lane batch, and the chunk replays outside any batch', async () => {
    const db = new LaneDb();
    db.failGroupKeys.add('N-7');
    db.failWriteOnce.add('N-7');
    const cursor = createMergeCursor();
    const opts = { applyImpl: groupSink(db), getTimeoutMs: 0, batchApply: { ...BATCH, snapshotLanes: 4 } };
    const first = await mergeAdmittedLogsIncremental([memLog([chunk(setRows(0, 120))])], cursor, opts);

    expect(cursor.positions.get(LOG) ?? 0).toBe(0);
    expect(cursor.applyFailures?.get(LOG)?.reason).toContain('snapshot lane batch lost');
    expect(cursor.batchSerialUntil?.get(LOG)).toBe(1);
    expect(first.batch?.rewinds).toBeGreaterThan(0);
    // No winner claims a row whose write rolled back.
    expect([...cursor.winners.keys()].every((k) => db.committed.has(k.split('::')[1]!))).toBe(true);

    const beginsBefore = db.count('BEGIN');
    const groupsBefore = db.statements.filter((s) => s.startsWith('WRITEMANY ')).length;
    await mergeAdmittedLogsIncremental([memLog([chunk(setRows(0, 120))])], cursor, opts);
    expect(db.committed.size).toBe(120);
    expect(cursor.positions.get(LOG)).toBe(1);
    expect(cursor.applyFailures?.get(LOG)).toBeUndefined();
    // The replay wrote row by row with no batch, so no group either.
    expect(db.count('BEGIN') - beginsBefore).toBe(0);
    expect(db.statements.filter((s) => s.startsWith('WRITEMANY ')).length).toBe(groupsBefore);
    await vi.waitFor(() => expect(db.releases).toBe(db.reserves));
  });

  it('two records for one row never share a group: the later one lands last', async () => {
    const rows = setRows(0, 40);
    rows.push({ table: 'notes', hbKey: 'N-3', value: { n: 'second' }, ts: 9999, schema_version: 1 });
    const perOpDb = new LaneDb();
    await foldChunk(rows, sink(perOpDb));
    const db = new LaneDb();
    const { cursor } = await foldChunk(rows, groupSink(db));

    expect(perOpDb.committed.get('N-3')).toEqual({ n: 'second' });
    expect(db.committed.get('N-3')).toEqual({ n: 'second' });
    expect([...db.committed].sort()).toEqual([...perOpDb.committed].sort());
    const groupsWithN3 = db.statements.filter((s) => s.startsWith('WRITEMANY ') && s.split(/[ ,]/).includes('N-3'));
    expect(groupsWithN3).toHaveLength(2);
    expect(cursor.positions.get(LOG)).toBe(1);
  });

  it('an op that hands its record over and then does not apply takes the record back', async () => {
    const rows = setRows(0, 120);
    const perOpDb = new LaneDb();
    const perOp = await foldChunk(rows, sink(perOpDb, { defer: new Set(['N-5']) }));
    const db = new LaneDb();
    const { cursor } = await foldChunk(rows, groupSink(db, { deferAfterHandover: new Set(['N-5']) }));

    expect(db.committed.has('N-5')).toBe(false);
    expect([...db.committed].sort()).toEqual([...perOpDb.committed].sort());
    expect(cursor.applyFailures?.get(LOG)).toMatchObject({ position: 0, kind: 'dependency-waiting' });
    expect(winnersOf(cursor)).toEqual(winnersOf(perOp.cursor));
  });

  it('a statement an op issues itself lands after the records handed over before it', async () => {
    // WI rows write straight away (a projection without a group writer); N rows are grouped.
    const rows = setRows(40, 160);
    const perOpDb = new LaneDb();
    await foldChunk(rows, sink(perOpDb));
    const db = new LaneDb();
    const timeline: string[] = [];
    await foldChunk(rows, groupSink(db, { direct: (k) => k.startsWith('WI-'), timeline }));

    expect([...db.committed].sort()).toEqual([...perOpDb.committed].sort());
    expect(db.count('SAVEPOINT read_merge_op')).toBe(40);
    expect(db.statements.some((s) => s.startsWith('WRITEMANY '))).toBe(true);
    // Every connection wrote its keys in the order their ops ran.
    for (const tx of db.connections) {
      const mine = new Set(tx.order);
      expect(tx.order).toEqual(timeline.filter((k) => mine.has(k)));
    }
  });

  it('the tail batch never groups: only snapshot lanes do', async () => {
    const ops: PeerLogOp[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'put',
      table: 'notes',
      hbKey: `T-${i}`,
      value: { i },
      ts: 1000 + i,
      schema_version: 1,
      author_pubkey: 'pk',
    }));
    const db = new LaneDb();
    const res = await mergeAdmittedLogsIncremental([memLog(ops)], createMergeCursor(), {
      applyImpl: groupSink(db),
      getTimeoutMs: 0,
      batchApply: { ...BATCH, snapshotLanes: 4 },
    });
    expect(db.committed.size).toBe(60);
    expect(db.statements.filter((s) => s.startsWith('WRITEMANY ')).length).toBe(0);
    expect(db.count('SAVEPOINT read_merge_op')).toBe(60);
    expect(res.batch).toMatchObject({ ops: 60, grouped: 0 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  produceLogSnapshot,
  isSnapshotOp,
  SNAPSHOT_READ_CONCURRENCY,
  type SnapshotPayload,
} from '../log-snapshot';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * P-014 (2026-08-09) — `produceLogSnapshot` reads the own log with a BOUNDED PIPELINE
 * instead of one awaited `get` per block.
 *
 * Why this suite exists as a guard rather than a perf note: the serial form was not
 * merely slow, it was UNCOMPLETABLE on a real corpus (461,475 blocks unfinished after
 * 29 minutes on one saturated core, against a holder recycled every ~8.5 min — and the
 * read restarts from index 0 every time, so no retry budget could ever close it). Five
 * successive release cuts failed there. A regression would not show up as a slow test;
 * it would show up weeks later as a release cut that silently ships a FULL seed.
 *
 * Two properties, and the second is the one that makes the first safe to want:
 *
 *  1. CONCURRENCY — reads actually overlap. This test FAILS against the serial
 *     implementation (max in-flight would be exactly 1), which is what makes it a
 *     falsifiable guard rather than a restatement of the code.
 *
 *  2. ORDER — the ops array is assembled in INDEX order even when the store resolves
 *     reads OUT of order. This is the calibration case: concurrency is only correct
 *     because the fold is last-writer-wins BY POSITION, so an implementation that
 *     pushed in COMPLETION order would corrupt the snapshot while still passing (1).
 *     The log below resolves later indices FIRST, so completion order is the reverse
 *     of index order and the two are maximally distinguishable.
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}

/**
 * In-memory OwnLog that (a) counts concurrent `get`s and (b) resolves them in an order
 * chosen by `delayFor`, so completion order can be made to disagree with index order.
 */
function instrumentedLog(
  ops: PeerLogOp[],
  delayFor: (i: number) => number,
): OwnLog & { maxInFlight: number; completionOrder: number[] } {
  const appended: PeerLogOp[] = [...ops];
  let inFlight = 0;
  const self = {
    maxInFlight: 0,
    completionOrder: [] as number[],
    get keyHex() {
      return 'k'.repeat(64);
    },
    get length() {
      return appended.length;
    },
    async append(op: PeerLogOp) {
      appended.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      appended.push(...batch);
    },
    async get(i: number) {
      inFlight += 1;
      self.maxInFlight = Math.max(self.maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayFor(i)));
      inFlight -= 1;
      self.completionOrder.push(i);
      return appended[i] ?? null;
    },
  };
  return self;
}

describe('produceLogSnapshot own-log read pipelining (P-014)', () => {
  it('CONTROL: the in-flight counter reports 1 for a deliberately SERIAL read', async () => {
    // Calibration for the guard below. Without this, `maxInFlight > 1` could pass for a
    // reason unrelated to the subject (a miscounting instrument), and the guard would be
    // unfalsifiable — green whether or not the pipeline exists. This reproduces the OLD
    // implementation's read shape exactly, and pins that the instrument distinguishes it.
    const ops = Array.from({ length: 300 }, (_, i) => put('queue', `K${i}`, i, 1));
    const log = instrumentedLog(ops, () => 1);

    const collected: PeerLogOp[] = [];
    for (let i = 0; i < log.length; i++) {
      const op = await log.get(i);
      if (op) collected.push(op);
    }

    expect(collected).toHaveLength(300);
    expect(log.maxInFlight).toBe(1);
  });

  it('reads the own log CONCURRENTLY, not one awaited get at a time', async () => {
    // Enough ops to fill more than one read window, so the bound is exercised too.
    const ops = Array.from({ length: SNAPSHOT_READ_CONCURRENCY + 40 }, (_, i) =>
      put('queue', `K${i}`, i, 1),
    );
    const log = instrumentedLog(ops, () => 1);

    const res = await produceLogSnapshot(log, { now: 5, schemaVersion: 1 });

    expect(res.appended).toBe(true);
    // The falsifier: the serial implementation can never exceed 1.
    expect(log.maxInFlight).toBeGreaterThan(1);
    // And it stays BOUNDED — an unbounded Promise.all over the whole history would
    // put every one of the 461k blocks in flight at once on the real corpus.
    expect(log.maxInFlight).toBeLessThanOrEqual(SNAPSHOT_READ_CONCURRENCY);
  });

  it('preserves INDEX order when the store resolves reads out of order', async () => {
    // One key written twice: first at index 0, last at the final index. Last write wins
    // by POSITION, so the snapshot must carry `'last'`.
    const n = SNAPSHOT_READ_CONCURRENCY + 40; // spans a window boundary on purpose
    const ops: PeerLogOp[] = Array.from({ length: n }, (_, i) => put('queue', `K${i}`, i, 1));
    ops[0] = put('queue', 'DUP', 'first', 1);
    ops[n - 1] = put('queue', 'DUP', 'last', 2);

    // Later indices resolve FIRST within each window, so completion order is reversed
    // relative to index order.
    const log = instrumentedLog(ops, (i) => (i % SNAPSHOT_READ_CONCURRENCY === 0 ? 8 : 1));

    const lengthBefore = log.length;
    const res = await produceLogSnapshot(log, { now: 9, schemaVersion: 1 });
    expect(res.appended).toBe(true);

    // Calibration: the store really did complete reads out of index order, otherwise
    // this test would pass against a completion-order implementation by luck.
    const firstCompleted = log.completionOrder[0];
    expect(firstCompleted).not.toBe(0);

    // Read the appended snapshot chunks back and find the DUP row.
    const rows: { table: string; hbKey: string; value: unknown }[] = [];
    for (let i = lengthBefore; i < log.length; i++) {
      const op = await log.get(i);
      if (op && isSnapshotOp(op)) rows.push(...(op.value as SnapshotPayload).rows);
    }

    const dup = rows.filter((r) => r.hbKey === 'DUP');
    expect(dup).toHaveLength(1);
    expect(dup[0].value).toBe('last');
  });
});

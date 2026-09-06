import { describe, it, expect } from 'vitest';
import {
  produceLogSnapshot,
  buildSnapshotRows,
  isSnapshotOp,
  SnapshotRowFolder,
  SNAPSHOT_READ_CONCURRENCY,
  SNAPSHOT_TOMBSTONE_HORIZON_MS,
  type SnapshotPayload,
  type SnapshotRow,
} from '../log-snapshot';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * P-014 half (2), 2026-08-09 — `produceLogSnapshot` folds each read window and DROPS it,
 * instead of materializing the whole decoded history into one `ops` array.
 *
 * Why this is a guard and not a perf note. The fold's OUTPUT is bounded by the LIVE KEY
 * COUNT; only its INPUT was ever bounded by the OP COUNT. On this box's real corpus
 * (461,475 ops) the accumulating form drove the holder to a `20.1G memory peak` and killed
 * it — SIGABRT status=134, V8 stack in `String::NewFromOneByte`. A regression would not
 * surface as a slow test; it would surface as a release cut that OOMs its own host.
 *
 * ⚠ The wall was ALWAYS there, MASKED by the serial-read latency bug (see
 * log-snapshot-read-pipelining.test.ts). The serial read was so slow the holder got
 * recycled before the heap could fill; making the read fast let execution reach the real
 * ceiling. That is why this suite is separate from the pipelining one — the two fixes are
 * independent, and either one alone leaves the producer unable to finish.
 *
 * THE INSTRUMENT. Retention is not directly observable without leaning on GC (flaky), so
 * this measures the property that CAUSES it: how many ops have been READ but not yet
 * FOLDED. Each synthetic op exposes `value` as a getter, which the fold reads exactly once
 * per op — so "folded" is observed at the fold itself rather than inferred. Outstanding =
 * reads − folds. Streaming keeps that at one window regardless of history length;
 * accumulating grows it linearly with the history, which is the memory bug restated in a
 * form a test can see.
 */

const DISTINCT_KEYS = 8;

/** An op whose `value` getter fires exactly when the fold consumes it. */
function observableOp(i: number, onFold: (i: number) => void): PeerLogOp {
  const op = {
    type: 'put',
    table: 'queue',
    hbKey: `K${i % DISTINCT_KEYS}`,
    ts: 1,
    schema_version: 1,
    author_pubkey: 'me',
  } as PeerLogOp;
  let payload: unknown = { i };
  Object.defineProperty(op, 'value', {
    get() {
      onFold(i);
      return payload;
    },
    set(v: unknown) {
      payload = v;
    },
    enumerable: true,
    configurable: true,
  });
  return op;
}

interface FoldProbe {
  log: OwnLog;
  /** Peak count of ops READ but not yet FOLDED — the memory property, made observable. */
  maxOutstanding: number;
  reads: number;
  /** Every `get` call, including bounded seed discovery and appended chunks. */
  getCalls: number;
  folds: number;
}

function foldProbeLog(historyLength: number): FoldProbe {
  const probe: FoldProbe = {
    log: null as unknown as OwnLog,
    maxOutstanding: 0,
    reads: 0,
    getCalls: 0,
    folds: 0,
  };
  const history = Array.from({ length: historyLength }, (_, i) =>
    observableOp(i, () => {
      probe.folds += 1;
    }),
  );
  const appended: PeerLogOp[] = [];
  let inFlight = 0;
  let pipelineObserved = false;
  probe.log = {
    get keyHex() {
      return 'k'.repeat(64);
    },
    get length() {
      return historyLength + appended.length;
    },
    async append(op: PeerLogOp) {
      appended.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      appended.push(...batch);
    },
    async get(i: number) {
      inFlight += 1;
      if (i < historyLength && inFlight > 1) {
        // Seed discovery probes the tail serially and discards non-snapshot
        // blocks. Count only the first genuinely concurrent fold window so the
        // retention metric measures decoded ops held for folding, not the
        // bounded metadata scan that intentionally does not retain them.
        if (!pipelineObserved) {
          pipelineObserved = true;
          probe.reads += inFlight - 1;
        }
        probe.reads += 1;
        probe.maxOutstanding = Math.max(probe.maxOutstanding, probe.reads - probe.folds);
      } else if (i < historyLength && pipelineObserved) {
        probe.reads += 1;
        probe.maxOutstanding = Math.max(probe.maxOutstanding, probe.reads - probe.folds);
      }
      await new Promise((r) => setTimeout(r, 0));
      probe.getCalls += 1;
      try {
        if (i >= historyLength) return appended[i - historyLength] ?? null;
        return history[i];
      } finally {
        inFlight -= 1;
      }
    },
  };
  return probe;
}

/**
 * CONTROL — the OLD producer's read+fold shape, kept permanently so the guard below is
 * demonstrably falsifiable rather than merely green. It reads with the same bounded
 * pipeline (so this isolates the FOLD change, not the read change) but accumulates every
 * decoded op before folding, exactly as `produceLogSnapshot` did before P-014 half (2).
 */
async function accumulateThenFold(log: OwnLog, now: number): Promise<SnapshotRow[]> {
  const coversUpTo = log.length;
  const ops: PeerLogOp[] = [];
  for (let start = 0; start < coversUpTo; start += SNAPSHOT_READ_CONCURRENCY) {
    const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, coversUpTo);
    const window = await Promise.all(
      Array.from({ length: end - start }, (_, k) => log.get(start + k)),
    );
    for (const op of window) if (op) ops.push(op);
  }
  return buildSnapshotRows(ops, { now });
}

/** Concatenate the rows of every snapshot chunk appended at/after `fromIndex`. */
async function readBackRows(log: OwnLog, fromIndex: number): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  for (let i = fromIndex; i < log.length; i++) {
    const op = await log.get(i);
    if (op && isSnapshotOp(op)) rows.push(...(op.value as SnapshotPayload).rows);
  }
  return rows;
}

describe('produceLogSnapshot incremental fold (P-014 half 2)', () => {
  it('CONTROL: the instrument SEES the accumulating form retain the whole history', async () => {
    // Calibration. Without this, "outstanding stayed small" could be true because the
    // probe never observed anything — a guard that is green whether or not the fix
    // exists. This pins that the same instrument reports the OLD shape as unbounded, and
    // that its peak scales with history length rather than with the read window.
    const small = foldProbeLog(1000);
    await accumulateThenFold(small.log, 5);
    const big = foldProbeLog(4000);
    await accumulateThenFold(big.log, 5);

    expect(small.maxOutstanding).toBe(1000);
    expect(big.maxOutstanding).toBe(4000);
    // The signature of the bug: 4x the history ⇒ 4x the peak retention.
    expect(big.maxOutstanding).toBeGreaterThan(small.maxOutstanding * 3);
  });

  it('holds at most ONE read window of decoded ops, not the whole history', async () => {
    const probe = foldProbeLog(4000); // >> one window, and >> the live key count
    const res = await produceLogSnapshot(probe.log, { now: 5, schemaVersion: 1 });

    expect(res.appended).toBe(true);
    // Every op was actually folded — the bound below is not an artifact of skipped work.
    expect(probe.folds).toBe(4000);
    // The falsifier: the accumulating form peaks at 4000 here (see the CONTROL above).
    // Allow two windows of slack so a legitimate sliding-window read is not pinned to
    // this exact scheduling, while still separating hard from history-scale retention.
    expect(probe.maxOutstanding).toBeLessThanOrEqual(SNAPSHOT_READ_CONCURRENCY * 2);
    // And the fold really did collapse 4000 ops to the live key count — the reason
    // bounded retention is possible at all.
    expect(res.rowCount).toBe(DISTINCT_KEYS);
  });

  it('attributes own compaction progress to the core, source span, and decoded volume', async () => {
    const historyLength = SNAPSHOT_READ_CONCURRENCY + 3;
    const probe = foldProbeLog(historyLength);
    const progress: Array<{
      phase: string;
      coreKey?: string;
      sourceStart: number;
      sourceEnd: number;
      processed: number;
      total: number;
      decodedOps: number;
      decodedBytes: number;
    }> = [];

    const res = await produceLogSnapshot(probe.log, {
      now: 5,
      schemaVersion: 1,
      onProgress: (event) => progress.push(event),
    });

    expect(res.appended).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toMatchObject({
      phase: 'own-compaction',
      coreKey: 'k'.repeat(64),
      sourceStart: 0,
      sourceEnd: historyLength,
      processed: historyLength,
      total: historyLength,
      decodedOps: historyLength,
    });
    expect(progress.at(-1)!.decodedBytes).toBeGreaterThan(0);
    expect(progress.every((event, i) => i === 0 || event.decodedOps >= progress[i - 1]!.decodedOps)).toBe(true);
  });

  it('peak retention does NOT grow with history length', async () => {
    // The property in its load-bearing form. An absolute bound alone could be satisfied
    // by a big-but-finite buffer; what makes the producer survive a 461k-op corpus is
    // that the bound is independent of how long the log is.
    const small = foldProbeLog(1000);
    await produceLogSnapshot(small.log, { now: 5, schemaVersion: 1 });
    const big = foldProbeLog(4000);
    await produceLogSnapshot(big.log, { now: 5, schemaVersion: 1 });

    expect(big.folds).toBe(4000);
    expect(big.maxOutstanding).toBeLessThanOrEqual(small.maxOutstanding);
  });

  it('folds forward from the latest complete snapshot instead of rereading history', async () => {
    const historyLength = SNAPSHOT_READ_CONCURRENCY * 2 + 17;
    const probe = foldProbeLog(historyLength);

    const first = await produceLogSnapshot(probe.log, { now: 5, schemaVersion: 1 });
    expect(first.appended).toBe(true);
    const callsBeforeSecond = probe.getCalls;

    await probe.log.append({
      type: 'put',
      table: 'queue',
      hbKey: 'K0',
      value: { i: historyLength + 1 },
      ts: 6,
      schema_version: 1,
      author_pubkey: 'me',
    });

    const second = await produceLogSnapshot(probe.log, { now: 7, schemaVersion: 1 });
    expect(second.appended).toBe(true);
    // Seed discovery verifies the prior snapshot set, folds only the one new
    // source op, and performs the final anchor check. It must not approach the
    // original history length even though the log now contains that history.
    expect(probe.getCalls - callsBeforeSecond).toBeLessThan(historyLength / 2);
    expect(second.rowCount).toBe(DISTINCT_KEYS);
  });

  it('streams to the SAME rows the pure builder produces (puts, dels, prior snapshot, GC)', async () => {
    // Equivalence against the oracle the property suite already governs, over a history
    // that exercises every branch the fold has: last-writer-wins by position, a tombstone
    // that survives, a tombstone GC'd past the horizon, and an expanded PRIOR snapshot.
    const now = SNAPSHOT_TOMBSTONE_HORIZON_MS + 100_000;
    const priorSnapshot: PeerLogOp = {
      type: 'put',
      table: '__snapshot__',
      hbKey: 'snapshot/0',
      value: {
        coversUpTo: 0,
        rows: [
          { table: 'queue', hbKey: 'FROM-PRIOR', value: { v: 'kept' }, ts: now, schema_version: 1 },
        ],
      } satisfies SnapshotPayload,
      ts: now,
      schema_version: 1,
      author_pubkey: 'me',
    };
    const history: PeerLogOp[] = [
      priorSnapshot,
      { type: 'put', table: 'queue', hbKey: 'DUP', value: 'first', ts: now, schema_version: 1, author_pubkey: 'me' },
      { type: 'put', table: 'alpha', hbKey: 'A', value: { a: 1 }, ts: now, schema_version: 1, author_pubkey: 'me', epoch: 3, hlc: 'h1' },
      // Deleted long ago ⇒ GC'd back to omitted at production time.
      { type: 'put', table: 'queue', hbKey: 'OLD-DEL', value: 'x', ts: 1, schema_version: 1, author_pubkey: 'me' },
      { type: 'del', table: 'queue', hbKey: 'OLD-DEL', value: null, ts: 1, schema_version: 1, author_pubkey: 'me' },
      // Deleted just now ⇒ survives as a tombstone row.
      { type: 'del', table: 'queue', hbKey: 'NEW-DEL', value: null, ts: now, schema_version: 1, author_pubkey: 'me', hlc: 'h2' },
      // Spans past a window boundary so the DUP winner is resolved ACROSS windows.
      ...Array.from({ length: SNAPSHOT_READ_CONCURRENCY + 10 }, (_, i) => ({
        type: 'put' as const, table: 'bulk', hbKey: `B${i}`, value: i, ts: now, schema_version: 1, author_pubkey: 'me',
      })),
      { type: 'put', table: 'queue', hbKey: 'DUP', value: 'last', ts: now, schema_version: 1, author_pubkey: 'me' },
    ];

    const appended: PeerLogOp[] = [];
    const log: OwnLog = {
      keyHex: 'k'.repeat(64),
      get length() {
        return history.length + appended.length;
      },
      async append(op) {
        appended.push(op);
      },
      async appendBatch(batch) {
        appended.push(...batch);
      },
      async get(i) {
        return i < history.length ? history[i] : (appended[i - history.length] ?? null);
      },
    };

    const before = log.length;
    const res = await produceLogSnapshot(log, { now, schemaVersion: 1 });
    expect(res.appended).toBe(true);

    const streamed = await readBackRows(log, before);
    // The oracle: the pure array-form builder over the identical history.
    expect(streamed).toEqual(buildSnapshotRows(history, { now }));

    // Spot-check the branches, so a both-sides-wrong refactor cannot pass by symmetry.
    const byKey = new Map(streamed.map((r) => [`${r.table}::${r.hbKey}`, r]));
    expect(byKey.get('queue::DUP')?.value).toBe('last'); // LWW by position, across windows
    expect(byKey.get('queue::FROM-PRIOR')?.value).toEqual({ v: 'kept' }); // prior snapshot expanded
    expect(byKey.get('queue::NEW-DEL')?.deleted).toBe(true); // tombstone kept
    expect(byKey.has('queue::OLD-DEL')).toBe(false); // tombstone GC'd past the horizon
    expect(byKey.get('alpha::A')?.epoch).toBe(3); // WI-808 epoch preserved
  });
});

describe('SnapshotRowFolder (P-014 half 2)', () => {
  it('is the implementation buildSnapshotRows itself uses — incremental == batch', () => {
    // Guards against the folder drifting into a parallel copy of the fold. Because
    // buildSnapshotRows delegates here, the property suite's PREFIX-REPLACEMENT
    // FAITHFULNESS law already covers this class; this pins the delegation.
    const ops: PeerLogOp[] = [
      { type: 'put', table: 'queue', hbKey: 'A', value: 1, ts: 10, schema_version: 1, author_pubkey: 'me' },
      { type: 'put', table: 'queue', hbKey: 'B', value: 2, ts: 10, schema_version: 1, author_pubkey: 'me' },
      { type: 'put', table: 'queue', hbKey: 'A', value: 3, ts: 11, schema_version: 1, author_pubkey: 'me' },
    ];
    const folder = new SnapshotRowFolder();
    for (const op of ops) folder.add(op); // one at a time — the streaming path
    expect(folder.finish()).toEqual(buildSnapshotRows(ops));
    // keyCount is the bound the producer relies on: distinct keys, not ops folded.
    expect(folder.keyCount).toBe(2);
  });

  it('window boundaries are invisible to the fold', () => {
    // The producer feeds ops in arbitrary-sized batches; splitting a history at any point
    // must not change the result, or peak-memory tuning would be a correctness knob.
    const ops: PeerLogOp[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'put' as const, table: 'queue', hbKey: `K${i % 5}`, value: i, ts: 10, schema_version: 1, author_pubkey: 'me',
    }));
    const expected = buildSnapshotRows(ops);
    for (const split of [1, 7, 25, 49]) {
      const folder = new SnapshotRowFolder();
      folder.addAll(ops.slice(0, split));
      folder.addAll(ops.slice(split));
      expect(folder.finish(), `split at ${split}`).toEqual(expected);
    }
  });
});

/**
 * pg-merge-cursor.test.ts — WI-2105 REV fix: durable per-log merge-cursor
 * persistence (PG-cursor). Unit layer: pure functions + in-memory fakes (a fake
 * `MergeCursorStore` + fake `AdmittedLog`s), NO PG/Docker.
 *
 * Proves the three properties the REV-leg fix rests on:
 *   1. seedCursorFromPg RESUMES a fold from persisted positions (a restart folds
 *      only the tail, not from 0 — the whole point vs the in-memory cursor that
 *      reset every bg-host restart and starved routinesTick → the REV loop).
 *   2. PERSIST-AFTER-APPLY (17c98's correctness invariant, mr5ymwgw): every
 *      persisted position is <= the count of ops whose apply has committed, so a
 *      crash between apply and persist RE-folds the last batch idempotently
 *      rather than SKIPPING it. With distinct keys (every op applies) the
 *      persisted position EQUALS the applied count at each persist point.
 *   3. INTRA-PASS persistence: a single pass over a > MERGE_PERSIST_EVERY_OPS
 *      backlog checkpoints progress MID-pass (not only after it returns), so a
 *      pass that outlasts the 240s bg-host watchdog still advances monotonically.
 *
 * RUN (unit — no PG/Docker):
 *   cd packages/operator-core && npx vitest run \
 *     lib/sync/hyperbee/__tests__/pg-merge-cursor.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  seedCursorFromPg,
  persistCursor,
  MERGE_PERSIST_EVERY_OPS,
  type AdmittedLog,
  type MergeCursor,
  type MergeCursorStore,
} from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

function fakeLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return {
    keyHex,
    get length() {
      return ops.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      return ops[i] ?? null;
    },
  };
}

function put(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value: { id: hbKey, ts }, ts, schema_version: 1, author_pubkey: 'pk' } as PeerLogOp;
}

/** An in-memory MergeCursorStore (== the PG store's contract), so the seam is
 *  exercised without a live PG. Records every save for assertions. */
function fakeStore(initial?: Map<string, number>): MergeCursorStore & { saves: Array<Map<string, number>>; data: Map<string, number> } {
  const data = new Map<string, number>(initial ?? []);
  const saves: Array<Map<string, number>> = [];
  return {
    data,
    saves,
    async load() {
      return new Map(data);
    },
    async save(positions) {
      // Snapshot the map at save time (the live cursor map mutates after).
      saves.push(new Map(positions));
      for (const [k, v] of positions) data.set(k, v);
    },
  };
}

/** N distinct-key puts on one log — every op applies (no LWW losers), so
 *  applied == decoded == cursor position throughout. */
function distinctLog(keyHex: string, n: number): AdmittedLog {
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < n; i++) ops.push(put('features_consolidated', `${keyHex}-K${i}`, 1000 + i));
  return fakeLog(keyHex, ops);
}

describe('seedCursorFromPg (WI-2105)', () => {
  it('seeds each log at its persisted position (fresh cursor)', async () => {
    const store = fakeStore(new Map([['logA', 40], ['logB', 12]]));
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store);
    expect(cursor.positions.get('logA')).toBe(40);
    expect(cursor.positions.get('logB')).toBe(12);
  });

  it('never rewinds a log that already has an in-memory position (idempotent)', async () => {
    const store = fakeStore(new Map([['logA', 40]]));
    const cursor = createMergeCursor();
    cursor.positions.set('logA', 55); // a live fold already ahead of PG
    await seedCursorFromPg(cursor, store);
    expect(cursor.positions.get('logA')).toBe(55); // NOT rewound to 40
  });

  it('ignores a persisted position of 0 (fold-from-0, nothing to skip)', async () => {
    const store = fakeStore(new Map([['logA', 0]]));
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store);
    expect(cursor.positions.has('logA')).toBe(false);
  });
});

describe('persistCursor (WI-2105)', () => {
  it('writes the positions through to the injected store', async () => {
    const store = fakeStore();
    await persistCursor(new Map([['logA', 7]]), store);
    expect(store.data.get('logA')).toBe(7);
  });
});

/** Fold `log` from a cursor, persisting via onCursorAdvance, tracking the
 *  committed-apply count so we can assert persist-after-apply at each persist. */
async function foldWithPersist(
  log: AdmittedLog,
  cursor: MergeCursor,
  store: MergeCursorStore,
): Promise<{ decoded: number; applied: number; persistVsApplied: Array<{ persisted: number; applied: number }> }> {
  let appliedCount = 0;
  const persistVsApplied: Array<{ persisted: number; applied: number }> = [];
  const result = await mergeAdmittedLogsIncremental([log], cursor, {
    getTimeoutMs: 0,
    // apply commits synchronously BEFORE any subsequent persist fires.
    applyImpl: async (_op: OpEnvelope) => {
      appliedCount++;
      return true;
    },
    onCursorAdvance: async (positions) => {
      persistVsApplied.push({ persisted: positions.get(log.keyHex) ?? 0, applied: appliedCount });
      await store.save(positions);
    },
  });
  return { decoded: result.decoded, applied: result.applied, persistVsApplied };
}

describe('mergeAdmittedLogsIncremental onCursorAdvance — persist-after-apply (WI-2105)', () => {
  it('every persisted position <= committed-apply count (crash re-folds, never skips)', async () => {
    const log = distinctLog('logA', 120);
    const store = fakeStore();
    const { persistVsApplied } = await foldWithPersist(log, createMergeCursor(), store);
    expect(persistVsApplied.length).toBeGreaterThan(0);
    for (const { persisted, applied } of persistVsApplied) {
      // The invariant: a persisted position is never AHEAD of durably-applied
      // ops → a crash at that point re-folds [persisted, …) idempotently.
      expect(persisted).toBeLessThanOrEqual(applied);
      // Distinct keys ⇒ every op applied ⇒ position EQUALS applied at persist.
      expect(persisted).toBe(applied);
    }
    // Final persisted position == full length.
    expect(store.data.get('logA')).toBe(120);
  });

  it('persists INTRA-pass for a backlog > MERGE_PERSIST_EVERY_OPS (survives a watchdog kill mid-pass)', async () => {
    const n = MERGE_PERSIST_EVERY_OPS + 1; // one op past the persist cadence
    const log = distinctLog('logBig', n);
    const store = fakeStore();
    const { persistVsApplied } = await foldWithPersist(log, createMergeCursor(), store);
    // At least one persist fired STRICTLY before the log completed — that is the
    // intra-pass checkpoint (persist-after-pass alone would capture nothing here,
    // the WI-2105 REV restart loop). And the cadence checkpoint lands at exactly
    // MERGE_PERSIST_EVERY_OPS.
    const positions = persistVsApplied.map((p) => p.persisted);
    expect(positions.some((p) => p > 0 && p < n)).toBe(true);
    // The cadence checkpoint fires at the top of the (MERGE_PERSIST_EVERY_OPS)th
    // iteration — BEFORE reading that op — so it persists the committed-apply
    // count so far == MERGE_PERSIST_EVERY_OPS - 1 (persist-after-apply, never ahead).
    expect(positions).toContain(MERGE_PERSIST_EVERY_OPS - 1);
    expect(store.data.get('logBig')).toBe(n);
  });
});

describe('restart-resume via PG-cursor (WI-2105 — the REV-leg fix)', () => {
  it('a seeded cursor folds ONLY the tail, not from 0 (monotonic across a restart)', async () => {
    // Boot 1: fold 100 ops, persisting positions to the store.
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 100; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));
    const store = fakeStore();
    const boot1 = await foldWithPersist(fakeLog('logA', [...ops]), createMergeCursor(), store);
    expect(boot1.decoded).toBe(100);
    expect(store.data.get('logA')).toBe(100);

    // 10 more ops land while "offline".
    for (let i = 100; i < 110; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));

    // Boot 2 (restart): a FRESH cursor SEEDED from PG resumes at 100 → the fold
    // decodes only the 10-op tail, NOT all 110 from 0. This is exactly what makes
    // a large orphaned log's fold complete across restarts instead of looping.
    const cursor2 = createMergeCursor();
    await seedCursorFromPg(cursor2, store);
    expect(cursor2.positions.get('logA')).toBe(100);
    const boot2 = await foldWithPersist(fakeLog('logA', [...ops]), cursor2, store);
    expect(boot2.decoded).toBe(10); // tail only — the resume win
    expect(store.data.get('logA')).toBe(110);
  });

  it('crash-consistency: re-folding from a mid-fold persisted position converges (idempotent)', async () => {
    // Simulate a crash after persisting position 60 of a 100-op log, then a
    // restart that re-folds [60,100). LWW-idempotent apply ⇒ same final applied
    // set as an uninterrupted fold; no op is skipped (persist was after apply).
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 100; i++) ops.push(put('features_consolidated', `K${i}`, 1000 + i));
    const store = fakeStore(new Map([['logA', 60]])); // persisted mid-fold pre-crash
    const cursor = createMergeCursor();
    await seedCursorFromPg(cursor, store);
    const applied: string[] = [];
    const result = await mergeAdmittedLogsIncremental([fakeLog('logA', ops)], cursor, {
      getTimeoutMs: 0,
      applyImpl: async (op: OpEnvelope) => {
        applied.push(op.hbKey ?? '');
        return true;
      },
    });
    // Only the un-persisted tail [60,100) re-folds — the persisted prefix's applies
    // already committed pre-crash, so re-folding them would be redundant, not wrong.
    expect(result.decoded).toBe(40);
    expect(applied).toEqual(Array.from({ length: 40 }, (_, i) => `K${60 + i}`));
  });
});

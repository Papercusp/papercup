/**
 * read-merge-intra-pass-persist.test.ts — WI-10002474.
 *
 * THE BUG: `mergeAdmittedLogsIncremental` cleared a log's `applyFailures` entry
 * only at pass END. A failure carried in from a PREVIOUS pass (seeded from PG)
 * therefore rode along on every INTRA-pass persist (every
 * `MERGE_PERSIST_EVERY_OPS`), beside a position that had advanced past it.
 * Migration 1122's check `apply_failure.position >= position` rejects that row,
 * the multi-row save fails for EVERY log, and the swallowed catch hid it. Seen on
 * the P-203 rig: the VM's durable cursor sat frozen at 1,849,877 while the
 * in-memory fold reached about 1.89M, so a restart would re-fold everything.
 *
 * TEETH: the fake store below enforces the 1122 invariant exactly as PG does.
 * Under the pre-fix code the first intra-pass save throws, and `saved` records
 * no advanced position, so test 1 fails.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  MERGE_PERSIST_EVERY_OPS,
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  resetCursorPersistWarnThrottleForTests,
  type AdmittedLog,
  type MergeApplyFailure,
  type MergeCursor,
} from './read-merge';
import type { PeerLogOp } from './peer-log';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(i: number): PeerLogOp {
  return {
    type: 'put',
    table: 'features-by-id',
    hbKey: `k${i}`,
    value: { id: `k${i}` },
    ts: 1000 + i,
    schema_version: 1,
    author_pubkey: 'pk',
  };
}
function staleFailure(position: number): MergeApplyFailure {
  return {
    position,
    groupKey: 'engineer-issues::papercusp/EI-1',
    kind: 'retryable',
    reason: 'duplicate key value violates unique constraint "work_items_watchdog_identity_uq"',
    errorCode: '23505',
    attempts: 628_488,
    firstSeenAt: 1,
    lastSeenAt: 2,
  };
}

/** A store that enforces migration 1122's row check the way PG does: one bad
 *  row fails the whole multi-row save. Records every accepted save. */
function constraintEnforcingStore(cursor: MergeCursor) {
  const saved: Array<Map<string, number>> = [];
  const onCursorAdvance = async (positions: ReadonlyMap<string, number>): Promise<void> => {
    for (const [keyHex, position] of positions) {
      const failure = cursor.applyFailures?.get(keyHex);
      if (failure && failure.position < position) {
        throw new Error(
          'new row for relation "substrate_merge_cursor" violates check constraint "substrate_merge_cursor_apply_failure_check"',
        );
      }
    }
    saved.push(new Map(positions));
  };
  return { saved, onCursorAdvance };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetCursorPersistWarnThrottleForTests();
});

describe('WI-10002474 — intra-pass cursor persist with a previous-pass failure', () => {
  it('a previous-pass failure the pass has applied past is cleared BEFORE the intra-pass persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const total = MERGE_PERSIST_EVERY_OPS + 10;
    const log = memLog('A', Array.from({ length: total }, (_, i) => put(i)));
    const cursor = createMergeCursor();
    // Seeded exactly as seedCursorFromPg leaves it after the old block: the
    // durable position equals the failure's position.
    cursor.positions.set('A', 0);
    cursor.applyFailures = new Map([['A', staleFailure(0)]]);
    const { saved, onCursorAdvance } = constraintEnforcingStore(cursor);

    await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: async () => true,
      getTimeoutMs: 0,
      onCursorAdvance,
    });

    // The intra-pass save landed an ADVANCED position (the pre-fix code threw here).
    const intraPass = saved.find((m) => (m.get('A') ?? 0) > 0 && (m.get('A') ?? 0) < total);
    expect(intraPass?.get('A')).toBe(MERGE_PERSIST_EVERY_OPS - 1);
    // The pass-end save landed too, and the failure is gone.
    expect(saved.at(-1)?.get('A')).toBe(total);
    expect(cursor.applyFailures?.has('A')).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('persist FAILED'), expect.anything());
  });

  it('a failure AHEAD of the intra-pass position is kept (it has not been reached yet)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const total = MERGE_PERSIST_EVERY_OPS + 10;
    const failAt = MERGE_PERSIST_EVERY_OPS + 5;
    const log = memLog('A', Array.from({ length: total }, (_, i) => put(i)));
    const cursor = createMergeCursor();
    const snapshots: Array<MergeApplyFailure | undefined> = [];
    await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: async (op) => {
        if (op.hbKey === `k${failAt}`) throw new Error('transient PG blip');
        return true;
      },
      getTimeoutMs: 0,
      onCursorAdvance: async () => {
        snapshots.push(cursor.applyFailures?.get('A'));
      },
    });
    // The op that failed THIS pass holds the cursor and keeps its record.
    expect(cursor.positions.get('A')).toBe(failAt);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: failAt, kind: 'retryable', attempts: 1 });
    expect(snapshots.at(-1)).toMatchObject({ position: failAt });
  });

  it('a persist that fails is WARNED about, never silently swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = memLog('A', [put(0), put(1)]);
    const cursor = createMergeCursor();
    const res = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: async () => true,
      getTimeoutMs: 0,
      onCursorAdvance: async () => {
        throw new Error('store down');
      },
    });
    // The pass itself still completes (persist stays best-effort)...
    expect(res.caughtUp).toBe(true);
    expect(cursor.positions.get('A')).toBe(2);
    // ...but the failure is visible.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('persist FAILED'), 'store down');
  });
});

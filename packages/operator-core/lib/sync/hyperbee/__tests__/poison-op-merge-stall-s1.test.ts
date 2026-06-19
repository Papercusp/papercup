import { describe, it, expect } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * Brief Z (shared-hive-release-testing) — Z#4/Z#5: the POISON-OP federation STALL.
 *
 * A single federated op whose PG apply THROWS is a poison pill: it permanently stalls
 * the incremental merge for its log AND cascades to every log ordered after it in the
 * pass — because nothing quarantines a throwing apply.
 *
 * Grounded chain (current code):
 *   1. NO NUL/control-char sanitization anywhere in the federation value path.
 *   2. title/summary/notes bind to PG TEXT columns; metadata/tags cast to JSONB — PG
 *      REJECTS a NUL (0x00) byte in either ("invalid byte sequence for encoding UTF8:
 *      0x00" / "unsupported Unicode escape sequence"). So a federated op with a NUL in
 *      any string field makes the projection write throw. (Binary / odd-unicode content
 *      pasted into a title/notes can carry it; nothing strips it on the way in or out.)
 *   3. projection.ts applyOpVia has NO try/catch around putToPg/deleteFromPg → the PG
 *      throw propagates out of `apply`.
 *   4. read-merge.ts mergeAdmittedLogsIncremental calls `await apply(env)` with NO
 *      try/catch (L~563) and sets `cursor.positions` only AFTER the per-op loop (L~565).
 *      So a throwing apply means the cursor NEVER advances past the poison op.
 *   5. The throw also aborts the outer `for (const log of logs)` loop → every log after
 *      the poison op's log in that pass is blocked too.
 * Net: the poison op re-throws every pass → permanent federation stall (a content-driven
 * liveness DoS), not a graceful skip/quarantine.
 *
 * PG-free + faithful: the applyImpl THROWS on a value carrying a literal NUL exactly as
 * the real PG write would on `${row.title}` — the merge cannot tell the difference, and
 * the defect under test is the merge's lack of quarantine, independent of the cause.
 * (We detect the NUL by scanning string fields, NOT via JSON.stringify — that escapes
 *   the NUL to a 6-char sequence and would never match the real failure.)
 *
 * FIX SHAPE (owner/lead's call — NOT applied here): quarantine a throwing apply — catch
 * it, record the poison op (boot-history / dead-letter), ADVANCE the cursor past it so
 * the rest of the log + the other logs keep draining; and sanitize NUL at the value
 * boundary so well-formed content never poisons. When fixed, flip the `it.fails` case.
 */

const NUL = String.fromCharCode(0); // a literal NUL char at runtime; no special byte in source

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}

function memLog(keyHex: string): OwnLog {
  const ops: PeerLogOp[] = [];
  return {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp) {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  };
}

/** True iff any (nested) string field holds a literal NUL — what PG rejects when the
 *  projection binds `${row.title}` etc. */
function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (value && typeof value === 'object') return Object.values(value).some(hasNul);
  return false;
}

/** applyImpl that throws on any put whose value carries a NUL (mimics the PG rejection). */
function pgLikeApply(pg: Map<string, unknown>) {
  return async (env: { table: string; hbKey: string; type: string; value?: unknown }) => {
    if (env.type === 'put' && hasNul(env.value)) {
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00'); // PG-shaped
    }
    const k = `${env.table}::${env.hbKey}`;
    if (env.type === 'del') pg.delete(k);
    else pg.set(k, env.value);
    return true;
  };
}

async function buildLog(): Promise<OwnLog> {
  const log = memLog('c0'.repeat(32));
  await log.append(put('queue', 'GOOD-1', { v: 'ok' }, 1));
  await log.append(put('queue', 'POISON', { title: 'bad' + NUL + 'title' }, 2)); // NUL in a field
  await log.append(put('queue', 'GOOD-2', { v: 'ok2' }, 3)); // after the poison
  return log;
}

describe('Brief Z Z#4/Z#5 — poison-op federation merge stall', () => {
  it('CURRENT (buggy): a throwing apply propagates out of the merge — uncaught', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    await expect(
      mergeAdmittedLogsIncremental([log], cursor, {
        getTimeoutMs: 0,
        maxOpsPerPass: 0,
        applyImpl: pgLikeApply(pg),
      }),
    ).rejects.toThrow(/invalid byte sequence/);
  });

  it('CURRENT (buggy): the cursor never advances past the poison op → re-throws every pass (stall)', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    await expect(
      mergeAdmittedLogsIncremental([log], cursor, { getTimeoutMs: 0, maxOpsPerPass: 0, applyImpl: pgLikeApply(pg) }),
    ).rejects.toThrow();
    // Cursor for this log is still at/before the poison op (index 1), NOT advanced to 3.
    expect(cursor.positions.get(log.keyHex) ?? 0).toBeLessThanOrEqual(1);
    // GOOD-1 (before the poison) applied; GOOD-2 (after) did NOT — it is blocked.
    expect(pg.has('queue::GOOD-1')).toBe(true);
    expect(pg.has('queue::GOOD-2')).toBe(false);
    // Pass 2 re-hits the same poison op → throws again (poison pill, never drains).
    await expect(
      mergeAdmittedLogsIncremental([log], cursor, { getTimeoutMs: 0, maxOpsPerPass: 0, applyImpl: pgLikeApply(pg) }),
    ).rejects.toThrow();
    expect(pg.has('queue::GOOD-2')).toBe(false); // still blocked
  });

  // DESIRED invariant (violated today): the merge QUARANTINES a poison op — survives,
  // advances past it, applies the good ops on the same log. it.fails because today the
  // merge throws before GOOD-2 is reached. Flip to `it` when the quarantine fix lands.
  it.fails(
    'DESIRED: the merge quarantines a poison op and still applies the surrounding good ops',
    async () => {
      const log = await buildLog();
      const pg = new Map<string, unknown>();
      const cursor = createMergeCursor();
      await mergeAdmittedLogsIncremental([log], cursor, {
        getTimeoutMs: 0,
        maxOpsPerPass: 0,
        applyImpl: pgLikeApply(pg),
      });
      expect(pg.has('queue::GOOD-1')).toBe(true);
      expect(pg.has('queue::GOOD-2')).toBe(true);
    },
  );
});

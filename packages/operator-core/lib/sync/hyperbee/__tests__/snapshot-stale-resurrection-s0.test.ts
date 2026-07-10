import { describe, it, expect } from 'vitest';
import { produceLogSnapshot } from '../log-snapshot';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  seedCursorFromSnapshots,
  type AdmittedLog,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * Brief Z (shared-pot-release-testing) — H-Z1: the stale-PUT-after-DELETE
 * RESURRECTION S0, made permanent by snapshot-seeded folds.
 *
 * read-merge.ts documents put-after-del as a "KNOWN BOUNDED TRANSIENT" (line ~466):
 * deletes leave NO PG tombstone, so a reset replay that folds an old put before its
 * winning del re-INSERTs the row "until the del re-applies … the fixpoint always
 * converges." That bound RELIES on the reset re-folding from index 0 so the winning
 * del is re-read and re-wins.
 *
 * With `papercusp-substrate-log-snapshot` ON (verified ON in this workspace) that bound
 * is DEFEATED — a 5-fact chain:
 *   1. snapshots OMIT deleted keys (log-snapshot.ts:~66 — no tombstone, no del HLC);
 *   2. `seedCursorFromSnapshots` seeds the cursor AT the snapshot index (read-merge.ts:~360),
 *      so every op before it — INCLUDING the winning del — is never re-folded;
 *   3. the in-memory `winners` fold is therefore EMPTY for that key after a seeded reset;
 *   4. a stale, lower-clock PUT for the key (e.g. a partitioned/healed peer's old op)
 *      arriving past the snapshot horizon folds with no del to beat → applied;
 *   5. the PG PUT guard (`ON CONFLICT DO UPDATE WHERE EXCLUDED.fed_* >= …`) only fires
 *      when a row EXISTS — after a bare del there is no row → no conflict → bare INSERT.
 * Net: the deleted key is RESURRECTED with the stale value, PERMANENTLY (the del is
 * behind the snapshot horizon and never re-applies). This is the same gap d2230 staged
 * in findings-Z.md (H-Z1), confirmed against current code.
 *
 * INVARIANT Z must hold: a key whose winning op is a DELETE stays absent on every peer
 * regardless of fold path — a later-ARRIVING but causally-EARLIER (lower-clock) put must
 * NOT resurrect it.
 *
 * This file is the deterministic, PG-free proof (the snapshot-fold harness). The fix is
 * the OWNER's call (a durable per-key tombstone with the del's HLC/ts that the PUT guard
 * checks; GC past a safe horizon) — NOT applied here. When it lands, flip `it.fails` →
 * `it` on the seeded-fold case.
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}
function del(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table, hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

/** In-memory log satisfying OwnLog (append/get/length/keyHex) + AdmittedLog. */
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

/** Fold `logs` into a simulated PG, seeding each log's cursor at `startIndex`. */
async function foldToPg(
  logs: AdmittedLog[],
  startIndex: number,
): Promise<Record<string, unknown>> {
  const pg = new Map<string, unknown>();
  const cursor = createMergeCursor();
  for (const l of logs) cursor.positions.set(l.keyHex, startIndex);
  await mergeAdmittedLogsIncremental(logs, cursor, {
    getTimeoutMs: 0,
    maxOpsPerPass: 0,
    applyImpl: async (env) => {
      const k = `${env.table}::${env.hbKey}`;
      if (env.type === 'del') pg.delete(k);
      else pg.set(k, env.value);
      return true;
    },
  });
  return Object.fromEntries(pg);
}

/** Fold with the PRODUCTION reader-seed path: a fresh cursor seeded from each log's
 *  latest snapshot (snapshots-ON behavior), then incremental fold forward. */
async function foldSeededFromSnapshots(logs: AdmittedLog[]): Promise<Record<string, unknown>> {
  const pg = new Map<string, unknown>();
  const cursor = createMergeCursor();
  await seedCursorFromSnapshots(logs, cursor, { maxLookback: 1000, getTimeoutMs: 0 });
  await mergeAdmittedLogsIncremental(logs, cursor, {
    getTimeoutMs: 0,
    maxOpsPerPass: 0,
    applyImpl: async (env) => {
      const k = `${env.table}::${env.hbKey}`;
      if (env.type === 'del') pg.delete(k);
      else pg.set(k, env.value);
      return true;
    },
  });
  return Object.fromEntries(pg);
}

/**
 * Build the scenario, CROSS-LOG (the realistic shape):
 *   - log A (owner): put(A) → del(A, high ts) → put(B), then a snapshot covering all
 *     three (omits A, deleted). A snapshot-seeded reader skips A's del.
 *   - log B (a healed/partitioned peer): a single STALE put(A, low ts) — its old op,
 *     federating late, past A's snapshot horizon.
 * Winning op for key A across the logs is A's del (ts 5) — A must stay DELETED.
 */
async function buildScenario(): Promise<{ logA: OwnLog; logB: OwnLog }> {
  const logA = memLog('a1'.repeat(32));
  await logA.append(put('queue', 'A', { v: 'v0' }, 1));
  await logA.append(del('queue', 'A', 5)); // A DELETED — the winner (highest ts)
  await logA.append(put('queue', 'B', { v: 'b' }, 6));
  await produceLogSnapshot(logA, { now: 100, schemaVersion: 1 }); // omits A (del'd)

  const logB = memLog('b2'.repeat(32));
  await logB.append(put('queue', 'A', { v: 'STALE' }, 2)); // late, lower ts than the del
  return { logA, logB };
}

describe('Brief Z H-Z1 — snapshot-seeded stale-PUT-after-DELETE resurrection (S0)', () => {
  it('CONTROL: a full fold from index 0 keeps the deleted key absent (the del wins)', async () => {
    const { logA, logB } = await buildScenario();
    const pg = await foldToPg([logA, logB], 0);
    // del(A, ts5) beats the stale put(A, ts2) in the global winners fold → A absent.
    expect(pg['queue::A']).toBeUndefined();
    expect(pg['queue::B']).toEqual({ v: 'b' });
  });

  // EI-1688 FIXED (su-c2a63): log-snapshot.ts buildSnapshotRows now reconstitutes a
  // deleted key as a TOMBSTONE row (carrying the del's ts/hlc) instead of omitting it,
  // and read-merge.ts snapshotRowToEnvelope emits a `del` env for it. So the
  // snapshot-seeded fold seeds winners[A]=del(ts5) → the stale put(A, ts2) loses the
  // per-op winner-gate (read-merge.ts `!beatsStored → continue`) → A stays absent.
  // (Was `it.fails` while the resurrection stood.)
  it(
    'S0 FIXED: the snapshot-seeded fold keeps the deleted key absent (EI-1688 — del-tombstone carried)',
    async () => {
      const { logA, logB } = await buildScenario();
      const pgSeeded = await foldSeededFromSnapshots([logA, logB]);
      // INVARIANT Z: A was deleted (ts5) → it STAYS gone, even though A's del sits
      // behind logA's snapshot horizon — the snapshot carries A's del-tombstone.
      expect(pgSeeded['queue::A']).toBeUndefined();
    },
  );

  it('CONVERGENCE (EI-1688 fixed): seeded fold and full fold now AGREE — the deleted key stays absent', async () => {
    const { logA, logB } = await buildScenario();
    const fromZero = await foldToPg([logA, logB], 0);
    const seeded = await foldSeededFromSnapshots([logA, logB]);
    // EI-1688 was the counterexample where the snapshot-seeded fold diverged from the
    // full fold (it RESURRECTED A with the stale put). With A's del carried as a
    // snapshot tombstone, the seeded fold matches the full fold — A absent on BOTH.
    expect(fromZero['queue::A']).toBeUndefined(); // correct (the del wins)
    expect(seeded['queue::A']).toBeUndefined(); // now ALSO absent — no resurrection
    expect(seeded['queue::B']).toEqual({ v: 'b' }); // a live key still reconstitutes
  });
});

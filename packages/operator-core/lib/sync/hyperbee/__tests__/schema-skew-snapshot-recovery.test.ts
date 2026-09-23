/**
 * schema-skew-snapshot-recovery.test.ts — Brief F (shared-pot-release-testing)
 * Scenario 7, caveat C2 (raised in findings-F.md): the SNAPSHOT-COMPACTION ×
 * SCHEMA-SKEW interaction.
 *
 * `schema-skew-rolling-upgrade.test.ts` proved that an op a peer gate-dropped while
 * on an old build is RECOVERED after upgrade — because the upgrade restarts the
 * process, which rebuilds a fresh merge cursor that re-folds the whole log from 0.
 * But with log-snapshot compaction enabled (flag `papercusp-substrate-log-snapshot`),
 * boot.ts seeds a fresh cursor at the log's LATEST snapshot index
 * (`seedCursorFromSnapshots`), SKIPPING the summarized prefix. If the formerly-
 * dropped newer op lived in that skipped prefix, the upgraded peer never re-reads
 * it — recovery then depends ENTIRELY on the snapshot having reconstituted that
 * key's value. C2 asked: does it?
 *
 * Answer (this test, teeth-verified): YES. The producer's snapshot includes the
 * newer key (latest live put per key), tagged at the producer's version, so:
 *   - the OLD peer drops the whole snapshot op (its version > known) → no v2 row
 *     leaks past the gate (the op-level gate protects the old peer), AND
 *   - the UPGRADED peer seeds its cursor AT the snapshot (past the original op's
 *     index) and recovers the key SOLELY from the snapshot's reconstituted row.
 *
 * Drives the real `seedCursorFromSnapshots` + `mergeAdmittedLogsIncremental` + a
 * real `buildSnapshotOp`, with a faithful mirror of boot.ts's (private)
 * `versionGatedLog` parameterized by the reading peer's build version.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  seedCursorFromSnapshots,
  createMergeCursor,
  type AdmittedLog,
} from '../read-merge';
import { buildSnapshotOp } from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

const KNOWN_OLD = 1; // an old build's CURRENT_SCHEMA_VERSION
const NEWER = 2; // a newer build's version
const AUTHOR = 'b'.repeat(64);

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

/** Faithful mirror of boot.ts `versionGatedLog`, parameterized by the reader's
 *  build version. Forwards no prefetch (the snapshot scan reads sequentially). */
function gate(log: AdmittedLog, known: number): AdmittedLog {
  return {
    keyHex: log.keyHex,
    get length() {
      return log.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      const op = await log.get(i);
      if (!op) return null;
      if ((op.schema_version ?? 0) > known) return null; // unknown-newer → drop
      return op;
    },
  };
}

function put(hbKey: string, ts: number, schema_version: number): PeerLogOp {
  return {
    type: 'put',
    table: 'skew_snap_table',
    hbKey,
    value: { id: hbKey },
    ts,
    schema_version,
    author_pubkey: AUTHOR,
  } as PeerLogOp;
}

function captureSink() {
  const appliedKeys: string[] = [];
  return {
    appliedKeys,
    applyImpl: async (op: OpEnvelope): Promise<boolean> => {
      appliedKeys.push(op.hbKey!);
      return true;
    },
  };
}

describe('Brief F / Scenario 7 C2 — schema-skew × snapshot-compaction recovery', () => {
  // Peer B (newer build) wrote K1@v1, K_future@v2, K3@v1, then COMPACTED: a snapshot
  // op covering [0,3) at the producer's version (v2), reconstituting all three keys.
  const prefix: PeerLogOp[] = [
    put('K1', 100, KNOWN_OLD),
    put('K_future', 200, NEWER), // the newer-than-known op the old peer will drop
    put('K3', 300, KNOWN_OLD),
  ];
  const snapshotOp = buildSnapshotOp({
    ops: prefix,
    coversUpTo: prefix.length,
    author_pubkey: AUTHOR,
    ts: 400,
    schema_version: NEWER, // a v2 producer stamps its snapshot at v2
  });
  const bLog = [...prefix, snapshotOp]; // snapshot at index 3
  const SNAP_INDEX = prefix.length; // 3

  it('OLD peer: the v2 snapshot op is gate-dropped wholesale → no v2 row leaks past the gate', async () => {
    const B = fakeLog('B', bLog);
    const cursor = createMergeCursor();
    const sink = captureSink();

    // Snapshot seeding runs over the GATED log (as boot.ts does). The v2 snapshot
    // reads as null on an old peer, so the cursor is NOT seeded → folds from 0.
    await seedCursorFromSnapshots([gate(B, KNOWN_OLD)], cursor);
    expect(cursor.positions.get('B') ?? 0).toBe(0);

    await mergeAdmittedLogsIncremental([gate(B, KNOWN_OLD)], cursor, {
      applyImpl: sink.applyImpl,
      getTimeoutMs: 0,
    });

    // Compatible keys applied; the newer key is NOT applied — not via its own op
    // (gate-dropped) and not via the snapshot (the whole snapshot op is gate-dropped,
    // so its v2 row never reaches apply). The op-level gate protects the old peer.
    expect(sink.appliedKeys.sort()).toEqual(['K1', 'K3']);
    expect(sink.appliedKeys).not.toContain('K_future');
  });

  it('UPGRADED peer: seeds the cursor PAST the original op and recovers the key SOLELY from the snapshot', async () => {
    const B = fakeLog('B', bLog);
    const cursor = createMergeCursor();
    const sink = captureSink();

    // Upgrade = restart → fresh cursor + known is now NEWER. Snapshot seeding now
    // accepts the v2 snapshot and seeds the cursor AT it — PAST the original
    // K_future op's index (1). So K_future can ONLY be recovered via the snapshot row.
    await seedCursorFromSnapshots([gate(B, NEWER)], cursor);
    expect(cursor.positions.get('B')).toBe(SNAP_INDEX);
    expect(SNAP_INDEX).toBeGreaterThan(1); // the cursor truly skipped the original op's index

    await mergeAdmittedLogsIncremental([gate(B, NEWER)], cursor, {
      applyImpl: sink.applyImpl,
      getTimeoutMs: 0,
    });

    // RECOVERY: the snapshot reconstituted every key, including the formerly-dropped
    // newer one — so compaction does NOT cause permanent loss across a rolling upgrade.
    expect(sink.appliedKeys.sort()).toEqual(['K1', 'K3', 'K_future']);
    expect(sink.appliedKeys).toContain('K_future');
  });

  it('P-004: an OLD peer with a positioned cursor does NOT jump (it cannot read the v2 set)', async () => {
    const B = fakeLog('B', bLog);
    const cursor = createMergeCursor();
    cursor.positions.set('B', 1);
    await seedCursorFromSnapshots([gate(B, KNOWN_OLD)], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    expect(cursor.positions.get('B')).toBe(1);
  });

  it('P-004: an UPGRADED peer whose cursor sat behind the dropped op jumps and recovers it from the set', async () => {
    // Resumed at position 2 (it had folded K1, gate-dropped K_future on the old build).
    // After the upgrade the durable position survives, so fresh seeding never runs.
    // Only the far-behind jump can reach the set.
    const B = fakeLog('B', bLog);
    const cursor = createMergeCursor();
    cursor.positions.set('B', 2);
    const sink = captureSink();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedCursorFromSnapshots([gate(B, NEWER)], cursor, { getTimeoutMs: 0, jumpMinBacklogOps: 1 });
    warn.mockRestore();
    expect(cursor.positions.get('B')).toBe(SNAP_INDEX);
    await mergeAdmittedLogsIncremental([gate(B, NEWER)], cursor, { applyImpl: sink.applyImpl, getTimeoutMs: 0 });
    expect(sink.appliedKeys).toContain('K_future');
  });
});

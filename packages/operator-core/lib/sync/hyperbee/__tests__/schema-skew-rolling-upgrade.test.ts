/**
 * schema-skew-rolling-upgrade.test.ts — Brief F (shared-pot-release-testing)
 * Scenario 7: schema-version skew across a ROLLING public upgrade.
 *
 * The existing `version-gate-merge.test.ts` proves the DROP half: an old peer
 * (known = CURRENT_SCHEMA_VERSION) drops a newer peer's `CURRENT+1` op + alerts
 * once, and a repeat merge is idempotent. It does NOT prove the RELEASE-CRITICAL
 * half a public rolling upgrade depends on:
 *
 *   When the old peer UPGRADES, are the ops it previously dropped RECOVERED, or
 *   are they lost forever?
 *
 * The answer is load-bearing and SUBTLE. The merge driver advances the cursor
 * PAST a version-gated drop (read-merge.ts: `if (!op) continue; // version-gated
 * drop — advance past it`). The merge cursor is in-memory and NEVER persisted
 * (read-merge.ts MergeCursor doc), and boot.ts creates a FRESH cursor every boot.
 * So:
 *
 *   - Within one process session, a gate-dropped op is skipped for good (the
 *     cursor has moved past it). It is recovered ONLY by a cursor rebuild.
 *   - A real upgrade is a NEW BUILD = a PROCESS RESTART. The restart boots a
 *     fresh cursor that re-folds every log from index 0; with the now-higher
 *     `known` version the gate accepts the formerly-newer op → it is APPLIED.
 *
 * So rolling upgrades are SAFE *because* the upgrade is a restart and the cursor
 * is non-persisted. This is an IMPLICIT, undocumented invariant: "the known
 * schema version can only rise via a process restart." If anyone ever wires the
 * in-session learning the schema-version.ts header doc once promised
 * (`notedHigherSchemaVersion`, which does NOT exist) WITHOUT resetting merge
 * cursors, every op gate-dropped earlier in the session is lost permanently.
 *
 * This test LOCKS that contract end-to-end:
 *   Phase 1  old peer (known=1) drops the v2 op + advances the cursor past it.
 *   Phase 2  upgrade = restart (fresh cursor, known=2) → the v2 op is RECOVERED.
 *   Phase 3  in-session known-bump WITHOUT a cursor reset → the v2 op stays LOST
 *            (the regression guard against a naive notedHigherSchemaVersion).
 *
 * It drives `mergeAdmittedLogsIncremental` directly over fake AdmittedLogs. The
 * `gate(log, known)` wrapper is a faithful mirror of boot.ts's (non-exported)
 * `versionGatedLog`; Phase 1 also ANCHORS to the real exported `acceptOpVersion`
 * so the model can't drift from production's gate decision.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  type AdmittedLog,
  type MergeCursor,
} from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';
import {
  acceptOpVersion,
  CURRENT_SCHEMA_VERSION,
  _resetForTests as _resetSchemaVersionForTests,
} from '../schema-version';

afterEach(() => {
  _resetSchemaVersionForTests();
});

const AUTHOR = 'b'.repeat(64);

/** An in-memory single-writer log satisfying the merge's AdmittedLog view. */
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

/**
 * Faithful mirror of boot.ts's `versionGatedLog` (which is module-private, so it
 * cannot be imported). `known` models the reading peer's build version: an op
 * with `schema_version > known` resolves `null` (dropped), exactly like the real
 * gate's `acceptOpVersion(slug, version)` => `version <= known`.
 */
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
    table: 'skew_table',
    hbKey,
    value: { id: hbKey },
    ts,
    schema_version,
    author_pubkey: AUTHOR,
  } as PeerLogOp;
}

/** Capture every op handed to the apply sink (always "applied"). */
function captureSink() {
  const appliedKeys: string[] = [];
  const applyImpl = async (op: OpEnvelope): Promise<boolean> => {
    appliedKeys.push(op.hbKey!);
    return true;
  };
  return { appliedKeys, applyImpl };
}

describe('Brief F / Scenario 7 — schema-skew rolling upgrade (recovery + contract)', () => {
  // Peer B (on the newer build) wrote: two CURRENT-version ops and, between them,
  // one CURRENT+1 op (a field only the newer build knows). LWW order by ts.
  const V = CURRENT_SCHEMA_VERSION; // 1
  const NEWER = CURRENT_SCHEMA_VERSION + 1; // 2
  const peerBOps = [
    put('K1', 100, V), // compatible
    put('K2', 200, NEWER), // newer-than-known for an old peer
    put('K3', 300, V), // compatible
  ];

  it('Phase 1 — old peer (known=CURRENT) drops the newer op and advances the cursor PAST it', async () => {
    // Anchor the model to production's real gate decision.
    expect(acceptOpVersion('skew', V)).toBe(true);
    expect(acceptOpVersion('skew', NEWER)).toBe(false);

    const B = fakeLog('B', peerBOps);
    const cursor = createMergeCursor();
    const { appliedKeys, applyImpl } = captureSink();

    const res = await mergeAdmittedLogsIncremental([gate(B, V)], cursor, {
      applyImpl,
      getTimeoutMs: 0,
    });

    // Only the compatible ops applied; the newer op was dropped.
    expect(appliedKeys.sort()).toEqual(['K1', 'K3']);
    expect(appliedKeys).not.toContain('K2');
    // The merge fully caught up — and the cursor sits at the log's END, i.e. it
    // ADVANCED PAST the dropped op (the load-bearing behavior this brief probes).
    expect(res.caughtUp).toBe(true);
    expect(cursor.positions.get('B')).toBe(peerBOps.length);
    // Only the two compatible ops were decoded+folded as winners.
    expect(res.applied).toBe(2);
  });

  it('Phase 2 — upgrade = process restart (FRESH cursor, known=CURRENT+1) RECOVERS the dropped op (no permanent loss)', async () => {
    const B = fakeLog('B', peerBOps);

    // Pre-upgrade session: old build drops K2.
    const oldCursor = createMergeCursor();
    const pre = captureSink();
    await mergeAdmittedLogsIncremental([gate(B, V)], oldCursor, {
      applyImpl: pre.applyImpl,
      getTimeoutMs: 0,
    });
    expect(pre.appliedKeys).not.toContain('K2');

    // Upgrade: a NEW BUILD restarts the process. boot.ts creates a FRESH cursor
    // (`createMergeCursor()` at boot) and the new build's known version is higher.
    const upgradedCursor = createMergeCursor();
    const post = captureSink();
    const res = await mergeAdmittedLogsIncremental([gate(B, NEWER)], upgradedCursor, {
      applyImpl: post.applyImpl,
      getTimeoutMs: 0,
    });

    // RECOVERY: the formerly-dropped op is now applied. A rolling upgrade loses
    // nothing — the restart's fresh-cursor re-fold re-reads B's whole log.
    expect(post.appliedKeys.sort()).toEqual(['K1', 'K2', 'K3']);
    expect(post.appliedKeys).toContain('K2');
    expect(res.applied).toBe(3);
  });

  it('Phase 3 — CONTRACT GUARD: raising known WITHOUT a cursor reset leaves the dropped op LOST forever', async () => {
    const B = fakeLog('B', peerBOps);

    // Old session drops K2 and advances the cursor to the end.
    const cursor: MergeCursor = createMergeCursor();
    const first = captureSink();
    await mergeAdmittedLogsIncremental([gate(B, V)], cursor, {
      applyImpl: first.applyImpl,
      getTimeoutMs: 0,
    });
    expect(first.appliedKeys).not.toContain('K2');
    expect(cursor.positions.get('B')).toBe(peerBOps.length);

    // Hypothetical in-session learning: `known` rises to NEWER mid-session (what a
    // naive `notedHigherSchemaVersion` would do) but the SAME cursor is reused —
    // it already points past K2's index, so K2 is NEVER re-read.
    const second = captureSink();
    const res = await mergeAdmittedLogsIncremental([gate(B, NEWER)], cursor, {
      applyImpl: second.applyImpl,
      getTimeoutMs: 0,
    });

    // K2 stays LOST. This is WHY recovery requires the restart's cursor rebuild
    // (Phase 2), not just a version bump. If a future change makes `known` rise
    // in-session, it MUST reset every merge cursor or this assertion will (and
    // should) start failing — the regression guard against silent data loss.
    expect(second.appliedKeys).not.toContain('K2');
    expect(res.applied).toBe(0); // nothing new past the already-advanced cursor
    expect(res.caughtUp).toBe(true);
  });

  it('forward-compat — a NEWER peer (known=CURRENT+1) applies an OLD peer\'s CURRENT-version ops unchanged', async () => {
    // The other direction of skew during a rolling upgrade: already-upgraded peers
    // must keep applying not-yet-upgraded peers' ops (older <= known).
    const oldPeer = fakeLog('OLD', [put('A1', 10, V), put('A2', 20, V)]);
    const cursor = createMergeCursor();
    const { appliedKeys, applyImpl } = captureSink();

    const res = await mergeAdmittedLogsIncremental([gate(oldPeer, NEWER)], cursor, {
      applyImpl,
      getTimeoutMs: 0,
    });

    expect(appliedKeys.sort()).toEqual(['A1', 'A2']);
    expect(res.applied).toBe(2);
    expect(res.caughtUp).toBe(true);
  });
});

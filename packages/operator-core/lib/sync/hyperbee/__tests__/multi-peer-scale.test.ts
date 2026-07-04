/**
 * multi-peer-scale.test.ts — Brief F (shared-hive-release-testing) Scenarios 6 + 3:
 * SCALE (many peers, large history) and LONG-OFFLINE BACKFILL.
 *
 * The bench runner (perf/) measures these with real OS processes; merge-scaling.
 * test.ts locks the single-own-log idle invariant at 20k. Neither exercises the
 * production merge CORE (`mergeAdmittedLogsIncremental`) across 8–16 PEER logs of
 * 10k–50k ops each. This test does, deterministically (synthetic peer logs, no
 * DHT/corestore), and records the measured numbers the findings cite. It is the
 * same merge core boot.ts drives every tick — driving it directly is the faithful
 * way to reach 16 peers without 16 live corestores.
 *
 * Locks (deterministic):
 *   - CONVERGENCE / NO LOSS: after backfill the standing winner map holds EXACTLY
 *     one entry per distinct key across all peers (peers × distinctKeys).
 *   - FULL READ: backfill decodes every op (peers × opsPerPeer), none skipped.
 *   - IDLE-AFTER-BACKFILL (the EI-79 skip at scale, and the S3 "offline peer
 *     rejoins then idles" property): a tick with no growth decodes 0, applies 0.
 * Plus GENEROUS timing/RSS belt-and-braces (logged, asserted only against a loose
 * ceiling so it can't flake under CI load).
 */

import { describe, expect, it } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  type AdmittedLog,
  type MergeCursor,
} from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * A LAZY synthetic peer log: `get(i)` synthesizes op i on demand, so the fixture
 * holds NO op objects — the measured heap growth is the merge's OWN footprint
 * (the standing winner map), not a pre-built corpus. Keys are
 * `${keyHex}-K${i % distinctKeys}` and ts climbs with i, so re-writes to the same
 * key LWW-resolve to the latest (real fold work), collapsing to `distinctKeys`
 * winners per peer.
 */
function lazyPeerLog(keyHex: string, opsLen: number, distinctKeys: number): AdmittedLog {
  return {
    keyHex,
    get length() {
      return opsLen;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      if (i < 0 || i >= opsLen) return null;
      const k = `${keyHex}-K${i % distinctKeys}`;
      return {
        type: 'put',
        table: 'scale_table',
        hbKey: k,
        value: { id: k, i },
        ts: 1000 + i, // strictly increasing → later re-write of a key wins
        schema_version: 1,
        author_pubkey: keyHex.padEnd(64, '0').slice(0, 64),
      } as PeerLogOp;
    },
  };
}

/** A counting apply sink — never retains op data, so it doesn't skew the RSS read. */
function countingSink() {
  let applied = 0;
  const applyImpl = async (_op: OpEnvelope): Promise<boolean> => {
    applied++;
    return true;
  };
  return { get applied() { return applied; }, applyImpl };
}

/** Run a full backfill (loop passes until caught up) then one idle tick. */
async function backfillThenIdle(
  logs: AdmittedLog[],
  cursor: MergeCursor,
): Promise<{
  backfillMs: number;
  totalDecoded: number;
  passes: number;
  idleMs: number;
  idleDecoded: number;
  idleApplied: number;
  rssDeltaMb: number;
}> {
  const sink = countingSink();
  const rssBefore = process.memoryUsage().rss;

  const t0 = process.hrtime.bigint();
  let totalDecoded = 0;
  let passes = 0;
  for (;;) {
    const r = await mergeAdmittedLogsIncremental(logs, cursor, {
      applyImpl: sink.applyImpl,
      getTimeoutMs: 0,
    });
    totalDecoded += r.decoded;
    passes++;
    if (r.caughtUp) break;
    if (passes > 1000) throw new Error('backfill did not converge'); // safety
  }
  const backfillMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;

  // Idle tick: no growth → the skip path.
  const tIdle = process.hrtime.bigint();
  const idle = await mergeAdmittedLogsIncremental(logs, cursor, {
    applyImpl: sink.applyImpl,
    getTimeoutMs: 0,
  });
  const idleMs = Number(process.hrtime.bigint() - tIdle) / 1e6;

  return {
    backfillMs,
    totalDecoded,
    passes,
    idleMs,
    idleDecoded: idle.decoded,
    idleApplied: idle.applied,
    rssDeltaMb,
  };
}

describe('Brief F / Scenario 6 — scale: many peers × large history', () => {
  // [peers, opsPerPeer]. distinctKeys = half the ops (≈50% re-writes — real fold work).
  const matrix: Array<[number, number]> = [
    [8, 10_000],
    [16, 10_000],
    [8, 50_000],
    [16, 50_000],
  ];

  for (const [peers, opsPerPeer] of matrix) {
    it(`${peers} peers × ${opsPerPeer.toLocaleString()} ops: converges with no loss, then idles (decode/apply 0)`, async () => {
      const distinctKeys = Math.max(1, Math.floor(opsPerPeer / 2));
      const logs: AdmittedLog[] = Array.from({ length: peers }, (_, p) =>
        lazyPeerLog(`peer${p}`, opsPerPeer, distinctKeys),
      );
      const cursor = createMergeCursor();

      const m = await backfillThenIdle(logs, cursor);

      const expectedDistinct = peers * distinctKeys;
      const totalOps = peers * opsPerPeer;

      // CONVERGENCE / NO LOSS: exactly one winner per distinct key, fleet-wide.
      expect(cursor.winners.size).toBe(expectedDistinct);
      // FULL READ: every op was decoded across the backfill passes (none skipped).
      expect(m.totalDecoded).toBe(totalOps);
      // IDLE-AFTER-BACKFILL: the steady-state skip — zero decode, zero apply.
      expect(m.idleDecoded).toBe(0);
      expect(m.idleApplied).toBe(0);

      // Belt-and-braces (LOGGED for the findings matrix; asserted only loosely).
       
      console.log(
        `[scale] ${peers}p × ${opsPerPeer} ops: backfill=${m.backfillMs.toFixed(0)}ms ` +
          `(${m.passes} pass) idle=${m.idleMs.toFixed(2)}ms decoded=${m.totalDecoded} ` +
          `winners=${cursor.winners.size} rssΔ=${m.rssDeltaMb.toFixed(1)}MB`,
      );
      // An idle tick is O(#logs), not O(history): it must be trivially cheap even
      // at 16×50k. 250ms is a vast CI-headroom ceiling over the real sub-ms cost.
      expect(m.idleMs).toBeLessThan(250);
    }, 120_000);
  }
});

describe('Brief F / Scenario 3 — long-offline peer rejoins after a large gap, then idles', () => {
  it('a peer offline while the hive advanced 50k ops backfills fully, then decodes/applies NOTHING', async () => {
    // The rejoining peer sees one remote log that grew to 50k ops while it was down.
    const GAP = 50_000;
    const distinctKeys = 8_000; // ~6 re-writes/key on average
    const remote = lazyPeerLog('faraway', GAP, distinctKeys);
    const cursor = createMergeCursor();
    const m = await backfillThenIdle([remote], cursor);

    // Full backfill of the gap; converges to the distinct-key winner set.
    expect(m.totalDecoded).toBe(GAP);
    expect(cursor.winners.size).toBe(distinctKeys);

    // Idle thereafter: many ticks each decode + apply NOTHING (the brief's core
    // "idle ticks must decode/apply NOTHING after backfill", extended to a large gap).
    for (let i = 0; i < 10; i++) {
      const idle = await mergeAdmittedLogsIncremental([remote], cursor, { getTimeoutMs: 0 });
      expect(idle.decoded).toBe(0);
      expect(idle.applied).toBe(0);
      expect(idle.caughtUp).toBe(true);
    }
     
    console.log(
      `[backfill] 50k-op gap: backfill=${m.backfillMs.toFixed(0)}ms idle=${m.idleMs.toFixed(2)}ms ` +
        `winners=${cursor.winners.size} rssΔ=${m.rssDeltaMb.toFixed(1)}MB`,
    );
  }, 120_000);
});

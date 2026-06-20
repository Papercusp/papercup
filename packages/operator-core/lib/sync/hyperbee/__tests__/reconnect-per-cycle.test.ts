/**
 * reconnect-per-cycle.test.ts — Brief F (shared-hive-release-testing) Scenario 1,
 * the per-cycle half. `swarm-chaos.test.ts` exercises the REAL Hyperswarm transport
 * under kill/reconnect churn and asserts convergence ONCE after all churn (+ no dup,
 * admission/revocation under churn). It does NOT assert that NO OPS ARE MISSED across
 * EACH reconnect boundary, nor that presence/heartbeat recovers per cycle — the brief's
 * explicit S1 ask.
 *
 * Asserting that against a real DHT would be flaky (retry-timer backoff + dedupe churn —
 * documented in swarm-chaos.test.ts). The INVARIANT — "ops written while disconnected are
 * delivered on reconnect, every cycle, and the presence heartbeat resumes" — is transport-
 * agnostic, so this test proves it DETERMINISTICALLY on the severable piped-replication rig
 * (three-peer-partition-rejoin.test.ts's pattern): real Corestores, real piped replication
 * streams (sever = destroy the streams), the real incremental LWW merge. The real-transport
 * path is covered once by swarm-chaos; this adds the per-cycle invariant without the flake.
 *
 * Each of N cycles: SEVER the link, BOTH peers write a feature op AND a presence heartbeat
 * while disconnected, RECONNECT, then assert — BEFORE the next cycle —
 *   (a) NO MISSED OPS: each peer now holds every feature key written through this cycle,
 *   (b) PRESENCE/HEARTBEAT RECOVERS: each peer sees the OTHER's LATEST heartbeat ts,
 *   (c) watermark cursors are monotonic + the merge caught up (no fork/reset).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOwnLog, openRemoteLog, type OwnLog, type PeerLogOp, type RemoteLog } from '../peer-log';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  type MergeCursor,
} from '../read-merge';
import type { OpEnvelope } from '../op-envelope-types';

const FEATURE_TABLE = 'features_consolidated';
const PRESENCE_TABLE = 'presence';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* teardown best-effort */
    }
  }
});

function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const store = new Corestore(dir);
  cleanups.push(() => void store.close());
  return store;
}

/** A severable replication link between two Corestores (a "network cable"). */
interface Link {
  sever(): void;
}
function link(s1: Corestore, s2: Corestore): Link {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
  return {
    sever() {
      try {
        a.destroy();
      } catch {
        /* already closed */
      }
      try {
        b.destroy();
      } catch {
        /* already closed */
      }
    },
  };
}

class Peer {
  readonly store: Corestore;
  own!: OwnLog;
  readonly cursor: MergeCursor = createMergeCursor();
  readonly remotes = new Map<string, RemoteLog>();
  readonly applied: OpEnvelope[] = [];
  private lastPositions = new Map<string, number>();

  constructor(readonly name: string) {
    this.store = makeStore(`reconnect-${name}-`);
  }

  async init(): Promise<void> {
    await this.store.ready();
    this.own = await openOwnLog(this.store);
  }

  async openRemote(other: Peer): Promise<void> {
    this.remotes.set(other.name, await openRemoteLog(this.store, other.own.keyHex));
  }

  async appendFeature(hbKey: string, ts: number): Promise<void> {
    await this.own.append({
      type: 'put',
      table: FEATURE_TABLE,
      hbKey,
      value: { from: this.name, ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${this.name}`,
    } as PeerLogOp);
  }

  /** A presence "heartbeat": a put to the peer's stable presence key with a fresh ts. */
  async heartbeat(ts: number): Promise<void> {
    await this.own.append({
      type: 'put',
      table: PRESENCE_TABLE,
      hbKey: `presence:${this.name}`,
      value: { from: this.name, lastSeen: ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${this.name}`,
    } as PeerLogOp);
  }

  async merge(): Promise<void> {
    for (const r of this.remotes.values()) await r.update();
    const res = await mergeAdmittedLogsIncremental([this.own, ...this.remotes.values()], this.cursor, {
      applyImpl: async (op) => {
        this.applied.push(op);
        return true;
      },
      getTimeoutMs: 2_000,
    });
    expect(res.truncated).toBe(false); // no fork/reset, ever
    // Watermark monotonicity across every sever/reconnect.
    for (const [keyHex, pos] of this.cursor.positions) {
      const prev = this.lastPositions.get(keyHex) ?? 0;
      expect(pos, `${this.name} cursor ${keyHex.slice(0, 8)}… regressed`).toBeGreaterThanOrEqual(prev);
      this.lastPositions.set(keyHex, pos);
    }
  }

  featureKeys(): Set<string> {
    return new Set(this.applied.filter((o) => o.table === FEATURE_TABLE).map((o) => o.hbKey!));
  }

  /** The latest-applied heartbeat ts this peer has seen for `presenceKey` (or -1). */
  latestHeartbeatTs(presenceKey: string): number {
    let ts = -1;
    for (const o of this.applied) {
      if (o.table === PRESENCE_TABLE && o.hbKey === presenceKey) ts = Math.max(ts, o.ts ?? -1);
    }
    return ts;
  }
}

/** Drive both peers' merge until `pred()` holds, bounded by maxPasses (replication
 *  over a freshly-healed pipe is async, so a fixed pass-count would race). */
async function drainUntil(peers: Peer[], pred: () => boolean, maxPasses = 40): Promise<boolean> {
  for (let i = 0; i < maxPasses; i++) {
    for (const p of peers) await p.merge();
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe('Brief F / Scenario 1 — per-cycle reconnect: no missed ops + presence recovery', () => {
  it('across many sever/reconnect cycles, every disconnect-window op is delivered AND the heartbeat resumes — each cycle', async () => {
    const A = new Peer('A');
    const B = new Peer('B');
    const peers = [A, B];
    for (const p of peers) await p.init();
    await A.openRemote(B);
    await B.openRemote(A);

    // Baseline link + initial convergence so both peers know each other's log.
    let cable: Link = link(A.store, B.store);
    await A.appendFeature('F-A-0', 1_000);
    await B.appendFeature('F-B-0', 1_001);
    await A.heartbeat(1_000);
    await B.heartbeat(1_001);
    const expectFeatures = new Set(['F-A-0', 'F-B-0']);
    const base = await drainUntil(peers, () =>
      peers.every((p) => [...expectFeatures].every((k) => p.featureKeys().has(k))),
    );
    expect(base, 'baseline did not converge').toBe(true);

    const CYCLES = 6;
    for (let c = 1; c <= CYCLES; c++) {
      const ts = 2_000 + c * 10;

      // ── Disconnect mid-life: sever the only link. ──
      cable.sever();

      // ── Both peers keep working WHILE DISCONNECTED: a feature + a heartbeat. ──
      await A.appendFeature(`F-A-${c}`, ts + 1);
      await B.appendFeature(`F-B-${c}`, ts + 2);
      await A.heartbeat(ts + 1); // A's heartbeat advances
      await B.heartbeat(ts + 2); // B's heartbeat advances
      expectFeatures.add(`F-A-${c}`).add(`F-B-${c}`);

      // While severed, neither peer should have the other's NEW ops yet (proves the
      // partition is real — otherwise the per-cycle convergence assertion is vacuous).
      for (const p of peers) await p.merge();
      expect(A.featureKeys().has(`F-B-${c}`)).toBe(false);
      expect(B.featureKeys().has(`F-A-${c}`)).toBe(false);

      // ── RECONNECT. ──
      cable = link(A.store, B.store);

      // ── Assert, BEFORE the next cycle: convergence reached this cycle. ──
      const aHb = `presence:A`;
      const bHb = `presence:B`;
      const converged = await drainUntil(peers, () => {
        const featuresOk = peers.every((p) => [...expectFeatures].every((k) => p.featureKeys().has(k)));
        // (b) presence/heartbeat recovers: each peer sees the OTHER's latest heartbeat ts.
        const presenceOk = B.latestHeartbeatTs(aHb) === ts + 1 && A.latestHeartbeatTs(bHb) === ts + 2;
        return featuresOk && presenceOk;
      });

      // (a) NO MISSED OPS this cycle.
      expect(converged, `cycle ${c}: peers did not converge after reconnect`).toBe(true);
      for (const p of peers) {
        for (const k of expectFeatures) {
          expect(p.featureKeys().has(k), `cycle ${c}: ${p.name} missing ${k}`).toBe(true);
        }
      }
      // (b) heartbeat recovered + advanced to THIS cycle's value (not a stale one).
      expect(B.latestHeartbeatTs(aHb), `cycle ${c}: B missed A's heartbeat`).toBe(ts + 1);
      expect(A.latestHeartbeatTs(bHb), `cycle ${c}: A missed B's heartbeat`).toBe(ts + 2);
    }

    // (c) After all cycles, a quiescent pass applies nothing (no echo loop).
    const beforeIdle = A.applied.length + B.applied.length;
    for (const p of peers) await p.merge();
    expect(A.applied.length + B.applied.length).toBe(beforeIdle);

    cable.sever();
  }, 60_000);
});

/**
 * swarm-chaos.test.ts — P-004 of coord-system-e2e-testing-2026-06-10:
 * real-network chaos on the ACTUAL Hyperswarm replication path (not piped
 * streams).
 *
 * Extends two-peer-swarm.test.ts's real-transport rig (real `hyperswarm`
 * instances over an offline `hyperdht/testnet`, real DHT discovery, real
 * secret-stream connections, the real announce/admission channel) with a
 * SEEDED chaos controller that repeatedly DESTROYS live swarm connections
 * mid-replication and drives reconnects via the per-topic
 * `discovery.refresh()` (the only reliable reconnect driver — see
 * directory-swarm.ts).
 *
 * ## Why connection kills, not stream-level drop/reorder
 * Hyperswarm rides UDX, a RELIABLE transport: genuine packet loss / reorder
 * happens BELOW the byte stream and is absorbed by retransmission — the
 * substrate can only ever observe it as latency, stalls, or connection death.
 * Injecting drops/reorders INTO the byte stream would corrupt protocol
 * framing artificially (a failure mode the real network cannot produce).
 * So the chaos the substrate genuinely faces — and what this test injects —
 * is repeated mid-replication connection death + reconnect churn while
 * writes keep flowing on every side.
 *
 * ## What it proves under churn
 *  1. CONVERGENCE: both honest peers end with every honest op applied
 *     exactly once per key (no loss, no dup) despite seeded kill rounds.
 *  2. ADMISSION still enforced: a peer whose channel-2 binding FAILS keeps
 *     announcing across every reconnect and is never admitted, its ops never
 *     merge anywhere.
 *  3. REVOCATION still enforced: a peer revoked MID-SESSION stays out after
 *     reconnect churn (re-announce refused as revoked, its log dropped),
 *     while the surviving direction keeps replicating — proven with a
 *     positive control op on the same wire.
 *
 * Deterministic-ish per the plan's bar: a seeded LCG schedules the kill
 * rounds, every wait is a BOUNDED poll, the DHT is the offline loopback
 * testnet. Like the sibling: a normal `*.test.ts` (apply sinks injected — no
 * PG/Docker), generous-but-bounded timeout.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await (swarm as { destroy(): Promise<void> }).destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── The chaos controller ─────────────────────────────────────────────────────

/** Seeded LCG — the chaos schedule is reproducible run to run. */
function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Destroy every live connection on `swarm` (mid-replication kill). */
function killConnections(swarm: HyperswarmLike): number {
  let killed = 0;
  for (const sock of swarm.connections ?? []) {
    try {
      (sock as { destroy(): void }).destroy();
      killed++;
    } catch {
      /* already dead */
    }
  }
  return killed;
}

/** Re-drive the topic's DHT announce+lookup so killed peers reconnect. */
function refreshTopic(swarm: HyperswarmLike, topicHex: string): void {
  try {
    const discovery = swarm.join(Buffer.from(topicHex, 'hex'), { server: true, client: true });
    discovery.refresh?.({ client: true, server: true });
  } catch {
    /* discovery churn is best-effort */
  }
}

/**
 * Force reconnection across all swarms: topic refresh PLUS `joinPeer` between
 * every pair. An abruptly-killed connection puts the peer on hyperswarm's
 * retry-timer backoff ladder (1s → 5s → 15s → 10min, lib/retry-timer.js);
 * `joinPeer` marks the peer EXPLICIT and re-enqueues it with priority, which
 * is the deterministic reconnect driver a test needs (waiting out the ladder
 * is the flaky alternative).
 */
function forceReconnectAll(all: HyperswarmLike[], topicHex: string): void {
  for (const s of all) {
    refreshTopic(s, topicHex);
    for (const o of all) {
      if (o === s) continue;
      try {
        const key = (o as { keyPair?: { publicKey?: Buffer } }).keyPair?.publicKey;
        if (key) (s as { joinPeer?: (k: Buffer) => void }).joinPeer?.(key);
      } catch {
        /* best-effort */
      }
    }
  }
}

describe('swarm-path chaos — real Hyperswarm, seeded connection churn (P-004)', () => {
  it(
    'converges with no loss/dup under kill-reconnect churn; admission + mid-session revocation stay enforced',
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const workspaceId = 'ws-chaos-test';
      const harnessSlug = 'sheets';
      const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

      const idA = makeIdentityOverride('alice', 4242, 'kc-chaos-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-chaos-bob');
      const idM = makeIdentityOverride('mallory', 666, 'kc-chaos-mallory');

      // Honest peers admit each other; Mallory's channel-2 binding FAILS.
      const honestVerify = async (pk: string) => (pk === idM.devicePubkey ? ('fail' as const) : ('verified' as const));

      const swarms = {
        A: makeSwarm(testnet.bootstrap),
        B: makeSwarm(testnet.bootstrap),
        M: makeSwarm(testnet.bootstrap),
      };
      const applies = {
        A: vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true),
        B: vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true),
        M: vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true),
      };

      async function bootPeer(
        name: 'A' | 'B' | 'M',
        id: ReturnType<typeof makeIdentityOverride>,
        verify: (pk: string) => Promise<'verified' | 'fail'>,
      ): Promise<BootedHarnessHandle> {
        const root = makeWorkspaceRoot(`chaos-${name}-`);
        const handle = await bootHarnessSubstrate({
          workspaceRoot: root,
          workspaceId,
          harnessSlug,
          swarmBinding: binding,
          swarmOverride: swarms[name],
          verifyBindingOverride: verify,
          applyOverride: applies[name],
          mergePollMs: 0,
          pendingRetryMs: 0,
          loadRevokedOverride: async () => new Set(),
          announceIdentityOverride: id.override,
        });
        cleanups.push(async () => {
          await handle.close();
          await closeHarnessStore({ workspaceRoot: root, harnessSlug });
        });
        return handle;
      }

      const A = await bootPeer('A', idA, honestVerify);
      const B = await bootPeer('B', idB, honestVerify);
      const M = await bootPeer('M', idM, async () => 'verified');

      expect(A.swarm).not.toBeNull();
      const topicHex = A.swarm!.topicHex;
      expect(B.swarm!.topicHex).toBe(topicHex);
      expect(M.swarm!.topicHex).toBe(topicHex);

      const append = (h: BootedHarnessHandle, pk: string, key: string, ts: number) =>
        h.append({
          type: 'put',
          table: 'features_consolidated',
          hbKey: key,
          value: { chaos: true },
          ts,
          schema_version: 1,
          writerPubkey: pk,
        });

      // ── Phase 1: write storm under seeded kill-reconnect churn ────────────
      const rand = makeRand(42);
      const ROUNDS = 6;
      const honestKeys: string[] = [];
      let killsFired = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const tsBase = 1_000 + r * 10;
        await append(A, idA.devicePubkey, `F-A-${r}`, tsBase + 1);
        await append(B, idB.devicePubkey, `F-B-${r}`, tsBase + 2);
        await append(M, idM.devicePubkey, `F-M-${r}`, tsBase + 3);
        honestKeys.push(`F-A-${r}`, `F-B-${r}`);

        // Seeded chaos: kill EVERY live connection mid-replication on the
        // rounds the seeded coin picks, then force reconnects.
        if (rand() < 0.4) {
          killsFired += killConnections(swarms.A) + killConnections(swarms.B) + killConnections(swarms.M);
          forceReconnectAll(Object.values(swarms), topicHex);
        }

        // Bounded merge nudges — replication progresses whenever a link is up.
        await A.mergeNow();
        await B.mergeNow();
      }
      expect(killsFired).toBeGreaterThan(0); // the chaos was real (seed 42 fires ≥1 kill round)

      // CONVERGENCE: both honest peers see every honest op despite the churn.
      // Nudge reconnects on a SLOW cadence (every ~5s): a per-tick joinPeer
      // storm creates duplicate-connection dedupe churn (connect → dedupe-kill
      // → reconnect) so fast that no link survives long enough to replicate —
      // nudge, then let the links stabilize.
      let pollTick = 0;
      const converged = await pollUntil(
        async () => {
          if (pollTick++ % 10 === 0) forceReconnectAll(Object.values(swarms), topicHex);
          await A.mergeNow();
          await B.mergeNow();
          const haveA = new Set(applies.A.mock.calls.map((c) => c[0].hbKey));
          const haveB = new Set(applies.B.mock.calls.map((c) => c[0].hbKey));
          return honestKeys.every((k) => haveA.has(k) && haveB.has(k));
        },
        { timeoutMs: 60_000, intervalMs: 500 },
      );
      expect(converged, 'honest peers never converged after the churn').toBe(true);

      // NO DUP: each key applied exactly once per peer (unique (key, ts) ops —
      // a winner can only change once, so a second apply would be a replay bug).
      for (const [name, spy] of Object.entries({ A: applies.A, B: applies.B })) {
        const counts = new Map<string, number>();
        for (const c of spy.mock.calls) counts.set(c[0].hbKey, (counts.get(c[0].hbKey) ?? 0) + 1);
        for (const k of honestKeys) {
          expect(counts.get(k), `${name} applied ${k} ${counts.get(k)} times`).toBe(1);
        }
      }

      // ADMISSION ENFORCED: Mallory announced on every reconnect across the
      // churn, yet her log was never admitted and none of her ops merged.
      const mLogKey = M.ownLog.keyHex;
      expect(A.admitted.has(mLogKey)).toBe(false);
      expect(B.admitted.has(mLogKey)).toBe(false);
      const mKeysAtHonest = [...applies.A.mock.calls, ...applies.B.mock.calls]
        .map((c) => c[0].hbKey)
        .filter((k) => k.startsWith('F-M-'));
      expect(mKeysAtHonest).toEqual([]);

      // ── Phase 2: MID-SESSION revocation, then more churn ─────────────────
      await A.revoke(idB.devicePubkey);
      const bLogKey = B.ownLog.keyHex;
      expect(A.admitted.has(bLogKey)).toBe(false);

      // B writes post-revocation; A writes the positive control on the same wire.
      await append(B, idB.devicePubkey, 'F-B-post', 9_001);
      await append(A, idA.devicePubkey, 'F-A-post', 9_002);

      // Churn again: kills + reconnects force B to RE-ANNOUNCE to A — the
      // re-announce must be refused (revoked), not quietly re-admitted.
      killConnections(swarms.A);
      killConnections(swarms.B);
      forceReconnectAll(Object.values(swarms), topicHex);

      // Positive control proves the wire is alive: B (which still admits A)
      // receives A's post-revocation op… (same slow reconnect-nudge cadence)
      let controlTick = 0;
      const controlArrived = await pollUntil(
        async () => {
          if (controlTick++ % 10 === 0) forceReconnectAll(Object.values(swarms), topicHex);
          await A.mergeNow();
          await B.mergeNow();
          return applies.B.mock.calls.some((c) => c[0].hbKey === 'F-A-post');
        },
        { timeoutMs: 45_000, intervalMs: 500 },
      );
      expect(controlArrived, "positive control op never reached B — wire dead, revocation assertion would be vacuous").toBe(true);

      // …while the revoked B stays OUT at A: log still dropped, no post op,
      // across the same reconnect churn that delivered the control op.
      await A.mergeNow();
      expect(A.admitted.has(bLogKey)).toBe(false);
      expect(applies.A.mock.calls.some((c) => c[0].hbKey === 'F-B-post')).toBe(false);
    },
    120_000,
  );
});

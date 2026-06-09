/**
 * cross-hive-two-hive.test.ts — the LIVE cross-Hive transport across two REAL
 * Hyperswarms (cross-hive-boundary-2026-06-08 P-006). The in-process proxy for
 * the cross-machine run (P-005): two SEPARATE Hives (distinct Ed25519 identities)
 * each on their own swarm join a local testnet DHT; Hive A dials Hive B by PUBKEY
 * and delivers a signed envelope over the actual `papercusp/cross-hive` Protomux
 * channel; B's subscriber receives it; then B replies and A receives — proving
 * the bidirectional Hive→Hive wire over real Hyperswarm (loopback-UDP testnet, no
 * Docker/PG). The only thing the literal Hetzner run (P-005) adds is two physical
 * machines + the public DHT; this proves the transport itself end-to-end.
 *
 * Sovereignty note: A only opens the cross-hive channel on B's topic — it never
 * replicates B's corestore. Admission (grants) is the boundary's job
 * (receiveCrossHive), not the transport's; this test exercises raw delivery.
 *
 * Resource hygiene: both transports closed, both swarms destroyed, the testnet
 * destroyed in afterEach.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { makeSwarmCrossHiveTransport, type SwarmCrossHiveTransport } from './cross-hive-swarm-transport';
import { type HyperswarmLike } from './sync/hyperbee/swarm';
import type { CrossHiveWireEnvelope } from './cross-hive-transport';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
  }
});

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

async function pollUntil(fn: () => boolean, { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number }): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const env = (id: string, from: string, to: string, over: Partial<CrossHiveWireEnvelope> = {}): CrossHiveWireEnvelope => ({
  id,
  fromHivePubkey: from,
  toHivePubkey: to,
  kind: 'ask',
  subject: `subject-${id}`,
  body: `body-${id}`,
  sig: `sig-${id}`,
  ...over,
});

describe('cross-Hive transport over two REAL Hyperswarms (P-006 live wire, P-005 in-process proxy)', () => {
  it(
    'Hive A dials Hive B by pubkey and delivers an envelope; B replies and A receives (bidirectional)',
    // Real public-DHT discovery over a loopback testnet is timing-sensitive on a
    // busy shared box; retry a transient connect miss (each attempt is a fresh
    // testnet/swarms). The transport LOGIC is covered deterministically by
    // cross-hive-swarm-transport.test.ts; this is the real-Hyperswarm proof.
    { timeout: 100_000, retry: 3 },
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      // Two SEPARATE Hive identities (distinct keypairs → distinct federation topics).
      const hiveA = rawPubkeyBase64(generateKeyPairSync('ed25519').publicKey);
      const hiveB = rawPubkeyBase64(generateKeyPairSync('ed25519').publicKey);

      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);

      const tA: SwarmCrossHiveTransport = makeSwarmCrossHiveTransport({
        swarm: swarmA,
        selfHivePubkey: hiveA,
        sendWaitMs: 45_000,
        pollMs: 100,
      });
      const tB: SwarmCrossHiveTransport = makeSwarmCrossHiveTransport({
        swarm: swarmB,
        selfHivePubkey: hiveB,
        sendWaitMs: 45_000,
        pollMs: 100,
      });
      cleanups.push(() => tA.close());
      cleanups.push(() => tB.close());

      const receivedByB: CrossHiveWireEnvelope[] = [];
      const receivedByA: CrossHiveWireEnvelope[] = [];
      tB.subscribe(async (e) => { receivedByB.push(e); });
      tA.subscribe(async (e) => { receivedByA.push(e); });

      // 1. A → B: dial B by pubkey, deliver an `ask` over the real swarm.
      const ask = env('ask-1', hiveA, hiveB, { kind: 'ask' });
      await tA.send(hiveB, ask);
      const gotAsk = await pollUntil(() => receivedByB.length > 0, { timeoutMs: 45_000, intervalMs: 150 });
      expect(gotAsk).toBe(true);
      expect(receivedByB[0]).toEqual(ask);

      // 2. B → A: reply (answer) correlated back to the originating ask.
      const answer = env('answer-1', hiveB, hiveA, { kind: 'answer', correlationId: 'ask-1' });
      await tB.send(hiveA, answer);
      const gotAnswer = await pollUntil(() => receivedByA.length > 0, { timeoutMs: 45_000, intervalMs: 150 });
      expect(gotAnswer).toBe(true);
      expect(receivedByA[0]).toEqual(answer);
    },
  );
});

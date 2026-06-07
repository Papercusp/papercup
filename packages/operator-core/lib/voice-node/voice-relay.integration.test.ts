/**
 * P-013/D-009 — the explicit relay story, end-to-end on an isolated DHT
 * testnet: a blind-relay server (startVoiceRelayServer) + two REAL hyperswarm
 * voice nodes configured with `relayThrough`, exchanging real Opus audio.
 *
 * What this proves: the whole relay leg works — both peers dial the relay,
 * complete the blind-relay pairing protocol (pairings.matched), and the relay
 * allocates forwarding streams, while channel audio flows peer↔peer.
 *
 * What it deliberately can't prove on one loopback host: that the MEDIA
 * ultimately rides the relay leg rather than the direct one — on loopback the
 * hole-punch always succeeds and hyperdht races both legs. On a real
 * firewalled↔firewalled pair the direct leg cannot exist and hyperswarm
 * force-retries through this same relay path (shouldForceRelaying in
 * hyperswarm/index.js). The cross-NAT field rate stays the hardware-gated
 * remainder recorded on the plan.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createVoiceNode, energy, type SwarmLike } from '@papercusp/p2p-voice';
import { getOpusCodec, VOICE_FRAME_SAMPLES } from './codec';
import { startVoiceRelayServer, type VoiceRelayServer } from './voice-relay';

type Stats = {
  sessions: { accepted: number };
  pairings: { matched: number };
  streams: { opened: number };
};

interface SwarmCtor {
  new (opts: Record<string, unknown>): SwarmLike & { destroy(): Promise<void> };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      /* teardown best-effort */
    }
  }
  (await getOpusCodec()).dispose();
});

function sineFrame(freq = 440, amp = 0.6): Int16Array {
  const out = new Int16Array(VOICE_FRAME_SAMPLES);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / 48_000) * amp * 32767);
  }
  return out;
}

async function until(cond: () => boolean, ms: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('voice relay (blind-relay over an isolated DHT testnet)', () => {
  it(
    'two relay-configured voice nodes pair through the relay and exchange audio',
    { timeout: 90_000 },
    async () => {
      const { default: createTestnet } = (await import('hyperdht/testnet.js')) as unknown as {
        default: (size: number) => Promise<{ bootstrap: Array<{ host: string; port: number }>; destroy(): Promise<void> }>;
      };
      const testnet = await createTestnet(3);
      cleanups.push(() => testnet.destroy());

      const relay: VoiceRelayServer = await startVoiceRelayServer({
        bootstrap: testnet.bootstrap,
        seed: randomBytes(32),
      });
      cleanups.push(() => relay.close());
      const relayKey = Buffer.from(relay.publicKey, 'hex');

      const { default: Hyperswarm } = (await import('hyperswarm')) as unknown as { default: SwarmCtor };
      // Function form = relay EVERY connection attempt (not just forced
      // retries) so the pairing protocol provably runs in this test.
      const mkSwarm = () =>
        new Hyperswarm({ bootstrap: testnet.bootstrap, relayThrough: () => relayKey });
      const swarmA = mkSwarm();
      const swarmB = mkSwarm();
      cleanups.push(() => swarmA.destroy(), () => swarmB.destroy());

      const codec = await getOpusCodec();
      const A = createVoiceNode({ swarm: swarmA, codec, identity: { id: 'A', label: 'A' } });
      const B = createVoiceNode({ swarm: swarmB, codec, identity: { id: 'B', label: 'B' } });
      cleanups.push(() => A.destroy(), () => B.destroy());

      const topic = randomBytes(32).toString('hex');
      const chanA = A.joinChannel(topic);
      const chanB = B.joinChannel(topic);

      await until(
        () => chanA.peers().length === 1 && chanB.peers().length === 1,
        60_000,
        'peers discover each other on the testnet',
      );

      const got: Int16Array[] = [];
      chanB.onPeerFrame((_id, f) => got.push(f));
      const pcm = sineFrame();
      const pump = setInterval(() => chanA.pushMic(pcm), 20);
      try {
        await until(() => got.length >= 10, 20_000, 'audio frames arrive at B');
      } finally {
        clearInterval(pump);
      }
      const tail = got[got.length - 1];
      expect(tail.length).toBe(VOICE_FRAME_SAMPLES);
      expect(energy(tail)).toBeGreaterThan(energy(pcm) * 0.4);

      // The relay leg was genuinely built: both peers attached sessions and
      // the blind-relay matched them into a pairing with forwarding streams.
      const stats = relay.stats() as Stats;
      expect(stats.sessions.accepted).toBeGreaterThanOrEqual(2);
      expect(stats.pairings.matched).toBeGreaterThanOrEqual(1);
      expect(stats.streams.opened).toBeGreaterThanOrEqual(2);

      await chanA.leave();
      await chanB.leave();
    },
  );
});

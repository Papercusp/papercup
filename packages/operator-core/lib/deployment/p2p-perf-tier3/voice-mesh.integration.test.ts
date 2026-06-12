/**
 * Voice-mesh P-014 — $0 local parity (holepunch-voice-channels-2026-06-05;
 * WI-101). Drives the ENTIRE voice-mesh measurement pipeline — the
 * voice-mesh-child line protocol over real child processes, a REAL Hyperswarm
 * on a local testnet, REAL Opus encode/decode through @papercusp/p2p-voice,
 * clock-offset probe, pairwise fold, artifact + report — with no cloud, no
 * SSH, no creds. The metal run (sshVoiceMeshLauncher) swaps only the
 * transport; this is the CI proof of everything else.
 */

import { describe, it, expect } from 'vitest';
import createTestnet from 'hyperdht/testnet.js';
import { localVoiceMeshLauncher, runVoiceMeshSuite } from './voice-mesh';

type MetricSummary = { count: number; p50: number };

const TEN_MIN = 10 * 60_000;

describe('Tier-3 voice mesh — $0 local parity (no cloud, no SSH)', () => {
  it(
    'runs a 3-peer voice mesh over local children → mouth-to-ear + bandwidth artifact',
    async () => {
      const testnet = await createTestnet(3);
      const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
        host: b.host,
        port: b.port,
      }));
      const launcher = localVoiceMeshLauncher({ count: 3, bootstrap, log: () => {} });
      try {
        const res = await runVoiceMeshSuite({
          meshSizes: [3],
          launcher,
          harnessSlug: `voice-mesh-parity-${Date.now()}`,
          frames: 100, // 2s of 20ms audio per peer — enough samples, fast test
          log: () => {},
        });
        expect(res.artifacts).toHaveLength(1);
        const a = res.artifacts[0];
        expect(a.tier).toBe(3);
        expect(a.scenario).toBe('tier3.voice-mesh');
        expect(a.params['peers']).toBe(3);

        // Every ordered pair delivered audio: 3 peers → 6 pairs × ~100 frames.
        const m2e = a.metrics['mouthToEarMs'] as MetricSummary;
        expect(m2e).toBeDefined();
        expect(m2e.count).toBeGreaterThan(300); // ≥ half of the 600 expected samples
        // Loopback Opus encode+wire+decode is single-digit ms; anything near a
        // second means the timelines misaligned.
        expect(m2e.p50).toBeLessThan(500);
        expect(m2e.p50).toBeGreaterThanOrEqual(0);

        // Reliable streams on loopback: loss is in-flight tail only.
        const loss = a.metrics['frameLossPct'] as MetricSummary;
        expect(loss).toBeDefined();
        expect(loss.p50).toBeLessThan(10);

        // Real bytes moved both ways on every peer.
        const egress = a.metrics['egressBytesPerSec'] as MetricSummary;
        const ingress = a.metrics['ingressBytesPerSec'] as MetricSummary;
        expect(egress.count).toBe(3);
        expect(egress.p50).toBeGreaterThan(0);
        expect(ingress.p50).toBeGreaterThan(0);

        const mesh = a.metrics['meshReadyMs'] as MetricSummary;
        expect(mesh.count).toBe(3);
      } finally {
        await testnet.destroy();
      }
    },
    TEN_MIN,
  );
});

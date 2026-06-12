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
import { resolve } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import {
  localVoiceMeshLauncher,
  sshVoiceMeshLauncher,
  runVoiceMeshSuite,
  type VoiceMeshSshSlotSpec,
} from './voice-mesh';

type MetricSummary = { count: number; p50: number; p95: number };

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

// ── CRED-GATED REAL FRAMES — the P-014 co-located rung (owner ack 2026-06-10,
// WI-101). Provisions VOICE_MESH_FRAMES frames in ONE region (co-located;
// cross-region stays gated on the Latitude quota raise), runs the mesh at
// VOICE_MESH_SIZES over the public DHT, DESTROYS everything in a finally.
// Same cred/skip posture as the Tier-3 substrate test above. $0 in CI.
// Two provider variants through the SAME provider-agnostic fleet code (the
// substrate test's pattern). NOTE 2026-06-12: Latitude VM creates currently
// yield Running-but-unreachable machines (no ssh from any vantage even with
// the OS fix) — Hetzner is the rung that actually ran.
const FOUR_HOURS = 4 * 60 * 60_000;

async function runVoiceMeshMetal(opts: {
  driver: import('@papercusp/deployment-driver').DeploymentDriver;
  providerDefaults: Record<string, unknown>;
  identityFile?: string;
  size: string;
  region: string;
  tag: string;
}): Promise<void> {
  const { provisionBenchFleet } = await import('./bench-frames');
  const repoRoot = process.cwd().includes('packages/operator-core')
    ? resolve(process.cwd(), '..', '..')
    : process.cwd();
  const frameCount = Math.max(2, Number(process.env.VOICE_MESH_FRAMES ?? 10));
  const meshSizes = (process.env.VOICE_MESH_SIZES ?? '2,5,10')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n >= 2 && n <= frameCount);
  const log = (lvl: string, m: string) => console.log(`[voice-mesh ${opts.tag} ${lvl}] ${m}`);

  const fleet = await provisionBenchFleet({
    driver: opts.driver,
    repoRoot,
    sshIdentityFile: opts.identityFile,
    providerDefaults: opts.providerDefaults,
    specs: Array.from({ length: frameCount }, (_, i) => ({
      label: `voice-${opts.region.toLowerCase()}-${i}`,
      region: opts.region,
      size: opts.size,
      kind: 'vm' as const,
      // Co-located rung measures the mesh itself — direct connectivity,
      // no NAT-like firewall (D-009/relay is a separate, shipped story).
      firewall: false,
    })),
    log,
  });
  try {
    const frames: VoiceMeshSshSlotSpec[] = fleet.frames.map((f) => ({
      label: f.spec.label,
      region: f.spec.region,
      target: f.target,
    }));
    const launcher = sshVoiceMeshLauncher({
      frames,
      log: (l) => console.log(`[voice-mesh ${opts.tag} peer] ${l}`),
    });
    const res = await runVoiceMeshSuite({
      meshSizes,
      launcher,
      harnessSlug: `voice-mesh-p014-${Date.now()}`,
      frames: Number(process.env.VOICE_MESH_FRAMES_PER_PEER ?? 750), // 15s of audio
      meshTimeoutMs: 240_000,
      log: (l) => console.log(`[voice-mesh ${opts.tag}] ${l}`),
    });
    expect(res.artifacts.length).toBe(meshSizes.length);
    for (const a of res.artifacts) {
      const m2e = a.metrics['mouthToEarMs'] as MetricSummary;
      expect(m2e?.count).toBeGreaterThan(0);
      console.log(
        `[voice-mesh ${opts.tag}] ${a.params['peers']} peers — mouthToEar p50=${m2e.p50}ms p95=${m2e.p95}ms ` +
          `loss p50=${(a.metrics['frameLossPct'] as MetricSummary)?.p50}% ` +
          `egress p50=${(a.metrics['egressBytesPerSec'] as MetricSummary)?.p50}B/s`,
      );
    }
  } finally {
    await fleet.teardownAll();
  }
}

const project = process.env.P2P_PERF_LATITUDE_PROJECT ?? process.env.LATITUDE_E2E_PROJECT;
const haveLatitude = !!process.env.LATITUDE_API_KEY && !!project;

describe.skipIf(!haveLatitude)(
  'P-014 voice mesh — REAL Latitude frames (needs LATITUDE_API_KEY + P2P_PERF_LATITUDE_PROJECT)',
  () => {
    it(
      'provisions co-located VM frames, measures 2/5/10-peer voice mesh, DESTROYS always',
      async () => {
        const { LatitudeDriver } = await import('../latitude/latitude-driver');
        const sshKeyIds = (process.env.P2P_PERF_SSH_KEY_IDS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const identityFile = process.env.P2P_PERF_SSH_IDENTITY_FILE;
        await runVoiceMeshMetal({
          driver: LatitudeDriver,
          providerDefaults: { project, sshKeys: sshKeyIds, sshIdentityFile: identityFile },
          identityFile,
          size: process.env.P2P_PERF_LATITUDE_VM_PLAN ?? 'vm.small',
          region: process.env.VOICE_MESH_REGION ?? 'ASH',
          tag: 'latitude',
        });
      },
      FOUR_HOURS,
    );
  },
);

const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) && !!hetznerSshKeyId && !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  'P-014 voice mesh — REAL Hetzner frames (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      'provisions co-located VM frames, measures 2/5/10-peer voice mesh, DESTROYS always',
      async () => {
        const { HetznerDriver } = await import('../hetzner/hetzner-driver');
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        await runVoiceMeshMetal({
          driver: HetznerDriver,
          providerDefaults: { sshKeys: [sshKeyId], sshIdentityFile: hetznerIdentity },
          identityFile: hetznerIdentity,
          size: process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31',
          region: process.env.VOICE_MESH_REGION ?? 'ash',
          tag: 'hetzner',
        });
      },
      FOUR_HOURS,
    );
  },
);

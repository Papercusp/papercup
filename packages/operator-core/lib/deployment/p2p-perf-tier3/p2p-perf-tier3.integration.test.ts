/**
 * Tier-3 p2p-perf — real-machine benchmarks (p2p-performance-suite-2026-06-07
 * P-010/P-011/P-012).
 *
 * TWO paths in one file:
 *
 *  1. $0 LOCAL PARITY (always runs — the CI coverage). Drives the ENTIRE Tier-3
 *     pipeline — fleet-shaped launcher, the peer-child line protocol, clock-offset
 *     probe, scenario orchestration, artifact + report production — against LOCAL
 *     "frames" (local spawn on a local testnet). No cloud, no SSH, no creds. This
 *     is what proves the logic; the cred-gated path below only swaps in real
 *     provisioning + real WAN.
 *
 *  2. CRED-GATED REAL FRAMES — TWO provider variants, each $0 in CI (skipped
 *     without that provider's creds, like latitude-e2e.integration.test.ts).
 *     Provisions 2 VM frames (one firewalled, NAT-like) over the SAME provider-
 *     agnostic bench fleet, runs the scenario matrix over SSH against the PUBLIC
 *     DHT, and DESTROYS everything in a finally (no billing leak). On-demand only
 *     (D-004/D-006) — the implementing agent builds + verifies the gate, never
 *     burns frames on cron.
 *       • Latitude: LATITUDE_API_KEY, P2P_PERF_LATITUDE_PROJECT (or LATITUDE_E2E_PROJECT),
 *         P2P_PERF_SSH_KEY_IDS (comma-sep Latitude ssh_key ids), P2P_PERF_SSH_IDENTITY_FILE.
 *       • Hetzner (the standing hourly-churn default — cloud-deployment-layer D-017/D-018):
 *         HCLOUD_TOKEN, HETZNER_SSH_KEY_ID, HETZNER_SSH_IDENTITY_FILE;
 *         opt HETZNER_E2E_SERVER_TYPE (cpx31), P2P_PERF_HETZNER_LOCATIONS (ash,ash).
 *     Both variants drive the IDENTICAL fleet+scenario code — the only difference
 *     is which DeploymentDriver is imported, the proof the seam is provider-agnostic.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { localPeerLauncher, sshPeerLauncher, type SshSlotSpec } from './remote-peer';
import { runTier3Suite } from './run-tier3';
import type { PerfArtifact } from '../../sync/hyperbee/perf/artifact';

const FIFTEEN_MIN = 15 * 60_000;
const NINETY_MIN = 90 * 60_000;

function assertTier3Artifact(a: PerfArtifact): void {
  expect(a.schema).toBe(1);
  expect(a.tier).toBe(3);
  expect(a.host.hostname).toBeTruthy();
  expect(typeof a.durationMs).toBe('number');
  // loop-lag is the headline SLO instrument — present on every scenario.
  expect(a.loopLag).not.toBeNull();
}

describe('Tier-3 p2p-perf — $0 local parity (no cloud, no SSH)', () => {
  it(
    'runs cross-region + dht-discovery over local frames → tier:3 artifacts + report',
    async () => {
      const testnet = await createTestnet(3);
      const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
        host: b.host,
        port: b.port,
      }));
      const launcher = localPeerLauncher({ count: 2, bootstrap, log: () => {} });
      try {
        const res = await runTier3Suite({
          launcher,
          harnessSlug: `p2p-perf-parity-${Date.now()}`,
          scenarios: ['cross-region-replication', 'dht-discovery'],
          count: 20,
          rate: 10,
          estimateClock: true,
          log: () => {},
        });

        expect(res.artifacts.length).toBe(2);
        for (const a of res.artifacts) assertTier3Artifact(a);

        const cr = res.artifacts.find((a) => a.scenario === 'tier3.cross-region-replication');
        expect(cr).toBeTruthy();
        // The append→visible distribution is the metric Tier-1 also emits (overlay parity).
        expect(cr!.metrics['appendToVisibleMs']?.count).toBeGreaterThan(0);
        // The net block is folded in (zeros on a loopback testnet, but present).
        expect(cr!.metrics['connectedPeers']).toBeTruthy();

        const disc = res.artifacts.find((a) => a.scenario === 'tier3.dht-discovery');
        expect(disc).toBeTruthy();
        expect(disc!.metrics['peerAdmittedMs']?.count).toBeGreaterThan(0);

        expect(res.reportPath.endsWith('report.md')).toBe(true);
      } finally {
        launcher.cleanup();
        await testnet.destroy();
      }
    },
    FIFTEEN_MIN,
  );
});

/**
 * The provider-agnostic real-frame body, shared by the Latitude + Hetzner blocks
 * (the whole point of the DeploymentDriver seam): provision 2 VM frames over
 * `driver`, run the scenario matrix over SSH against the PUBLIC DHT, assert the
 * cross-region append→visible distribution, ALWAYS teardown. Only `driver` +
 * `providerDefaults` + size/region defaults differ between providers.
 */
async function runRealFrameTier3(opts: {
  driver: import('@papercusp/deployment-driver').DeploymentDriver;
  providerDefaults: Record<string, unknown>;
  identityFile?: string;
  size: string;
  regions: string[];
  tag: string;
}): Promise<void> {
  const { provisionBenchFleet } = await import('./bench-frames');
  const repoRoot = process.cwd().includes('packages/operator-core')
    ? resolve(process.cwd(), '..', '..')
    : process.cwd();
  // Quota-adaptive: a constrained account runs FRAMES=1 + PEERS_PER_FRAME=2 —
  // co-located peers over the PUBLIC DHT still verify the full real-machine path
  // (SSH launch, npm-ci'd runtime, DHT join, measurement) minus true cross-region
  // RTT. A full account runs FRAMES=2-3 for real WAN + cross-frame holepunch.
  const frameCount = Math.max(1, Number(process.env.P2P_PERF_FRAMES ?? 2));
  const peersPerFrame = Math.max(1, Number(process.env.P2P_PERF_PEERS_PER_FRAME ?? 1));
  const log = (lvl: string, m: string) => console.log(`[tier3 ${opts.tag} ${lvl}] ${m}`);

  // Labels must be UNIQUE per frame — the provisioned server NAME derives from the
  // label (Hetzner rejects a duplicate name with a 409 uniqueness_error). Suffix
  // the index whenever there aren't enough DISTINCT regions to disambiguate the
  // frames (e.g. two frames both in `ash`). Distinct-region runs (Latitude ASH,DAL)
  // keep their clean region labels.
  const needsIndexSuffix = new Set(opts.regions.slice(0, frameCount)).size < frameCount;
  const fleet = await provisionBenchFleet({
    driver: opts.driver,
    repoRoot,
    sshIdentityFile: opts.identityFile,
    providerDefaults: opts.providerDefaults,
    specs: Array.from({ length: frameCount }, (_, i) => ({
      label: opts.regions[i % opts.regions.length] + (needsIndexSuffix ? `-${i}` : ''),
      region: opts.regions[i % opts.regions.length],
      size: opts.size,
      kind: 'vm' as const,
      // Firewall the 2nd+ frame (NAT-like) so holepunch is exercised cross-frame.
      firewall: i > 0,
    })),
    log,
  });
  try {
    // Fan each frame into `peersPerFrame` slots (distinct peerIndex → distinct
    // remote corestore root), so 1 frame can host writer+reader if quota-capped.
    const frameSlots: SshSlotSpec[] = fleet.frames.flatMap((f) =>
      Array.from({ length: peersPerFrame }, (_, k) => ({
        label: peersPerFrame > 1 ? `${f.spec.label}-p${k}` : f.spec.label,
        region: f.spec.region,
        target: f.target,
      })),
    );
    const launcher = sshPeerLauncher({ frames: frameSlots, log: (l) => console.log(`[tier3 ${opts.tag} peer] ${l}`) });
    const scenarios: Array<'cross-region-replication' | 'dht-discovery' | 'nat-holepunch'> =
      fleet.frames.length >= 2
        ? ['cross-region-replication', 'dht-discovery', 'nat-holepunch']
        : ['cross-region-replication', 'dht-discovery'];
    const res = await runTier3Suite({
      launcher,
      harnessSlug: `p2p-perf-tier3-${opts.tag}-${Date.now()}`,
      scenarios,
      count: 200,
      rate: 10,
      estimateClock: true,
      meshTimeoutMs: 180_000,
      catchUpTimeoutMs: 300_000,
      log: (l) => console.log(`[tier3 ${opts.tag}] ${l}`),
    });
    expect(res.artifacts.length).toBe(scenarios.length);
    for (const a of res.artifacts) assertTier3Artifact(a);
    const cr = res.artifacts.find((a) => a.scenario === 'tier3.cross-region-replication')!;
    expect(cr.metrics['appendToVisibleMs']?.count).toBeGreaterThan(0);
    console.log(`[tier3 ${opts.tag}] cross-region append→visible p95=${cr.metrics['appendToVisibleMs']?.p95}ms`);
    const disc = res.artifacts.find((a) => a.scenario === 'tier3.dht-discovery');
    if (disc) console.log(`[tier3 ${opts.tag}] DHT discovery p95=${disc.metrics['peerAdmittedMs']?.p95}ms`);
    const hp = res.artifacts.find((a) => a.scenario === 'tier3.nat-holepunch');
    if (hp) console.log(`[tier3 ${opts.tag}] holepunch notes: ${hp.notes.join(' | ')}`);
  } finally {
    await fleet.teardownAll();
  }
}

const project = process.env.P2P_PERF_LATITUDE_PROJECT ?? process.env.LATITUDE_E2E_PROJECT;
const haveCreds = !!process.env.LATITUDE_API_KEY && !!project;

describe.skipIf(!haveCreds)(
  'Tier-3 p2p-perf — REAL Latitude frames (needs LATITUDE_API_KEY + P2P_PERF_LATITUDE_PROJECT)',
  () => {
    it(
      'provisions VM frames, measures cross-region replication + DHT discovery (+holepunch with ≥2 frames), DESTROYS always',
      async () => {
        const { LatitudeDriver } = await import('../latitude/latitude-driver');
        const sshKeyIds = (process.env.P2P_PERF_SSH_KEY_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const identityFile = process.env.P2P_PERF_SSH_IDENTITY_FILE;
        await runRealFrameTier3({
          driver: LatitudeDriver,
          providerDefaults: { project, sshKeys: sshKeyIds, sshIdentityFile: identityFile },
          identityFile,
          size: process.env.P2P_PERF_LATITUDE_VM_PLAN ?? 'vm.small',
          // VM stock (live 2026-06-07): ASH/DAL/TYO3/LON/FRA — NYC is metal-only.
          regions: (process.env.P2P_PERF_REGIONS ?? 'ASH,DAL').split(',').map((s) => s.trim()),
          tag: 'latitude',
        });
      },
      NINETY_MIN,
    );
  },
);

// Hetzner — the standing hourly-churn default (cloud-deployment-layer D-017/D-018).
// Same fleet + scenarios as Latitude through the provider-agnostic seam; only the
// driver + the Hetzner-shaped provider block (numeric ssh_key id, server_type,
// location) differ. Closes the `linux-test-vm-and-federation` D-018 "needs a
// truly separate machine" gate: two distinct public-IP cloud VMs DO holepunch +
// merge over the public DHT where two same-host VMs cannot.
const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) &&
  !!hetznerSshKeyId &&
  !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  'Tier-3 p2p-perf — REAL Hetzner frames (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      'provisions Hetzner VM frames, measures cross-region replication + DHT discovery + holepunch, DESTROYS always',
      async () => {
        const { HetznerDriver } = await import('../hetzner/hetzner-driver');
        // Hetzner ssh key id is numeric; the driver accepts string|number.
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        await runRealFrameTier3({
          driver: HetznerDriver,
          providerDefaults: { sshKeys: [sshKeyId], sshIdentityFile: hetznerIdentity },
          identityFile: hetznerIdentity,
          size: process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31',
          // Hetzner locations (us): ash, hil. Default two @ ash — distinct VMs,
          // distinct public IPs (the same-host wall is about ONE host, not one DC).
          regions: (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash').split(',').map((s) => s.trim()),
          tag: 'hetzner',
        });
      },
      NINETY_MIN,
    );
  },
);

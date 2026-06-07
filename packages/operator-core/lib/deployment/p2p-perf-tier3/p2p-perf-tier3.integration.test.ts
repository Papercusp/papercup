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
 *  2. CRED-GATED REAL FRAMES (skipped without LATITUDE_API_KEY — $0 in CI, like
 *     latitude-e2e.integration.test.ts). Provisions 2 VM frames (one firewalled,
 *     NAT-like), runs the scenario matrix over SSH against the PUBLIC DHT, and
 *     DESTROYS everything in a finally (no billing leak). On-demand only (D-004/
 *     D-006) — the implementing agent builds + verifies the gate, never burns
 *     frames on cron.
 *     Env: LATITUDE_API_KEY, P2P_PERF_LATITUDE_PROJECT (or LATITUDE_E2E_PROJECT),
 *     P2P_PERF_SSH_KEY_IDS (comma-sep Latitude ssh_key ids), P2P_PERF_SSH_IDENTITY_FILE.
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

const project = process.env.P2P_PERF_LATITUDE_PROJECT ?? process.env.LATITUDE_E2E_PROJECT;
const haveCreds = !!process.env.LATITUDE_API_KEY && !!project;

describe.skipIf(!haveCreds)(
  'Tier-3 p2p-perf — REAL Latitude frames (needs LATITUDE_API_KEY + P2P_PERF_LATITUDE_PROJECT)',
  () => {
    it(
      'provisions 2 VM frames (1 firewalled), measures cross-region replication + DHT discovery + holepunch, DESTROYS always',
      async () => {
        const { LatitudeDriver } = await import('../latitude/latitude-driver');
        const { provisionBenchFleet } = await import('./bench-frames');
        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const sshKeyIds = (process.env.P2P_PERF_SSH_KEY_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const identityFile = process.env.P2P_PERF_SSH_IDENTITY_FILE;
        const size = process.env.P2P_PERF_LATITUDE_VM_PLAN ?? 'vm.small';
        // VM stock (live 2026-06-07): ASH/DAL/TYO3/LON/FRA — NYC is metal-only.
        const regionA = process.env.P2P_PERF_REGION_A ?? 'ASH';
        const regionB = process.env.P2P_PERF_REGION_B ?? 'DAL';
        const log = (lvl: string, m: string) => console.log(`[tier3 ${lvl}] ${m}`);

        const fleet = await provisionBenchFleet({
          driver: LatitudeDriver,
          repoRoot,
          sshIdentityFile: identityFile,
          providerDefaults: { project, sshKeys: sshKeyIds, sshIdentityFile: identityFile },
          specs: [
            { label: regionA, region: regionA, size, kind: 'vm' },
            // The second frame is firewalled (NAT-like) so holepunch is exercised.
            { label: regionB, region: regionB, size, kind: 'vm', firewall: true },
          ],
          log,
        });
        try {
          const launcher = sshPeerLauncher({
            frames: fleet.frames.map(
              (f): SshSlotSpec => ({ label: f.spec.label, region: f.spec.region, target: f.target }),
            ),
            log: (l) => console.log(`[tier3 peer] ${l}`),
          });
          const res = await runTier3Suite({
            launcher,
            harnessSlug: `p2p-perf-tier3-${Date.now()}`,
            scenarios: ['cross-region-replication', 'dht-discovery', 'nat-holepunch'],
            count: 200,
            rate: 10,
            estimateClock: true,
            meshTimeoutMs: 180_000,
            catchUpTimeoutMs: 300_000,
            log: (l) => console.log(`[tier3] ${l}`),
          });
          expect(res.artifacts.length).toBe(3);
          for (const a of res.artifacts) assertTier3Artifact(a);
          const cr = res.artifacts.find((a) => a.scenario === 'tier3.cross-region-replication')!;
          expect(cr.metrics['appendToVisibleMs']?.count).toBeGreaterThan(0);
          console.log(`[tier3] cross-region append→visible p95=${cr.metrics['appendToVisibleMs']?.p95}ms`);
          const hp = res.artifacts.find((a) => a.scenario === 'tier3.nat-holepunch')!;
          console.log(`[tier3] holepunch notes: ${hp.notes.join(' | ')}`);
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);

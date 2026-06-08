/**
 * Hive cross-machine federation E2E — the literal P-011 of
 * `shared-hive-federation-2026-06-08`.
 *
 * P-011: "one Hive shared across two-plus instances (a laptop Swarm + a cloud
 * Swarm, and/or two engineers) — coord / work / locks federate end-to-end;
 * separate machines required (same-host bridged VMs cannot holepunch)."
 *
 * Two already-green layers proved the pieces (D-012): the cross-machine SUBSTRATE
 * holepunch on real Hetzner (`p2p-perf-tier3` + linux-test-vm-and-federation
 * D-019/D-021) and the Hive federation LOCAL-parity (`hive-two-peer-federation`).
 * This file is the COMBINED run: the Hive's OWN topic
 * (`deriveHiveFederationTopic(hive_pubkey)`, P-004 re-key) federating across two
 * SEPARATE public-IP machines over the real public DHT. Per D-003 ("re-key, do
 * not rebuild") it reuses the proven Tier-3 real-frame harness verbatim and only
 * swaps the swarm binding from `{kind:'local'}` to `{kind:'hive'}` via the
 * `hivePubkey` seam threaded through run-tier3 → scenarios → peer-child.
 *
 * TWO paths, like p2p-perf-tier3:
 *  1. $0 LOCAL PARITY (always runs — the CI coverage). Two peers on one local
 *     testnet, both bound to the SAME hive pubkey topic; the reader applying the
 *     writer's ops proves the hive-binding federates (a different topic → zero
 *     visible ops). No cloud, no SSH, no creds — this is what validates the seam
 *     before a cent is spent.
 *  2. CRED-GATED REAL HETZNER (skipped without creds, like p2p-perf-tier3's
 *     Hetzner block). Provisions 2 distinct public-IP Hetzner VMs, runs the
 *     replication scenario over the HIVE topic against the public DHT (2nd frame
 *     firewalled → holepunch exercised), and DESTROYS everything in a finally
 *     (provisionBenchFleet also sweeps any leftover frames at start — no billing
 *     leak). On-demand only: needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID +
 *     HETZNER_SSH_IDENTITY_FILE (+ opt HETZNER_E2E_SERVER_TYPE=cpx31,
 *     P2P_PERF_HETZNER_LOCATIONS=ash,ash).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import { localPeerLauncher, sshPeerLauncher, type SshSlotSpec } from './p2p-perf-tier3/remote-peer';
import { runTier3Suite, type Tier3ScenarioId } from './p2p-perf-tier3/run-tier3';
import { deriveHiveFederationTopic } from '../sync/hyperbee/derive-swarm-topic';

const FIFTEEN_MIN = 15 * 60_000;
const NINETY_MIN = 90 * 60_000;

/**
 * A fresh raw-32-byte base64 Hive pubkey → a UNIQUE federation topic per run, so
 * concurrent runs (or other agents on the public DHT) never collide on the
 * topic. The topic derivation only needs the pubkey (the secret key is never
 * touched here — admission is proven separately in P-006; this run proves the
 * TOPIC re-key federates cross-machine). Mirrors hive-two-peer-federation's
 * "any valid raw-32-byte pubkey proves the join" convention.
 */
function freshHivePubkey(): string {
  return randomBytes(32).toString('base64');
}

describe('Hive cross-machine federation — $0 local parity (no cloud, no SSH)', () => {
  it(
    'federates a Hive record across two peers over the HIVE pubkey topic (P-004 re-key, local testnet)',
    async () => {
      const hivePubkey = freshHivePubkey();
      // The binding the peers will use resolves to the 32-byte hive topic.
      expect(deriveHiveFederationTopic(hivePubkey)).toHaveLength(32);

      const testnet = await createTestnet(3);
      const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
        host: b.host,
        port: b.port,
      }));
      const launcher = localPeerLauncher({ count: 2, bootstrap, log: () => {} });
      try {
        const res = await runTier3Suite({
          launcher,
          harnessSlug: `hive-xm-parity-${Date.now()}`,
          hivePubkey,
          scenarios: ['cross-region-replication'],
          count: 20,
          rate: 10,
          estimateClock: true,
          log: () => {},
        });
        expect(res.artifacts.length).toBe(1);
        const cr = res.artifacts.find((a) => a.scenario === 'tier3.cross-region-replication');
        expect(cr).toBeTruthy();
        // The reader applied the writer's appended ops → both peers joined the
        // SAME hive topic and federated. A wrong/different topic yields zero
        // visible ops, so a positive count IS the hive-topic federation proof.
        expect(cr!.metrics['appendToVisibleMs']?.count).toBeGreaterThan(0);
      } finally {
        launcher.cleanup();
        await testnet.destroy();
      }
    },
    FIFTEEN_MIN,
  );
});

// ── CRED-GATED: real two-machine Hetzner Hive federation (the P-011 deliverable) ──
const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) &&
  !!hetznerSshKeyId &&
  !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  'Hive cross-machine federation — REAL Hetzner frames (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      'two SEPARATE Hetzner machines federate one Hive over its pubkey topic across the public DHT, DESTROYS always',
      async () => {
        const hivePubkey = freshHivePubkey();
        const { provisionBenchFleet } = await import('./p2p-perf-tier3/bench-frames');
        const { HetznerDriver } = await import('./hetzner/hetzner-driver');
        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const size = process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31';
        // Two distinct VMs (distinct public IPs) — the same-host holepunch wall is
        // about ONE host, not one datacenter, so both in `ash` is a valid 2-machine run.
        const locations = (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash').split(',').map((s) => s.trim());
        const frameCount = Math.max(2, Number(process.env.HIVE_XM_FRAMES ?? 2));
        // Hetzner ssh key id is numeric; the driver accepts string|number.
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        // Server NAME derives from the label; Hetzner 409s on a duplicate name, so
        // suffix the index when there aren't enough DISTINCT locations to disambiguate.
        const needsIndexSuffix = new Set(locations.slice(0, frameCount)).size < frameCount;

        const fleet = await provisionBenchFleet({
          driver: HetznerDriver,
          repoRoot,
          sshIdentityFile: hetznerIdentity,
          providerDefaults: { sshKeys: [sshKeyId], sshIdentityFile: hetznerIdentity },
          specs: Array.from({ length: frameCount }, (_, i) => ({
            label: locations[i % locations.length] + (needsIndexSuffix ? `-${i}` : ''),
            region: locations[i % locations.length],
            size,
            kind: 'vm' as const,
            // Firewall the 2nd+ frame (NAT-like) so holepunch is exercised over
            // the HIVE topic cross-frame — not just an open-port connect.
            firewall: i > 0,
          })),
          log: (lvl, m) => console.log(`[hive-xm ${lvl}] ${m}`),
        });

        try {
          const frameSlots: SshSlotSpec[] = fleet.frames.map((f) => ({
            label: f.spec.label,
            region: f.spec.region,
            target: f.target,
          }));
          const launcher = sshPeerLauncher({ frames: frameSlots, log: (l) => console.log(`[hive-xm peer] ${l}`) });
          const scenarios: Tier3ScenarioId[] =
            frameSlots.length >= 2
              ? ['cross-region-replication', 'dht-discovery', 'nat-holepunch']
              : ['cross-region-replication'];

          const res = await runTier3Suite({
            launcher,
            harnessSlug: `hive-xm-hetzner-${Date.now()}`,
            hivePubkey,
            scenarios,
            count: 200,
            rate: 10,
            estimateClock: true,
            meshTimeoutMs: 180_000,
            catchUpTimeoutMs: 300_000,
            log: (l) => console.log(`[hive-xm] ${l}`),
          });

          const cr = res.artifacts.find((a) => a.scenario === 'tier3.cross-region-replication');
          expect(cr).toBeTruthy();
          // THE P-011 proof: a record appended on frame A is VISIBLE on frame B,
          // over the Hive's OWN pubkey topic, across two separate public-IP
          // machines on the real public DHT.
          expect(cr!.metrics['appendToVisibleMs']?.count).toBeGreaterThan(0);
          console.log(
            `[hive-xm] HIVE topic ${deriveHiveFederationTopic(hivePubkey).toString('hex').slice(0, 16)}… ` +
              `append→visible p95=${cr!.metrics['appendToVisibleMs']?.p95}ms across ${frameSlots.length} machines`,
          );
          const disc = res.artifacts.find((a) => a.scenario === 'tier3.dht-discovery');
          if (disc) {
            console.log(
              `[hive-xm] DHT discovery: admitted p95=${disc.metrics['peerAdmittedMs']?.p95 ?? 'n/a'}ms, ` +
                `first-connection p95=${disc.metrics['dhtFirstConnectionMs']?.p95 ?? 'n/a'}ms`,
            );
          }
          const hp = res.artifacts.find((a) => a.scenario === 'tier3.nat-holepunch');
          if (hp) console.log(`[hive-xm] holepunch over the hive topic: ${hp.notes.join(' | ')}`);
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);

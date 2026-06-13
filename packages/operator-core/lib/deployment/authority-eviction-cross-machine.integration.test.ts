/**
 * ≥3-peer cross-machine LOCK-AUTHORITY φ+SWIM EVICTION E2E — the live two-machine
 * prompt-eviction proof P-016 of `shared-hive-hardening-2026-06-13` was waiting on (D-003/
 * D-010). It plugs an eviction scenario into su-116e7's Hetzner harness (`provisionBenchFleet`
 * + the SSH launcher pattern), exactly as the ≥3-Swarm claim-dispatch E2E does.
 *
 * Why ≥3 peers (NOT 2): the SWIM relay-confirmation in `authority/peer-eviction.ts decide()`
 * returns KEEP when `relays.length === 0`, and relays = observed-non-self-peers − target. With
 * only 2 machines (authority + corpse) the witness set is empty → it never evicts. Eviction
 * needs a third peer to vouch the suspect dead (the module header: "a real crash in a ≥3-peer
 * hive (witnesses exist + agree dead) → prompt eviction"). So this is a ≥3-machine proof — a
 * distinct gate from B-01's P-003 two-machine lock-SERIALIZATION proof.
 *
 * What it proves (the layers the in-process tests can't): the REAL `AuthorityEvictionMonitor`
 * + REAL `peer.probe` authority op + REAL `HttpPeerRpcTransport` firing across processes/
 * machines on a REAL process kill — the suspect's `GET /alive` stops, its presence freezes on
 * the survivors, φ crosses 8, a witness confirms it dead, and it is EXCLUDED from candidacy
 * BEFORE the 90s staleness floor, promoting the next LIVE peer (a survivor's `lock.acquire`
 * then lands on that promoted authority instead of failing open to the corpse). The ONLY
 * non-production leg is the presence SOURCE (a lightweight `/alive` heartbeat view in place of
 * the PG `shared_presence` projection — the same PG-less-frame seam swap claim-agent uses for
 * its store); the substrate's real cross-machine presence FEDERATION is proven separately
 * (hive-cross-machine P-011).
 *
 * TWO paths, like swarm-claim-dispatch.integration.test.ts:
 *  1. $0 LOCAL PARITY (always runs — the CI coverage). 3 peers as child processes on loopback,
 *     real HTTP authority RPC + peer.probe between them. Two sub-runs: eviction ON proves the
 *     dead authority is evicted < floor + a LIVE authority promoted; eviction OFF (the pre-P-016
 *     control) proves the survivors stay stuck on the corpse → the acquire fails open. No cloud.
 *  2. CRED-GATED REAL HETZNER (skipped without creds). 3 peers across real public-IP frames —
 *     by default 3 peers over 2 frames (the AUTHORITY alone on frame 0, the two survivors on
 *     frame 1; this account's Hetzner server limit is 2), so killing frame 0 freezes the
 *     authority's presence across a real machine boundary. DESTROYS everything in a finally.
 *     Raise EVICT_E2E_FRAMES (after raising the account limit) for 1 peer per distinct VM (the
 *     placement degrades to that, making the witness relay-probe cross-machine too). Needs
 *     HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE (+ opt
 *     HETZNER_E2E_SERVER_TYPE=cpx31, EVICT_E2E_FRAMES, EVICT_E2E_PEERS, P2P_PERF_HETZNER_LOCATIONS).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { localEvictionLauncher, sshEvictionLauncher, type SshEvictionSlotSpec } from './p2p-perf-tier3/eviction-launcher';
import { runEvictionProof, pubkeyFor } from './p2p-perf-tier3/run-eviction-proof';

const FIVE_MIN = 5 * 60_000;
const NINETY_MIN = 90 * 60_000;

// A per-process loopback port base, so concurrent test files don't collide.
const LOCAL_BASE_PORT = 48_000 + (process.pid % 1400);

describe('≥3-peer authority eviction — $0 local parity (no cloud, no SSH)', () => {
  it(
    'EVICTION ON: kill the authority → survivors evict it BEFORE the 90s floor + promote a LIVE authority; acquire lands on it (not fail-open)',
    async () => {
      const launcher = localEvictionLauncher({ count: 3, basePort: LOCAL_BASE_PORT, log: () => {} });
      const v = await runEvictionProof({
        launcher,
        evictionEnabled: true,
        heartbeatMs: 300,
        evictionStaleMs: 1500,
        authorityStaleMs: 90_000, // the production floor — eviction must beat it
        refreshThrottleMs: 300,
        pollTimeoutMs: 800,
        rpcTimeoutMs: 1500,
        stabilizeMs: 2500,
        evictWaitMs: 15_000,
        pollIntervalMs: 300,
      });

      // Control: before the kill, all 3 peers agree the authority is slot 0 and nothing is evicted.
      expect(v.preKillAuthorityAgreed).toBe(true);
      expect(v.preKillAuthorityPubkey).toBe(pubkeyFor(0));
      expect(v.preKillNoEvictions).toBe(true);

      // The kill landed on the elected authority.
      expect(v.killedAuthority.peerIndex).toBe(0);

      // Both survivors relay-confirmed it dead and EXCLUDED it from candidacy.
      expect(v.survivorsEvictedDead).toBe(true);
      // …and agree the next LIVE peer (slot 1) is the new authority.
      expect(v.survivorsAgreeNewAuthority).toBe(true);
      expect(v.newAuthorityPubkey).toBe(pubkeyFor(1));
      expect(v.newAuthorityIsLive).toBe(true);

      // Eviction was prompt AND strictly beat the 90s staleness floor (the corpse was still
      // "fresh" by the floor when the φ+SWIM path evicted it — the whole point of P-016).
      expect(v.evictLatencyMs).not.toBeNull();
      expect(v.evictLatencyMs!).toBeLessThan(15_000);
      expect(v.beatStalenessFloor).toBe(true);
      expect(v.deadStaleAtEvictMs!).toBeLessThan(v.authorityStaleMs / 2);

      // A survivor's acquire routed to the promoted LIVE authority (slot 1), NOT fail-open.
      expect(v.acquireVia).toBe('remote-authority');
      expect(v.acquireOk).toBe(true);
      expect(v.acquireAuthorityPubkey).toBe(pubkeyFor(1));
    },
    FIVE_MIN,
  );

  it(
    'EVICTION OFF (pre-P-016 control): same kill → survivors stay stuck on the corpse (not evicted, still elected) → acquire FAILS OPEN',
    async () => {
      const launcher = localEvictionLauncher({ count: 3, basePort: LOCAL_BASE_PORT + 10, log: () => {} });
      const v = await runEvictionProof({
        launcher,
        evictionEnabled: false,
        heartbeatMs: 300,
        evictionStaleMs: 1500,
        authorityStaleMs: 90_000,
        pollTimeoutMs: 800,
        rpcTimeoutMs: 1500,
        stabilizeMs: 2500,
        evictWaitMs: 6_000, // long enough that eviction WOULD have fired if a monitor were installed
        pollIntervalMs: 300,
      });

      expect(v.preKillAuthorityAgreed).toBe(true);
      expect(v.killedAuthority.peerIndex).toBe(0);

      // No monitor → nothing is ever evicted, and the survivors keep electing the DEAD authority
      // (its presence is only seconds stale, well within the 90s floor).
      expect(v.survivorsEvictedDead).toBe(false);
      expect(v.finalSnapshots.length).toBe(2);
      expect(v.finalSnapshots.every((s) => s.evicted.length === 0)).toBe(true);
      expect(v.finalSnapshots.every((s) => s.authorityPubkey === pubkeyFor(0))).toBe(true);
      expect(v.survivorsAgreeNewAuthority).toBe(false);
      expect(v.evictLatencyMs).toBeNull();

      // The acquire routes to the dead authority → unreachable → fail-open (the exact UX P-016
      // removes: extra merge churn while a crashed authority is held onto for up to 90s).
      expect(v.acquireVia).toBe('fail-open');
    },
    FIVE_MIN,
  );
});

// ── CRED-GATED: real ≥3-machine Hetzner authority eviction (the P-016 cross-machine deliverable) ──
const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) && !!hetznerSshKeyId && !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  '≥3-peer authority eviction — REAL Hetzner frames (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      '≥3 peers across real Hetzner machines: kill the authority frame → survivors φ+SWIM-evict it < floor, promote a LIVE authority, acquire not fail-open; DESTROYS always',
      async () => {
        const { provisionBenchFleet } = await import('./p2p-perf-tier3/bench-frames');
        const { HetznerDriver } = await import('./hetzner/hetzner-driver');
        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const size = process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31';
        // ≥3 peers across ≥2 frames. Default 3 peers on 2 frames (the account's server limit is 2):
        // the AUTHORITY runs ALONE on frame 0, the survivors on frame 1 — so killing frame 0's agent
        // freezes the authority's presence across a real machine boundary. The survivors' death-
        // detection (frame1 → frame0 /alive polls) is therefore cross-machine; the witness relay-probe
        // between the two survivors is intra-frame in this layout. Raise EVICT_E2E_FRAMES (after
        // raising the account limit) for 1 peer per distinct VM → the relay-probe goes cross-machine too.
        const frameCount = Math.max(2, Number(process.env.EVICT_E2E_FRAMES ?? 2));
        const peerCount = Math.max(3, Number(process.env.EVICT_E2E_PEERS ?? 3));
        const locations = (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash').split(',').map((s) => s.trim());
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        const needsIndexSuffix = new Set(locations.slice(0, frameCount)).size < frameCount;
        const basePort = Number(process.env.EVICT_E2E_HTTP_PORT ?? 48_100);

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
            // No firewall: every frame must serve/receive the authority HTTP RPC + /alive heartbeat
            // on its public IP.
            firewall: false,
          })),
          log: (lvl, m) => console.log(`[evict-xm ${lvl}] ${m}`),
        });

        try {
          // Place peer 0 (the authority) alone on frame 0; peers 1.. round-robin the rest. Co-located
          // peers get distinct ports, so killing peer 0 kills ONLY the authority.
          const portByFrame = new Map<number, number>();
          const frameOf = (peerIdx: number) => (peerIdx === 0 ? 0 : 1 + ((peerIdx - 1) % Math.max(1, frameCount - 1)));
          const slotSpecs: SshEvictionSlotSpec[] = Array.from({ length: peerCount }, (_, a) => {
            const fi = frameOf(a);
            const portOffset = portByFrame.get(fi) ?? 0;
            portByFrame.set(fi, portOffset + 1);
            const frame = fleet.frames[fi];
            return {
              label: `${frame.spec.label}-p${a}`,
              host: frame.target.host,
              target: frame.target,
              httpPort: basePort + portOffset,
            };
          });
          const launcher = sshEvictionLauncher({ slots: slotSpecs, log: (l) => console.log(`[evict-xm] ${l}`) });

          const v = await runEvictionProof({
            launcher,
            evictionEnabled: true,
            // Real WAN: generous cadences/timeouts so a real RTT never false-evicts a live peer.
            heartbeatMs: 500,
            evictionStaleMs: 3_000,
            authorityStaleMs: 90_000,
            refreshThrottleMs: 500,
            pollTimeoutMs: 1_500,
            rpcTimeoutMs: 4_000,
            stabilizeMs: 5_000,
            evictWaitMs: 30_000,
            pollIntervalMs: 500,
            readyTimeoutMs: 120_000,
            queryTimeoutMs: 30_000,
            log: (l) => console.log(`[evict-xm] ${l}`),
          });

          console.log(
            `[evict-xm] ${v.peerCount} peers over ${frameCount} frames; killed ${v.killedAuthority.devicePubkey.slice(0, 12)}…; ` +
              `evicted=${v.survivorsEvictedDead} in ${v.evictLatencyMs}ms (dead ${v.deadStaleAtEvictMs}ms stale, floor ${v.authorityStaleMs}ms); ` +
              `new-authority=${v.newAuthorityPubkey?.slice(0, 12)}… acquire-via=${v.acquireVia}`,
          );

          // THE P-016 cross-machine proof.
          expect(v.peerCount).toBeGreaterThanOrEqual(3);
          expect(v.killedAuthority.peerIndex).toBe(0);
          expect(v.preKillAuthorityAgreed).toBe(true);
          expect(v.survivorsEvictedDead).toBe(true); // φ+SWIM-evicted across real machines
          expect(v.survivorsAgreeNewAuthority).toBe(true);
          expect(v.newAuthorityPubkey).toBe(pubkeyFor(1));
          expect(v.newAuthorityIsLive).toBe(true);
          expect(v.beatStalenessFloor).toBe(true); // evicted while still fresh by the 90s floor
          expect(v.evictLatencyMs!).toBeLessThan(30_000);
          // A survivor's acquire crossed to the promoted LIVE authority (not fail-open to the corpse).
          expect(v.acquireVia).toBe('remote-authority');
          expect(v.acquireOk).toBe(true);
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);

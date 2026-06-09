/**
 * ≥3-Swarm decentralized work-item-claim dispatch E2E — the literal P-013 of
 * `decentralized-dispatch-scaling-2026-06-08`:
 *
 *   "one Hive, ≥3 Swarms across instances, each claiming DIFFERENT items off the shared
 *    backlog with no central dispatcher; kill the authority mid-run → fail-open reconcile;
 *    assert no double-completed work + no starvation."
 *
 * It plugs the claim scenario into su-116e7's landed Hetzner harness (`provisionBenchFleet`
 * + the SSH launcher pattern), exactly as the plan's Now directs. The proven layers it
 * builds on: the per-Hive authority serialization on real PG
 * (`work-item-claims-two-instance.integration.test.ts`, N=2), the fail-open → reconcile
 * composition (`work-item-claim-reconcile.integration.test.ts`), and the in-memory store ↔
 * SQL store parity (`work-item-claim-mem-store.integration.test.ts`). This file is the
 * DISTRIBUTED-DYNAMICS layer those don't cover: ≥3 real Swarms, no central dispatcher, the
 * authority killed mid-run, end-to-end no-double-complete + no-starvation.
 *
 * TWO paths, like hive-cross-machine.integration.test.ts:
 *  1. $0 LOCAL PARITY (always runs — the CI coverage). 3 Swarms as child processes on
 *     loopback, real HTTP authority RPC between them. Two sub-runs: NO-KILL proves
 *     exactly-once (the authority serializes → zero double-claims), and KILL-AUTHORITY
 *     proves fail-open + deterministic reconcile + no starvation. No cloud, no creds.
 *  2. CRED-GATED REAL HETZNER (skipped without creds). ≥3 Swarms across real public-IP
 *     frames — by default 3 Swarms over 2 frames (the AUTHORITY alone on frame 0, the two
 *     survivors on frame 1), because this account's Hetzner server limit is 2. The authority
 *     RPC crosses the real machine boundary (survivors on frame 1 → authority on frame 0 over
 *     its public IP); the authority's agent is killed mid-run → the survivors fail open →
 *     reconcile. DESTROYS everything in a finally. Raise CLAIM_E2E_FRAMES (after raising the
 *     account limit) to put one Swarm per distinct VM — the placement degrades to that.
 *     Needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE
 *     (+ opt HETZNER_E2E_SERVER_TYPE=cpx31, CLAIM_E2E_FRAMES, CLAIM_E2E_SWARMS, P2P_PERF_HETZNER_LOCATIONS).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { localClaimLauncher, sshClaimLauncher, type SshClaimSlotSpec } from './p2p-perf-tier3/claim-launcher';
import { runClaimDispatch } from './p2p-perf-tier3/run-claim-dispatch';

const FIVE_MIN = 5 * 60_000;
const NINETY_MIN = 90 * 60_000;

// A per-process loopback port base, so concurrent test files don't collide.
const LOCAL_BASE_PORT = 47_000 + (process.pid % 1500);

describe('≥3-Swarm claim dispatch — $0 local parity (no cloud, no SSH)', () => {
  it(
    'NO-KILL: 3 Swarms claim DIFFERENT items off one backlog → exactly-once, no starvation',
    async () => {
      const launcher = localClaimLauncher({ count: 3, basePort: LOCAL_BASE_PORT, log: () => {} });
      const v = await runClaimDispatch({
        launcher,
        backlogSize: 15,
        killAuthority: false,
        workMinMs: 20,
        workMaxMs: 60,
        sweepDelayMs: 40,
        rpcTimeoutMs: 1500,
      });

      // No central dispatcher + a live authority ⇒ every item completed exactly once.
      expect(v.starvedItems).toEqual([]); // no starvation — whole backlog done
      expect(v.completedItems.length).toBe(15);
      expect(v.rawDoubleClaimed).toEqual([]); // exactly-once — the authority serialized all
      expect(v.exactlyOnceObserved).toBe(true);
      expect(v.failOpenObserved).toBe(false); // authority always reachable → never failed open
      expect(v.doubleCompletedAfterReconcile).toEqual([]);
      // The work was genuinely distributed across the 3 Swarms (no single Swarm did it all).
      const perSwarm = v.results.map((r) => r.completions.length).sort((a, b) => a - b);
      expect(v.results.length).toBe(3);
      expect(perSwarm[0]).toBeGreaterThan(0); // every Swarm claimed at least one item
      // Remote authority RPC was actually exercised (the non-authority Swarms routed to slot 0).
      expect(v.routeStats.remoteAuthority).toBeGreaterThan(0);
      expect(v.routeStats.localAuthority).toBeGreaterThan(0);
    },
    FIVE_MIN,
  );

  it(
    'KILL-AUTHORITY mid-run: survivors fail open → deterministic reconcile, no starvation, no surviving double-completion',
    async () => {
      const launcher = localClaimLauncher({ count: 3, basePort: LOCAL_BASE_PORT + 100, log: () => {} });
      const v = await runClaimDispatch({
        launcher,
        backlogSize: 15,
        killAuthority: true,
        killAfterMs: 350,
        // Generous per-item work so the Swarms are still mid-run when the authority is
        // killed (so fail-open is genuinely exercised, not raced past).
        workMinMs: 80,
        workMaxMs: 180,
        sweepDelayMs: 60,
        rpcTimeoutMs: 1200,
      });

      expect(v.killedAuthority?.swarmIndex).toBe(0);
      expect(v.results.length).toBe(2); // the 2 survivors reported

      // No starvation: every backlog item was completed by SOME surviving Swarm — including
      // the items the dead authority had claimed (reclaimed via fail-open work-stealing).
      expect(v.starvedItems).toEqual([]);
      expect(v.completedItems.length).toBe(15);

      // The kill genuinely partitioned the survivors from the authority → they failed open.
      expect(v.failOpenObserved).toBe(true);

      // The tolerated cost: with the authority gone, items get double-claimed across the two
      // survivors' stores. The HYBRID's guarantee is that the deterministic reconcile resolves
      // EVERY contested item to a single, order-independent winner — so no double-completed
      // work survives.
      expect(v.rawDoubleClaimed.length).toBeGreaterThan(0); // fail-open really happened
      expect(v.doubleCompletedAfterReconcile).toEqual([]); // reconcile yields one winner each
      expect(v.determinismHolds).toBe(true); // same winner under reversed input order
      // Every backlog item has exactly one reconcile winner.
      const winnersPerItem = new Map<string, number>();
      for (const r of v.reconciliations) winnersPerItem.set(r.workItemId, (winnersPerItem.get(r.workItemId) ?? 0) + 1);
      for (const item of v.completedItems) expect(winnersPerItem.get(item)).toBe(1);
    },
    FIVE_MIN,
  );
});

// ── CRED-GATED: real ≥3-machine Hetzner claim dispatch (the P-013 cross-machine deliverable) ──
const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) && !!hetznerSshKeyId && !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  '≥3-Swarm claim dispatch — REAL Hetzner frames (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      '≥3 Swarms across real Hetzner machines claim off one backlog; kill the authority mid-run → fail-open reconcile, no double-complete, no starvation; DESTROYS always',
      async () => {
        const { provisionBenchFleet } = await import('./p2p-perf-tier3/bench-frames');
        const { HetznerDriver } = await import('./hetzner/hetzner-driver');
        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const size = process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31';
        // ≥3 Swarms across ≥2 frames. Default 3 Swarms on 2 frames (this account's Hetzner
        // server limit is 2): the AUTHORITY runs ALONE on frame 0, the survivors on frame 1 —
        // so killing frame 0's agent partitions the survivors from the authority across a real
        // machine boundary. Raise CLAIM_E2E_FRAMES (after raising the account limit) for 1
        // Swarm per distinct VM; the placement degrades to that automatically.
        const frameCount = Math.max(2, Number(process.env.CLAIM_E2E_FRAMES ?? 2));
        const swarmCount = Math.max(3, Number(process.env.CLAIM_E2E_SWARMS ?? 3));
        // Distinct VMs in (by default) one region — the authority RPC is plain HTTP over the
        // VMs' public IPs; cross-machine is per-HOST, so same datacenter is a valid run.
        const locations = (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash')
          .split(',')
          .map((s) => s.trim());
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        // Hetzner 409s on a duplicate server name → suffix the index when locations repeat.
        const needsIndexSuffix = new Set(locations.slice(0, frameCount)).size < frameCount;
        const basePort = Number(process.env.CLAIM_E2E_HTTP_PORT ?? 47_990);

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
            // No firewall: every frame must serve/receive the authority HTTP RPC on its
            // public IP (so the elected authority is reachable from the other Swarms).
            firewall: false,
          })),
          log: (lvl, m) => console.log(`[claim-xm ${lvl}] ${m}`),
        });

        try {
          // Place Swarm 0 (the authority) alone on frame 0; Swarms 1.. round-robin the rest.
          // Co-located Swarms get distinct ports; killing Swarm 0 thus kills ONLY the authority.
          const portByFrame = new Map<number, number>();
          const frameOf = (swarmIdx: number) =>
            swarmIdx === 0 ? 0 : 1 + ((swarmIdx - 1) % Math.max(1, frameCount - 1));
          const slotSpecs: SshClaimSlotSpec[] = Array.from({ length: swarmCount }, (_, a) => {
            const fi = frameOf(a);
            const portOffset = portByFrame.get(fi) ?? 0;
            portByFrame.set(fi, portOffset + 1);
            const frame = fleet.frames[fi];
            return {
              label: `${frame.spec.label}-s${a}`,
              host: frame.target.host,
              target: frame.target,
              httpPort: basePort + portOffset,
            };
          });
          const launcher = sshClaimLauncher({ slots: slotSpecs, log: (l) => console.log(`[claim-xm] ${l}`) });

          const v = await runClaimDispatch({
            launcher,
            backlogSize: Number(process.env.CLAIM_E2E_BACKLOG ?? 18),
            killAuthority: true,
            killAfterMs: Number(process.env.CLAIM_E2E_KILL_AFTER_MS ?? 4_000),
            // Real WAN: generous timeouts + work so the kill lands mid-run.
            workMinMs: 150,
            workMaxMs: 400,
            sweepDelayMs: 200,
            rpcTimeoutMs: 4_000,
            readyTimeoutMs: 120_000,
            resultTimeoutMs: 300_000,
            log: (l) => console.log(`[claim-xm] ${l}`),
          });

          console.log(
            `[claim-xm] ${v.swarmCount} Swarms over ${frameCount} frames; killed authority ` +
              `${v.killedAuthority?.devicePubkey.slice(0, 12)}…; completed ${v.completedItems.length}/${v.backlog.length}; ` +
              `raw-double=${v.rawDoubleClaimed.length}; route ${JSON.stringify(v.routeStats)}`,
          );

          // THE P-013 cross-machine proof.
          expect(v.swarmCount).toBeGreaterThanOrEqual(3);
          expect(v.killedAuthority).not.toBeNull();
          expect(v.results.length).toBe(swarmCount - 1); // survivors reported
          expect(v.starvedItems).toEqual([]); // no starvation across real machines
          expect(v.completedItems.length).toBe(v.backlog.length);
          expect(v.failOpenObserved).toBe(true); // killing the authority frame partitioned them
          expect(v.doubleCompletedAfterReconcile).toEqual([]); // reconcile resolves every contest
          expect(v.determinismHolds).toBe(true);
          // The authority RPC genuinely crossed machines before the kill.
          expect(v.routeStats.remoteAuthority).toBeGreaterThan(0);
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);

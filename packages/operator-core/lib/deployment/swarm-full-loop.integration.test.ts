/**
 * Full autonomous shared-hive loop on ≥3 Swarms — the real-metal E2E of
 * `shared-hive-loop-e2e-testing-2026-06-10` Phase 2 (brief-12 runbook §1+§2):
 *
 *   P-008 — the FULL loop (steer → contend → execute → converge → steer) across
 *           real machines: scripted Queen, fake-runner pipelines, REAL public-DHT
 *           substrate federation, REAL cross-machine authority HTTP RPC;
 *   P-009 — the chaos replay: partition mid-feature (REAL nftables cut), kill the
 *           authority, lease-steal mid-pipeline (D-007 adoption);
 *   P-011 — revoked-swarm-mid-run: the EI-284 caller-standing gate refuses a
 *           revoked Swarm's acquire over real RPC (asserted, not just noted —
 *           the D-010 owner ack's explicit requirement).
 *
 * TWO paths, like swarm-claim-dispatch.integration.test.ts:
 *  1. $0 LOCAL PARITY (always runs — the CI coverage). 3 Swarms as child processes
 *     on loopback + a local hyperswarm TESTNET; the partition is the agent's
 *     injected transport fault. Every scenario the metal run replays is proven
 *     here first (the brief-12 "metal must reproduce, not discover" rule).
 *  2. CRED-GATED REAL HETZNER (skipped without creds). 3 Swarms over 2 frames
 *     (account server limit): the AUTHORITY alone on frame 0; the Queen + a bee
 *     on frame 1. Substrate federates over the PUBLIC DHT (fresh random Hive
 *     topic per scenario — zero crosstalk); the partition is a REAL nftables
 *     drop of the authority RPC port on frame 1; the kill is a remote pkill.
 *     DESTROYS everything in a finally + the leak check is on the caller
 *     (see the reference memory: verify 0 servers via the Hetzner API after).
 *     Needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { localLoopLauncher, sshLoopLauncher, type SshLoopSlotSpec } from './p2p-perf-tier3/loop-launcher';
import { runFullLoop, type FullLoopVerdict } from './p2p-perf-tier3/run-full-loop';

const TEN_MIN = 10 * 60_000;
const NINETY_MIN = 90 * 60_000;

// Per-process port base so concurrent test files don't collide; each scenario
// offsets further so sequential scenarios never reuse a port (TIME_WAIT).
const LOCAL_BASE_PORT = 48_500 + (process.pid % 800);

type Testnet = { bootstrap: Array<{ host: string; port: number }>; destroy(): Promise<void> };
const testnets: Testnet[] = [];
afterAll(async () => {
  for (const t of testnets) await t.destroy().catch(() => {});
});

async function localBootstrap(): Promise<Array<{ host: string; port: number }>> {
  const testnet = (await createTestnet(3)) as unknown as Testnet;
  testnets.push(testnet);
  return testnet.bootstrap.map((b) => ({ host: b.host, port: b.port }));
}

describe('full shared-hive loop — $0 local parity (3 Swarms, testnet DHT, loopback authority RPC)', () => {
  it(
    'HAPPY PATH: Queen steers → both bees claim in steered order → fake pipelines → CDC convergence → Queen turn 2 sees remote completions',
    async () => {
      const bootstrap = await localBootstrap();
      const launcher = localLoopLauncher({ count: 3, basePort: LOCAL_BASE_PORT, log: () => {} });
      const v = await runFullLoop({
        launcher,
        scenario: { kind: 'happy' },
        bootstrap,
        backlogSize: 10,
        workMinMs: 30,
        workMaxMs: 80,
        sweepDelayMs: 50,
        rpcTimeoutMs: 1500,
        mergePollMs: 300,
        convergenceTimeoutMs: 60_000,
      });

      // Exactly-once dispatch (live authority serializes all claims).
      expect(v.starvedItems).toEqual([]);
      expect(v.completedItems.length).toBe(10);
      expect(v.exactlyOnceObserved).toBe(true);
      expect(v.failOpenObserved).toBe(false);
      expect(v.doubleCompletedAfterReconcile).toEqual([]);
      // Work distributed; remote authority RPC genuinely crossed processes.
      expect(v.results.length).toBe(3);
      expect(v.routeStats.remoteAuthority).toBeGreaterThan(0);
      expect(v.routeStats.localAuthority).toBeGreaterThan(0);
      // STEERING: the Queen's epoch-1 reprioritization federated to every Swarm
      // BEFORE dispatch, and every Swarm's grants followed its steered order.
      expect(v.steering.epoch1SeenByAll).toBe(true);
      expect(v.steering.claimsFollowedSteering.every(Boolean)).toBe(true);
      // STEERING MONOTONICITY: the Queen's next turn sees the other Swarms' work.
      expect(v.steering.queenMissedItems).toEqual([]);
      expect(v.steering.queenSawAllRemoteCompletions).toBe(true);
      // CONVERGENCE: one fixpoint everywhere, bounded lag.
      expect(v.convergence.digestsEqual).toBe(true);
      expect(v.convergence.doneVisibleEverywhere).toBe(true);
      expect(v.convergence.lagCount).toBeGreaterThan(0);
      expect(v.convergence.lagMaxMs).toBeLessThan(30_000);
    },
    TEN_MIN,
  );

  it(
    'PARTITION mid-feature: cut bee fails open → double-claims tolerated → heal → reconcile one deterministic winner per item, convergence resumes',
    async () => {
      const bootstrap = await localBootstrap();
      const launcher = localLoopLauncher({ count: 3, basePort: LOCAL_BASE_PORT + 10, log: () => {} });
      const v = await runFullLoop({
        launcher,
        scenario: { kind: 'partition', targetIndex: 2, healAfterMs: 3_000 },
        bootstrap,
        backlogSize: 12,
        workMinMs: 150,
        workMaxMs: 350,
        sweepDelayMs: 60,
        rpcTimeoutMs: 800,
        mergePollMs: 300,
        convergenceTimeoutMs: 60_000,
      });

      expect(v.starvedItems).toEqual([]);
      expect(v.completedItems.length).toBe(12);
      // The cut genuinely forced fail-open local claims on the partitioned bee…
      expect(v.failOpenObserved).toBe(true);
      // …and the deterministic reconcile resolved every contested item to ONE winner.
      expect(v.doubleCompletedAfterReconcile).toEqual([]);
      expect(v.determinismHolds).toBe(true);
      // Post-heal the substrate still reaches one fixpoint everywhere.
      expect(v.convergence.digestsEqual).toBe(true);
      expect(v.convergence.doneVisibleEverywhere).toBe(true);
      expect(v.steering.queenSawAllRemoteCompletions).toBe(true);
    },
    TEN_MIN,
  );

  it(
    'KILL-AUTHORITY mid-run: survivors fail open, no starvation, zero double-completions after reconcile; Queen (slot 1) turn 2 still sees everything',
    async () => {
      const bootstrap = await localBootstrap();
      const launcher = localLoopLauncher({ count: 3, basePort: LOCAL_BASE_PORT + 20, log: () => {} });
      const v = await runFullLoop({
        launcher,
        scenario: { kind: 'kill-authority', killSettleMs: 300 },
        bootstrap,
        backlogSize: 12,
        workMinMs: 100,
        workMaxMs: 250,
        sweepDelayMs: 60,
        rpcTimeoutMs: 800,
        mergePollMs: 300,
        agentDeadlineMs: 90_000,
        convergenceTimeoutMs: 60_000,
      });

      expect(v.killedAuthority?.swarmIndex).toBe(0);
      expect(v.results.length).toBe(2); // survivors
      // No starvation: every item has completion EVIDENCE — survivor-reported, or
      // federated by the authority before it died, or reclaimed via fail-open.
      expect(v.starvedItems).toEqual([]);
      expect(v.failOpenObserved).toBe(true);
      expect(v.doubleCompletedAfterReconcile).toEqual([]);
      expect(v.determinismHolds).toBe(true);
      // The SURVIVORS' substrate still converges to one fixpoint, and the Queen
      // (deliberately placed off the authority slot) saw the remote completions.
      expect(v.convergence.digestsEqual).toBe(true);
      expect(v.convergence.doneVisibleEverywhere).toBe(true);
      expect(v.steering.queenSawAllRemoteCompletions).toBe(true);
    },
    TEN_MIN,
  );

  it(
    'LEASE-STEAL mid-pipeline: stalled lease lapses → peer steals + completes → zombie completes anyway → D-007 adoption picks the LEASE-CURRENT winner; zombie observed the abort signal',
    async () => {
      const bootstrap = await localBootstrap();
      const launcher = localLoopLauncher({ count: 3, basePort: LOCAL_BASE_PORT + 30, log: () => {} });
      const v = await runFullLoop({
        launcher,
        scenario: { kind: 'lease-steal', stallIndex: 2, stallMs: 7_000, ttlSec: 2 },
        bootstrap,
        backlogSize: 6,
        workMinMs: 50,
        workMaxMs: 100,
        sweepDelayMs: 200,
        rpcTimeoutMs: 1500,
        mergePollMs: 300,
        agentDeadlineMs: 60_000,
        convergenceTimeoutMs: 60_000,
      });

      expect(v.adoption).not.toBeNull();
      const a = v.adoption!;
      // The stall happened, the lease lapsed, a peer stole + completed, the zombie
      // completed anyway → the stalled item carries ≥2 completion records…
      expect(a.stalledItem).not.toBeNull();
      expect(v.rawDoubleClaimed).toContain(a.stalledItem);
      // …whose duplicated SIDE EFFECTS are detected (both runs left their marker)…
      expect(a.sideEffectsDuplicated).toBe(true);
      // …and adoption resolves by D-007 rule 2: the LEASE-CURRENT record (the
      // stealer's) wins; the zombie's earlier acquire is precisely the abandoned one.
      expect(a.stalledItemRule).toBe('lease-current');
      expect(a.adoptedOwner).not.toBeNull();
      expect(a.adoptedOwner).not.toBe(a.zombieOwner);
      // D-007 rule 5: the zombie's mid-pipeline heartbeat returned the abort signal.
      expect(a.zombieAbortSignaled).toBe(true);
      // The rest of the backlog completed normally.
      expect(v.starvedItems).toEqual([]);
      expect(v.convergence.doneVisibleEverywhere).toBe(true);
    },
    TEN_MIN,
  );

  it(
    'REVOKE mid-run (EI-284): authority refuses the revoked Swarm with caller_revoked; zero post-revocation grants; live Swarms finish the backlog',
    async () => {
      const bootstrap = await localBootstrap();
      const launcher = localLoopLauncher({ count: 3, basePort: LOCAL_BASE_PORT + 40, log: () => {} });
      const v = await runFullLoop({
        launcher,
        scenario: { kind: 'revoke', revokeIndex: 2 },
        bootstrap,
        backlogSize: 12,
        workMinMs: 150,
        workMaxMs: 300,
        sweepDelayMs: 60,
        rpcTimeoutMs: 1500,
        mergePollMs: 300,
        convergenceTimeoutMs: 60_000,
      });

      expect(v.revoke).not.toBeNull();
      const r = v.revoke!;
      // The gate fired over the REAL authority RPC: the revoked bee was refused…
      expect(r.refusedCount).toBeGreaterThan(0);
      expect(v.routeStats.refusedRevoked).toBeGreaterThan(0);
      // …and could not win a single lease after the gate armed (the EI-284 fix:
      // before it, a revoked swarm still won leases and BLOCKED live swarms).
      expect(r.postRevocationGrants).toEqual([]);
      expect(r.postRevocationCompletions).toEqual([]);
      // The live Swarms claimed immediately — no starvation, full completion.
      expect(v.starvedItems).toEqual([]);
      expect(v.completedItems.length).toBe(12);
      expect(v.doubleCompletedAfterReconcile).toEqual([]);
      expect(v.convergence.doneVisibleEverywhere).toBe(true);
    },
    TEN_MIN,
  );
});

// ── CRED-GATED: the real-metal run (brief-12 §1+§2 + the P-011 revoke rung) ──
const hetznerSshKeyId = process.env.HETZNER_SSH_KEY_ID;
const hetznerIdentity = process.env.HETZNER_SSH_IDENTITY_FILE;
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) && !!hetznerSshKeyId && !!hetznerIdentity;

describe.skipIf(!haveHetzner)(
  'full shared-hive loop — REAL Hetzner frames, PUBLIC DHT (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      '§1 full loop + §2 chaos replay (real partition, kill, lease-steal) + P-011 revoke w/ EI-284 asserted; one fleet, DESTROYS always',
      async () => {
        const { provisionBenchFleet } = await import('./p2p-perf-tier3/bench-frames');
        const { HetznerDriver } = await import('./hetzner/hetzner-driver');
        const { createSshRemoteExec } = await import('./remote-exec');
        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const size = process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31';
        // 3 Swarms over 2 frames (account server limit 2): authority ALONE on
        // frame 0; Queen (slot 1) + bee (slot 2) on frame 1 — every authority RPC
        // from frame 1 crosses the real machine boundary, and the substrate topic
        // federates over the real public DHT.
        const frameCount = Math.max(2, Number(process.env.LOOP_E2E_FRAMES ?? 2));
        const swarmCount = Math.max(3, Number(process.env.LOOP_E2E_SWARMS ?? 3));
        const locations = (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash').split(',').map((s) => s.trim());
        const sshKeyId = Number(hetznerSshKeyId) || hetznerSshKeyId!;
        const needsIndexSuffix = new Set(locations.slice(0, frameCount)).size < frameCount;
        const basePort = Number(process.env.LOOP_E2E_HTTP_PORT ?? 48_300);

        const fleet = await provisionBenchFleet({
          driver: HetznerDriver,
          repoRoot,
          sshIdentityFile: hetznerIdentity,
          providerDefaults: { sshKeys: [sshKeyId], sshIdentityFile: hetznerIdentity },
          specs: Array.from({ length: frameCount }, (_, i) => ({
            label: `loop-${locations[i % locations.length]}${needsIndexSuffix ? `-${i}` : ''}`,
            region: locations[i % locations.length],
            size,
            kind: 'vm' as const,
            // No firewall: authority HTTP RPC + DHT both ride the public IPs.
            firewall: false,
          })),
          log: (lvl, m) => console.log(`[loop-xm ${lvl}] ${m}`),
        });

        const verdicts: Record<string, FullLoopVerdict> = {};
        try {
          const frameOf = (swarmIdx: number) =>
            swarmIdx === 0 ? 0 : 1 + ((swarmIdx - 1) % Math.max(1, frameCount - 1));

          const launcherFor = (scenarioIdx: number) => {
            const portByFrame = new Map<number, number>();
            const slotSpecs: SshLoopSlotSpec[] = Array.from({ length: swarmCount }, (_, a) => {
              const fi = frameOf(a);
              const portOffset = portByFrame.get(fi) ?? 0;
              portByFrame.set(fi, portOffset + 1);
              const frame = fleet.frames[fi];
              return {
                label: `${frame.spec.label}-s${a}`,
                host: frame.target.host,
                target: frame.target,
                httpPort: basePort + scenarioIdx * 10 + portOffset,
              };
            });
            return sshLoopLauncher({ slots: slotSpecs, log: (l) => console.log(`[loop-xm ${scenarioIdx}] ${l}`) });
          };

          const metalKnobs = {
            workMinMs: 150,
            workMaxMs: 400,
            sweepDelayMs: 200,
            rpcTimeoutMs: 4_000,
            mergePollMs: 1_000,
            readyTimeoutMs: 180_000,
            meshTimeoutMs: 300_000,
            steerTimeoutMs: 180_000,
            resultTimeoutMs: 420_000,
            convergenceTimeoutMs: 240_000,
            agentDeadlineMs: 300_000,
          } as const;

          // ── §1: the full loop, happy path ──
          console.log('[loop-xm] scenario 1/5: HAPPY PATH');
          verdicts.happy = await runFullLoop({
            launcher: launcherFor(0),
            scenario: { kind: 'happy' },
            backlogSize: 12,
            ...metalKnobs,
            log: (l) => console.log(`[loop-xm happy] ${l}`),
          });
          const happy = verdicts.happy;
          expect(happy.starvedItems).toEqual([]);
          expect(happy.completedItems.length).toBe(12);
          expect(happy.exactlyOnceObserved).toBe(true);
          expect(happy.doubleCompletedAfterReconcile).toEqual([]);
          expect(happy.routeStats.remoteAuthority).toBeGreaterThan(0); // crossed machines
          expect(happy.steering.epoch1SeenByAll).toBe(true); // steering federated over the PUBLIC DHT
          expect(happy.steering.claimsFollowedSteering.every(Boolean)).toBe(true);
          expect(happy.steering.queenSawAllRemoteCompletions).toBe(true); // monotonicity
          expect(happy.convergence.digestsEqual).toBe(true);
          expect(happy.convergence.doneVisibleEverywhere).toBe(true);
          expect(happy.convergence.lagMaxMs).toBeLessThan(120_000); // bounded lag oracle

          // ── §2a: REAL network partition — nftables cuts ALL frame1↔frame0 traffic
          // (authority RPC + substrate replication alike, the true machine-boundary
          // partition). SSH control rides the orchestrator's box → frames, untouched.
          console.log('[loop-xm] scenario 2/5: PARTITION (real nftables cut)');
          const authorityIp = fleet.frames[0].target.host;
          const frame1Exec = createSshRemoteExec({ ...fleet.frames[1].target, sudo: false });
          verdicts.partition = await runFullLoop({
            launcher: launcherFor(1),
            scenario: {
              kind: 'partition',
              targetIndex: 2,
              healAfterMs: 15_000,
              engage: async () => {
                await frame1Exec.runScript(
                  [
                    'nft add table inet loopchaos',
                    `nft add chain inet loopchaos output '{ type filter hook output priority 0 ; policy accept ; }'`,
                    `nft add chain inet loopchaos input '{ type filter hook input priority 0 ; policy accept ; }'`,
                    `nft add rule inet loopchaos output ip daddr ${authorityIp} drop`,
                    `nft add rule inet loopchaos input ip saddr ${authorityIp} drop`,
                  ].join('\n') + '\n',
                );
              },
              heal: async () => {
                await frame1Exec.runScript('nft delete table inet loopchaos || true\n');
              },
            },
            backlogSize: 12,
            ...metalKnobs,
            rpcTimeoutMs: 3_000, // dropped packets must fail open inside the work window
            log: (l) => console.log(`[loop-xm partition] ${l}`),
          });
          const part = verdicts.partition;
          expect(part.starvedItems).toEqual([]);
          expect(part.failOpenObserved).toBe(true); // the REAL cut forced fail-open
          expect(part.doubleCompletedAfterReconcile).toEqual([]); // one winner per contest
          expect(part.determinismHolds).toBe(true);
          expect(part.convergence.digestsEqual).toBe(true); // heal → convergence resumed
          expect(part.convergence.doneVisibleEverywhere).toBe(true);

          // ── §2b: kill the authority machine's agent mid-run ──
          console.log('[loop-xm] scenario 3/5: KILL-AUTHORITY');
          verdicts.kill = await runFullLoop({
            launcher: launcherFor(2),
            scenario: { kind: 'kill-authority', killSettleMs: 500 },
            backlogSize: 12,
            ...metalKnobs,
            rpcTimeoutMs: 3_000,
            log: (l) => console.log(`[loop-xm kill] ${l}`),
          });
          const kill = verdicts.kill;
          expect(kill.killedAuthority?.swarmIndex).toBe(0);
          expect(kill.results.length).toBe(swarmCount - 1);
          expect(kill.starvedItems).toEqual([]);
          expect(kill.failOpenObserved).toBe(true);
          expect(kill.doubleCompletedAfterReconcile).toEqual([]);
          expect(kill.determinismHolds).toBe(true);
          expect(kill.steering.queenSawAllRemoteCompletions).toBe(true);
          expect(kill.convergence.doneVisibleEverywhere).toBe(true);

          // ── §2c: lease-steal mid-pipeline across machines (D-007 adoption) ──
          console.log('[loop-xm] scenario 4/5: LEASE-STEAL');
          verdicts.steal = await runFullLoop({
            launcher: launcherFor(3),
            scenario: { kind: 'lease-steal', stallIndex: 2, stallMs: 30_000, ttlSec: 8 },
            backlogSize: 6,
            ...metalKnobs,
            log: (l) => console.log(`[loop-xm steal] ${l}`),
          });
          const steal = verdicts.steal;
          expect(steal.adoption).not.toBeNull();
          expect(steal.adoption!.stalledItem).not.toBeNull();
          expect(steal.adoption!.stalledItemRule).toBe('lease-current');
          expect(steal.adoption!.adoptedOwner).not.toBe(steal.adoption!.zombieOwner);
          expect(steal.adoption!.zombieAbortSignaled).toBe(true);
          expect(steal.adoption!.sideEffectsDuplicated).toBe(true);
          expect(steal.starvedItems).toEqual([]);

          // ── P-011: revoke mid-run, EI-284 exercised + asserted over real RPC ──
          console.log('[loop-xm] scenario 5/5: REVOKE (EI-284)');
          verdicts.revoke = await runFullLoop({
            launcher: launcherFor(4),
            scenario: { kind: 'revoke', revokeIndex: 2 },
            backlogSize: 12,
            ...metalKnobs,
            log: (l) => console.log(`[loop-xm revoke] ${l}`),
          });
          const rev = verdicts.revoke;
          expect(rev.revoke).not.toBeNull();
          expect(rev.revoke!.refusedCount).toBeGreaterThan(0); // refusal crossed the machine boundary
          expect(rev.revoke!.postRevocationGrants).toEqual([]); // the EI-284 contract
          expect(rev.revoke!.postRevocationCompletions).toEqual([]);
          expect(rev.starvedItems).toEqual([]); // live swarms claimed immediately
          expect(rev.convergence.doneVisibleEverywhere).toBe(true);

          console.log(
            `[loop-xm] ALL 5 SCENARIOS GREEN — lag(happy) max=${happy.convergence.lagMaxMs}ms ` +
              `p95=${happy.convergence.lagP95Ms}ms; fixpoint after ${happy.convergence.fixpointAfterMs}ms; ` +
              `remote RPC crossings: ${Object.values(verdicts).reduce((n, v) => n + v.routeStats.remoteAuthority, 0)}`,
          );
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);

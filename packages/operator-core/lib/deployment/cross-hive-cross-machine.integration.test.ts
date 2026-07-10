/**
 * cross-hive-cross-machine.integration.test.ts — the LITERAL cross-machine
 * cross-Hive E2E (cross-hive-boundary-2026-06-08 P-005). Two SEPARATE Hives on two
 * SEPARATE machines: Hive A dials Hive B by pubkey over the real public DHT, B
 * admits per its grant and answers; sovereignty holds (A cannot reach B's agents —
 * it only delivers a mediated envelope B chose to admit).
 *
 * Mirrors hive-cross-machine.integration.test.ts (the shared-hive-federation P-011
 * harness) — TWO paths:
 *  1. $0 LOCAL SMOKE (always runs): spawn the REAL frame program
 *     (cross-hive-frame.ts) as two local subprocesses on one testnet DHT. This
 *     exercises the exact deployable artifact — config parse, Ed25519 signing,
 *     makeSwarmCrossHiveTransport, wireCrossHiveBoundary, grant admission, reply —
 *     end-to-end before a cent is spent. (The in-process transport/admission proofs
 *     live in cross-hive-two-hive.test.ts + cross-hive-wiring.integration.test.ts.)
 *  2. CRED-GATED REAL HETZNER (skipped without creds): provisions 2 distinct
 *     public-IP VMs, installs the packed runtime, SSH-launches B then A, scrapes
 *     the stdout markers, asserts the admit→reply round-trip, and DESTROYS
 *     everything in a finally. Needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID +
 *     HETZNER_SSH_IDENTITY_FILE (the same creds as the proven P-011 run).
 *
 * NOTE: the cross-machine CONNECTIVITY (NAT holepunch over the public DHT on the
 * same hyperswarm + deriveHiveFederationTopic) is already proven by P-011/D-017;
 * a cross-Hive Protomux channel rides that connection identically (Protomux is
 * transport-agnostic) — so this is the formal cross-Hive validation on top of a
 * proven substrate.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';

const FIFTEEN_MIN = 15 * 60_000;
const NINETY_MIN = 90 * 60_000;
const FRAME_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'cross-hive-frame.ts');

/** A Hive identity: raw-32-byte base64 pubkey + PKCS8-DER base64 private key. */
function hiveKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubkey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64'),
    privPkcs8B64: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

/** Spawn cross-hive-frame.ts locally, collecting stdout lines. */
function spawnFrameLocal(cfg: unknown): { proc: ChildProcess; lines: string[] } {
  const lines: string[] = [];
  const proc = spawn('node', ['--import', 'tsx', FRAME_PATH], {
    env: { ...process.env, XPOT_FRAME: JSON.stringify(cfg), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  cleanups.push(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });
  return { proc, lines };
}

async function waitForLine(lines: string[], match: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = lines.find((l) => l.includes(match));
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('cross-Hive cross-machine — $0 local smoke (the deployable frame program)', () => {
  it(
    'two REAL cross-hive-frame processes: A dials B, B admits per its grant + answers',
    async () => {
      const A = hiveKeypair();
      const B = hiveKeypair();
      const corr = 'xhive-smoke-1';
      const testnet = await createTestnet(3);
      cleanups.push(async () => { await testnet.destroy().catch(() => {}); });
      const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({ host: b.host, port: b.port }));

      // B (receiver/grantor) first, so it is announced before A dials.
      const b = spawnFrameLocal({ role: 'B', selfPubkey: B.pubkey, selfPrivPkcs8B64: B.privPkcs8B64, peerPubkey: A.pubkey, corr, bootstrap, ttlSec: 120 });
      expect(await waitForLine(b.lines, 'XHIVE_READY', 30_000)).toBeTruthy();

      const a = spawnFrameLocal({ role: 'A', selfPubkey: A.pubkey, selfPrivPkcs8B64: A.privPkcs8B64, peerPubkey: B.pubkey, corr, bootstrap, ttlSec: 120 });
      expect(await waitForLine(a.lines, 'XHIVE_READY', 30_000)).toBeTruthy();

      // B admits A's ask (its grant covers 'ask') and A receives the answer.
      expect(await waitForLine(b.lines, 'XHIVE_ADMITTED', 90_000), 'B never admitted A\'s ask').toBeTruthy();
      const reply = await waitForLine(a.lines, 'XHIVE_REPLY', 90_000);
      expect(reply, 'A never received B\'s answer').toBeTruthy();
      expect(reply).toContain(corr);
    },
    FIFTEEN_MIN,
  );
});

// ── CRED-GATED: the literal two-Hetzner-machine cross-Hive run (P-005 deliverable) ──
const haveHetzner =
  !!(process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN) &&
  !!process.env.HETZNER_SSH_KEY_ID &&
  !!process.env.HETZNER_SSH_IDENTITY_FILE;

describe.skipIf(!haveHetzner)(
  'cross-Hive cross-machine — REAL Hetzner (needs HCLOUD_TOKEN + HETZNER_SSH_KEY_ID + HETZNER_SSH_IDENTITY_FILE)',
  () => {
    it(
      'two SEPARATE Hetzner machines: Hive A dials Hive B over the public DHT, B admits + answers, DESTROYS always',
      async () => {
        const { provisionBenchFleet } = await import('./p2p-perf-tier3/bench-frames');
        const { HetznerDriver } = await import('./hetzner/hetzner-driver');
        const { benchRuntimeDir } = await import('./p2p-perf-tier3/bench-bootstrap');
        const { buildSshStreamArgs } = await import('./remote-exec');

        const repoRoot = process.cwd().includes('packages/operator-core')
          ? resolve(process.cwd(), '..', '..')
          : process.cwd();
        const size = process.env.HETZNER_E2E_SERVER_TYPE ?? 'cpx31';
        const locations = (process.env.P2P_PERF_HETZNER_LOCATIONS ?? 'ash,ash').split(',').map((s) => s.trim());
        const sshKeyId = Number(process.env.HETZNER_SSH_KEY_ID) || process.env.HETZNER_SSH_KEY_ID!;
        const identity = process.env.HETZNER_SSH_IDENTITY_FILE!;
        const needsIndexSuffix = new Set(locations.slice(0, 2)).size < 2;

        const fleet = await provisionBenchFleet({
          driver: HetznerDriver,
          repoRoot,
          sshIdentityFile: identity,
          providerDefaults: { sshKeys: [sshKeyId], sshIdentityFile: identity },
          specs: Array.from({ length: 2 }, (_, i) => ({
            label: locations[i % locations.length] + (needsIndexSuffix ? `-${i}` : ''),
            region: locations[i % locations.length],
            size,
            kind: 'vm' as const,
            firewall: i > 0, // 2nd frame firewalled → exercise NAT holepunch over the cross-hive topic
          })),
          log: (lvl, m) => console.log(`[xhive-xm ${lvl}] ${m}`),
        });

        try {
          const A = hiveKeypair();
          const B = hiveKeypair();
          const corr = `xhive-hetzner-${Date.now()}`;
          const framePath = `${benchRuntimeDir()}/packages/operator-core/lib/deployment/cross-hive-frame.ts`;
          const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

          const launchRemote = (frameIdx: number, cfg: unknown) => {
            const lines: string[] = [];
            const remoteCommand =
              `cd ${shq(benchRuntimeDir())} && XPOT_FRAME=${shq(JSON.stringify(cfg))} NODE_ENV=test ` +
              `exec node --import tsx ${shq(framePath)}`;
            const target = { ...fleet.frames[frameIdx].target, sudo: false };
            const { cmd, args } = buildSshStreamArgs(target, remoteCommand);
            const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let buf = '';
            proc.stdout?.on('data', (d: Buffer) => {
              buf += d.toString();
              let nl: number;
              while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); lines.push(line); console.log(`[xhive-xm f${frameIdx}] ${line}`); buf = buf.slice(nl + 1); }
            });
            proc.stderr?.on('data', (d: Buffer) => console.log(`[xhive-xm f${frameIdx} err] ${d.toString().trim()}`));
            cleanups.push(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });
            return { proc, lines };
          };

          // Frame 1 = B (receiver/grantor) — launch + wait until it's announced.
          const b = launchRemote(1, { role: 'B', selfPubkey: B.pubkey, selfPrivPkcs8B64: B.privPkcs8B64, peerPubkey: A.pubkey, corr, ttlSec: 600 });
          expect(await waitForLine(b.lines, 'XHIVE_READY', 120_000), 'frame B never became ready').toBeTruthy();

          // Frame 0 = A (sender) — dials B by pubkey over the public DHT.
          const a = launchRemote(0, { role: 'A', selfPubkey: A.pubkey, selfPrivPkcs8B64: A.privPkcs8B64, peerPubkey: B.pubkey, corr, ttlSec: 600 });
          expect(await waitForLine(a.lines, 'XHIVE_READY', 120_000), 'frame A never became ready').toBeTruthy();

          // THE P-005 PROOF: across two SEPARATE machines, B admitted A's ask per its
          // grant and A received B's answer over the real public DHT.
          expect(await waitForLine(b.lines, 'XHIVE_ADMITTED', 300_000), 'B never admitted A\'s ask cross-machine').toBeTruthy();
          const reply = await waitForLine(a.lines, 'XHIVE_REPLY', 300_000);
          expect(reply, 'A never received B\'s answer cross-machine').toBeTruthy();
          expect(reply).toContain(corr);
          console.log('[xhive-xm] ✅ cross-machine cross-Hive admit→reply proven over the public DHT');
        } finally {
          await fleet.teardownAll();
        }
      },
      NINETY_MIN,
    );
  },
);

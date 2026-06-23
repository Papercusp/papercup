/**
 * authority-rpc-swarm-real-wire.test.ts — the REAL-WIRE two-peer
 * lock-serialization proof for the option-(c) protomux authority-RPC transport
 * (shared-hive-hardening-2026-06-13 P-003, the D-003 real-hardware gate).
 *
 * # Why this exists (the gap the loopback test left open)
 *
 * `authority-rpc-swarm-loopback.test.ts` proves the transport LOGIC by wiring two
 * `makeAuthorityRpcSwarmTransport` instances together over PAIRED FAKE protomux
 * channels — a perfect, zero-latency, in-memory "wire". That proves serialization
 * at one store but, by its own admission, "CANNOT prove (needs real hardware):
 * reachability / NAT traversal / real network latency". The sibling real-hardware
 * proof that DID run on Hetzner (D-011, eviction) used the HTTP transport
 * (`HttpPeerRpcTransport`), NOT this protomux swarm transport — so until now the
 * protomux authority-RPC channel had NEVER carried a contended lock over a real
 * Hyperswarm connection.
 *
 * # What this proves (the real wire)
 *
 * Two GENUINELY DISTINCT peers (distinct Ed25519 identities, distinct corestores,
 * distinct embedded swarms) discover each other on a LOCAL testnet DHT
 * (`hyperdht/testnet.js`, offline + deterministic), connect over the real
 * Hyperswarm / Noise secret-stream, and the substrate forms the per-harness
 * Protomux muxer on each connection (the same `socket.userData` muxer the
 * `papercusp/announce` channel uses). We then wire the PRODUCTION
 * `makeAuthorityRpcSwarmTransport` onto each peer's REAL swarm, so the
 * `papercusp/authority-rpc` channel opens on that SAME real muxer over that SAME
 * real connection — byte-for-byte the production path (authority-rpc-swarm-wiring
 * `wireAuthorityRpcSwarmTransport`). Then:
 *
 *   - Requester A routes a `lock.acquire` to authority B over the real channel;
 *     B (the lowest-device_pubkey peer, the deterministic authority) grants it —
 *     `via: 'remote-authority'`, NOT fail-open.
 *   - A second contender on the SAME path is REFUSED by B's single store (mutual
 *     exclusion serialized cross-"machine" at one authority over the real wire).
 *   - Release frees the path; a contender can then acquire it.
 *
 * This is the "two-machine (or VM-rig)" run the plan's `## Now` names: two real
 * swarm peers, a real DHT, a real encrypted connection, a real protomux channel.
 *
 * # What it (still) does NOT add over a true cross-HOST run
 *
 * Both peers share one process + one OS, so this does not add WAN latency or
 * cross-host NAT traversal beyond what the loopback testnet exercises. But the
 * Hyperswarm CONNECTION + Protomux MUXER + channel handshake are the IDENTICAL
 * stack already proven cross-host for the SIBLING channels (`papercusp/announce`
 * two-peer + `papercusp/cross-hive` + the Hetzner eviction over the same swarm
 * connection) — the authority-rpc channel is one more protocol id on that same
 * muxer. So the residual is reachability latency only, and the transport FAILS
 * OPEN (D-002): the worst case of any residual is extra merge churn, never data
 * loss.
 *
 * # Offline-deterministic seams (same as two-peer-swarm.test.ts)
 *
 * The channel-2 GitHub-binding admission gate is bypassed (`verifyBindingOverride`)
 * — this validates the authority-RPC TRANSPORT over the wire, not the gate (the
 * gate is unit-tested elsewhere). The authority-RPC requests are UNSIGNED (no
 * `envelopeSigner`), exactly like the loopback proof: the EI-322 signing path is
 * tested separately (authority-rpc-swarm-transport.test.ts); the device_pubkey is
 * only an addressing token here, and B is the deterministic authority by argmin.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

import { bootHarnessSubstrate, type BootedHarnessHandle } from '../../sync/hyperbee/boot';
import { type HyperswarmLike } from '../../sync/hyperbee/swarm';
import type { OpEnvelope } from '../../sync/hyperbee/op-envelope-types';
import { _resetCacheForTests, closeHarnessStore } from '../../sync/hyperbee/corestore';
import { _resetBootHistoryForTests } from '../../sync/hyperbee/boot-history';

import {
  makeAuthorityRpcSwarmTransport,
  type AuthorityRpcSwarmTransport,
} from '../authority-rpc-swarm-transport';
import {
  buildFileLockAuthorityHandlers,
  FILE_LOCK_OP_KINDS,
  type FileLockCoordinator,
  type FileLockAcquireParams,
  type FileLockReleaseParams,
} from '../file-lock-authority-ops';
import { handleAuthorityRpc } from '../authority-op-registry';
import { routeToAuthority, type LockAuthorityDeps } from '../lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../peer-rpc-transport';

// ── Async resource teardown (newest-first, mirrors two-peer-swarm.test.ts). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  __resetPeerRpcTransportForTests();
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm/dir/transport
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

/** A fresh tmp workspace root, registered for teardown. Distinct roots → distinct
 *  corestores → distinct per-peer log cores → two genuinely distinct peers. */
function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's `device_pubkey` convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** A real distinct identity: a self-generated Ed25519 keypair + a fake gh user +
 *  a substrate `announceIdentityOverride` that signs with the matching key (so no
 *  OS keychain / `gh`, but `verifyAnnounce` still passes over the wire). */
function makeIdentity(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

/** A real `hyperswarm` bootstrapped to the local testnet DHT (offline). Destroyed in teardown. */
function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

/** Poll `fn()` until it returns truthy or `timeoutMs` elapses. Bounded. */
async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const DOMAIN = '/repo/realpath';

/** A trivial in-memory file-lock coordinator: path → { owner, lockId }. The single
 *  serialization point standing in for the authority's su-lock store (identical to
 *  the loopback proof's coordinator — the wire is what differs here, not the store). */
function makeCoordinator(): FileLockCoordinator {
  const held = new Map<string, { owner: string; lockId: string }>();
  let seq = 0;
  return {
    async acquire(p: FileLockAcquireParams) {
      const busy: Array<{ path: string; owner: string }> = [];
      for (const path of p.paths) {
        const cur = held.get(path);
        if (cur && cur.owner !== p.owner) busy.push({ path, owner: cur.owner });
      }
      if (busy.length) return { ok: false, busy };
      const lockId = `lk-${++seq}`;
      for (const path of p.paths) held.set(path, { owner: p.owner, lockId });
      return { ok: true, lockId };
    },
    async release(p: FileLockReleaseParams) {
      const released: string[] = [];
      for (const [path, lock] of [...held]) {
        if (lock.owner === p.owner && (p.allMine || p.lockId === lock.lockId || p.paths?.includes(path))) {
          held.delete(path);
          released.push(path);
        }
      }
      return { ok: true, released };
    },
    async queue() {
      return { active_locks: [...held.entries()].map(([path, l]) => ({ path, owner: l.owner })) };
    },
  };
}

/** The unified op-result type (local + remote.decode must agree on T). */
type LockOpResult = {
  ok: boolean;
  lockId?: string;
  busy?: Array<{ path: string; owner: string }>;
  released?: string[];
  active_locks?: Array<{ path: string; owner: string }>;
  viaLocal?: boolean;
};
const localFalse = async (): Promise<LockOpResult> => ({ ok: false });

const acquireOp = (owner: string, paths: string[]) => ({
  kind: FILE_LOCK_OP_KINDS.acquire,
  payload: { owner, paths, intent: 'edit', ttlSec: 1200, coordinationDomain: DOMAIN },
  decode: (raw: unknown) => raw as LockOpResult,
});
const releaseOp = (owner: string, lockId: string | undefined) => ({
  kind: FILE_LOCK_OP_KINDS.release,
  payload: { owner, lockId, coordinationDomain: DOMAIN },
  decode: (raw: unknown) => raw as LockOpResult,
});
const queueOp = (owner: string) => ({
  kind: FILE_LOCK_OP_KINDS.queue,
  payload: { owner, coordinationDomain: DOMAIN },
  decode: (raw: unknown) => raw as LockOpResult,
});

describe('option-(c) protomux authority-RPC transport serializes a contended lock over a REAL Hyperswarm wire (P-003 / D-003)', () => {
  it(
    'two real peers, one DHT, one connection: requester A routes a contended lock to authority B and B serializes it cross-peer (NOT fail-open)',
    async () => {
      // ── Local testnet DHT (offline, deterministic). 3 nodes for a stable
      //    bootstrap; both swarms join it instead of the public DHT. ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const workspaceId = 'ws-authority-rpc-realwire';
      const harnessSlug = 'sheets';
      const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

      // ── Two DISTINCT real identities. The AUTHORITY is the lowest device_pubkey
      //    (D-005 argmin), so designate roles AFTER generating the keys. ──
      const id1 = makeIdentity('peer-one', 101, 'kc-one');
      const id2 = makeIdentity('peer-two', 202, 'kc-two');
      const [authId, reqId] =
        id1.devicePubkey < id2.devicePubkey ? [id1, id2] : [id2, id1];
      // authId = B (authority, lowest pubkey); reqId = A (requester).
      expect(authId.devicePubkey < reqId.devicePubkey).toBe(true);

      const swarmAuth = makeSwarm(testnet.bootstrap);
      const swarmReq = makeSwarm(testnet.bootstrap);

      const applyAuth = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyReq = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

      const rootAuth = makeWorkspaceRoot('arpc-auth-');
      const rootReq = makeWorkspaceRoot('arpc-req-');

      let handleAuth: BootedHarnessHandle | undefined;
      let handleReq: BootedHarnessHandle | undefined;

      // ── Boot both real substrate peers onto the same swarm topic. This forms the
      //    real Hyperswarm connection + the per-socket Protomux muxer that the
      //    authority-rpc channel will ride (exactly as production boots before
      //    wireAuthorityRpcSwarmTransport runs). ──
      handleAuth = await bootHarnessSubstrate({
        workspaceRoot: rootAuth,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmAuth,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyAuth,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: authId.override,
      });
      cleanups.push(async () => {
        await handleAuth?.close();
        await closeHarnessStore({ workspaceRoot: rootAuth, harnessSlug });
      });

      handleReq = await bootHarnessSubstrate({
        workspaceRoot: rootReq,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmReq,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyReq,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: reqId.override,
      });
      cleanups.push(async () => {
        await handleReq?.close();
        await closeHarnessStore({ workspaceRoot: rootReq, harnessSlug });
      });

      expect(handleAuth.swarm).not.toBeNull();
      expect(handleReq.swarm).not.toBeNull();
      expect(handleAuth.swarm!.topicHex).toBe(handleReq.swarm!.topicHex);

      // ── Wire the PRODUCTION authority-RPC swarm transport onto each peer's REAL
      //    swarm. The receiving (authority) side runs the REAL file-lock authority
      //    handlers over ONE in-memory store; the requesting side serves nothing.
      //    Each transport attaches to the already-forming connection (its
      //    on('connection') + retroactive connections scan), opening the
      //    `papercusp/authority-rpc` channel on the same real muxer as announce. ──
      const coordinator = makeCoordinator();
      const authHandlers = buildFileLockAuthorityHandlers(coordinator, { emit: () => {} });

      const transportAuth: AuthorityRpcSwarmTransport = makeAuthorityRpcSwarmTransport({
        swarm: swarmAuth,
        selfDevicePubkey: authId.devicePubkey,
        dispatch: (env) => handleAuthorityRpc(env, { handlers: authHandlers }),
      });
      cleanups.push(() => transportAuth.close());

      const transportReq: AuthorityRpcSwarmTransport = makeAuthorityRpcSwarmTransport({
        swarm: swarmReq,
        selfDevicePubkey: reqId.devicePubkey,
        // requester serves nothing (send-only)
      });
      cleanups.push(() => transportReq.close());

      // routeToAuthority (called as the REQUESTER) reads the process-global
      // transport. The authority RECEIVES via transportAuth.dispatch directly.
      setPeerRpcTransport(transportReq);

      // Requester deps: fixed clock, self = A, presence has BOTH peers (so argmin =
      // B = the authority), eviction disabled. No real PG.
      const NOW = 1_700_000_000_000;
      const requesterDeps: LockAuthorityDeps = {
        now: () => NOW,
        evictionMonitor: null,
        resolveSelf: async () => ({ githubUserId: reqId.userId, devicePubkey: reqId.devicePubkey }),
        fetchPresenceRows: async () => [
          { device_pubkey: authId.devicePubkey, github_user_id: authId.userId, machine_label: 'authority-B', last_seen_ms: NOW - 1000 },
          { device_pubkey: reqId.devicePubkey, github_user_id: reqId.userId, machine_label: 'requester-A', last_seen_ms: NOW - 1000 },
        ],
      };

      // ── Wait until the authority-rpc channel has PAIRED over the real wire and
      //    A has learned B's device_pubkey via the HELLO — confirmed decisively by
      //    a non-mutating `lock.queue` probe routing `via: 'remote-authority'`
      //    (not fail-open). DHT discovery + connect + channel-open is seconds. ──
      const wired = await pollUntil(
        async () => {
          const probe = await routeToAuthority('h1', { local: localFalse, remote: queueOp('probe') }, requesterDeps);
          return probe.via === 'remote-authority' ? probe : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 250 },
      );
      expect(
        wired,
        'the authority-rpc channel never carried a remote-authority op over the real wire (stuck fail-open)',
      ).toBeTruthy();
      expect(transportReq.openChannelCount).toBeGreaterThanOrEqual(1);
      expect(transportAuth.openChannelCount).toBeGreaterThanOrEqual(1);

      // ── THE PROOF (over the real wire) ────────────────────────────────────────
      // 1. A acquires a contended path at authority B → granted, remote-authority.
      const acq = await routeToAuthority(
        'h1',
        { local: localFalse, remote: acquireOp('owner-A', ['shared.ts']) },
        requesterDeps,
      );
      expect(acq.via).toBe('remote-authority');
      expect(acq.value.ok).toBe(true);
      expect(acq.value.lockId).toBeTruthy();

      // 2. A second contender on the SAME path is REFUSED by B's single store —
      //    mutual exclusion serialized cross-peer at one authority over the wire.
      const contend = await routeToAuthority(
        'h1',
        { local: localFalse, remote: acquireOp('owner-C', ['shared.ts']) },
        requesterDeps,
      );
      expect(contend.via).toBe('remote-authority');
      expect(contend.value.ok).toBe(false);
      expect(contend.value.busy).toEqual([{ path: 'shared.ts', owner: 'owner-A' }]);

      // 3. Release frees the path at the authority...
      const rel = await routeToAuthority(
        'h1',
        { local: localFalse, remote: releaseOp('owner-A', acq.value.lockId) },
        requesterDeps,
      );
      expect(rel.via).toBe('remote-authority');
      expect(rel.value.released).toEqual(['shared.ts']);

      // 4. ...so the contender can now acquire it.
      const reacq = await routeToAuthority(
        'h1',
        { local: localFalse, remote: acquireOp('owner-C', ['shared.ts']) },
        requesterDeps,
      );
      expect(reacq.via).toBe('remote-authority');
      expect(reacq.value.ok).toBe(true);
    },
    60_000,
  );
});

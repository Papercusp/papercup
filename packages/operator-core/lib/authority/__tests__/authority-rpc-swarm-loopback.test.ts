/**
 * authority-rpc-swarm-loopback.test.ts — the in-process two-instance equivalent
 * of the real-hardware cross-machine lock-serialization proof
 * (shared-hive-hardening-2026-06-13 P-003, D-003 real-hardware gate). Two
 * transport instances are wired together over PAIRED fake protomux channels (the
 * loopback "wire"); the authority instance runs the REAL file-lock authority
 * handlers (buildFileLockAuthorityHandlers) over a single in-memory lock store.
 *
 * This proves the option-(c) transport actually SERIALIZES contended locks at one
 * authority store: requester A routes lock.acquire to authority B over the
 * Hyperswarm-channel transport (via routeToAuthority → my transport →
 * handleAuthorityRpc → coordinator), B grants; a second requester contends the
 * same path and B refuses (mutual exclusion at the single store); release frees
 * it; and an unlinked transport fails open (PeerUnreachableError).
 *
 * What it CANNOT prove (needs real hardware, P-003 → needs-human): reachability /
 * NAT traversal / real network latency / clock skew. The paired-channel wire has
 * zero latency and is a perfect transport, exactly as the in-process HTTP rig
 * (two-instance-authority.integration.test.ts) cannot prove those either.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeAuthorityRpcSwarmTransport } from '../authority-rpc-swarm-transport';
import {
  buildFileLockAuthorityHandlers,
  FILE_LOCK_OP_KINDS,
  type FileLockCoordinator,
  type FileLockAcquireParams,
  type FileLockReleaseParams,
} from '../file-lock-authority-ops';
import { handleAuthorityRpc } from '../authority-op-registry';
import { routeToAuthority, type LockAuthorityDeps } from '../lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests, PeerUnreachableError } from '../peer-rpc-transport';

// ── Paired fake protomux (a loopback wire: one side's send → the other's onmessage) ──
interface FakeChannel {
  onopen?: () => void;
  onclose?: () => void;
  sent: unknown[];
  inbound?: (frame: unknown) => void;
  linkedTo: FakeChannel | null;
  open(): void;
  addMessage(m: { onmessage?: (f: unknown) => void }): { send(v: unknown): void };
  pair(): void;
}
function makeFakeProtomux() {
  const created: FakeChannel[] = [];
  return {
    created,
    protomux: {
      from(_socket: unknown) {
        return {
          createChannel(spec: { protocol: string; onopen?: () => void; onclose?: () => void }): FakeChannel {
            const ch: FakeChannel = {
              onopen: spec.onopen,
              onclose: spec.onclose,
              sent: [],
              inbound: undefined,
              linkedTo: null,
              open() {},
              addMessage(m) {
                ch.inbound = m.onmessage;
                return {
                  send(v: unknown) {
                    ch.sent.push(v);
                    if (ch.linkedTo) {
                      const peer = ch.linkedTo;
                      queueMicrotask(() => peer.inbound?.(v));
                    }
                  },
                };
              },
              pair() {
                this.onopen?.();
              },
            };
            created.push(ch);
            return ch;
          },
        };
      },
    },
  };
}
function makeFakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  return {
    swarm: {
      on(_e: 'connection', l: (s: unknown) => void) {
        handler = l;
      },
      off() {
        handler = null;
      },
      join() {
        return {};
      },
      leave() {},
      connections: [] as unknown[],
    },
    connect(socket: unknown = {}) {
      handler?.(socket);
    },
  };
}

// Device pubkeys chosen so B is the lock authority (lowest device_pubkey).
const A_SELF = 'zzz-requester-A';
const B_SELF = 'aaa-authority-B';
const DOMAIN = '/repo/realpath';
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A trivial in-memory file-lock coordinator: path → { owner, lockId }. The
 *  single serialization point standing in for the authority's su-lock store. */
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

/** Build the two wired instances: A (requester) and B (authority). */
function wirePair() {
  const coordinator = makeCoordinator();
  const bHandlers = buildFileLockAuthorityHandlers(coordinator);

  const fA = makeFakeSwarm();
  const pA = makeFakeProtomux();
  const transportA = makeAuthorityRpcSwarmTransport({
    swarm: fA.swarm,
    selfDevicePubkey: A_SELF,
    protomux: pA.protomux,
    // A is the requester; it also serves nothing (no handlers) — fine.
  });

  const fB = makeFakeSwarm();
  const pB = makeFakeProtomux();
  const transportB = makeAuthorityRpcSwarmTransport({
    swarm: fB.swarm,
    selfDevicePubkey: B_SELF,
    protomux: pB.protomux,
    dispatch: (env) => handleAuthorityRpc(env, { handlers: bHandlers }),
  });

  // Form the connection on both sides + link the channels into a loopback wire.
  fA.connect();
  fB.connect();
  const chA = pA.created[0];
  const chB = pB.created[0];
  chA.linkedTo = chB;
  chB.linkedTo = chA;
  chA.pair(); // A onopen → HELLO(A_SELF) → B learns A
  chB.pair(); // B onopen → HELLO(B_SELF) → A learns B

  return { transportA, transportB, coordinator };
}

// Deps that resolve B as the authority (lowest device_pubkey), self = A.
const NOW = 1_700_000_000_000;
const requesterDeps: LockAuthorityDeps = {
  now: () => NOW,
  resolveSelf: async () => ({ githubUserId: 2, devicePubkey: A_SELF }),
  fetchPresenceRows: async () => [
    { device_pubkey: B_SELF, github_user_id: 1, machine_label: 'authority-B', last_seen_ms: NOW - 1000 },
    { device_pubkey: A_SELF, github_user_id: 2, machine_label: 'requester-A', last_seen_ms: NOW - 1000 },
  ],
};

/** The unified op-result type so routeToAuthority<T> infers one T for both the
 *  local branch and remote.decode (local + remote must agree on T). */
type LockOpResult = {
  ok: boolean;
  lockId?: string;
  busy?: Array<{ path: string; owner: string }>;
  released?: string[];
  viaLocal?: boolean;
};
const localFalse = async (): Promise<LockOpResult> => ({ ok: false });

const acquireOp = (owner: string, paths: string[]) => ({
  kind: FILE_LOCK_OP_KINDS.acquire,
  payload: { owner, paths, intent: 'edit', ttlSec: 1200, coordinationDomain: DOMAIN },
  decode: (raw: unknown) => raw as LockOpResult,
});

beforeEach(() => {
  __resetPeerRpcTransportForTests();
});

describe('option-(c) transport serializes a contended lock at the authority (in-process P-003 equivalent)', () => {
  it('routes a lock.acquire to the remote authority over the swarm channel and grants it', async () => {
    const { transportA } = wirePair();
    await flush(); // HELLOs settle
    setPeerRpcTransport(transportA);

    const res = await routeToAuthority('h1', { local: localFalse, remote: acquireOp('owner-A', ['x.ts']) }, requesterDeps);

    expect(res.via).toBe('remote-authority');
    expect(res.value).toMatchObject({ ok: true });
    expect(res.value.lockId).toBeTruthy();
  });

  it('a second requester contending the same path is refused (mutual exclusion at one store)', async () => {
    const { transportA } = wirePair();
    await flush();
    setPeerRpcTransport(transportA);

    const first = await routeToAuthority('h1', { local: localFalse, remote: acquireOp('owner-A', ['shared.ts']) }, requesterDeps);
    expect(first.value.ok).toBe(true);

    const second = await routeToAuthority('h1', { local: localFalse, remote: acquireOp('owner-C', ['shared.ts']) }, requesterDeps);
    expect(second.via).toBe('remote-authority');
    expect(second.value.ok).toBe(false);
    expect(second.value.busy).toEqual([{ path: 'shared.ts', owner: 'owner-A' }]);
  });

  it('release frees the path so a contender can then acquire it', async () => {
    const { transportA } = wirePair();
    await flush();
    setPeerRpcTransport(transportA);

    const acq = await routeToAuthority('h1', { local: localFalse, remote: acquireOp('owner-A', ['p.ts']) }, requesterDeps);
    const lockId = acq.value.lockId;

    const rel = await routeToAuthority(
      'h1',
      {
        local: localFalse,
        remote: {
          kind: FILE_LOCK_OP_KINDS.release,
          payload: { owner: 'owner-A', lockId, coordinationDomain: DOMAIN },
          decode: (raw: unknown) => raw as LockOpResult,
        },
      },
      requesterDeps,
    );
    expect(rel.via).toBe('remote-authority');
    expect(rel.value.released).toEqual(['p.ts']);

    // Now a contender can take it.
    const reacq = await routeToAuthority('h1', { local: localFalse, remote: acquireOp('owner-C', ['p.ts']) }, requesterDeps);
    expect(reacq.value.ok).toBe(true);
  });

  it('fails open (local) when the transport has no channel to the authority', async () => {
    // A transport with no peer connection at all → unreachable → fail-open.
    const fA = makeFakeSwarm();
    const pA = makeFakeProtomux();
    const transportA = makeAuthorityRpcSwarmTransport({ swarm: fA.swarm, selfDevicePubkey: A_SELF, protomux: pA.protomux });
    setPeerRpcTransport(transportA);

    const res = await routeToAuthority(
      'h1',
      {
        local: async (): Promise<LockOpResult> => ({ ok: true, viaLocal: true }),
        remote: acquireOp('owner-A', ['y.ts']),
      },
      requesterDeps,
    );
    expect(res.via).toBe('fail-open');
    expect(res.value).toMatchObject({ ok: true, viaLocal: true });
    expect(res.warning).toBeTruthy();
  });

  it('the direct transport rpc throws PeerUnreachableError when unlinked', async () => {
    const fA = makeFakeSwarm();
    const pA = makeFakeProtomux();
    const transportA = makeAuthorityRpcSwarmTransport({ swarm: fA.swarm, selfDevicePubkey: A_SELF, protomux: pA.protomux });
    await expect(
      transportA.rpc({ devicePubkey: B_SELF, machineLabel: 'B' } as never, { harnessSlug: 'h', kind: 'lock.acquire', payload: {} }),
    ).rejects.toBeInstanceOf(PeerUnreachableError);
  });
});

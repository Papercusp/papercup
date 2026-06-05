/**
 * Two-instance authority serialization test (Phase 3 / the VM-rig substitute,
 * distributed-coordination-shared-harness-2026-06-04). Real loopback HTTP — two
 * client "peers" route a contended lock to ONE authority peer (a real http server
 * wrapping handleAuthorityRpc) over the real HttpPeerRpcTransport, and the
 * authority's single store serializes them. This is the end-to-end proof of
 * Track B's purpose — cross-machine mutual exclusion via the authority — that the
 * in-process projection tests + the single-peer loopback test don't cover
 * together. It needs no VMs: two in-process peers + one authority http server,
 * each with its own store, talking over loopback.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { routeToAuthority, type LockAuthorityDeps } from '../lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../peer-rpc-transport';
import { HttpPeerRpcTransport } from '../http-peer-rpc-transport';
import {
  registerAuthorityOp,
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../authority-op-registry';
import { __resetRemotePeersCacheForTests } from '../remote-peers-cache';

const NOW = 1_700_000_000_000;

/** The lock-op result both the local fallback and the decoded RPC return. */
type LockResult = { granted: boolean; owner?: string; heldBy?: string };

/** A minimal lock store standing in for a per-machine su-lock-store: one owner
 *  per path; same-owner re-acquire is idempotent. */
class FakeLockStore {
  readonly held = new Map<string, string>();
  acquire(owner: string, path: string): { granted: boolean; owner?: string; heldBy?: string } {
    const cur = this.held.get(path);
    if (!cur || cur === owner) {
      this.held.set(path, owner);
      return { granted: true, owner };
    }
    return { granted: false, heldBy: cur };
  }
  release(owner: string, path: string): void {
    if (this.held.get(path) === owner) this.held.delete(path);
  }
}

// The harness's swarm roster (what each client's lockAuthorityFor sees). The
// authority is argmin(device_pubkey) = 'auth-aaa' (the http-server peer).
const ROSTER = [
  { device_pubkey: 'auth-aaa', github_user_id: 1, machine_label: 'authority-box', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'cli-mmm', github_user_id: 2, machine_label: 'client-1', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'cli-zzz', github_user_id: 3, machine_label: 'client-2', last_seen_ms: NOW - 1000 },
];
function clientDeps(selfPubkey: string): LockAuthorityDeps {
  return {
    now: () => NOW,
    resolveSelf: async () => ({ githubUserId: 9, devicePubkey: selfPubkey }),
    fetchPresenceRows: async () => ROSTER,
  };
}

describe('two-instance authority serialization over loopback', () => {
  let server: Server;
  let port: number;
  const authorityStore = new FakeLockStore();

  beforeAll(async () => {
    // The AUTHORITY peer: an http server that runs received lock ops against ITS
    // single store. This is the one serialization point.
    registerAuthorityOp('lock.acquire', async (payload) => {
      const p = payload as { owner: string; path: string };
      return authorityStore.acquire(p.owner, p.path);
    });
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const env = JSON.parse(raw) as AuthorityRpcEnvelope;
        const result = await handleAuthorityRpc(env);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    // Every client's transport resolves the authority peer → this server.
    setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
  });

  afterAll(() => {
    server.close();
    __resetPeerRpcTransportForTests();
    __resetAuthorityOpsForTests();
  });

  afterEach(() => {
    authorityStore.held.clear();
    __resetRemotePeersCacheForTests();
  });

  /** A client peer acquires `path` for `owner` by routing to the authority. */
  async function clientAcquire(selfPubkey: string, owner: string, path: string) {
    return routeToAuthority<LockResult>(
      'papercup',
      {
        // local fallback should NOT be what wins here — the authority is remote +
        // reachable, so the RPC result is authoritative.
        local: async (): Promise<LockResult> => ({ granted: false }),
        remote: {
          kind: 'lock.acquire',
          payload: { owner, path },
          decode: (raw): LockResult => raw as LockResult,
        },
      },
      clientDeps(selfPubkey),
    );
  }

  it('two client peers contend for one path → the authority grants exactly one', async () => {
    const a = await clientAcquire('cli-mmm', 'client-1', 'apps/x.ts');
    const c = await clientAcquire('cli-zzz', 'client-2', 'apps/x.ts');

    // Both went through the remote authority (not the local fallback).
    expect(a.via).toBe('remote-authority');
    expect(c.via).toBe('remote-authority');
    // Exactly one holds it — the authority's single store serialized them.
    expect(a.value).toEqual({ granted: true, owner: 'client-1' });
    expect(c.value).toEqual({ granted: false, heldBy: 'client-1' });
    expect(authorityStore.held.get('apps/x.ts')).toBe('client-1');
  });

  it('different paths from different peers both grant (no false contention)', async () => {
    const a = await clientAcquire('cli-mmm', 'client-1', 'apps/a.ts');
    const c = await clientAcquire('cli-zzz', 'client-2', 'apps/b.ts');
    expect((a.value as { granted: boolean }).granted).toBe(true);
    expect((c.value as { granted: boolean }).granted).toBe(true);
  });

  it('the authority itself (self === argmin) runs locally, no RPC', async () => {
    // When THIS peer is the authority (self = 'auth-aaa'), routeToAuthority runs
    // the local op — no self-RPC. Prove via a local op that records into a
    // separate store.
    const localStore = new FakeLockStore();
    const r = await routeToAuthority(
      'papercup',
      {
        local: async () => localStore.acquire('authority-box', 'apps/self.ts'),
        remote: { kind: 'lock.acquire', payload: { owner: 'authority-box', path: 'apps/self.ts' }, decode: (x): LockResult => x as LockResult },
      },
      clientDeps('auth-aaa'),
    );
    expect(r.via).toBe('local-authority');
    expect(localStore.held.get('apps/self.ts')).toBe('authority-box');
    // The remote authority store was NOT touched (no self-RPC).
    expect(authorityStore.held.has('apps/self.ts')).toBe(false);
  });

  it('failover: when the authority peer ages out, the next-lowest peer becomes authority', async () => {
    // 'auth-aaa' goes stale (>window); roster now [cli-mmm, cli-zzz] → authority
    // = 'cli-mmm'. From cli-zzz's view, the authority is cli-mmm (still remote);
    // from cli-mmm's own view, it is now self (local).
    const staleRoster = [
      { ...ROSTER[0], last_seen_ms: NOW - 200_000 }, // auth-aaa stale
      ROSTER[1],
      ROSTER[2],
    ];
    const depsFrom = (self: string): LockAuthorityDeps => ({
      now: () => NOW,
      staleMs: 90_000,
      resolveSelf: async () => ({ githubUserId: 9, devicePubkey: self }),
      fetchPresenceRows: async () => staleRoster,
    });
    const localStore = new FakeLockStore();
    // cli-mmm is now the authority → its op runs locally.
    const onMmm = await routeToAuthority(
      'papercup',
      { local: async () => localStore.acquire('client-1', 'apps/f.ts'), remote: { kind: 'lock.acquire', payload: {}, decode: (x) => x } },
      depsFrom('cli-mmm'),
    );
    expect(onMmm.via).toBe('local-authority');
    expect(localStore.held.get('apps/f.ts')).toBe('client-1');
  });
});

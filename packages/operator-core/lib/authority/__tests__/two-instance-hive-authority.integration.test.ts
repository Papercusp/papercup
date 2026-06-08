/**
 * Two-instance HIVE authority serialization test (shared-hive-federation-2026-06-08
 * P-009/P-011 Track B — the Hive-scoped analog of `two-instance-authority.integration.test.ts`).
 *
 * Two client "Swarms" of ONE shared Hive route a contended file-lock to the single
 * Hive authority — `argmin(device_pubkey)` over the Hive's live Swarms
 * (`shared_presence WHERE hive_slug = ?`, su-30045's P-009 `lockAuthorityForHive`)
 * — over the real `HttpPeerRpcTransport`, and the authority's single store
 * serializes them. This is the end-to-end proof of Track B's purpose AT HIVE SCOPE:
 * cross-Swarm mutual exclusion via ONE authority for the whole Hive, not per-harness
 * (D-011 — a Hive has one file-claim authority across all its harnesses' Swarms).
 *
 * ## What this PROVES
 * The Hive-scoped routing + serialization: `routeToAuthorityForHive` elects the
 * lowest live device_pubkey over the Hive roster, routes the remote op to it, and
 * the authority's store grants exactly one holder per path. Mirrors the harness
 * proof (`routeToAuthority`) but exercises `lockAuthorityForHive` + the
 * `fetchHivePresenceRows` seam.
 *
 * ## What this INTENTIONALLY does NOT prove (the layer above)
 * Presence is INJECTED (`fetchHivePresenceRows` returns a fixed Hive roster) — this
 * is the authority/routing/serialization layer in isolation, exactly like the
 * harness version injects `fetchPresenceRows`. The LIVE cross-machine proof — where
 * a remote Swarm's `shared_presence.hive_slug` row is populated by the
 * presence-announce PUBLISHER over the real peer-log (P-008, su-02ae39's
 * designed-not-built keystone) — is the separate P-011 cross-machine E2E and is
 * gated on that publisher. So: this test going green means "the Hive authority logic
 * serializes correctly when the roster says there are N Swarms"; it does NOT by
 * itself mean live cross-machine presence federation works. Don't over-read it.
 *
 * No VMs, no PG: two in-process client peers + one authority http server, each with
 * its own store, talking over loopback — same shape as the harness test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { routeToAuthorityForHive, type LockAuthorityDeps } from '../lock-authority';
import { routeFileLockOp } from '../file-lock-routing';
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

/** A minimal lock store standing in for a per-Swarm su-lock-store: one owner per
 *  path; same-owner re-acquire is idempotent. */
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

// The shared Hive's SWARM roster (what each Swarm's lockAuthorityForHive sees via
// `shared_presence WHERE hive_slug = 'my-hive'`). Each row is one Swarm (machine/
// deployment) of the Hive. The authority = argmin(device_pubkey) = 'auth-aaa' (the
// http-server peer = the "authority Swarm"). Contrast the harness test: there the
// roster is one harness's peers; here it spans the Hive's Swarms, across harnesses.
const HIVE_ROSTER = [
  { device_pubkey: 'auth-aaa', github_user_id: 1, machine_label: 'authority-swarm', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'swarm-mmm', github_user_id: 2, machine_label: 'laptop-swarm', last_seen_ms: NOW - 1000 },
  { device_pubkey: 'swarm-zzz', github_user_id: 3, machine_label: 'cloud-swarm', last_seen_ms: NOW - 1000 },
];

/** Deps for a Swarm whose self-identity is `selfPubkey`, seeing the Hive roster. */
function hiveDeps(selfPubkey: string): LockAuthorityDeps {
  return {
    now: () => NOW,
    resolveSelf: async () => ({ githubUserId: 9, devicePubkey: selfPubkey }),
    // The HIVE-scoped seam (vs the harness test's fetchPresenceRows) — proves the
    // routing consumes lockAuthorityForHive, not lockAuthorityFor.
    fetchHivePresenceRows: async () => HIVE_ROSTER,
  };
}

describe('two-instance HIVE authority serialization over loopback', () => {
  let server: Server;
  let port: number;
  const authorityStore = new FakeLockStore();

  beforeAll(async () => {
    // The AUTHORITY Swarm: an http server that runs received lock ops against ITS
    // single store. This is the one serialization point for the whole Hive.
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
    // Every Swarm's transport resolves the authority peer → this server.
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

  /** A client Swarm acquires `path` for `owner` by routing to the Hive authority. */
  async function swarmAcquire(selfPubkey: string, owner: string, path: string) {
    return routeToAuthorityForHive<LockResult>(
      'my-hive',
      {
        // local fallback should NOT win — the authority is remote + reachable, so
        // the RPC result is authoritative.
        local: async (): Promise<LockResult> => ({ granted: false }),
        remote: {
          kind: 'lock.acquire',
          payload: { owner, path },
          decode: (rawResult): LockResult => rawResult as LockResult,
        },
      },
      hiveDeps(selfPubkey),
    );
  }

  it('two Swarms of one Hive contend for one path → the Hive authority grants exactly one', async () => {
    const a = await swarmAcquire('swarm-mmm', 'laptop', 'apps/x.ts');
    const c = await swarmAcquire('swarm-zzz', 'cloud', 'apps/x.ts');

    // Both routed through the remote Hive authority (not the local fallback).
    expect(a.via).toBe('remote-authority');
    expect(c.via).toBe('remote-authority');
    // Exactly one holds it — the Hive authority's single store serialized them
    // across two DIFFERENT Swarms of the same Hive.
    expect(a.value).toEqual({ granted: true, owner: 'laptop' });
    expect(c.value).toEqual({ granted: false, heldBy: 'laptop' });
    expect(authorityStore.held.get('apps/x.ts')).toBe('laptop');
  });

  it('different paths from different Swarms both grant (no false contention)', async () => {
    const a = await swarmAcquire('swarm-mmm', 'laptop', 'apps/a.ts');
    const c = await swarmAcquire('swarm-zzz', 'cloud', 'apps/b.ts');
    expect((a.value as { granted: boolean }).granted).toBe(true);
    expect((c.value as { granted: boolean }).granted).toBe(true);
  });

  it('the authority Swarm itself (self === argmin) runs locally, no RPC', async () => {
    // When THIS Swarm is the Hive authority (self = 'auth-aaa'),
    // routeToAuthorityForHive runs the local op — no self-RPC. Prove via a local op
    // recording into a separate store.
    const localStore = new FakeLockStore();
    const r = await routeToAuthorityForHive(
      'my-hive',
      {
        local: async () => localStore.acquire('authority-swarm', 'apps/self.ts'),
        remote: { kind: 'lock.acquire', payload: { owner: 'authority-swarm', path: 'apps/self.ts' }, decode: (x): LockResult => x as LockResult },
      },
      hiveDeps('auth-aaa'),
    );
    expect(r.via).toBe('local-authority');
    expect(localStore.held.get('apps/self.ts')).toBe('authority-swarm');
    // The remote authority store was NOT touched (no self-RPC).
    expect(authorityStore.held.has('apps/self.ts')).toBe(false);
  });

  it('failover: when the authority Swarm ages out, the next-lowest Swarm becomes the Hive authority', async () => {
    // 'auth-aaa' goes stale (>window); roster now effectively [swarm-mmm, swarm-zzz]
    // → Hive authority = 'swarm-mmm'. From swarm-mmm's own view it is now self (local).
    const staleRoster = [
      { ...HIVE_ROSTER[0], last_seen_ms: NOW - 200_000 }, // auth-aaa stale
      HIVE_ROSTER[1],
      HIVE_ROSTER[2],
    ];
    const depsFrom = (self: string): LockAuthorityDeps => ({
      now: () => NOW,
      staleMs: 90_000,
      resolveSelf: async () => ({ githubUserId: 9, devicePubkey: self }),
      fetchHivePresenceRows: async () => staleRoster,
    });
    const localStore = new FakeLockStore();
    // swarm-mmm is now the Hive authority → its op runs locally.
    const onMmm = await routeToAuthorityForHive(
      'my-hive',
      { local: async () => localStore.acquire('laptop', 'apps/f.ts'), remote: { kind: 'lock.acquire', payload: {}, decode: (x) => x } },
      depsFrom('swarm-mmm'),
    );
    expect(onMmm.via).toBe('local-authority');
    expect(localStore.held.get('apps/f.ts')).toBe('laptop');
  });

  it('a single-Swarm Hive (only self live) is its own authority — no remote, runs local', async () => {
    // A Hive with one live Swarm (just self) → lockAuthorityForHive returns
    // isSelf:true, so the op runs locally with no RPC. The cross-machine teeth only
    // grow once the presence publisher (P-008) populates remote Swarms' hive_slug
    // rows — until then a lone Swarm proceeds local-advisory, by design.
    const localStore = new FakeLockStore();
    const soloDeps: LockAuthorityDeps = {
      now: () => NOW,
      resolveSelf: async () => ({ githubUserId: 9, devicePubkey: 'swarm-solo' }),
      fetchHivePresenceRows: async () => [
        { device_pubkey: 'swarm-solo', github_user_id: 9, machine_label: 'solo', last_seen_ms: NOW - 500 },
      ],
    };
    const r = await routeToAuthorityForHive(
      'my-hive',
      { local: async () => localStore.acquire('solo', 'apps/only.ts'), remote: { kind: 'lock.acquire', payload: {}, decode: (x): LockResult => x as LockResult } },
      soloDeps,
    );
    expect(r.via).toBe('local-authority');
    expect(localStore.held.get('apps/only.ts')).toBe('solo');
  });

  // ── The PRODUCTION file-claim entry point (su-30045's routeFileLockOp, P-009) ──
  // The cases above drive routeToAuthorityForHive directly; these prove the SAME
  // cross-Swarm serialization through routeFileLockOp — the wrapper the live
  // locks:acquire hot-path cutover will call — so a Hive MEMBER harness's file
  // claims (domain → harness → home Hive) serialize at the Hive authority. Reuses
  // the outer describe's loopback authority server (a nested describe inherits its
  // beforeAll/afterEach hooks).
  describe('via routeFileLockOp — the production file-claim entry point', () => {
    const HIVE_DOMAIN = '/repos/member-checkout'; // a repo root = coordination_domain

    /** Acquire `path` via the production wrapper: domain → 'member-harness' → home
     *  Hive 'my-hive' → the Hive authority. skipRemotePeersFastPath forces authority
     *  routing (the no-remote-peers short-circuit is unit-tested by su-30045's
     *  file-lock-routing-hive.test.ts; here we prove serialization once routed). */
    async function fileLockAcquire(selfPubkey: string, owner: string, path: string) {
      return routeFileLockOp<LockResult>(
        HIVE_DOMAIN,
        {
          local: async (): Promise<LockResult> => ({ granted: false }),
          remote: { kind: 'lock.acquire', payload: { owner, path }, decode: (raw): LockResult => raw as LockResult },
        },
        {
          now: () => NOW,
          resolveSelf: async () => ({ githubUserId: 9, devicePubkey: selfPubkey }),
          domainToHarnessSlug: () => 'member-harness',
          harnessToHiveSlug: () => 'my-hive',
          fetchHivePresenceRows: async () => HIVE_ROSTER,
          skipRemotePeersFastPath: true,
        },
      );
    }

    it('two Swarms of one Hive contend for one file → the Hive authority grants exactly one', async () => {
      const a = await fileLockAcquire('swarm-mmm', 'laptop', 'apps/x.ts');
      const c = await fileLockAcquire('swarm-zzz', 'cloud', 'apps/x.ts');
      // Both routed through the remote Hive authority via the production wrapper.
      expect(a.via).toBe('remote-authority');
      expect(c.via).toBe('remote-authority');
      // The Hive authority serialized two DIFFERENT Swarms' file claims (D-009: a
      // Hive member's file locks serialize at the HIVE authority, not the harness).
      expect(a.value).toEqual({ granted: true, owner: 'laptop' });
      expect(c.value).toEqual({ granted: false, heldBy: 'laptop' });
      expect(authorityStore.held.get('apps/x.ts')).toBe('laptop');
    });

    it('different files from different Swarms both grant (no false contention)', async () => {
      const a = await fileLockAcquire('swarm-mmm', 'laptop', 'apps/a.ts');
      const c = await fileLockAcquire('swarm-zzz', 'cloud', 'apps/b.ts');
      expect((a.value as { granted: boolean }).granted).toBe(true);
      expect((c.value as { granted: boolean }).granted).toBe(true);
    });
  });
});

/**
 * file-lock authority E2E — the REAL file-lock leg over the REAL HTTP transport
 * (P-006 of coord-system-e2e-testing-2026-06-10; closes the D-002 gap).
 *
 * The pre-existing two-instance test proves the generic transport chain with a
 * FAKE lock store and hand-registered op kinds. This test drives the exact
 * production chain end to end:
 *
 *   requester: routeFileLockOp (the cutover seam locks:acquire/release call)
 *     → boot-wired HttpPeerRpcTransport (transport-wiring, addressing via
 *       configurePeerAddressResolver — the production seam, not a test-only
 *       setPeerRpcTransport)
 *     → real loopback HTTP server mirroring /api/authority/rpc
 *       (handleAuthorityRpc + verifyIsAuthority, exactly as rpc.ts wraps it)
 *     → the boot-registered FILE_LOCK_OP_KINDS handlers
 *       (registerFileLockAuthorityOps over adaptSuLockStore — the REAL
 *       PG-backed su-lock store, inWorkspaceTxn + tryAcquire/tryRelease)
 *
 * One box, one PG, two logical peers: the wire crossing, the dispatch, the
 * authority-side store execution, and the fail-open degradations are all real;
 * only the network distance is collapsed (the two-box variant is plan P-010,
 * owner-gated). Asserts: remote grant, cross-wire mutual exclusion, cross-wire
 * release, not_authority refusal → fail-open, unreachable → fail-open, and
 * unmanaged-domain → pure local (no wire traffic).
 *
 * .skipIf(!live) when PG is unreachable, like the sibling su-locks suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { routeFileLockOp, type FileLockRoutingDeps } from '../file-lock-routing';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../authority-op-registry';
import {
  registerFileLockAuthorityOps,
  FILE_LOCK_OP_KINDS,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
  type FileLockReleaseParams,
} from '../file-lock-authority-ops';
import { __resetPeerRpcTransportForTests } from '../peer-rpc-transport';
import {
  wireAuthorityRpcTransport,
  configurePeerAddressResolver,
  _testing as transportTesting,
} from '../transport-wiring';
import { adaptSuLockStore } from '../../agent-tools/locks/file-lock-authority-wiring';
import { ensureBootstrap, getTxPool, readQueue, tryRelease } from '../../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';

const NOW = 1_700_000_000_000;
const HARNESS = 'e2e-file-lock-harness';
const DOMAIN = `e2e-file-lock-authority-${Date.now()}`;
const PATH_A = 'libs/contended.ts';
const OWNER_A = 'peer-A-agent';
const OWNER_B = 'peer-B-agent';

// The roster makes the loopback server's peer ('aaa-…') the argmin authority and
// the requester ('zzz-…') a non-authority — every routed op MUST cross the wire.
const AUTHORITY_PUBKEY = 'aaa-authority-box';
const REQUESTER_PUBKEY = 'zzz-requester-box';

async function dbLive(): Promise<boolean> {
  try {
    const sql = getTxPool();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('file-lock authority leg over the real HTTP transport', async () => {
  const live = await dbLive();

  let server: Server;
  let port = 0;
  const received: AuthorityRpcEnvelope[] = [];
  // Flipped by the failover-gap test: the server refuses ops as not_authority.
  let isAuthority = true;

  function requesterDeps(over: Partial<FileLockRoutingDeps> = {}): FileLockRoutingDeps {
    return {
      domainToHarnessSlug: (d) => (d === DOMAIN ? HARNESS : null),
      harnessToPotSlug: () => null,
      skipRemotePeersFastPath: true,
      now: () => NOW,
      resolveSelf: async () => ({ githubUserId: 2, devicePubkey: REQUESTER_PUBKEY }),
      fetchPresenceRows: async () => [
        { device_pubkey: AUTHORITY_PUBKEY, github_user_id: 1, machine_label: 'authority-box', last_seen_ms: NOW - 1000 },
        { device_pubkey: REQUESTER_PUBKEY, github_user_id: 2, machine_label: 'requester-box', last_seen_ms: NOW - 1000 },
      ],
      // HRW_RENDEZVOUS_AUTHORITY defaults ON since its 2026-07-17 graduation; this
      // fixture's premise is argmin electing AUTHORITY_PUBKEY — pin the rollback path.
      useHrwRendezvous: false,
      ...over,
    };
  }

  /** Route an acquire exactly the way locks:acquire does (same op kind + payload shape). */
  function routedAcquire(owner: string, paths: string[], deps?: Partial<FileLockRoutingDeps>) {
    const local = vi.fn(async () => ({ ok: false as const, busy: [{ path: 'LOCAL-FALLBACK', owner: 'n/a' }] }));
    return {
      local,
      run: routeFileLockOp<FileLockAcquireResult>(
        DOMAIN,
        {
          local: local as unknown as () => Promise<FileLockAcquireResult>,
          remote: {
            kind: FILE_LOCK_OP_KINDS.acquire,
            payload: {
              owner,
              ownerLabel: `e2e:${owner}`,
              paths,
              intent: 'file-lock authority E2E',
              ttlSec: 120,
              coordinationDomain: DOMAIN,
            } satisfies FileLockAcquireParams,
            decode: (raw) => raw as FileLockAcquireResult,
          },
        },
        requesterDeps(deps),
      ),
    };
  }

  beforeAll(async () => {
    if (!live) return;
    await ensureBootstrap();

    // Deterministic registry state: the boot side-effect (file-lock-authority-wiring
    // import) already registered these; reset + re-register the SAME production
    // handlers so this file is order-independent.
    __resetAuthorityOpsForTests();
    registerFileLockAuthorityOps(adaptSuLockStore());

    // The authority "instance": a loopback server wrapping handleAuthorityRpc the
    // same way endpoint-route/routes/authority/rpc.ts does.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const env = JSON.parse(body) as AuthorityRpcEnvelope;
          received.push(env);
          const result = await handleAuthorityRpc(env, {
            verifyIsAuthority: async (slug) => isAuthority && slug === HARNESS,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'handler_error', message: String(e) }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    // The PRODUCTION transport seam: boot wiring + a configured address resolver
    // (what a mesh/topology layer registers), NOT a test-only transport.
    transportTesting.reset();
    __resetPeerRpcTransportForTests();
    wireAuthorityRpcTransport();
    configurePeerAddressResolver((peer) =>
      peer.devicePubkey === AUTHORITY_PUBKEY ? `http://127.0.0.1:${port}` : null,
    );
  });

  afterAll(async () => {
    if (live) {
      // Best-effort store cleanup for both logical peers.
      for (const owner of [OWNER_A, OWNER_B]) {
        try {
          await inWorkspaceTxn(DOMAIN, owner, (tx) =>
            tryRelease(tx, { coordinationDomain: DOMAIN, owner, allMine: true }),
          );
        } catch {
          /* TTL expiry is the backstop */
        }
      }
    }
    transportTesting.reset();
    __resetPeerRpcTransportForTests();
    __resetAuthorityOpsForTests();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!live)('grants a remote acquire over the wire into the authority store', async () => {
    const wireBefore = received.length;
    const { run, local } = routedAcquire(OWNER_A, [PATH_A]);
    const res = await run;

    expect(res.via).toBe('remote-authority');
    expect(local).not.toHaveBeenCalled();
    expect(res.value.ok).toBe(true);
    expect(res.value.lockId).toBeTruthy();
    expect(res.value.expiresTs).toBeTruthy();
    expect(received.length).toBe(wireBefore + 1);
    expect(received[received.length - 1].kind).toBe(FILE_LOCK_OP_KINDS.acquire);

    // The grant is real: the AUTHORITY's store now holds the path for peer A.
    const q = await readQueue(getTxPool(), { coordinationDomain: DOMAIN });
    const held = q.active_locks.find((l: { path: string }) => l.path === PATH_A);
    expect(held).toBeTruthy();
    expect((held as { owner: string }).owner).toBe(OWNER_A);
  });

  it.skipIf(!live)('serializes a contending acquire from the second peer (mutual exclusion across the wire)', async () => {
    const { run, local } = routedAcquire(OWNER_B, [PATH_A]);
    const res = await run;

    expect(res.via).toBe('remote-authority');
    expect(local).not.toHaveBeenCalled();
    expect(res.value.ok).toBe(false);
    expect(res.value.busy).toEqual([{ path: PATH_A, owner: OWNER_A }]);
  });

  it.skipIf(!live)('releases over the wire and the contender then wins', async () => {
    const rel = await routeFileLockOp<{ ok: boolean; released?: string[] }>(
      DOMAIN,
      {
        local: async () => ({ ok: false }),
        remote: {
          kind: FILE_LOCK_OP_KINDS.release,
          payload: {
            owner: OWNER_A,
            allMine: true,
            coordinationDomain: DOMAIN,
          } satisfies FileLockReleaseParams,
          decode: (raw) => raw as { ok: boolean; released?: string[] },
        },
      },
      requesterDeps(),
    );
    expect(rel.via).toBe('remote-authority');
    expect(rel.value.ok).toBe(true);
    expect(rel.value.released).toContain(PATH_A);

    const { run } = routedAcquire(OWNER_B, [PATH_A]);
    const res = await run;
    expect(res.via).toBe('remote-authority');
    expect(res.value.ok).toBe(true);
  });

  it.skipIf(!live)('fails OPEN when the authority refuses during a failover gap (not_authority)', async () => {
    isAuthority = false;
    try {
      const { run, local } = routedAcquire(OWNER_B, ['libs/other.ts']);
      const res = await run;
      expect(res.via).toBe('fail-open');
      expect(res.warning).toContain('unreachable');
      expect(local).toHaveBeenCalledTimes(1);
    } finally {
      isAuthority = true;
    }
  });

  it.skipIf(!live)('fails OPEN when the authority is unreachable', async () => {
    configurePeerAddressResolver(() => 'http://127.0.0.1:1'); // nothing listens on port 1
    try {
      const { run, local } = routedAcquire(OWNER_B, ['libs/other.ts']);
      const res = await run;
      expect(res.via).toBe('fail-open');
      expect(res.warning).toContain('unreachable');
      expect(local).toHaveBeenCalledTimes(1);
    } finally {
      configurePeerAddressResolver((peer) =>
        peer.devicePubkey === AUTHORITY_PUBKEY ? `http://127.0.0.1:${port}` : null,
      );
    }
  });

  it.skipIf(!live)('an unmanaged domain runs locally and never touches the wire', async () => {
    const wireBefore = received.length;
    const local = vi.fn(async () => ({ ok: true as const }));
    const res = await routeFileLockOp(
      'some-unmanaged-checkout',
      { local },
      requesterDeps(),
    );
    expect(res.via).toBe('local-authority');
    expect(local).toHaveBeenCalledTimes(1);
    expect(received.length).toBe(wireBefore);
  });
});

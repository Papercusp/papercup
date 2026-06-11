/**
 * Integration test for the lock-authority REMOTE leg over a real loopback HTTP
 * server (Phase 2 of distributed-coordination-shared-harness-2026-06-04). Proves
 * the full chain: routeToAuthority resolves a REMOTE authority →
 * HttpPeerRpcTransport POSTs the envelope → a real http server wrapping
 * handleAuthorityRpc dispatches to the registered op handler → the result returns
 * to the caller (via 'remote-authority'). Also proves fail-open when the
 * authority server is unreachable.
 *
 * No PG — pure loopback HTTP. (Lives under the integration config because it does
 * real network I/O.)
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
import { buildAuthorityCallerVerifier } from '../verify-authority-caller';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import { signAuthorityRpcWithPrivateKeyDer } from '../authority-rpc-envelope';

// Force routeToAuthority to see a REMOTE authority: self ('mmm') is NOT the min;
// the live peer 'aaa' is → authority = the 'aaa' peer (machineLabel 'authority-box').
const NOW = 1_700_000_000_000;
const remoteDeps: LockAuthorityDeps = {
  now: () => NOW,
  resolveSelf: async () => ({ githubUserId: 2, devicePubkey: 'mmm' }),
  fetchPresenceRows: async () => [
    { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'authority-box', last_seen_ms: NOW - 1000 },
    { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'self', last_seen_ms: NOW - 1000 },
  ],
};

describe('lock-authority remote leg over loopback HTTP', () => {
  let server: Server;
  let port: number;
  const received: AuthorityRpcEnvelope[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const env = JSON.parse(body) as AuthorityRpcEnvelope;
          received.push(env);
          const result = await handleAuthorityRpc(env);
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
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    __resetPeerRpcTransportForTests();
    __resetAuthorityOpsForTests();
    received.length = 0;
  });

  it('routes a control op to the remote authority and returns its result (via remote-authority)', async () => {
    registerAuthorityOp('lock.acquire', async (payload, harness) => ({ granted: true, harness, echoed: payload }));
    setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));

    const res = await routeToAuthority(
      'papercup',
      {
        local: async () => ({ granted: false }),
        remote: { kind: 'lock.acquire', payload: { path: 'apps/x.ts' }, decode: (raw) => raw as { granted: boolean; harness: string } },
      },
      remoteDeps,
    );

    expect(res.via).toBe('remote-authority');
    expect(res.value).toEqual({ granted: true, harness: 'papercup', echoed: { path: 'apps/x.ts' } });
    // The authority actually received the envelope.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ harnessSlug: 'papercup', kind: 'lock.acquire', payload: { path: 'apps/x.ts' } });
  });

  it('fails open to local when the authority server is unreachable (D-004)', async () => {
    // Point at a dead port → connection refused → PeerUnreachable → fail open.
    setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:1`, timeoutMs: 500 }));
    const res = await routeToAuthority(
      'papercup',
      {
        local: async () => 'local-grant',
        remote: { kind: 'lock.acquire', payload: {}, decode: (raw) => raw as string },
      },
      remoteDeps,
    );
    expect(res.via).toBe('fail-open');
    expect(res.value).toBe('local-grant');
    expect(res.warning).toMatch(/git-merged/);
  });

  it('a handler_error on a reachable authority surfaces (NOT fail-open)', async () => {
    registerAuthorityOp('lock.acquire', async () => {
      throw new Error('lock store unavailable');
    });
    setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
    await expect(
      routeToAuthority(
        'papercup',
        { local: async () => 'L', remote: { kind: 'lock.acquire', payload: {}, decode: (raw) => raw as string } },
        remoteDeps,
      ),
    ).rejects.toThrow(/lock store unavailable/);
  });
});

/**
 * EI-322 end-to-end: the SIGNING transport reaches a VERIFYING authority over the
 * same real loopback HTTP. A signed op from a known device is granted; a forged
 * holderPubkey, an unsigned caller, and a tampered-in-flight body are refused as
 * `unauthenticated`.
 */
describe('authenticated authority RPC over loopback (EI-322)', () => {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  const signer = {
    devicePubkey: pubkeyBase64,
    sign: async (bytes: Buffer) => signAuthorityRpcWithPrivateKeyDer(privateKeyDer, bytes),
  };
  let server: Server;
  let port: number;
  let lastResult: unknown;
  // Mutates the parsed body before handleAuthorityRpc — simulates a MITM tamper.
  let mutateInFlight: ((env: AuthorityRpcEnvelope) => void) | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const env = JSON.parse(body) as AuthorityRpcEnvelope;
        if (mutateInFlight) mutateInFlight(env);
        lastResult = await handleAuthorityRpc(env, {
          verifyCaller: buildAuthorityCallerVerifier({ isRevoked: async () => false }),
          verifyIsAuthority: async () => true,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(lastResult));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());
  afterEach(() => {
    __resetPeerRpcTransportForTests();
    __resetAuthorityOpsForTests();
    mutateInFlight = null;
  });

  it('grants a validly-signed op whose holderPubkey is the signing device', async () => {
    registerAuthorityOp('work-item.claim.acquire', async (payload) => ({ granted: true, payload }));
    setPeerRpcTransport(
      new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}`, envelopeSigner: signer }),
    );
    const res = await routeToAuthority(
      'papercup',
      {
        local: async () => ({ granted: false }),
        remote: {
          kind: 'work-item.claim.acquire',
          payload: { workspaceId: 'ws', workItemId: 'WI-1', holderPubkey: pubkeyBase64 },
          decode: (raw) => raw as { granted: boolean },
        },
      },
      remoteDeps,
    );
    expect(res.via).toBe('remote-authority');
    expect(res.value).toEqual({ granted: true, payload: { workspaceId: 'ws', workItemId: 'WI-1', holderPubkey: pubkeyBase64 } });
  });

  it('an unsigned caller is refused as unauthenticated (flag-on authority)', async () => {
    registerAuthorityOp('work-item.claim.acquire', async () => ({ granted: true }));
    // No envelopeSigner → unsigned.
    setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
    const err = await routeToAuthority(
      'papercup',
      {
        local: async () => 'L',
        remote: { kind: 'work-item.claim.acquire', payload: { workspaceId: 'ws', holderPubkey: pubkeyBase64 }, decode: (r) => r as unknown },
      },
      remoteDeps,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/unauthenticated|missing/i);
  });

  it('refuses a forged holderPubkey: signed as self but claims another device', async () => {
    registerAuthorityOp('work-item.claim.acquire', async () => ({ granted: true }));
    setPeerRpcTransport(
      new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}`, envelopeSigner: signer }),
    );
    const err = await routeToAuthority(
      'papercup',
      {
        local: async () => 'L',
        remote: {
          kind: 'work-item.claim.acquire',
          payload: { workspaceId: 'ws', workItemId: 'WI-1', holderPubkey: 'a-different-device' },
          decode: (r) => r as unknown,
        },
      },
      remoteDeps,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/unauthenticated|does not match/i);
  });

  it('refuses a body tampered in flight (signature covers the payload)', async () => {
    registerAuthorityOp('work-item.claim.acquire', async () => ({ granted: true }));
    setPeerRpcTransport(
      new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}`, envelopeSigner: signer }),
    );
    // A MITM flips the workItemId after signing → sig no longer matches.
    mutateInFlight = (env) => {
      (env.payload as Record<string, unknown>).workItemId = 'WI-HIJACKED';
    };
    const err = await routeToAuthority(
      'papercup',
      {
        local: async () => 'L',
        remote: {
          kind: 'work-item.claim.acquire',
          payload: { workspaceId: 'ws', workItemId: 'WI-1', holderPubkey: pubkeyBase64 },
          decode: (r) => r as unknown,
        },
      },
      remoteDeps,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/unauthenticated|signature/i);
  });
});

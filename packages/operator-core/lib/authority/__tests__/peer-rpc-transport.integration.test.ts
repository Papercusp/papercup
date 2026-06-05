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

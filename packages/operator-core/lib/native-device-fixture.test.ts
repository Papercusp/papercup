import { createServer, request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { cleanupFixtureTunnel, fixtureIdentity, verifyProtectedIngress } from './native-device-fixture';
import type { CloudflareApi } from './own-tunnel/cloudflare-api';

const privateEnv = {
  PAPERCUSP_WORKSPACE_ID: 'test-runtime-native-123', PAPERCUSP_POT_HOME_SLUG: 'test-runtime-native-123',
  PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ROUTINES: '0',
  HOME: '/tmp/private-native/home', PAPERCUSP_HOME: '/tmp/private-native/home/.papercusp',
  PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:40001',
  PAPERCUSP_EXTERNAL_INGRESS_PORT: '40002',
};

describe('disposable native HTTPS fixture admission', () => {
  it('refuses a real workspace, remote admin or ordinary operator port before provisioning', () => {
    expect(fixtureIdentity(privateEnv).ingressPort).toBe(40002);
    for (const change of [
      { PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' }, { PAPERCUSP_ALLOW_REMOTE_ADMIN: '1' },
      { PAPERCUSP_BACKGROUND_WORKERS: '1' }, { PAPERCUSP_DBOS_ENABLE: '1' },
      { PAPERCUSP_SKIP_PG_DISCOVERY: '0' }, { PAPERCUSP_POT_HOME_SLUG: 'papercusp' },
      { PAPERCUSP_EXTERNAL_INGRESS_PORT: '40001' }, { PAPERCUSP_EXTERNAL_INGRESS_PORT: '3070' },
      { PAPERCUSP_EXTERNAL_INGRESS_PORT: '3170' }, { PAPERCUSP_OPERATOR_URL: 'http://192.168.1.2:40001' },
    ]) expect(() => fixtureIdentity({ ...privateEnv, ...change })).toThrow();
  });

  it('measures real HTTP denial even when the connector rewrites Host to localhost', async () => {
    const seen: Array<{ path: string; host: string | undefined; method: string | undefined }> = [];
    let exposeMint = false;
    const server = createServer((req, res) => {
      seen.push({ path: req.url!, host: req.headers.host, method: req.method });
      res.writeHead(req.url === '/api/device/heartbeat' ? (req.method === 'POST' ? 401 : 405) :
        (exposeMint && req.url?.endsWith('mint-pair-token')) ? 200 : 404);
      res.end('{}');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address() as { port: number };
      const base = 'http://127.0.0.1:' + address.port;
      // Native HTTP retains an explicitly rewritten Host; undici fetch may
      // replace it with the URL host. Both requests still hit the real socket.
      const socketFetch = ((input: string, init?: RequestInit) => new Promise<Response>((done, reject) => {
        const req = request(input, { method: init?.method, headers: init?.headers as Record<string, string> }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => done(new Response(Buffer.concat(chunks), { status: res.statusCode })));
        });
        req.on('error', reject); req.end(typeof init?.body === 'string' ? init.body : undefined);
      })) as typeof fetch;
      await expect(verifyProtectedIngress(base, socketFetch)).resolves.toMatchObject({ '/api/device/heartbeat': 401 });
      expect(seen.slice(0, 3).every(row => row.host === 'localhost')).toBe(true);
      expect(seen[3]).toMatchObject({ path: '/api/device/heartbeat', method: 'POST' });
      exposeMint = true;
      await expect(verifyProtectedIngress(base)).rejects.toThrow('exposed /api/device/desktop/mint-pair-token');
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });

  it('does not mistake a broken listener for a protected one', async () => {
    await expect(verifyProtectedIngress('http://127.0.0.1:1')).rejects.toThrow();
    const bad = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(verifyProtectedIngress('http://127.0.0.1:40002', bad)).rejects.toThrow('HTTP 500');
  });

  it('removes only its exact owned CNAME/tunnel, preserving another record at the hostname', async () => {
    let removed = false;
    const other = { id: 'peer', type: 'TXT', name: 'native.example.org', content: 'keep' };
    const api = {
      listTunnelsByName: vi.fn(async () => removed ? [] : [{ id: 'owned', name: 'native-exact', deleted_at: null }]),
      listDnsRecords: vi.fn(async () => removed ? [other] : [other,
        { id: 'ours', type: 'CNAME', name: 'native.example.org', content: 'owned.cfargotunnel.com' }]),
      deleteDnsRecord: vi.fn(async () => undefined), cleanupConnections: vi.fn(async () => undefined),
      deleteTunnel: vi.fn(async () => { removed = true; }),
    };
    await cleanupFixtureTunnel(api as unknown as CloudflareApi,
      { accountId: 'a', zoneId: 'z', tunnelId: 'owned', tunnelName: 'native-exact', hostname: 'native.example.org' });
    expect(api.deleteDnsRecord.mock.calls).toEqual([['z', 'ours']]);
    expect(api.deleteTunnel.mock.calls).toEqual([['a', 'owned']]);
  });

  it('refuses cleanup when the exact name now resolves to a different tunnel', async () => {
    const remove = vi.fn();
    const api = { listTunnelsByName: async () => [{ id: 'peer', name: 'native-exact' }], deleteTunnel: remove };
    await expect(cleanupFixtureTunnel(api as unknown as CloudflareApi,
      { accountId: 'a', zoneId: 'z', tunnelId: 'owned', tunnelName: 'native-exact', hostname: 'native.example.org' }))
      .rejects.toThrow('Fixture tunnel identity changed');
    expect(remove).not.toHaveBeenCalled();
  });
});

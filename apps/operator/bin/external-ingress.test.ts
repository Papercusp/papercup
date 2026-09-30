/**
 * WI-10004174 — the external-ingress listener (the port a user's own tunnel points at) must
 * (a) answer the MCP OAuth surface for the tunnel's PUBLIC Host, which the DNS-rebinding guard
 *     used to refuse with 403 host_not_allowed, and
 * (b) serve nothing else, which it used to do: the whole app, every `auth:'public'` route
 *     included, was reachable through the tunnel.
 * Both are driven through the real host composition (host-handler.ts), not a stand-in.
 */
import { describe, expect, it } from 'vitest';
import { externalIngressHandler, handler } from './host-handler';
import { EXTERNAL_INGRESS_SERVED_PATHS, isServedOnExternalIngress } from './external-ingress-paths';

const PUBLIC_HOST = 'ws.example.org';

function get(path: string, host: string): Request {
  return new Request(`http://${host}${path}`, {
    headers: { host, 'x-forwarded-proto': 'https' },
  });
}

describe('external-ingress listener (WI-10004174)', () => {
  it('serves the OAuth authorization-server metadata to the tunnel\'s public Host', async () => {
    const res = await externalIngressHandler(get('/api/connected-apps/oauth/authorization-server', PUBLIC_HOST));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token_endpoint?: string };
    expect(body.token_endpoint).toBe(`https://${PUBLIC_HOST}/api/connected-apps/oauth/token`);
  });

  it('serves the root RFC 8414 well-known document through the tunnel', async () => {
    const res = await externalIngressHandler(get('/.well-known/oauth-authorization-server', PUBLIC_HOST));
    expect(res.status).toBe(200);
  });

  it('refuses every other route with 404, even an auth:\'public\' one addressed to localhost', async () => {
    for (const path of ['/api/coord/presence', '/api/health', '/api/connected-apps', '/wiki']) {
      for (const host of [PUBLIC_HOST, 'localhost']) {
        const res = await externalIngressHandler(get(path, host));
        expect(res.status, `${host}${path}`).toBe(404);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, `${host}${path}`).toBe('not_served_on_external_ingress');
      }
    }
  });

  it('leaves the loopback listener refusing a public Host (the rebinding guard still applies there)', async () => {
    const res = await handler(get('/api/connected-apps/oauth/authorization-server', PUBLIC_HOST));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('host_not_allowed');
  });
});

describe('isServedOnExternalIngress', () => {
  it('matches exact served paths, with or without a trailing slash', () => {
    for (const path of EXTERNAL_INGRESS_SERVED_PATHS) {
      expect(isServedOnExternalIngress(path), path).toBe(true);
      expect(isServedOnExternalIngress(`${path}/`), `${path}/`).toBe(true);
    }
    expect(EXTERNAL_INGRESS_SERVED_PATHS.has('/api/mcp')).toBe(true);
    expect(EXTERNAL_INGRESS_SERVED_PATHS.has('/api/connected-apps/oauth/token')).toBe(true);
  });

  it('never matches by prefix', () => {
    for (const path of ['/', '/api', '/api/mcp/extra', '/api/connected-apps/oauth', '/api/connected-apps/oauth/pending', '/.well-known']) {
      expect(isServedOnExternalIngress(path), path).toBe(false);
    }
  });
});

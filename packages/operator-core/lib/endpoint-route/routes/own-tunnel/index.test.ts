/**
 * external-app-access P-009: the own-tunnel routes are loopback-only, refuse cross-site
 * browser writes, validate bodies and map service failures to user-facing errors.
 */
import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiError } from '../../../own-tunnel/cloudflare-api';
import { OwnTunnelInputError } from '../../../own-tunnel/config';
import { createOwnTunnelRoutes, type OwnTunnelRouteDependencies } from './index';

const STATUS = { configured: true, enabled: true, health: 'up' } as never;

function routes(over: Partial<OwnTunnelRouteDependencies> = {}, local = true) {
  const deps: OwnTunnelRouteDependencies = {
    isLocal: () => local,
    status: vi.fn(async () => STATUS),
    install: vi.fn(async () => ({ path: '/x/cloudflared', version: 'cloudflared version 2026.9.0' })),
    beginSignIn: vi.fn(async () => ({ loginUrl: 'https://dash.cloudflare.com/argotunnel?x=1', state: 'waiting' })),
    cancelSignIn: vi.fn(),
    signInStatus: vi.fn(() => ({ state: 'complete' as const, loginUrl: null, error: null, accountId: 'a', zoneId: 'z' })),
    signedInZone: vi.fn(async () => ({ zoneId: 'z', zoneName: 'example.com' })),
    provision: vi.fn(async () => STATUS),
    manual: vi.fn(async () => STATUS),
    setEnabled: vi.fn(async () => STATUS),
    remove: vi.fn(async () => ({ removed: true, cloudflare: 'done' as const, error: null })),
    ...over,
  };
  const list = createOwnTunnelRoutes(deps);
  const find = (method: string, path: string) => {
    const r = list.find((x: any) => x.method === method && x.path === path) as any;
    if (!r) throw new Error(`no route ${method} ${path}`);
    return (init: { body?: unknown; headers?: Record<string, string> } = {}) =>
      r.handler(
        new Request(`http://127.0.0.1:3070/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
          body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
        }),
      ) as Promise<Response>;
  };
  return { deps, list, find };
}

describe('own-tunnel routes', () => {
  it('every route is loopback-authenticated at the route stack', () => {
    const { list } = routes();
    expect(list.length).toBe(9);
    for (const r of list as any[]) expect(r.auth).toBe('loopback');
  });

  it('refuses a non-local caller even if the route stack let it through', async () => {
    const { find, deps } = routes({}, false);
    const res = await find('POST', '/remote-access/own-tunnel/enabled')({ body: { enabled: false } });
    expect(res.status).toBe(403);
    expect(deps.setEnabled).not.toHaveBeenCalled();
  });

  it('refuses a cross-site browser write', async () => {
    const { find, deps } = routes();
    const res = await find('POST', '/remote-access/own-tunnel/remove')({
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('passes provisioning input through and returns the status', async () => {
    const { find, deps } = routes();
    const res = await find('POST', '/remote-access/own-tunnel/cloudflare')({ body: { label: ' papercusp ', apiToken: '' } });
    expect(res.status).toBe(200);
    expect(deps.provision).toHaveBeenCalledWith({ hostname: undefined, label: 'papercusp', apiToken: undefined });
    expect(await res.json()).toMatchObject({ ok: true, tunnel: { health: 'up' } });
  });

  it('maps a user-fixable error to 400 and a Cloudflare refusal to 502', async () => {
    const input = routes({ provision: vi.fn(async () => { throw new OwnTunnelInputError('hostname_taken', 'taken'); }) });
    const r1 = await input.find('POST', '/remote-access/own-tunnel/cloudflare')({ body: { hostname: 'a.example.com' } });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ ok: false, error: { code: 'hostname_taken', message: 'taken' } });
    const cf = routes({ provision: vi.fn(async () => { throw new CloudflareApiError(403, 'Authentication error', null); }) });
    const r2 = await cf.find('POST', '/remote-access/own-tunnel/cloudflare')({ body: { hostname: 'a.example.com' } });
    expect(r2.status).toBe(502);
  });

  it('the kill switch needs a boolean', async () => {
    const { find, deps } = routes();
    expect((await find('POST', '/remote-access/own-tunnel/enabled')({ body: { enabled: 'no' } })).status).toBe(400);
    expect((await find('POST', '/remote-access/own-tunnel/enabled')({ body: { enabled: false } })).status).toBe(200);
    expect(deps.setEnabled).toHaveBeenCalledWith(false);
  });

  it('the sign-in poll includes the chosen zone name once complete', async () => {
    const { find } = routes();
    const res = await find('GET', '/remote-access/own-tunnel/sign-in')();
    expect(await res.json()).toMatchObject({ ok: true, signIn: { state: 'complete', zoneName: 'example.com' } });
  });

  it('remove keeps the row on a Cloudflare failure unless forced', async () => {
    const { find, deps } = routes();
    await find('POST', '/remote-access/own-tunnel/remove')({ body: {} });
    expect(deps.remove).toHaveBeenLastCalledWith({ keepIfCloudflareFails: true });
    await find('POST', '/remote-access/own-tunnel/remove')({ body: { force: true } });
    expect(deps.remove).toHaveBeenLastCalledWith({ keepIfCloudflareFails: false });
  });

  it('manual mode rejects a non-numeric port', async () => {
    const { find, deps } = routes();
    expect((await find('POST', '/remote-access/own-tunnel/manual')({ body: { port: '8080' } })).status).toBe(400);
    await find('POST', '/remote-access/own-tunnel/manual')({ body: { port: 8080, hostname: 'box.ts.net' } });
    expect(deps.manual).toHaveBeenCalledWith({ port: 8080, hostname: 'box.ts.net' });
  });
});

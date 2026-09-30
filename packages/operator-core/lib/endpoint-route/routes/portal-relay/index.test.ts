/**
 * external-app-access P-008: the Papercusp relay routes are loopback-only, refuse cross-site
 * browser writes and requests relayed in from outside, validate bodies, and map relay failures to
 * user-facing errors. The real isLoopbackHost is exercised once so the external-ingress marker
 * refusal is checked end to end, not only through a stub.
 */
import { describe, expect, it, vi } from 'vitest';
import { PortalRelayError } from '../../../remote-access/relay-opt-in';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../../../auth/forwarded-request-trust';
import { isLoopbackHost } from '../device/_shared';
import { createPortalRelayRoutes, type PortalRelayRouteDependencies } from './index';

const STATUS = { state: 'off', available: true } as never;

function routes(over: Partial<PortalRelayRouteDependencies> = {}, isLocal: (req: Request) => boolean = () => true) {
  const deps = {
    isLocal,
    status: vi.fn(async () => STATUS),
    accept: vi.fn(async () => STATUS),
    begin: vi.fn(async () => STATUS),
    cancel: vi.fn(async () => STATUS),
    disconnect: vi.fn(async () => ({ ...(STATUS as object), portalUnlinked: true }) as never),
    reconcileSoon: vi.fn(),
    ...over,
  } satisfies PortalRelayRouteDependencies;
  const list = createPortalRelayRoutes(deps);
  const find = (method: string, path: string) => {
    const r = list.find((x: any) => x.method === method && x.path === path) as any;
    if (!r) throw new Error(`no route ${method} ${path}`);
    return (init: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) =>
      r.handler(
        new Request(`http://127.0.0.1:3070/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
          body: method === 'GET' ? undefined : init.rawBody ?? JSON.stringify(init.body ?? {}),
        }),
      ) as Promise<Response>;
  };
  return { deps, list, find };
}

describe('Papercusp relay routes', () => {
  it('every route is loopback-authenticated at the route stack', () => {
    const { list } = routes();
    expect((list as any[]).map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /remote-access/portal-relay',
      'POST /remote-access/portal-relay/cancel',
      'POST /remote-access/portal-relay/connect',
      'POST /remote-access/portal-relay/consent',
      'POST /remote-access/portal-relay/disconnect',
    ]);
    for (const r of list as any[]) expect(r.auth).toBe('loopback');
  });

  it('refuses a non-local caller even if the route stack let it through', async () => {
    const { find, deps } = routes({}, () => false);
    const res = await find('POST', '/remote-access/portal-relay/connect')({ body: {} });
    expect(res.status).toBe(403);
    expect(deps.begin).not.toHaveBeenCalled();
  });

  it('a call relayed in from outside (external-ingress marker) cannot reach the controls, even on a loopback Host', async () => {
    const { find, deps } = routes({}, isLoopbackHost);
    // A fetch Request carries no Host header of its own; set the loopback Host so the only
    // difference between the two requests is the marker.
    const host = { host: '127.0.0.1:3070' };
    const res = await find('POST', '/remote-access/portal-relay/disconnect')({ headers: { ...host, [EXTERNAL_INGRESS_MARKER_HEADER]: '1' } });
    expect(res.status).toBe(403);
    expect(deps.disconnect).not.toHaveBeenCalled();
    // The same request without the marker is this computer.
    const local = await find('POST', '/remote-access/portal-relay/disconnect')({ headers: host });
    expect(local.status).toBe(200);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses a cross-site browser write', async () => {
    const { find, deps } = routes();
    const res = await find('POST', '/remote-access/portal-relay/consent')({
      body: { noticeVersion: 1 },
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('cross_origin_blocked');
    expect(deps.accept).not.toHaveBeenCalled();
  });

  it('consent needs a numeric notice version', async () => {
    const { find, deps } = routes();
    expect((await find('POST', '/remote-access/portal-relay/consent')({ body: {} })).status).toBe(400);
    expect((await find('POST', '/remote-access/portal-relay/consent')({ rawBody: '{nope' })).status).toBe(400);
    expect(deps.accept).not.toHaveBeenCalled();
    const res = await find('POST', '/remote-access/portal-relay/consent')({ body: { noticeVersion: 1 } });
    expect(res.status).toBe(200);
    expect(deps.accept).toHaveBeenCalledWith({ noticeVersion: 1 });
  });

  it('connect passes the portal address, then nudges the reconciler', async () => {
    const { find, deps } = routes();
    const res = await find('POST', '/remote-access/portal-relay/connect')({ body: { portalOrigin: 'https://portal.example.com' } });
    expect(res.status).toBe(200);
    expect(deps.begin).toHaveBeenCalledWith({ portalOrigin: 'https://portal.example.com' });
    expect(deps.reconcileSoon).toHaveBeenCalledTimes(1);
    await find('POST', '/remote-access/portal-relay/connect')({ body: {} });
    expect(deps.begin).toHaveBeenLastCalledWith({ portalOrigin: undefined });
    expect((await find('POST', '/remote-access/portal-relay/connect')({ body: { portalOrigin: 7 } })).status).toBe(400);
  });

  it.each([
    ['consent_required', 400],
    ['notice_outdated', 400],
    ['invalid_portal_origin', 400],
    ['hosted_machine', 409],
    ['already_linked', 409],
    ['portal_unavailable', 502],
    ['portal_refused', 502],
  ] as const)('maps a %s refusal to %i', async (code, status) => {
    const { find, deps } = routes({ begin: vi.fn(async () => { throw new PortalRelayError(code, `refused: ${code}`); }) });
    const res = await find('POST', '/remote-access/portal-relay/connect')({ body: {} });
    expect(res.status).toBe(status);
    expect(((await res.json()) as any).error).toMatchObject({ code, message: `refused: ${code}` });
    expect(deps.reconcileSoon).not.toHaveBeenCalled();
  });

  it('cancel and disconnect act and nudge the reconciler', async () => {
    const { find, deps } = routes();
    expect((await find('POST', '/remote-access/portal-relay/cancel')()).status).toBe(200);
    const res = await find('POST', '/remote-access/portal-relay/disconnect')();
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).relay.portalUnlinked).toBe(true);
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.reconcileSoon).toHaveBeenCalledTimes(2);
  });
});

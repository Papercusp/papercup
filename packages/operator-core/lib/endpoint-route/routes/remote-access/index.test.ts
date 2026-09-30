/**
 * external-app-access P-010 (D-025): the Remote access screen's routes are loopback-only, refuse
 * cross-site browser writes, route a phone ('mobile') to the device store and every other kind to
 * the app-key store, and push every successful write to open screens.
 */
import { describe, expect, it, vi } from 'vitest';
import { AppKeyScopeError } from '../../../connected-apps/store';
import { createRemoteAccessRoutes, REMOTE_ACCESS_QUERY, type RemoteAccessRouteDependencies } from './index';

const SETTING = (enabled: boolean) => ({ workspaceId: 'ws1', enabled, changedAt: new Date(0), changedBy: 'owner@local' });

function routes(over: Partial<RemoteAccessRouteDependencies> = {}, local = true) {
  const deps: RemoteAccessRouteDependencies = {
    isLocal: () => local,
    workspaceExists: (id) => id === 'ws1',
    getSwitch: vi.fn(async () => SETTING(true)),
    setSwitch: vi.fn(async (_ws: string, enabled: boolean) => SETTING(enabled)),
    pauseKey: vi.fn(async () => true),
    revokeKey: vi.fn(async () => true),
    pauseDevice: vi.fn(async () => true),
    revokeDevice: vi.fn(async () => true),
    resolveScopes: vi.fn((req) => ({ tools: req.tools ?? [], harnesses: req.harnesses })),
    setScopes: vi.fn(async (_ws: string, id: string, scopes) => ({ id, scopes }) as never),
    invalidate: vi.fn(async () => undefined),
    ...over,
  };
  const list = createRemoteAccessRoutes(deps);
  const call = (
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; query?: string } = {},
  ): Promise<Response> => {
    const r = list.find((x: any) => x.method === method && x.path === path) as any;
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r.handler(
      new Request(`http://127.0.0.1:3070/api${path}${init.query ?? ''}`, {
        method,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
      }),
    );
  };
  return { deps, list, call };
}

describe('remote-access routes', () => {
  it('every route is loopback-authenticated at the route stack', () => {
    const { list } = routes();
    expect(list.length).toBe(5);
    for (const r of list as any[]) expect(r.auth).toBe('loopback');
  });

  it('refuses a non-local caller before touching the switch', async () => {
    const { call, deps } = routes({}, false);
    const res = await call('POST', '/remote-access', { body: { workspaceId: 'ws1', enabled: false } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'local_only' } });
    expect(deps.setSwitch).not.toHaveBeenCalled();
  });

  it('refuses a cross-site browser write', async () => {
    const { call, deps } = routes();
    const res = await call('POST', '/remote-access/revoke', {
      body: { workspaceId: 'ws1', id: 'pcapp_x' },
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(deps.revokeKey).not.toHaveBeenCalled();
  });

  it('reads the switch and refuses an unknown workspace', async () => {
    const { call } = routes();
    const ok = await call('GET', '/remote-access', { query: '?workspaceId=ws1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, remoteAccess: { workspaceId: 'ws1', enabled: true } });
    const missing = await call('GET', '/remote-access', { query: '?workspaceId=nope' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'workspace_not_found' } });
  });

  it('turning the switch off stores it and pushes the change to open screens', async () => {
    const { call, deps } = routes();
    const res = await call('POST', '/remote-access', { body: { workspaceId: 'ws1', enabled: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, remoteAccess: { enabled: false } });
    expect(deps.setSwitch).toHaveBeenCalledWith('ws1', false, expect.any(String));
    expect(deps.invalidate).toHaveBeenCalledWith('ws1');
  });

  it('refuses a switch write whose enabled is not a boolean', async () => {
    const { call, deps } = routes();
    const res = await call('POST', '/remote-access', { body: { workspaceId: 'ws1', enabled: 'no' } });
    expect(res.status).toBe(400);
    expect(deps.setSwitch).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });

  it('routes a phone to the device store and a key to the app-key store', async () => {
    const { call, deps } = routes();
    await call('POST', '/remote-access/pause', { body: { workspaceId: 'ws1', id: 'dev1', kind: 'mobile', paused: true } });
    expect(deps.pauseDevice).toHaveBeenCalledWith('ws1', 'dev1', true);
    expect(deps.pauseKey).not.toHaveBeenCalled();
    await call('POST', '/remote-access/pause', { body: { workspaceId: 'ws1', id: 'pcapp_a', kind: 'service', paused: false } });
    expect(deps.pauseKey).toHaveBeenCalledWith('ws1', 'pcapp_a', false);

    await call('POST', '/remote-access/revoke', { body: { workspaceId: 'ws1', id: 'dev1', kind: 'mobile' } });
    expect(deps.revokeDevice).toHaveBeenCalledWith('ws1', 'dev1');
    const res = await call('POST', '/remote-access/revoke', { body: { workspaceId: 'ws1', id: 'pcapp_a', kind: 'app' } });
    expect(deps.revokeKey).toHaveBeenCalledWith('ws1', 'pcapp_a');
    expect(await res.json()).toMatchObject({ ok: true, id: 'pcapp_a', revoked: true });
    expect(deps.invalidate).toHaveBeenCalledTimes(4);
  });

  it('answers 404 and pushes nothing when the entry is not live', async () => {
    const { call, deps } = routes({ revokeKey: vi.fn(async () => false) });
    const res = await call('POST', '/remote-access/revoke', { body: { workspaceId: 'ws1', id: 'pcapp_gone' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(deps.invalidate).not.toHaveBeenCalled();
  });

  it('edits scopes through the scope resolver and reports refused scopes', async () => {
    const good = routes();
    const res = await good.call('POST', '/remote-access/scopes', {
      body: { workspaceId: 'ws1', id: 'pcapp_a', tools: ['plans:get'], harnesses: ['papercusp'] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, scopes: { tools: ['plans:get'], harnesses: ['papercusp'] } });
    expect(good.deps.setScopes).toHaveBeenCalledWith('ws1', 'pcapp_a', { tools: ['plans:get'], harnesses: ['papercusp'] });

    const bad = routes({
      resolveScopes: vi.fn(() => {
        throw new AppKeyScopeError([{ field: 'tools', value: 'nope:x', reason: 'unknown tool' }] as never);
      }),
    });
    const refused = await bad.call('POST', '/remote-access/scopes', { body: { workspaceId: 'ws1', id: 'pcapp_a', tools: ['nope:x'] } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_scope', problems: [{ value: 'nope:x' }] } });
    expect(bad.deps.setScopes).not.toHaveBeenCalled();

    const malformed = await good.call('POST', '/remote-access/scopes', { body: { workspaceId: 'ws1', id: 'pcapp_a', tools: 'plans:get' } });
    expect(malformed.status).toBe(400);
  });

  it('names the sync query the screen reads', () => {
    expect(REMOTE_ACCESS_QUERY).toBe('remoteAccess.overview');
  });
});

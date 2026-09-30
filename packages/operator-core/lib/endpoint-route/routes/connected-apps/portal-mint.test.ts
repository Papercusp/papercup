/**
 * POST /connected-apps/portal-mint — the machine's loopback route behind the portal's MCP OAuth
 * (plan external-app-access-to-workspaces-2026-09-29 P-325, WI-10004189; D-021). Its only caller is
 * the machine end of the `app-key-mint` relay channel (hosted-app-key-mint-channel.test.ts).
 *
 * Pinned: loopback-only at the route stack and in the handler; the portal's approver becomes the
 * key's creator, in THIS machine's workspace; a malformed approver, label or scope is refused
 * before a key exists; a scope the machine's policy refuses comes back as `invalid_scope`; and the
 * route is in the module's default export, so the operator actually mounts it.
 */
import { describe, expect, it } from 'vitest';
import { AppKeyScopeError, type AppKeyRow, type CreateAppKeyOptions, type CreatedAppKey } from '../../../connected-apps/store';
import routes, { createPortalMintRoute } from './oauth';

const LOCAL = 'http://127.0.0.1:3070';
const KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;

function setup(opts: { local?: boolean; refuse?: boolean } = {}) {
  const created: CreateAppKeyOptions[] = [];
  const route = createPortalMintRoute({
    workspaceId: () => 'ws-machine',
    isLocal: () => opts.local ?? true,
    async createKey(input): Promise<CreatedAppKey> {
      if (opts.refuse) throw new AppKeyScopeError([{ field: 'tools', value: 'admin:shutdown', reason: 'hard-denied' }] as never);
      created.push(input);
      return {
        key: KEY,
        app: { scopes: { capabilities: [], ...(input.tools ? { tools: [...input.tools] } : {}) } } as unknown as AppKeyRow,
      };
    },
  });
  const call = (body: unknown) =>
    route.handler(
      new Request(`${LOCAL}/api/connected-apps/portal-mint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { params: {}, principal: null } as never,
    ) as Promise<Response>;
  return { route, created, call };
}

const GOOD = { label: 'Claude', scopes: { tools: ['plans:get'], harnesses: ['papercusp'] }, approvedBy: 'portal:user-1' };

describe('POST /connected-apps/portal-mint (P-325)', () => {
  it('is a loopback route, mounted by the module', () => {
    const { route } = setup();
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/connected-apps/portal-mint');
    expect(route.auth).toBe('loopback');
    expect(routes.some((r) => r.path === '/connected-apps/portal-mint' && r.auth === 'loopback')).toBe(true);
  });

  it("mints in this machine's workspace, with the portal approver as the creator", async () => {
    const { call, created } = setup();
    const response = await call(GOOD);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, key: KEY, scopes: { capabilities: [], tools: ['plans:get'] } });
    expect(created).toEqual([
      { workspaceId: 'ws-machine', userEmail: 'portal:user-1', label: 'Claude', tools: ['plans:get'], harnesses: ['papercusp'] },
    ]);
  });

  it('refuses a non-local caller before reading the body', async () => {
    const { call, created } = setup({ local: false });
    const response = await call(GOOD);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'local_only' } });
    expect(created).toEqual([]);
  });

  it('refuses a malformed request without creating a key', async () => {
    for (const bad of [
      'not json',
      [],
      { ...GOOD, approvedBy: 'local@desktop' },
      { ...GOOD, approvedBy: 'portal:' },
      { ...GOOD, label: '' },
      { ...GOOD, label: '   ' },
      { ...GOOD, label: '\u0007' },
      { ...GOOD, label: 42 },
      { ...GOOD, scopes: { tools: 'plans:get' } },
      { ...GOOD, scopes: null },
    ]) {
      const { call, created } = setup();
      const response = await call(bad);
      expect(response.status).toBe(400);
      expect(created).toEqual([]);
    }
  });

  it("answers invalid_scope when this machine's policy refuses the consented scope", async () => {
    const { call } = setup({ refuse: true });
    const response = await call(GOOD);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_scope' } });
  });
});

/**
 * Pasted provider credentials over HTTP (cupboard-distributable-integrations-2026-10-10 P-001;
 * SPEC-R-2-P-001, SPEC-R-7-P-001). The routes are thin over provider-credentials.ts; what this
 * pins is the HTTP contract: no response ever carries a stored value, a bad value changes
 * nothing, cross-origin writes are refused, and every write invalidates the page's live query.
 *
 * Fixture values are deliberately neutral, low-entropy strings, not vendor-token-shaped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../../define-route';

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    getUser: vi.fn(),
    invalidate: vi.fn(),
    registryGet: vi.fn(),
  };
});

vi.mock('../../../auth', () => ({ getSessionUserOrDefault: mocks.getUser }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: mocks.invalidate }));
vi.mock('../../../integrations/provider-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../integrations/provider-registry')>()),
  readyProviderRegistry: async () => ({ get: mocks.registryGet, list: () => [] }),
}));
vi.mock('../../../oauth/storage-fs', () => ({
  fsTokenStorage: {
    async read(plugin: string, harness: string) {
      return { ...(mocks.store.get(`${harness}/${plugin}`) ?? {}) };
    },
    async update(plugin: string, harness: string, patch: Record<string, unknown>) {
      const key = `${harness}/${plugin}`;
      const next = { ...(mocks.store.get(key) ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      mocks.store.set(key, next);
    },
  },
}));

import routes from './provider-credentials';

const BASE = '/user/integrations/providers/:providerId/credentials';
const STORED_VALUE = 'chat-1-sample';

const descriptor = {
  id: 'fixture-chat',
  displayName: 'Fixture Chat',
  setup: {
    credentials: [
      { key: 'botToken', label: 'Bot token', pattern: 'chat-[0-9]+-[a-z]+', hosts: ['api.fixture-chat.test'] },
      { key: 'appToken', label: 'App token' },
    ],
  },
};

const route = (method: string, path: string): RouteDefinition => {
  const found = (routes as RouteDefinition[]).find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
};

const invoke = (method: string, path: string, req: Request, params: Record<string, string>) =>
  route(method, path).handler(req, { params } as never) as Promise<Response>;

const put = (values: unknown, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1/api/user/integrations/providers/fixture-chat/credentials', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ values }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  mocks.getUser.mockResolvedValue({ id: 'user-1' });
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.registryGet.mockImplementation((id: string) => (id === descriptor.id ? { descriptor } : undefined));
});

describe('provider credential routes', () => {
  it('GET lists each declared field as unconfigured before anything is saved', async () => {
    const res = await invoke('GET', BASE, new Request('http://127.0.0.1/x'), { providerId: 'fixture-chat' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials.map((f: { key: string; configured: boolean }) => [f.key, f.configured])).toEqual([
      ['botToken', false],
      ['appToken', false],
    ]);
  });

  it('PUT stores the value host-side and answers with status only, never the value', async () => {
    const res = await invoke('PUT', BASE, put({ botToken: STORED_VALUE }), { providerId: 'fixture-chat' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(STORED_VALUE);
    const body = JSON.parse(text);
    const bot = body.credentials.find((f: { key: string }) => f.key === 'botToken');
    expect(bot).toMatchObject({ configured: true, hosts: ['api.fixture-chat.test'] });
    expect(typeof bot.savedAt).toBe('string');
    expect(Object.values(mocks.store.get('papercusp/provider-setup:fixture-chat') ?? {})).toContain(STORED_VALUE);

    // A later read still never returns it.
    const read = await (await invoke('GET', BASE, new Request('http://127.0.0.1/x'), { providerId: 'fixture-chat' })).text();
    expect(read).not.toContain(STORED_VALUE);
    expect(mocks.invalidate).toHaveBeenCalledWith('integrations.tickets', { workspaceId: 'ws-test', userId: 'user-1' });
  });

  it('PUT with one bad value stores nothing and names the field, without echoing the value', async () => {
    const res = await invoke('PUT', BASE, put({ appToken: 'good-value', botToken: 'not the right shape' }), { providerId: 'fixture-chat' });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain('not the right shape');
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: 'invalid-value', field: 'botToken' });
    expect(mocks.store.size).toBe(0);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('PUT refuses an undeclared field and a malformed body', async () => {
    const unknown = await invoke('PUT', BASE, put({ webhookKey: 'x' }), { providerId: 'fixture-chat' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'unknown-field', field: 'webhookKey' });

    const malformed = await invoke(
      'PUT',
      BASE,
      new Request('http://127.0.0.1/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '"nope"' }),
      { providerId: 'fixture-chat' },
    );
    expect(malformed.status).toBe(400);
    expect(mocks.store.size).toBe(0);
  });

  it('refuses a provider that is not installed', async () => {
    const res = await invoke('GET', BASE, new Request('http://127.0.0.1/x'), { providerId: 'missing' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown_provider' });
  });

  it('refuses a cross-origin write before touching the store', async () => {
    const res = await invoke('PUT', BASE, put({ botToken: STORED_VALUE }, { origin: 'https://evil.example' }), { providerId: 'fixture-chat' });
    expect(res.status).toBe(403);
    expect(mocks.store.size).toBe(0);
  });

  it('DELETE forgets one value and reports it unconfigured', async () => {
    await invoke('PUT', BASE, put({ botToken: STORED_VALUE, appToken: 'app-value' }), { providerId: 'fixture-chat' });
    mocks.invalidate.mockClear();
    const res = await invoke('DELETE', `${BASE}/:key`, new Request('http://127.0.0.1/x', { method: 'DELETE' }), {
      providerId: 'fixture-chat',
      key: 'botToken',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials.map((f: { key: string; configured: boolean }) => [f.key, f.configured])).toEqual([
      ['botToken', false],
      ['appToken', true],
    ]);
    expect(Object.values(mocks.store.get('papercusp/provider-setup:fixture-chat') ?? {})).not.toContain(STORED_VALUE);
    expect(mocks.invalidate).toHaveBeenCalled();
  });
});

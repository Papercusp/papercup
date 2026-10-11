/**
 * Pasted provider credentials (cupboard-distributable-integrations-2026-10-10 P-001).
 *
 * SPEC-R-7-P-001: a pasted secret is never returned by any read after it is saved. Pinned three
 * ways: the status read has no value-bearing member and carries no trace of the value; the plain
 * plugin-config read routes refuse the store's name; and provider code never sees the value
 * while host.fetch still sends it to the declared host.
 * SPEC-R-2-P-001 (host half): a value that does not match the declared format is refused, and a
 * request with one bad value changes nothing.
 *
 * Fixture values are deliberately not shaped like any real vendor token.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import type { TokenStorage } from '../oauth/token';
import { createHostFetch, HostFetchError } from './host-fetch';
import {
  clearProviderCredential,
  ProviderCredentialError,
  providerCredentialStatus,
  providerSetupStoreKey,
  readProviderCredentialValue,
  saveProviderCredentials,
} from './provider-credentials';
import { createProviderRegistry } from './provider-registry';

const BOT = 'chat-fixture-SECRETBOT';
const APP = 'app-fixture-SECRETAPP';

const descriptor: ProviderDescriptor = {
  id: 'example-chat',
  contractVersion: 1,
  displayName: 'Example chat',
  datatypes: ['chat-message'],
  capabilities: ['chat.send'],
  egressHosts: ['chat.example.com', 'files.example.com'],
  setup: {
    credentials: [
      { key: 'bot_token', label: 'Bot token', pattern: 'chat-[A-Za-z0-9-]+', placeholder: 'chat-…', hosts: ['chat.example.com'] },
      { key: 'app_token', label: 'App-level token', pattern: 'app-[A-Za-z0-9-]+', help: 'Basic Information → App-Level Tokens' },
    ],
  },
};

function memoryStorage(): TokenStorage & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  return {
    data,
    async read(plugin, harness) {
      return { ...(data.get(`${harness}/${plugin}`) ?? {}) };
    },
    async update(plugin, harness, patch) {
      data.set(`${harness}/${plugin}`, { ...(data.get(`${harness}/${plugin}`) ?? {}), ...patch });
    },
  };
}

const NOW = () => new Date('2026-10-11T01:00:00.000Z');

describe('provider credentials: store and status', () => {
  it('stores trimmed values in the provider-setup store and reports only that they are configured', async () => {
    const storage = memoryStorage();
    const status = await saveProviderCredentials(descriptor, 'papercusp', { bot_token: `  ${BOT}\n` }, { storage, now: NOW });
    expect(storage.data.get(`papercusp/${providerSetupStoreKey('example-chat')}`)?.bot_token).toBe(BOT);
    expect(status).toEqual([
      {
        key: 'bot_token',
        label: 'Bot token',
        help: null,
        helpUrl: null,
        placeholder: 'chat-…',
        pattern: 'chat-[A-Za-z0-9-]+',
        hosts: ['chat.example.com'],
        configured: true,
        savedAt: '2026-10-11T01:00:00.000Z',
      },
      expect.objectContaining({ key: 'app_token', configured: false, savedAt: null, hosts: [] }),
    ]);
  });

  it('never returns a saved value, or any part of it, from a read', async () => {
    const storage = memoryStorage();
    await saveProviderCredentials(descriptor, 'papercusp', { bot_token: BOT, app_token: APP }, { storage, now: NOW });
    for (const read of [
      await providerCredentialStatus(descriptor, 'papercusp', storage),
      await clearProviderCredential(descriptor, 'papercusp', 'app_token', storage),
      await saveProviderCredentials(descriptor, 'papercusp', { app_token: APP }, { storage, now: NOW }),
    ]) {
      const text = JSON.stringify(read);
      for (const secret of [BOT, APP, 'SECRETBOT', 'SECRETAPP', 'fixture']) expect(text).not.toContain(secret);
      for (const field of read) {
        expect(Object.keys(field).sort()).toEqual(['configured', 'help', 'helpUrl', 'hosts', 'key', 'label', 'pattern', 'placeholder', 'savedAt']);
      }
    }
  });

  it('refuses a value that does not match the declared format and writes nothing', async () => {
    const storage = memoryStorage();
    const error = await saveProviderCredentials(descriptor, 'papercusp', { bot_token: BOT, app_token: 'chat-wrong-kind' }, { storage })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderCredentialError);
    expect(error).toMatchObject({ code: 'invalid-value', field: 'app_token', message: 'App-level token does not have the expected format' });
    expect(storage.data.size).toBe(0);
  });

  it('refuses an unknown field, an empty request and a provider with no credential fields', async () => {
    const storage = memoryStorage();
    await expect(saveProviderCredentials(descriptor, 'papercusp', { password: 'x' }, { storage })).rejects.toMatchObject({ code: 'unknown-field' });
    await expect(saveProviderCredentials(descriptor, 'papercusp', {}, { storage })).rejects.toMatchObject({ code: 'empty-request' });
    await expect(saveProviderCredentials({ ...descriptor, setup: undefined }, 'papercusp', { bot_token: BOT }, { storage }))
      .rejects.toMatchObject({ code: 'no-credential-fields' });
    await expect(clearProviderCredential(descriptor, 'papercusp', 'password', storage)).rejects.toMatchObject({ code: 'unknown-field' });
  });

  it('keeps installs apart and forgets a cleared value', async () => {
    const storage = memoryStorage();
    await saveProviderCredentials(descriptor, 'papercusp', { bot_token: BOT }, { storage });
    expect(await readProviderCredentialValue(descriptor, 'other-install', 'bot_token', storage)).toBeNull();
    expect(await readProviderCredentialValue(descriptor, 'papercusp', 'bot_token', storage)).toBe(BOT);
    expect(await readProviderCredentialValue(descriptor, 'papercusp', 'undeclared', storage)).toBeNull();
    await clearProviderCredential(descriptor, 'papercusp', 'bot_token', storage);
    expect(await readProviderCredentialValue(descriptor, 'papercusp', 'bot_token', storage)).toBeNull();
    expect((await providerCredentialStatus(descriptor, 'papercusp', storage))[0]).toMatchObject({ configured: false, savedAt: null });
  });
});

describe('provider credentials: plain plugin-config reads cannot name the store', () => {
  it('refuses the provider-setup store name on /plugins/config and /plugins/configs', async () => {
    type Route = { method?: string; handler: (req: Request) => Promise<Response> };
    const configModule = (await import('../endpoint-route/routes/plugins/config')) as unknown as { default: Route | Route[] };
    const configsModule = (await import('../endpoint-route/routes/plugins/configs')) as unknown as { default: Route };
    const routes = Array.isArray(configModule.default) ? configModule.default : [configModule.default];
    const getConfig = routes.find((r) => r.method === 'GET');
    expect(getConfig).toBeDefined();
    const store = encodeURIComponent(providerSetupStoreKey('example-chat'));
    const single = await getConfig!.handler(new Request(`http://127.0.0.1/api/plugins/config?harness=papercusp&plugin=${store}`));
    expect(single.status).toBe(400);
    const many = await configsModule.default.handler(new Request(`http://127.0.0.1/api/plugins/configs?harness=papercusp&plugins=${store}`));
    expect(many.status).toBe(400);
  });
});

describe('provider credentials: host.fetch', () => {
  async function setup(pasted: Record<string, string | null>, own: { ownCredential?: boolean; token?: string | null } = {}) {
    const registry = createProviderRegistry();
    const adapter: ProviderAdapter = {
      describe: () => descriptor,
      syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
      invoke: async () => ({}),
    };
    await registry.register({ descriptor, adapter, pluginName: 'example-chat' });
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const accessToken = vi.fn(async (): Promise<string | null> => own.token ?? null);
    const hostFetch = createHostFetch('example-chat', {
      registry,
      resolveSource: async (id) =>
        id === 'src-1'
          ? { sourceId: 'src-1', providerId: 'example-chat', ...(own.ownCredential ? { ownCredential: true } : {}) }
          : null,
      accessToken,
      pastedCredential: async (key) => pasted[key] ?? null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { hostFetch, fetchImpl, accessToken };
  }

  it('sends the pasted value only to its declared host and returns nothing of it to the provider', async () => {
    const { hostFetch, fetchImpl, accessToken } = await setup({ bot_token: BOT });
    const res = await hostFetch({ source: 'src-1', request: { url: 'https://chat.example.com/api/auth.test' } });
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get('authorization')).toBe(`Bearer ${BOT}`);
    expect(JSON.stringify(res)).not.toContain(BOT);
    expect(accessToken).not.toHaveBeenCalled();

    await hostFetch({ source: 'src-1', request: { url: 'https://files.example.com/upload' } });
    expect(new Headers(fetchImpl.mock.calls[1]![1]!.headers).get('authorization')).toBeNull();
  });

  it('refuses a declared host whose credential is not set up, without sending a request', async () => {
    const { hostFetch, fetchImpl } = await setup({});
    const error = await hostFetch({ source: 'src-1', request: { url: 'https://chat.example.com/api/auth.test' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostFetchError);
    expect(error).toMatchObject({ code: 'credential-unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // WI-6554700010008555: declaring a pasted credential as an alternative to OAuth cut every
  // OAuth-connected source of that provider off from its own account.
  it('sends a source that holds its own account credential its own token, not the pasted value', async () => {
    const { hostFetch, fetchImpl, accessToken } = await setup({ bot_token: BOT }, { ownCredential: true, token: 'oauth-own-token' });
    await hostFetch({ source: 'src-1', request: { url: 'https://chat.example.com/api/auth.test' } });
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer oauth-own-token');
    expect(accessToken).toHaveBeenCalledTimes(1);
  });

  it('works for an OAuth source when nothing was pasted', async () => {
    const { hostFetch, fetchImpl } = await setup({}, { ownCredential: true, token: 'oauth-own-token' });
    await hostFetch({ source: 'src-1', request: { url: 'https://chat.example.com/api/auth.test' } });
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer oauth-own-token');
  });

  it('falls back to the pasted value when a source with its own credential ref resolves no token', async () => {
    const { hostFetch, fetchImpl, accessToken } = await setup({ bot_token: BOT }, { ownCredential: true, token: null });
    await hostFetch({ source: 'src-1', request: { url: 'https://chat.example.com/api/auth.test' } });
    expect(accessToken).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get('authorization')).toBe(`Bearer ${BOT}`);
  });
});

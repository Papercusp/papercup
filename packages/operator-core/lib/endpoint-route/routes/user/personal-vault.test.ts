import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../../define-route';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  getUser: vi.fn(),
  parsePlan: vi.fn(),
  parseArchive: vi.fn(),
  enabled: vi.fn(),
  setEnabled: vi.fn(),
  stats: vi.fn(),
  listGrants: vi.fn(),
  replaceGrant: vi.fn(),
  revokeGrant: vi.fn(),
  purge: vi.fn(),
  upsert: vi.fn(),
  listSources: vi.fn(),
  disconnectSources: vi.fn(),
  loadProviders: vi.fn(),
  getProvider: vi.fn(),
  tokenUpdate: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('@papercusp/plan-parser', () => ({ parsePlan: mocks.parsePlan }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: mocks.getUser }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../personal-vault/archive-import', () => ({ parsePersonalArchive: mocks.parseArchive }));
vi.mock('../../../external-triggers/source-store', () => ({
  listOwnedExternalTriggerSources: mocks.listSources,
  disconnectOwnedExternalTriggerSources: mocks.disconnectSources,
}));
vi.mock('../../../external-triggers/google-workspace', () => ({
  GOOGLE_WORKSPACE_OAUTH_PLUGIN: 'google-workspace',
  GOOGLE_WORKSPACE_SOURCE_KINDS: ['gmail', 'gcal'],
  googleWorkspaceOAuthField: (ref: string) => ref.replace('google-workspace:', ''),
}));
vi.mock('../../../oauth/providers', () => ({
  loadAndRegisterProvidersFromDisk: mocks.loadProviders,
  getProvider: mocks.getProvider,
}));
vi.mock('../../../oauth/storage-fs', () => ({
  fsTokenStorage: { update: mocks.tokenUpdate },
}));
vi.mock('../../../personal-vault/store', async () => {
  const actual = await vi.importActual<typeof import('../../../personal-vault/store')>(
    '../../../personal-vault/store',
  );
  return {
    ...actual,
    isPersonalVaultEnabled: mocks.enabled,
    setPersonalVaultEnabled: mocks.setEnabled,
    personalVaultStats: mocks.stats,
    listPersonalGrants: mocks.listGrants,
    replacePersonalGrant: mocks.replaceGrant,
    revokePersonalGrant: mocks.revokeGrant,
    purgePersonalSource: mocks.purge,
    upsertPersonalDocuments: mocks.upsert,
  };
});

import routes, { declaredPersonalScopes } from './personal-vault';

const route = (method: string, path: string): RouteDefinition => {
  const found = (routes as RouteDefinition[]).find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
};

const invoke = (method: string, path: string, req: Request) =>
  route(method, path).handler(req, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ id: 'user-1', display_name: 'Owner' });
  mocks.enabled.mockResolvedValue(true);
  mocks.stats.mockResolvedValue({ sources: [{ source: 'gmail', documents: 2, newest_at: null }], unembedded: 1 });
  mocks.listGrants.mockResolvedValue([]);
  mocks.replaceGrant.mockResolvedValue({ id: 'grant-1', scopes: ['personal:gmail'], revoked: 0 });
  mocks.revokeGrant.mockResolvedValue(true);
  mocks.purge.mockResolvedValue({ documents: 2, cursors: 1, aliases: 1, identities: 1 });
  mocks.upsert.mockResolvedValue({ insertedOrUpdated: 1, ids: ['doc-1'] });
  mocks.loadProviders.mockResolvedValue(['google']);
  mocks.getProvider.mockReturnValue({ id: 'google' });
  mocks.listSources.mockResolvedValue([
    {
      id: 'gmail-source',
      workspaceId: 'ws-test',
      kind: 'gmail',
      ownerUserId: 'user-1',
      credentialRef: 'google-workspace:owner-user-1',
      status: 'connected',
      config: {},
      cursor: { historyId: 'never-serialize-me', lastSyncAt: '2026-08-23T00:00:00.000Z' },
      lastError: null,
      lastConnectedAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    },
  ]);
  mocks.disconnectSources.mockResolvedValue({
    sources: 2,
    credentialRefs: ['google-workspace:owner-user-1'],
  });
  mocks.parseArchive.mockReturnValue({
    documents: [{ source: 'gmail', kind: 'message', text: 'hello' }],
    sources: ['gmail'],
    warnings: [],
  });
  mocks.parsePlan.mockReturnValue({ frontmatter: { raw: { personalScopes: ['personal:gmail'] } } });
  mocks.sql.mockResolvedValue([
    { plan_slug: 'meeting-prep', harness_slug: 'papercusp', template_slug: null, content: 'plan' },
  ]);
});

describe('Personal Vault owner routes', () => {
  it('keeps reads public-compatible and every mutation loopback-only', () => {
    expect(route('GET', '/user/personal-vault').auth).toBe('public');
    expect(route('GET', '/user/personal-vault/grants').auth).toBe('public');
    for (const candidate of routes as RouteDefinition[]) {
      if (candidate.method !== 'GET') expect(candidate.auth).toBe('loopback');
    }
  });

  it('returns status from the canonical per-user store', async () => {
    const response = await invoke(
      'GET',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault'),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      enabled: true,
      workspaceId: 'ws-test',
      embedding: { mode: 'gemma', localOnly: true },
      stats: { unembedded: 1 },
      integrations: {
        google: {
          configured: true,
          connected: true,
          status: 'connected',
          sources: [{
            kind: 'gmail',
            status: 'connected',
            lastSyncAt: '2026-08-23T00:00:00.000Z',
          }],
        },
      },
    });
    expect(mocks.stats).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1');
    const body = JSON.stringify(payload);
    expect(body).not.toContain('historyId');
    expect(body).not.toContain('credentialRef');
  });

  it('disconnects Google sources and clears server-side token fields without purging vault data', async () => {
    const response = await invoke(
      'DELETE',
      '/user/personal-vault/integrations/google',
      new Request('http://localhost/user/personal-vault/integrations/google', { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: 'google',
      disconnectedSources: 2,
    });
    expect(mocks.disconnectSources).toHaveBeenCalledWith(
      mocks.sql,
      'ws-test',
      'user-1',
      ['gmail', 'gcal'],
    );
    expect(mocks.tokenUpdate).toHaveBeenCalledWith('google-workspace', 'papercusp', {
      'owner-user-1': null,
      'owner-user-1_refresh': null,
      'owner-user-1_expires_at': null,
      'owner-user-1_expired': true,
    });
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before purge', async () => {
    const refused = await invoke(
      'DELETE',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );
    expect(refused.status).toBe(400);
    expect(mocks.purge).not.toHaveBeenCalled();

    const accepted = await invoke(
      'DELETE',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail', confirm: true }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(mocks.purge).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', 'gmail');
  });

  it('parses multipart archives locally and upserts through the vault store', async () => {
    const form = new FormData();
    form.set('file', new File(['mail'], 'takeout.mbox', { type: 'application/mbox' }));
    const response = await invoke(
      'POST',
      '/user/personal-vault/import',
      new Request('http://localhost/user/personal-vault/import', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ documents: 1, sources: ['gmail'] });
    expect(mocks.parseArchive).toHaveBeenCalledWith('takeout.mbox', expect.any(Buffer));
    expect(mocks.upsert).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', expect.any(Array));
  });

  it('previews and approves only scopes declared by the plan template', async () => {
    const previewRequest = new Request('http://localhost/user/personal-vault/grants/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'meeting-prep', harnessSlug: 'papercusp' }),
    });
    const preview = await invoke('POST', '/user/personal-vault/grants/preview', previewRequest);
    await expect(preview.json()).resolves.toMatchObject({
      principalType: 'plan-template',
      principalId: 'meeting-prep',
      declaredScopes: ['personal:gmail'],
    });

    const approval = await invoke(
      'POST',
      '/user/personal-vault/grants',
      new Request('http://localhost/user/personal-vault/grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // An injected scopes array is ignored for plan approval: the declaration
        // is the authority, so this cannot escalate the grant to calendar.
        body: JSON.stringify({
          planSlug: 'meeting-prep',
          harnessSlug: 'papercusp',
          scopes: ['personal:calendar'],
        }),
      }),
    );
    expect(approval.status).toBe(200);
    expect(mocks.replaceGrant).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        principalType: 'plan-template',
        principalId: 'meeting-prep',
        scopes: ['personal:gmail'],
      }),
    );
  });
});

describe('declaredPersonalScopes', () => {
  it('normalizes aliases and deduplicates them', () => {
    expect(declaredPersonalScopes({ personalScopes: ['Gmail', 'personal:gmail', 'calendar'] })).toEqual([
      'personal:calendar',
      'personal:gmail',
    ]);
  });
});

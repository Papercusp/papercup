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
  setCapability: vi.fn(),
  loadProviders: vi.fn(),
  getProvider: vi.fn(),
  tokenRead: vi.fn(),
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
  setOwnedExternalTriggerSourceCapability: mocks.setCapability,
}));
vi.mock('../../../external-triggers/google-workspace', () => ({
  GOOGLE_WORKSPACE_OAUTH_PLUGIN: 'google-workspace',
  GOOGLE_WORKSPACE_SOURCE_KINDS: ['gmail', 'gcal', 'contacts'],
  googleWorkspaceOAuthField: (ref: string) => ref.replace('google-workspace:', ''),
}));
vi.mock('../../../external-triggers/facebook', () => ({
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN: 'facebook-personal-vault',
  FACEBOOK_PERSONAL_VAULT_SOURCE_KINDS: ['facebook'],
  facebookPersonalVaultOAuthField: (ref: string) => ref.replace('facebook-personal-vault:', ''),
}));
vi.mock('../../../oauth/providers', () => ({
  GOOGLE_GMAIL_READONLY_SCOPE: 'https://www.googleapis.com/auth/gmail.readonly',
  GOOGLE_GMAIL_COMPOSE_SCOPE: 'https://www.googleapis.com/auth/gmail.compose',
  GOOGLE_CALENDAR_READONLY_SCOPE: 'https://www.googleapis.com/auth/calendar.readonly',
  GOOGLE_CALENDAR_EVENTS_SCOPE: 'https://www.googleapis.com/auth/calendar.events',
  GOOGLE_CONTACTS_READONLY_SCOPE: 'https://www.googleapis.com/auth/contacts.readonly',
  GOOGLE_YOUTUBE_READONLY_SCOPE: 'https://www.googleapis.com/auth/youtube.readonly',
  GOOGLE_YOUTUBE_FORCE_SSL_SCOPE: 'https://www.googleapis.com/auth/youtube.force-ssl',
  GOOGLE_WORKSPACE_SCOPES: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
  ],
  loadAndRegisterProvidersFromDisk: mocks.loadProviders,
  getProvider: mocks.getProvider,
}));
vi.mock('../../../oauth/storage-fs', () => ({
  fsTokenStorage: { read: mocks.tokenRead, update: mocks.tokenUpdate },
}));
vi.mock('../../../personal-vault/store', async () => {
  const actual = await vi.importActual<typeof import('../../../personal-vault/store')>('../../../personal-vault/store');
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
  const found = (routes as RouteDefinition[]).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
};

const invoke = (method: string, path: string, req: Request) => route(method, path).handler(req, {} as never);

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
  mocks.getProvider.mockImplementation((id: string) => (id === 'google' ? { id: 'google' } : null));
  mocks.listSources.mockResolvedValue([
    {
      id: 'gmail-source',
      workspaceId: 'ws-test',
      kind: 'gmail',
      ownerUserId: 'user-1',
      credentialRef: 'google-workspace:owner-user-1',
      status: 'connected',
      config: { privateSetting: 'never-serialize-source-config' },
      cursor: { historyId: 'never-serialize-me', lastSyncAt: '2026-08-23T00:00:00.000Z' },
      lastError: null,
      lastConnectedAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    },
  ]);
  mocks.disconnectSources.mockResolvedValue({
    sources: 3,
    credentialRefs: ['google-workspace:owner-user-1'],
  });
  mocks.setCapability.mockResolvedValue({
    id: 'contacts-source',
    workspaceId: 'ws-test',
    kind: 'contacts',
    ownerUserId: 'user-1',
    credentialRef: 'google-workspace:owner-user-1',
    status: 'disabled',
    config: { capabilityEnabled: false },
    cursor: {},
  });
  mocks.tokenRead.mockResolvedValue({
    'owner-user-1': 'never-serialize-google-access-token',
    'owner-user-1_refresh': 'never-serialize-google-refresh-token',
    'owner-user-1_scopes': [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
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
    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
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
          sources: [
            {
              kind: 'gmail',
              status: 'connected',
              lastSyncAt: '2026-08-23T00:00:00.000Z',
            },
          ],
          capabilities: [
            expect.objectContaining({ id: 'gmail', enabled: true, status: 'connected' }),
            expect.objectContaining({ id: 'calendar', enabled: true, status: 'connected' }),
            expect.objectContaining({ id: 'contacts', enabled: true, status: 'connected' }),
            // D-019 IN ACTION, and the whole reason the YouTube scopes are kept
            // out of GOOGLE_WORKSPACE_SCOPES: this connection never consented to
            // them, so the capability must report NOT connected and name what is
            // missing. Had they been added to the presumed-granted list, this
            // would read connected — and the owner would discover otherwise via
            // a 403 at call time.
            expect.objectContaining({
              id: 'youtube',
              connected: false,
              missingScopes: [
                'https://www.googleapis.com/auth/youtube.readonly',
                'https://www.googleapis.com/auth/youtube.force-ssl',
              ],
            }),
          ],
        },
        facebook: {
          configured: false,
          connected: false,
          status: 'needs-app-config',
          sources: [],
        },
      },
    });
    expect(mocks.stats).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1');
    const body = JSON.stringify(payload);
    expect(body).not.toContain('historyId');
    expect(body).not.toContain('credentialRef');
    expect(body).not.toContain('never-serialize-source-config');
    expect(body).not.toContain('never-serialize-google-access-token');
    expect(body).not.toContain('never-serialize-google-refresh-token');
  });

  it('reports a persisted disabled YouTube capability as disabled on readback', async () => {
    mocks.listSources.mockResolvedValueOnce([
      {
        id: 'gmail-source',
        workspaceId: 'ws-test',
        kind: 'gmail',
        ownerUserId: 'user-1',
        credentialRef: 'google-workspace:owner-user-1',
        status: 'connected',
        config: {},
        cursor: {},
        lastError: null,
        lastConnectedAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
      {
        id: 'youtube-source',
        workspaceId: 'ws-test',
        kind: 'youtube',
        ownerUserId: 'user-1',
        credentialRef: 'google-workspace:owner-user-1',
        status: 'disabled',
        config: { capabilityEnabled: false },
        cursor: {},
        lastError: null,
        lastConnectedAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    ]);

    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.integrations.google.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'youtube',
          sourceKind: 'youtube',
          enabled: false,
          connected: false,
          status: 'disabled',
          missingScopes: [],
        }),
      ]),
    );
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
      disconnectedSources: 3,
    });
    expect(mocks.disconnectSources).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', ['gmail', 'gcal', 'contacts']);
    expect(mocks.tokenUpdate).toHaveBeenCalledWith('google-workspace', 'papercusp', {
      'owner-user-1': null,
      'owner-user-1_refresh': null,
      'owner-user-1_expires_at': null,
      'owner-user-1_scopes': null,
      'owner-user-1_expired': true,
    });
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('toggles one Google capability without revoking the shared OAuth credential', async () => {
    const response = await invoke(
      'PATCH',
      '/user/personal-vault/integrations/google/capabilities',
      new Request('http://localhost/user/personal-vault/integrations/google/capabilities', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'contacts', enabled: false }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capability: 'contacts',
      enabled: false,
      source: { kind: 'contacts', status: 'disabled' },
    });
    expect(mocks.setCapability).toHaveBeenCalledWith(mocks.sql, {
      workspaceId: 'ws-test',
      ownerUserId: 'user-1',
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user-1',
      enabled: false,
      createdBy: 'owner:user-1',
    });
    expect(mocks.disconnectSources).not.toHaveBeenCalled();
    expect(mocks.tokenUpdate).not.toHaveBeenCalled();
  });

  it('surfaces Calendar write consent as a capability-scoped upgrade', async () => {
    mocks.tokenRead.mockResolvedValueOnce({
      'owner-user-1_scopes': [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
      ],
    });
    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    const payload = await response.json();
    expect(payload.integrations.google.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'calendar',
          status: 'needs-consent',
          missingScopes: ['https://www.googleapis.com/auth/calendar.events'],
        }),
      ]),
    );
  });

  it('projects and disconnects Facebook without exposing cursors, credentials, or purging documents', async () => {
    mocks.getProvider.mockImplementation((id: string) => ({ id }));
    mocks.listSources.mockResolvedValue([
      {
        id: 'facebook-source',
        workspaceId: 'ws-test',
        kind: 'facebook',
        ownerUserId: 'user-1',
        credentialRef: 'facebook-personal-vault:owner-user-1',
        status: 'connected',
        config: { coverage: ['profile', 'posts', 'photo-metadata'] },
        cursor: { since: 'secret-provider-watermark', lastSyncAt: '2026-08-23T00:15:00.000Z' },
        lastError: null,
        lastConnectedAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:15:00.000Z',
      },
    ]);
    mocks.disconnectSources.mockResolvedValue({
      sources: 1,
      credentialRefs: ['facebook-personal-vault:owner-user-1'],
    });

    const statusResponse = await invoke(
      'GET',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault'),
    );
    const statusPayload = await statusResponse.json();
    expect(statusPayload.integrations.facebook).toMatchObject({
      provider: 'facebook',
      configured: true,
      connected: true,
      status: 'connected',
      sources: [{ kind: 'facebook', lastSyncAt: '2026-08-23T00:15:00.000Z' }],
    });
    expect(JSON.stringify(statusPayload)).not.toContain('secret-provider-watermark');
    expect(JSON.stringify(statusPayload)).not.toContain('credentialRef');

    const disconnectResponse = await invoke(
      'DELETE',
      '/user/personal-vault/integrations/facebook',
      new Request('http://localhost/user/personal-vault/integrations/facebook', { method: 'DELETE' }),
    );
    await expect(disconnectResponse.json()).resolves.toMatchObject({
      provider: 'facebook',
      disconnectedSources: 1,
    });
    expect(mocks.disconnectSources).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', ['facebook']);
    expect(mocks.tokenUpdate).toHaveBeenCalledWith('facebook-personal-vault', 'papercusp', {
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

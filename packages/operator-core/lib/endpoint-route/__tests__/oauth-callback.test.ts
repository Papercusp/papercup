/**
 * Smoke tests for GET /api/oauth/callback.
 *
 * Ported from app/api/oauth/callback/route.test.ts — the route is now
 * routes/oauth/callback.ts. Keeps the resetModules + doMock pattern: the
 * PG mirror in fsTokenStorage is mocked, and the on-first-request
 * provider disk-load is neutralised and the registry is fully test-controlled.
 * Mocks are stable at module scope: a per-test resetModules()+dynamic import
 * made the first assertion pay the entire cold transform graph and exceed
 * Vitest's 5-second test timeout before the handler even ran.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const sourceMocks = vi.hoisted(() => ({
  provision: vi.fn(async () => [
    {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-1',
      kind: 'gmail',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      providerAccountId: 'owner@example.com',
      credentialRef: 'google-workspace:owner',
      status: 'connected',
      config: { installSlug: 'papercusp' },
      cursor: {},
    },
  ]),
  ensureGmailBinding: vi.fn(async () => ({
    plan: { created: true, schemaAdded: true },
    binding: { id: 'binding-1', armed: false },
  })),
  provisionFacebook: vi.fn(async () => ({
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: 'workspace-1',
    kind: 'facebook',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: 'facebook-personal-vault:owner',
    status: 'connected',
    config: {},
    cursor: {},
  })),
  resolveGoogleAccount: vi.fn(async () => ({
    providerAccountId: 'owner@example.com',
    displayName: 'owner@example.com',
  })),
  listOwned: vi.fn(async (): Promise<unknown[]> => []),
  renameAccount: vi.fn(async (): Promise<unknown[]> => []),
  sql: { test: true },
}));

vi.mock('../../plugin-configs-pg', () => ({
  mirrorPluginConfig: async () => undefined,
}));
vi.mock('../../oauth/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../oauth/providers')>()),
  loadAndRegisterProvidersFromDisk: async () => {},
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sourceMocks.sql }),
}));
vi.mock('../../external-triggers/google-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../external-triggers/google-workspace')>()),
  provisionOwnedGoogleWorkspaceSources: sourceMocks.provision,
  resolveGoogleWorkspaceProviderAccount: sourceMocks.resolveGoogleAccount,
}));
vi.mock('../../external-triggers/source-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../external-triggers/source-store')>()),
  listOwnedExternalTriggerSources: sourceMocks.listOwned,
  renameOwnedExternalTriggerSourceAccount: sourceMocks.renameAccount,
}));
vi.mock('../../external-triggers/gmail-flagship', () => ({
  ensureGmailRespondDraftBinding: sourceMocks.ensureGmailBinding,
}));
vi.mock('../../external-triggers/facebook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../external-triggers/facebook')>()),
  provisionOwnedFacebookPersonalVaultSource: sourceMocks.provisionFacebook,
}));
vi.mock('../../oauth/state', () => ({
  verifyAndConsumeState: async (token: string) => {
    if (!token.includes('.') || token === 'garbage.sig') {
      return { ok: false, error: 'bad-signature' };
    }
    if (
      token === 'google.valid' ||
      token === 'google.missing' ||
      token === 'google.legacy' ||
      token === 'google.mismatch'
    ) {
      const reconnectProviderAccountId =
        token === 'google.legacy'
          ? 'google-workspace:legacy-field'
          : token === 'google.mismatch'
            ? 'owner@example.com'
            : undefined;
      return {
        ok: true,
        privateContext: {
          codeVerifier: 'persisted-verifier',
          ...(token === 'google.missing'
            ? {}
            : {
                ownerUserId: '22222222-2222-4222-8222-222222222222',
                workspaceId: 'workspace-1',
                requestedScopes: JSON.stringify([
                  'https://www.googleapis.com/auth/gmail.readonly',
                  'https://www.googleapis.com/auth/calendar.events',
                ]),
                ...(reconnectProviderAccountId ? { reconnectProviderAccountId } : {}),
              }),
        },
        claims: {
          plugin: 'google-workspace',
          harness: 'papercusp',
          field: token === 'google.legacy' ? 'legacy-field' : 'owner-22222222-2222-4222-8222-222222222222',
          providerHost: 'accounts.google.com',
          provider: 'google',
        },
      };
    }
    if (token === 'facebook.valid' || token === 'facebook.missing') {
      return {
        ok: true,
        privateContext:
          token === 'facebook.missing'
            ? {}
            : {
                ownerUserId: '22222222-2222-4222-8222-222222222222',
                workspaceId: 'workspace-1',
              },
        claims: {
          plugin: 'facebook-personal-vault',
          harness: 'papercusp',
          field: 'owner-22222222-2222-4222-8222-222222222222',
          providerHost: 'www.facebook.com',
          provider: 'facebook',
        },
      };
    }
    return {
      ok: true,
      privateContext: { codeVerifier: 'persisted-verifier' },
      claims: {
        plugin: 'github-repo',
        harness: 'demo',
        field: 'github_token',
        providerHost: 'example.com',
        provider: 'github',
      },
    };
  },
}));

import callbackRoute from '../routes/oauth/callback';
import * as providers from '../../oauth/providers';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-callback-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  providers.__resetRegistryForTest();
  sourceMocks.provision.mockClear();
  sourceMocks.provisionFacebook.mockClear();
  sourceMocks.ensureGmailBinding.mockClear();
  sourceMocks.resolveGoogleAccount.mockReset();
  sourceMocks.resolveGoogleAccount.mockResolvedValue({
    providerAccountId: 'owner@example.com',
    displayName: 'owner@example.com',
  });
  sourceMocks.listOwned.mockReset();
  sourceMocks.listOwned.mockResolvedValue([]);
  sourceMocks.renameAccount.mockReset();
  sourceMocks.renameAccount.mockResolvedValue([]);
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  providers.__resetRegistryForTest();
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

const GET = (req: Request) => Promise.resolve(callbackRoute.handler(req, CTX));

describe('GET /api/oauth/callback', () => {
  it('returns 400 when code or state is missing', async () => {
    const r = await GET(new Request('http://x/api/oauth/callback'));
    expect(r.status).toBe(400);
  });

  it('redirects with oauth_error when provider sent error= param', async () => {
    const r = await GET(new Request('http://x/api/oauth/callback?error=access_denied'));
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('oauth_error=access_denied');
  });

  it('returns a cancelled Google Workspace consent to Personal Vault settings', async () => {
    const response = await GET(new Request('http://x/api/oauth/callback?error=access_denied&state=google.valid'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://x/settings/personal-vault?oauth_error=access_denied');
  });

  it('rejects state with bad signature', async () => {
    const r = await GET(new Request('http://x/api/oauth/callback?code=c&state=garbage.sig'));
    expect(r.status).toBe(400);
  });

  it('exchanges code, writes token to config on happy path', async () => {
    providers.__resetRegistryForTest();
    providers.registerProvider({
      id: 'github',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        redirectUri: 'http://localhost:3055/cb',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({
        accessToken: 'gho_realtoken',
        refreshToken: 'gho_refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    // Token shape is irrelevant — verifyAndConsumeState is stubbed (see
    // beforeEach) to return the demo claims for any well-formed token.
    const r = await GET(new Request('http://x/api/oauth/callback?code=abc&state=valid.token'));
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('connected=github-repo');

    const cfgPath = join(TMP_HOME, 'harnesses/demo/plugin-configs/github-repo.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg.github_token).toBe('gho_realtoken');
    expect(cfg.github_token_refresh).toBe('gho_refresh');
    expect(typeof cfg.github_token_expires_at).toBe('number');
  });

  it('passes the server-side flow context to the provider exchange', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: 'google-token' }));
    providers.__resetRegistryForTest();
    providers.registerProvider({
      id: 'github',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        redirectUri: 'http://localhost:3055/cb',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode,
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=valid.token'));
    expect(response.status).toBe(307);
    expect(exchangeCode).toHaveBeenCalledWith('authorization-code', { codeVerifier: 'persisted-verifier' });
  });

  it('provisions one Google account without replacing another account token', async () => {
    const cfgDir = join(TMP_HOME, 'harnesses/papercusp/plugin-configs');
    const cfgPath = join(cfgDir, 'google-workspace.json');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        'other-private-field': 'keep-other-access',
        'other-private-field_refresh': 'keep-other-refresh',
      }),
    );
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '44444444-4444-4444-8444-444444444444',
        workspaceId: 'workspace-1',
        kind: 'gmail',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        providerAccountId: 'other@example.com',
        credentialRef: 'google-workspace:other-private-field',
        status: 'connected',
        config: {},
        cursor: { historyId: 'keep-other-cursor' },
      },
    ]);
    providers.registerProvider({
      id: 'google',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({
        accessToken: 'google-access',
        refreshToken: 'google-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'],
      }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.valid'));
    expect(response.status).toBe(307);
    expect(sourceMocks.provision).toHaveBeenCalledWith(sourceMocks.sql, {
      workspaceId: 'workspace-1',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      providerAccountId: 'owner@example.com',
      field: 'owner-22222222-2222-4222-8222-222222222222',
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
    });
    expect(sourceMocks.ensureGmailBinding).toHaveBeenCalledWith(
      sourceMocks.sql,
      'workspace-1',
      expect.objectContaining({ kind: 'gmail', ownerUserId: '22222222-2222-4222-8222-222222222222' }),
      'owner:22222222-2222-4222-8222-222222222222',
    );
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg['owner-22222222-2222-4222-8222-222222222222']).toBe('google-access');
    expect(cfg['owner-22222222-2222-4222-8222-222222222222_refresh']).toBe('google-refresh');
    expect(cfg['owner-22222222-2222-4222-8222-222222222222_scopes']).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    expect(cfg['other-private-field']).toBe('keep-other-access');
    expect(cfg['other-private-field_refresh']).toBe('keep-other-refresh');
    expect(response.headers.get('location')).toBe('http://x/settings/personal-vault?oauth_connected=google-workspace');
  });

  it('adopts a canonical Google account identity in place for a provisional reconnect', async () => {
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'workspace-1',
        kind: 'gmail',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        providerAccountId: 'owner@example.com',
        credentialRef: 'google-workspace:legacy-field',
        status: 'connected',
        config: {},
        cursor: { historyId: 'keep-me' },
      },
    ]);
    providers.registerProvider({
      id: 'google',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({ accessToken: 'google-access' }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.legacy'));
    expect(response.status).toBe(307);
    expect(sourceMocks.renameAccount).toHaveBeenCalledWith(sourceMocks.sql, {
      workspaceId: 'workspace-1',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      previousProviderAccountId: 'google-workspace:legacy-field',
      providerAccountId: 'owner@example.com',
    });
    expect(sourceMocks.provision).toHaveBeenCalledWith(
      sourceMocks.sql,
      expect.objectContaining({ providerAccountId: 'owner@example.com', field: 'legacy-field' }),
    );
  });

  it('fails closed when a targeted Google reconnect authenticates a different canonical account', async () => {
    sourceMocks.resolveGoogleAccount.mockResolvedValue({
      providerAccountId: 'other@example.com',
      displayName: 'other@example.com',
    });
    providers.registerProvider({
      id: 'google',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({ accessToken: 'must-not-store' }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(
      new Request('http://x/api/oauth/callback?code=authorization-code&state=google.mismatch'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=google_workspace_account_mismatch',
    );
    expect(sourceMocks.renameAccount).not.toHaveBeenCalled();
    expect(sourceMocks.provision).not.toHaveBeenCalled();
    await expect(
      fs.access(join(TMP_HOME, 'harnesses/papercusp/plugin-configs/google-workspace.json')),
    ).rejects.toThrow();
  });

  it('fails closed when a Google Workspace callback lacks server-owned identity context', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: 'must-not-store' }));
    providers.registerProvider({
      id: 'google',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode,
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.missing'));
    expect(response.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(sourceMocks.provision).not.toHaveBeenCalled();
  });

  it('stores the Facebook token under the private plugin and provisions exactly one owned source', async () => {
    providers.registerProvider({
      id: 'facebook',
      config: {
        clientId: 'facebook-app',
        clientSecret: 'facebook-secret',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/oauth/access_token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({
        accessToken: 'facebook-long-lived',
        refreshToken: 'facebook-long-lived',
        expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
      }),
      refresh: async () => ({ accessToken: 'facebook-refreshed' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=facebook.valid'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_connected=facebook-personal-vault',
    );
    expect(sourceMocks.provisionFacebook).toHaveBeenCalledWith(sourceMocks.sql, {
      workspaceId: 'workspace-1',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      field: 'owner-22222222-2222-4222-8222-222222222222',
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
    });
    const cfgPath = join(TMP_HOME, 'harnesses/papercusp/plugin-configs/facebook-personal-vault.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg['owner-22222222-2222-4222-8222-222222222222']).toBe('facebook-long-lived');
    expect(cfg['owner-22222222-2222-4222-8222-222222222222_refresh']).toBe('facebook-long-lived');
  });

  it('fails closed when a Facebook callback lacks server-owned identity context', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: 'must-not-store' }));
    providers.registerProvider({
      id: 'facebook',
      config: {
        clientId: 'facebook-app',
        clientSecret: 'facebook-secret',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/oauth/access_token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode,
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(
      new Request('http://x/api/oauth/callback?code=authorization-code&state=facebook.missing'),
    );
    expect(response.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(sourceMocks.provisionFacebook).not.toHaveBeenCalled();
  });
});

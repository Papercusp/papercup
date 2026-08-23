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
}));
vi.mock('../../external-triggers/gmail-flagship', () => ({
  ensureGmailRespondDraftBinding: sourceMocks.ensureGmailBinding,
}));
vi.mock('../../oauth/state', () => ({
  verifyAndConsumeState: async (token: string) => {
    if (!token.includes('.') || token === 'garbage.sig') {
      return { ok: false, error: 'bad-signature' };
    }
    if (token === 'google.valid' || token === 'google.missing') {
      return {
        ok: true,
        privateContext: {
          codeVerifier: 'persisted-verifier',
          ...(token === 'google.missing'
            ? {}
            : {
                ownerUserId: '22222222-2222-4222-8222-222222222222',
                workspaceId: 'workspace-1',
              }),
        },
        claims: {
          plugin: 'google-workspace',
          harness: 'papercusp',
          field: 'owner-22222222-2222-4222-8222-222222222222',
          providerHost: 'accounts.google.com',
          provider: 'google',
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
  sourceMocks.ensureGmailBinding.mockClear();
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
    const response = await GET(
      new Request('http://x/api/oauth/callback?error=access_denied&state=google.valid'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=access_denied',
    );
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

  it('provisions the owned Gmail and Calendar sources after Google token storage', async () => {
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
      }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.valid'));
    expect(response.status).toBe(307);
    expect(sourceMocks.provision).toHaveBeenCalledWith(sourceMocks.sql, {
      workspaceId: 'workspace-1',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      field: 'owner-22222222-2222-4222-8222-222222222222',
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
    });
    expect(sourceMocks.ensureGmailBinding).toHaveBeenCalledWith(
      sourceMocks.sql,
      'workspace-1',
      expect.objectContaining({ kind: 'gmail', ownerUserId: '22222222-2222-4222-8222-222222222222' }),
      'owner:22222222-2222-4222-8222-222222222222',
    );
    const cfgPath = join(TMP_HOME, 'harnesses/papercusp/plugin-configs/google-workspace.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg['owner-22222222-2222-4222-8222-222222222222']).toBe('google-access');
    expect(cfg['owner-22222222-2222-4222-8222-222222222222_refresh']).toBe('google-refresh');
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_connected=google-workspace',
    );
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
});

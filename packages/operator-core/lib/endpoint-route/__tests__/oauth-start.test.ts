/**
 * Smoke tests for GET /api/oauth/start.
 *
 * Ported from app/api/oauth/start/route.test.ts — the route is now
 * routes/oauth/start.ts. The handler is called directly. The on-first-
 * request `loadAndRegisterProvidersFromDisk()` is mocked to a no-op so
 * the test controls the provider registry entirely via registerProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateMocks = vi.hoisted(() => ({
  signState: vi.fn(async () => 'test-state-token'),
}));
const authMocks = vi.hoisted(() => ({
  getSessionUserOrDefault: vi.fn(async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    username: 'owner',
    display_name: 'Owner',
    has_password: false,
  })),
}));

vi.mock('../../oauth/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oauth/providers')>();
  return { ...actual, loadAndRegisterProvidersFromDisk: async () => {} };
});
// The state token's nonce is persisted to PG (harness_shared.oauth_nonces).
// This route test exercises route behaviour, not the nonce store — stub
// signState so the test is hermetic (no DB).
vi.mock('../../oauth/state', () => ({
  signState: stateMocks.signState,
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: authMocks.getSessionUserOrDefault,
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'workspace-1',
}));

import startRoute from '../routes/oauth/start';
import { __resetRegistryForTest, registerProvider, type OAuthProvider } from '../../oauth/providers';
import type { RouteContext } from '../define-route';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};
const GET = (req: Request) => Promise.resolve(startRoute.handler(req, CTX));

const stubProvider: OAuthProvider = {
  id: 'github',
  config: {
    clientId: 'Iv1.test',
    clientSecret: 'secret',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    redirectUri: 'http://localhost:3055/api/oauth/callback',
  },
  buildAuthorizeUrl: (scopes, state) =>
    `https://github.com/login/oauth/authorize?scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`,
  exchangeCode: async () => ({ accessToken: 'unused' }),
  refresh: async () => ({ accessToken: 'unused' }),
};

beforeEach(() => {
  __resetRegistryForTest();
  stateMocks.signState.mockClear();
  authMocks.getSessionUserOrDefault.mockClear();
});

afterEach(() => {
  __resetRegistryForTest();
});

describe('GET /api/oauth/start', () => {
  it('rejects missing params with 400', async () => {
    const r = await GET(new Request('http://x/api/oauth/start?provider=github'));
    expect(r.status).toBe(400);
  });

  it('rejects unknown providers with 404', async () => {
    const r = await GET(new Request('http://x/api/oauth/start?provider=xyz&plugin=p&harness=h&field=f'));
    expect(r.status).toBe(404);
  });

  it('redirects 302 to provider authorize URL with state attached', async () => {
    registerProvider(stubProvider);
    const r = await GET(
      new Request('http://x/api/oauth/start?provider=github&plugin=p&harness=h&field=tok&scopes=repo,read:user'),
    );
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc).toContain('https://github.com/login/oauth/authorize');
    expect(loc).toContain('scope=repo%20read%3Auser');
    expect(loc).toContain('state=');
  });

  it('persists private flow context and enforces provider scope policy', async () => {
    const buildAuthorizeUrl = vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth');
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail'],
      allowedScopes: ['scope:mail'],
      createFlowContext: () => ({ codeVerifier: 'server-only-verifier' }),
      buildAuthorizeUrl,
    });

    const ok = await GET(new Request('http://x/api/oauth/start?provider=google&plugin=p&harness=h&field=tok'));
    expect(ok.status).toBe(302);
    expect(stateMocks.signState).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }), {
      privateContext: { codeVerifier: 'server-only-verifier' },
    });
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(['scope:mail'], 'test-state-token', {
      codeVerifier: 'server-only-verifier',
    });

    const denied = await GET(
      new Request('http://x/api/oauth/start?provider=google&plugin=p&harness=h&field=tok&scopes=scope:admin'),
    );
    expect(denied.status).toBe(400);
  });

  it('captures the local user and workspace only for the Google Workspace connection', async () => {
    const buildAuthorizeUrl = vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth');
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail', 'scope:calendar'],
      allowedScopes: ['scope:mail', 'scope:calendar', 'scope:calendar-write'],
      createFlowContext: () => ({ codeVerifier: 'server-only-verifier' }),
      buildAuthorizeUrl,
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&scopes=scope:calendar-write',
        { headers: { cookie: 'papercusp_session=opaque' } },
      ),
    );
    expect(response.status).toBe(302);
    expect(authMocks.getSessionUserOrDefault).toHaveBeenCalledTimes(1);
    expect(stateMocks.signState).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        plugin: 'google-workspace',
        harness: 'papercusp',
        field: 'owner-22222222-2222-4222-8222-222222222222',
      }),
      {
        privateContext: {
          codeVerifier: 'server-only-verifier',
          ownerUserId: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'workspace-1',
          returnPath: '/settings/personal-vault',
          requestedScopes: JSON.stringify(['scope:mail', 'scope:calendar', 'scope:calendar-write']),
        },
      },
    );
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      ['scope:mail', 'scope:calendar', 'scope:calendar-write'],
      'test-state-token',
      expect.objectContaining({
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        workspaceId: 'workspace-1',
        returnPath: '/settings/personal-vault',
        requestedScopes: JSON.stringify(['scope:mail', 'scope:calendar', 'scope:calendar-write']),
      }),
    );
  });

  it('rejects a non-Google provider under the reserved Workspace plugin id', async () => {
    registerProvider(stubProvider);
    const response = await GET(
      new Request('http://x/api/oauth/start?provider=github&plugin=google-workspace&harness=papercusp&field=owner'),
    );
    expect(response.status).toBe(400);
    expect(authMocks.getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('captures the owner for Facebook Personal Vault and always requests the capability-accurate scope set', async () => {
    const buildAuthorizeUrl = vi.fn(() => 'https://www.facebook.com/dialog/oauth');
    registerProvider({
      ...stubProvider,
      id: 'facebook',
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl,
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=facebook&plugin=facebook-personal-vault&harness=papercusp&field=ignored&scopes=public_profile',
        { headers: { cookie: 'papercusp_session=opaque' } },
      ),
    );
    expect(response.status).toBe(302);
    expect(stateMocks.signState).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'facebook',
        plugin: 'facebook-personal-vault',
        harness: 'papercusp',
        field: 'owner-22222222-2222-4222-8222-222222222222',
      }),
      {
        privateContext: {
          ownerUserId: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'workspace-1',
          returnPath: '/settings/personal-vault',
        },
      },
    );
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      ['public_profile', 'user_posts', 'user_photos'],
      'test-state-token',
      expect.objectContaining({ ownerUserId: '22222222-2222-4222-8222-222222222222' }),
    );
  });

  it('rejects a non-Facebook provider under the reserved Facebook Personal Vault plugin id', async () => {
    registerProvider(stubProvider);
    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=github&plugin=facebook-personal-vault&harness=papercusp&field=owner',
      ),
    );
    expect(response.status).toBe(400);
    expect(authMocks.getSessionUserOrDefault).not.toHaveBeenCalled();
  });
});

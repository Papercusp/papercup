/**
 * Smoke tests for GET /api/oauth/start.
 *
 * Ported from app/api/oauth/start/route.test.ts — the route is now
 * routes/oauth/start.ts. The handler is called directly. The on-first-
 * request `loadAndRegisterProvidersFromDisk()` is mocked to a no-op so
 * the test controls the provider registry entirely via registerProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../oauth/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oauth/providers')>();
  return { ...actual, loadAndRegisterProvidersFromDisk: async () => {} };
});
// The state token's nonce is persisted to PG (harness_shared.oauth_nonces).
// This route test exercises route behaviour, not the nonce store — stub
// signState so the test is hermetic (no DB).
vi.mock('../../oauth/state', () => ({
  signState: async () => 'test-state-token',
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
    const r = await GET(
      new Request('http://x/api/oauth/start?provider=xyz&plugin=p&harness=h&field=f'),
    );
    expect(r.status).toBe(404);
  });

  it('redirects 302 to provider authorize URL with state attached', async () => {
    registerProvider(stubProvider);
    const r = await GET(
      new Request(
        'http://x/api/oauth/start?provider=github&plugin=p&harness=h&field=tok&scopes=repo,read:user',
      ),
    );
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc).toContain('https://github.com/login/oauth/authorize');
    expect(loc).toContain('scope=repo%20read%3Auser');
    expect(loc).toContain('state=');
  });
});

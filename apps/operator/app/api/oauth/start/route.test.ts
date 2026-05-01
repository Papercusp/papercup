/**
 * Smoke tests for the /api/oauth/start route.
 *
 * Verifies:
 *   - missing required params → 400
 *   - unknown provider → 404
 *   - happy path returns a 302 to provider authorize URL
 *
 * Provider registration is mocked via direct registerProvider() call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import {
  __resetRegistryForTest,
  registerProvider,
  type OAuthProvider,
} from '@/lib/oauth/providers';

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
    // Provider not registered.
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

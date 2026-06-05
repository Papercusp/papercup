/**
 * Smoke tests for GET /api/oauth/callback.
 *
 * Ported from app/api/oauth/callback/route.test.ts — the route is now
 * routes/oauth/callback.ts. Keeps the resetModules + doMock pattern: the
 * PG mirror in fsTokenStorage is mocked, and the on-first-request
 * provider disk-load is neutralised, so the route is re-imported fresh
 * per test and the registry is fully test-controlled.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

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
  vi.resetModules();
  vi.doMock('../../plugin-configs-pg', () => ({
    mirrorPluginConfig: async () => undefined,
  }));
  // Neutralise the on-first-request provider disk-load.
  vi.doMock('../../oauth/providers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../oauth/providers')>()),
    loadAndRegisterProvidersFromDisk: async () => {},
  }));
  // The state token's nonce is persisted to PG (harness_shared.oauth_nonces).
  // This route test exercises route behaviour, not the nonce store — stub
  // verifyAndConsumeState so the test is hermetic (no DB). Bad-signature is
  // returned for the deliberately-malformed token; valid claims otherwise.
  vi.doMock('../../oauth/state', () => ({
    verifyAndConsumeState: async (token: string) => {
      if (!token.includes('.') || token === 'garbage.sig') {
        return { ok: false, error: 'bad-signature' };
      }
      return {
        ok: true,
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
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  vi.doUnmock('../../plugin-configs-pg');
  vi.doUnmock('../../oauth/providers');
  vi.doUnmock('../../oauth/state');
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

/** Re-import the route fresh (after resetModules + doMock) and bind its handler. */
async function loadCallback() {
  const mod = await import('../routes/oauth/callback');
  return (req: Request) => Promise.resolve(mod.default.handler(req, CTX));
}

describe('GET /api/oauth/callback', () => {
  it('returns 400 when code or state is missing', async () => {
    const GET = await loadCallback();
    const r = await GET(new Request('http://x/api/oauth/callback'));
    expect(r.status).toBe(400);
  });

  it('redirects with oauth_error when provider sent error= param', async () => {
    const GET = await loadCallback();
    const r = await GET(new Request('http://x/api/oauth/callback?error=access_denied'));
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('oauth_error=access_denied');
  });

  it('rejects state with bad signature', async () => {
    const GET = await loadCallback();
    const r = await GET(new Request('http://x/api/oauth/callback?code=c&state=garbage.sig'));
    expect(r.status).toBe(400);
  });

  it('exchanges code, writes token to config on happy path', async () => {
    const providers = await import('../../oauth/providers');
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
    const GET = await loadCallback();
    const r = await GET(
      new Request('http://x/api/oauth/callback?code=abc&state=valid.token'),
    );
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('connected=github-repo');

    const cfgPath = join(TMP_HOME, 'harnesses/demo/plugin-configs/github-repo.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg.github_token).toBe('gho_realtoken');
    expect(cfg.github_token_refresh).toBe('gho_refresh');
    expect(typeof cfg.github_token_expires_at).toBe('number');
  });
});

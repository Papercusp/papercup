/**
 * Smoke tests for /api/oauth/callback.
 *
 * Verifies:
 *   - missing code/state → 400
 *   - error= query param redirects to settings with the error attached
 *   - bad-signature state → 400
 *   - happy path: exchanges code, writes token to plugin config, redirects
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-callback-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
  // PG mirror is best-effort in fsTokenStorage; mock it.
  vi.doMock('@/lib/plugin-configs-pg', () => ({
    mirrorPluginConfig: async () => undefined,
  }));
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  vi.doUnmock('@/lib/plugin-configs-pg');
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('GET /api/oauth/callback', () => {
  it('returns 400 when code or state is missing', async () => {
    const { GET } = await import('./route');
    const r = await GET(new Request('http://x/api/oauth/callback'));
    expect(r.status).toBe(400);
  });

  it('redirects with oauth_error when provider sent error= param', async () => {
    const { GET } = await import('./route');
    const r = await GET(
      new Request('http://x/api/oauth/callback?error=access_denied'),
    );
    expect(r.status).toBe(307); // NextResponse.redirect default
    expect(r.headers.get('location') ?? '').toContain('oauth_error=access_denied');
  });

  it('rejects state with bad signature', async () => {
    const { GET } = await import('./route');
    const r = await GET(
      new Request('http://x/api/oauth/callback?code=c&state=garbage.sig'),
    );
    expect(r.status).toBe(400);
  });

  it('exchanges code, writes token to config on happy path', async () => {
    const providers = await import('@/lib/oauth/providers');
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

    const { signState } = await import('@/lib/oauth/state');
    const state = signState({
      plugin: 'github-repo',
      harness: 'demo',
      field: 'github_token',
      providerHost: 'example.com',
      provider: 'github',
    });

    const { GET } = await import('./route');
    const r = await GET(
      new Request(`http://x/api/oauth/callback?code=abc&state=${encodeURIComponent(state)}`),
    );
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('connected=github-repo');

    // Token was written.
    const cfgPath = join(TMP_HOME, 'harnesses/demo/plugin-configs/github-repo.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg.github_token).toBe('gho_realtoken');
    expect(cfg.github_token_refresh).toBe('gho_refresh');
    expect(typeof cfg.github_token_expires_at).toBe('number');
  });
});

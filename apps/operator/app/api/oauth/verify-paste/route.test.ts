/**
 * Tests for /api/oauth/verify-paste.
 *
 * Verifies missing-param rejection, exact/superset/subset outcomes, and
 * that subset rejects without writing the token.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-paste-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
  vi.doMock('@/lib/plugin-configs-pg', () => ({
    mirrorPluginConfig: async () => undefined,
  }));
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  vi.doUnmock('@/lib/plugin-configs-pg');
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

async function makeProvider(introspectScopes: string[]) {
  const providers = await import('@/lib/oauth/providers');
  providers.__resetRegistryForTest();
  providers.registerProvider({
    id: 'github',
    config: {
      clientId: 'cid',
      clientSecret: 'sec',
      authorizeUrl: '',
      tokenUrl: '',
      redirectUri: '',
    },
    buildAuthorizeUrl: () => '',
    exchangeCode: async () => ({ accessToken: '' }),
    refresh: async () => ({ accessToken: '' }),
    introspect: async () => ({ scopes: introspectScopes }),
  });
}

async function postPaste(body: unknown) {
  const { POST } = await import('./route');
  return POST(new Request('http://x/api/oauth/verify-paste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/oauth/verify-paste', () => {
  it('rejects missing required params', async () => {
    const r = await postPaste({});
    expect(r.status).toBe(400);
  });

  it('exact-match accepts and writes the token', async () => {
    await makeProvider(['repo']);
    const r = await postPaste({
      provider: 'github', plugin: 'gh-repo', harness: 'h', field: 'github_token',
      token: 'ghp_abc', requiredScopes: ['repo'],
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('exact');
    const cfg = JSON.parse(await fs.readFile(join(TMP_HOME, 'harnesses/h/plugin-configs/gh-repo.json'), 'utf8'));
    expect(cfg.github_token).toBe('ghp_abc');
  });

  it('superset accepts with extra scopes flagged', async () => {
    await makeProvider(['repo', 'admin:org', 'user']);
    const r = await postPaste({
      provider: 'github', plugin: 'gh', harness: 'h', field: 'tok',
      token: 'ghp_abc', requiredScopes: ['repo'],
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('superset');
    expect(body.extra.sort()).toEqual(['admin:org', 'user']);
  });

  it('subset rejects WITHOUT writing the token', async () => {
    await makeProvider(['public_repo']);
    const r = await postPaste({
      provider: 'github', plugin: 'gh', harness: 'h', field: 'tok',
      token: 'ghp_abc', requiredScopes: ['repo'],
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.outcome).toBe('subset');
    expect(body.missing).toEqual(['repo']);
    // No file written.
    await expect(
      fs.access(join(TMP_HOME, 'harnesses/h/plugin-configs/gh.json')),
    ).rejects.toThrow();
  });

  it('accepts without scope check when provider lacks introspect', async () => {
    const providers = await import('@/lib/oauth/providers');
    providers.__resetRegistryForTest();
    providers.registerProvider({
      id: 'noscope',
      config: { clientId: 'cid', clientSecret: 's', authorizeUrl: '', tokenUrl: '', redirectUri: '' },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({ accessToken: '' }),
      refresh: async () => ({ accessToken: '' }),
    });
    const r = await postPaste({
      provider: 'noscope', plugin: 'p', harness: 'h', field: 'f',
      token: 'tok', requiredScopes: [],
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('no-introspection');
  });
});

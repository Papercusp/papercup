import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH_DEFAULTS,
  FACEBOOK_OAUTH_SCOPES,
  GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT,
  GOOGLE_CONTACTS_READONLY_SCOPE,
  GOOGLE_WORKSPACE_SCOPES,
  compareScopes,
  __resetRegistryForTest,
  getProvider,
  loadAndRegisterProvidersFromDisk,
  loadGoogleProviderFromDesktopClientFile,
  makeClaudeProvider,
  makeFacebookProvider,
  makeGithubProvider,
  makeGoogleProvider,
} from './providers';

afterEach(() => {
  vi.unstubAllGlobals();
  __resetRegistryForTest();
});

describe('compareScopes', () => {
  it('flags exact matches', () => {
    expect(compareScopes(['repo'], ['repo'])).toEqual({ kind: 'exact' });
  });

  it('flags supersets with the extra scopes listed', () => {
    const r = compareScopes(['repo', 'admin:org', 'user'], ['repo']);
    expect(r.kind).toBe('superset');
    if (r.kind === 'superset') {
      expect(r.extra.sort()).toEqual(['admin:org', 'user']);
    }
  });

  it('flags subsets with the missing scopes listed', () => {
    const r = compareScopes(['repo'], ['repo', 'workflow']);
    expect(r.kind).toBe('subset');
    if (r.kind === 'subset') {
      expect(r.missing).toEqual(['workflow']);
    }
  });

  it('subset-rejection wins over superset-warning when both apply', () => {
    // Granted has 'extra' but is missing 'workflow' — must be `subset`.
    const r = compareScopes(['repo', 'extra'], ['repo', 'workflow']);
    expect(r.kind).toBe('subset');
  });

  it('handles empty grants and requirements gracefully', () => {
    expect(compareScopes([], []).kind).toBe('exact');
    expect(compareScopes(['repo'], [])).toEqual({ kind: 'superset', extra: ['repo'] });
    expect(compareScopes([], ['repo'])).toEqual({ kind: 'subset', missing: ['repo'] });
  });
});

describe('GitHub provider authorize URL', () => {
  const provider = makeGithubProvider({
    clientId: 'Iv1.test',
    clientSecret: 'secret',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    redirectUri: 'http://localhost:3055/api/oauth/callback?provider=github',
  });

  it('includes client_id, redirect_uri, scope, state', () => {
    const url = new URL(provider.buildAuthorizeUrl(['repo', 'read:user'], 'STATE_TOKEN'));
    expect(url.searchParams.get('client_id')).toBe('Iv1.test');
    expect(url.searchParams.get('scope')).toBe('repo read:user');
    expect(url.searchParams.get('state')).toBe('STATE_TOKEN');
    expect(url.searchParams.get('redirect_uri')).toContain('localhost:3055');
  });
});

describe('Google Workspace Desktop OAuth provider', () => {
  const config = {
    clientId: 'google-client.apps.googleusercontent.com',
    clientSecret: 'desktop-secret',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    redirectUri: 'http://127.0.0.1:3070/api/oauth/callback',
  };

  it('requests the complete least-privilege scope set for Gmail, Calendar, and Personal Vault Contacts', () => {
    expect(GOOGLE_WORKSPACE_SCOPES).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      GOOGLE_CONTACTS_READONLY_SCOPE,
    ]);
    expect(GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT).toBe(
      'https://people.googleapis.com/v1/people/me/connections',
    );
  });

  it('keeps the verifier server-side and sends only its S256 challenge', async () => {
    const provider = makeGoogleProvider(config);
    const privateContext = await provider.createFlowContext!();
    const url = new URL(provider.buildAuthorizeUrl([], 'STATE_TOKEN', privateContext));

    expect(url.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_WORKSPACE_SCOPES);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.toString()).not.toContain(privateContext.codeVerifier!);
  });

  it('requires the persisted verifier and uses it during code exchange', async () => {
    const provider = makeGoogleProvider(config);
    await expect(provider.exchangeCode('code-without-context')).rejects.toThrow(/PKCE verifier/);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: GOOGLE_WORKSPACE_SCOPES.join(' '),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const privateContext = { codeVerifier: 'persisted-verifier' };
    const tokens = await provider.exchangeCode('authorization-code', privateContext);

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('code_verifier')).toBe('persisted-verifier');
    expect(tokens.refreshToken).toBe('refresh');
  });

  it('loads only the installed credential shape from the well-known JSON format', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'papercusp-google-oauth-'));
    const path = join(dir, 'client.json');
    try {
      await fs.writeFile(
        path,
        JSON.stringify({
          installed: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            auth_uri: config.authorizeUrl,
            token_uri: config.tokenUrl,
            redirect_uris: ['http://localhost'],
          },
        }),
        { mode: 0o600 },
      );
      const provider = await loadGoogleProviderFromDesktopClientFile(path, config.redirectUri);
      expect(provider?.id).toBe('google');
      expect(provider?.config.clientId).toBe(config.clientId);

      await fs.writeFile(path, JSON.stringify({ web: { client_id: config.clientId } }));
      await expect(loadGoogleProviderFromDesktopClientFile(path, config.redirectUri)).rejects.toThrow(
        /Desktop app credential/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Meta / Facebook OAuth provider', () => {
  const config = {
    clientId: 'facebook-app-id',
    clientSecret: 'facebook-app-secret',
    authorizeUrl: 'https://www.facebook.com/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/oauth/access_token',
    redirectUri: 'http://127.0.0.1:3070/api/oauth/callback',
  };

  it('allowlists the owner profile/posts/photos scopes and exchanges for a long-lived token', async () => {
    const provider = makeFacebookProvider(config);
    const authorize = new URL(provider.buildAuthorizeUrl([], 'STATE_TOKEN'));
    expect(authorize.searchParams.get('scope')?.split(',')).toEqual(FACEBOOK_OAUTH_SCOPES);
    expect(authorize.searchParams.get('state')).toBe('STATE_TOKEN');

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'short-token', expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'long-token', expires_in: 5_184_000 }));
    vi.stubGlobal('fetch', fetchMock);
    const token = await provider.exchangeCode('authorization-code');

    expect(token.accessToken).toBe('long-token');
    expect(token.refreshToken).toBe('long-token');
    expect(token.scopes).toEqual(FACEBOOK_OAUTH_SCOPES);
    const longExchange = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(longExchange.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(longExchange.searchParams.get('fb_exchange_token')).toBe('short-token');
    expect(longExchange.searchParams.get('client_secret')).toBe(config.clientSecret);
  });

  it('loads the app secret only from external oauth-apps configuration', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'papercusp-facebook-oauth-'));
    const secretPath = join(dir, 'facebook.secret');
    try {
      await fs.writeFile(secretPath, config.clientSecret, { mode: 0o600 });
      await fs.writeFile(
        join(dir, 'oauth-apps.json'),
        JSON.stringify({
          facebook: {
            clientId: config.clientId,
            clientSecretFile: secretPath,
            redirectUri: config.redirectUri,
          },
        }),
        { mode: 0o600 },
      );
      await expect(loadAndRegisterProvidersFromDisk(dir, null)).resolves.toEqual(['facebook']);
      const provider = getProvider('facebook');
      expect(provider?.allowedScopes).toEqual(FACEBOOK_OAUTH_SCOPES);
      expect(provider?.config.clientSecret).toBe(config.clientSecret);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude provider endpoints (EI-553 regression)', () => {
  // Pins CLAUDE_OAUTH_DEFAULTS to the hosts confirmed live against the `claude` CLI's
  // own bundled OAuth config (v2.1.212) — catches a future silent re-drift back to the
  // retired `claude.ai` / `console.anthropic.com` hosts.
  it('defaults to the current claude.com/cai + platform.claude.com hosts, not the retired ones', () => {
    expect(CLAUDE_OAUTH_DEFAULTS.authorizeUrl).toBe('https://claude.com/cai/oauth/authorize');
    expect(CLAUDE_OAUTH_DEFAULTS.tokenUrl).toBe('https://platform.claude.com/v1/oauth/token');
    expect(CLAUDE_OAUTH_DEFAULTS.redirectUri).toBe('https://platform.claude.com/oauth/code/callback');
    // The client_id is UNCHANGED across the host migration — same PKCE client, re-hosted.
    expect(CLAUDE_OAUTH_DEFAULTS.clientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });

  it('builds an authorize URL on the live host with the PKCE params intact', () => {
    const provider = makeClaudeProvider({ codeVerifier: 'test-verifier' });
    const url = new URL(provider.buildAuthorizeUrl([], 'STATE_TOKEN'));
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_DEFAULTS.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE_TOKEN');
  });
});

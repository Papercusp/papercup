import { describe, expect, it } from 'vitest';
import { CLAUDE_OAUTH_DEFAULTS, compareScopes, makeClaudeProvider, makeGithubProvider } from './providers';

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

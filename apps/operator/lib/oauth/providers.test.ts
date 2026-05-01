import { describe, expect, it } from 'vitest';
import { compareScopes, makeGithubProvider } from './providers';

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

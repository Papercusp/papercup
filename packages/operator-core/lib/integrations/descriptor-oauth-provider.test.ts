import { describe, expect, it } from 'vitest';
import { makeDescriptorOAuthProvider } from './connection-lifecycle';

/**
 * The authorize URL a provider descriptor produces (linear-asana-task-sync-2026-10-05 P-004).
 * Linear documents a comma-separated `scope` and installs as an app user with `actor=app`, which
 * the descriptor carries in its own authorize URL; a REST provider keeps the space default.
 */
const client = { clientId: 'client-1', redirectUri: 'https://papercusp.test/oauth/callback' };

function authorize(oauth: Parameters<typeof makeDescriptorOAuthProvider>[1]): URL {
  const provider = makeDescriptorOAuthProvider('provider:example', oauth, client);
  return new URL(provider.buildAuthorizeUrl(oauth.scopes, 'state-1'));
}

describe('makeDescriptorOAuthProvider: authorize URL', () => {
  it('joins scopes with the declared comma and keeps the descriptor URL\'s own query (actor=app)', () => {
    const url = authorize({
      authorizeUrl: 'https://linear.app/oauth/authorize?actor=app',
      tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: ['read', 'write', 'app:assignable', 'app:mentionable'],
      scopeSeparator: ',',
    });
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read,write,app:assignable,app:mentionable');
    expect(url.searchParams.get('actor')).toBe('app');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('joins scopes with a space when no separator is declared', () => {
    const url = authorize({
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:user'],
    });
    expect(url.searchParams.get('scope')).toBe('repo read:user');
    expect(url.searchParams.has('actor')).toBe(false);
  });
});

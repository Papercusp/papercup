import { describe, expect, it } from 'vitest';
import {
  OAuthScopeError,
  clientSecretMatches,
  formatOAuthScope,
  isAuthorizationCode,
  isRequestHandle,
  isValidCodeChallenge,
  newAuthorizationCode,
  newRequestHandle,
  parseOAuthScope,
  pkceMatches,
  pkceS256,
  redirectUriProblem,
  sha256Hex,
  validateRegistration,
  type OAuthClient,
} from './mcp-oauth';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  publicOriginOf,
} from './mcp-oauth-discovery';

// RFC 7636 Appendix B — an independent oracle, not computed with the code under test.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('OAuth scope strings (P-006)', () => {
  it('parses tool and harness tokens, de-duplicated', () => {
    expect(parseOAuthScope('tool:plans:get tool:work_items:* harness:papercusp tool:plans:get')).toEqual({
      tools: ['plans:get', 'work_items:*'],
      harnesses: ['papercusp'],
    });
  });

  it('treats an absent or empty scope as no requested narrowing', () => {
    expect(parseOAuthScope(null)).toEqual({});
    expect(parseOAuthScope('   ')).toEqual({});
  });

  it('refuses any other token rather than ignoring it', () => {
    expect(() => parseOAuthScope('tool:plans:get openid')).toThrow(OAuthScopeError);
    expect(() => parseOAuthScope('tool:')).toThrow(OAuthScopeError);
    expect(() => parseOAuthScope('harness:')).toThrow(OAuthScopeError);
  });

  it('formats back to the same scope string', () => {
    const scopes = { tools: ['plans:get'], harnesses: ['papercusp'] };
    expect(parseOAuthScope(formatOAuthScope(scopes))).toEqual(scopes);
  });
});

describe('PKCE S256', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(pkceS256(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
    expect(pkceMatches(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge(RFC_CHALLENGE)).toBe(true);
  });

  it('refuses a wrong verifier, a malformed verifier and a malformed challenge', () => {
    expect(pkceMatches(`${RFC_VERIFIER.slice(0, -1)}A`, RFC_CHALLENGE)).toBe(false);
    expect(pkceMatches('short', RFC_CHALLENGE)).toBe(false);
    expect(pkceMatches(undefined, RFC_CHALLENGE)).toBe(false);
    expect(isValidCodeChallenge('plain-text-challenge')).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
  });
});

describe('redirect URI rules', () => {
  it('allows https, loopback http and a private-use scheme', () => {
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback')).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1:33418/callback')).toBeNull();
    expect(redirectUriProblem('http://localhost:6274/oauth/callback')).toBeNull();
    expect(redirectUriProblem('com.example.app:/oauth2redirect')).toBeNull();
  });

  it('refuses non-loopback http, a fragment, script/data/file schemes and garbage', () => {
    expect(redirectUriProblem('http://evil.example/cb')).toMatch(/loopback/);
    expect(redirectUriProblem('https://claude.ai/cb#frag')).toMatch(/fragment/);
    expect(redirectUriProblem('javascript:alert(1)')).toMatch(/not allowed/);
    expect(redirectUriProblem('data:text/html,x')).toMatch(/not allowed/);
    expect(redirectUriProblem('file:///etc/passwd')).toMatch(/not allowed/);
    expect(redirectUriProblem('not a uri')).toMatch(/absolute/);
    expect(redirectUriProblem('')).not.toBeNull();
  });
});

describe('dynamic client registration', () => {
  it('accepts a public client with the defaults the MCP SDK sends', () => {
    const verdict = validateRegistration({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(verdict).toEqual({
      ok: true,
      value: { clientName: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], tokenEndpointAuthMethod: 'none' },
    });
  });

  it('strips markup and control characters from the displayed name', () => {
    const verdict = validateRegistration({ client_name: '<b>Evil</b>\u0007 App', redirect_uris: ['https://a.example/cb'] });
    expect(verdict.ok && verdict.value.clientName).toBe('bEvil/b App');
  });

  it('refuses bad redirect URIs, an unknown auth method and implicit/other grants', () => {
    expect(validateRegistration({ redirect_uris: [] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(validateRegistration({ redirect_uris: ['http://evil.example/cb'] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(validateRegistration({ redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'private_key_jwt' })).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
    });
    expect(validateRegistration({ redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] })).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
    });
    expect(validateRegistration({ redirect_uris: ['https://a.example/cb'], response_types: ['token'] })).toMatchObject({
      ok: false,
      error: 'invalid_client_metadata',
    });
  });
});

describe('client authentication at the token endpoint', () => {
  const base: OAuthClient = {
    clientId: 'pcoc_abcdefghijklmnopqrstuv',
    clientName: 'x',
    redirectUris: ['https://a.example/cb'],
    tokenEndpointAuthMethod: 'client_secret_post',
    clientSecretHash: sha256Hex('s3cret'),
    createdAt: new Date(0),
  };

  it('checks a confidential client secret', () => {
    expect(clientSecretMatches(base, 's3cret')).toBe(true);
    expect(clientSecretMatches(base, 'wrong')).toBe(false);
    expect(clientSecretMatches(base, null)).toBe(false);
  });

  it('lets a public client through without a secret (PKCE binds it instead)', () => {
    expect(clientSecretMatches({ ...base, tokenEndpointAuthMethod: 'none', clientSecretHash: null }, null)).toBe(true);
  });
});

describe('request handles and authorization codes', () => {
  it('mints values their own validators accept, and nothing else passes', () => {
    const handle = newRequestHandle();
    const code = newAuthorizationCode();
    expect(isRequestHandle(handle)).toBe(true);
    expect(isAuthorizationCode(code)).toBe(true);
    expect(isRequestHandle(code)).toBe(false);
    expect(isAuthorizationCode(handle)).toBe(false);
    expect(newRequestHandle()).not.toBe(handle);
  });
});

describe('discovery documents', () => {
  it('names the MCP endpoint as the resource and this origin as the issuer', () => {
    const origin = 'https://ws.example.org';
    expect(protectedResourceMetadata(origin)).toMatchObject({
      resource: 'https://ws.example.org/api/mcp',
      authorization_servers: [origin],
    });
    expect(authorizationServerMetadata(origin)).toMatchObject({
      issuer: origin,
      authorization_endpoint: 'https://ws.example.org/api/connected-apps/oauth/authorize',
      token_endpoint: 'https://ws.example.org/api/connected-apps/oauth/token',
      registration_endpoint: 'https://ws.example.org/api/connected-apps/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });
    expect(protectedResourceMetadataUrl(origin)).toBe('https://ws.example.org/.well-known/oauth-protected-resource/api/mcp');
  });

  it('takes the scheme from the tunnel and the host from the URL the client addressed', () => {
    expect(publicOriginOf(new Request('http://ws.example.org/api/mcp', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(
      'https://ws.example.org',
    );
    expect(publicOriginOf(new Request('http://127.0.0.1:3070/api/mcp'))).toBe('http://127.0.0.1:3070');
    expect(publicOriginOf(new Request('http://a.example/x', { headers: { 'x-forwarded-proto': 'gopher' } }))).toBe('http://a.example');
  });
});

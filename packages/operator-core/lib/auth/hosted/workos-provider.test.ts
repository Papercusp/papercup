import { describe, expect, it, vi } from 'vitest';
import {
  createWorkOSHostedIdentityProvider,
  type WorkOSClientLike,
  type WorkOSSealedSessionRecord,
  type WorkOSSealedSessionVault,
} from './workos-provider';
import type { WorkOSHostedIdentitySecretResolver } from './workos-config';

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;
const API_KEY = 'api-key-test-value';
const COOKIE_PASSWORD = 'cookie-password-test-value-that-is-long-enough';
const SEALED_SESSION = 'sealed-session-test-value';

function accessToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    sid: 'session_test_001',
    iat: NOW_SECONDS - 60,
    auth_time: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 3_600,
    nonce: 'nonce_test_001',
    amr: ['pwd', 'mfa'],
    role: 'upstream-role-that-must-be-ignored',
    permissions: ['upstream:permission-that-must-be-ignored'],
    ...overrides,
  };
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature-verified-by-sdk-test-double',
  ].join('.');
}

function workOSUser() {
  return {
    object: 'user' as const,
    id: 'user_test_001',
    email: 'verified@example.test',
    emailVerified: true,
    profilePictureUrl: 'https://identity.test/avatar/user_test_001',
    name: 'Verified Test User',
    firstName: 'Verified',
    lastName: 'User',
    lastSignInAt: null,
    locale: 'en-US',
    createdAt: new Date(NOW_MS - 86_400_000).toISOString(),
    updatedAt: new Date(NOW_MS - 60_000).toISOString(),
    externalId: null,
    metadata: {},
  };
}

function authenticatedSession(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true as const,
    accessToken: accessToken(),
    authenticationMethod: 'SSO' as const,
    sessionId: 'session_test_001',
    organizationId: 'organization_test_001',
    user: workOSUser(),
    ...overrides,
  };
}

class MemorySessionVault implements WorkOSSealedSessionVault {
  readonly records = new Map<string, WorkOSSealedSessionRecord>();
  readonly deletes: string[] = [];

  async get(externalSessionId: string): Promise<WorkOSSealedSessionRecord | null> {
    return this.records.get(externalSessionId) ?? null;
  }

  async put(record: WorkOSSealedSessionRecord): Promise<void> {
    this.records.set(record.externalSessionId, record);
  }

  async delete(externalSessionId: string): Promise<void> {
    this.deletes.push(externalSessionId);
    this.records.delete(externalSessionId);
  }
}

function makeClient(options: {
  authenticated?: ReturnType<typeof authenticatedSession>;
  authenticateWithCodeError?: unknown;
  revokeError?: unknown;
} = {}) {
  const session = options.authenticated ?? authenticatedSession();
  const getAuthorizationUrl = vi.fn(() => 'https://auth.workos.test/authorize');
  const authenticateWithCode = options.authenticateWithCodeError
    ? vi.fn(async () => {
        throw options.authenticateWithCodeError;
      })
    : vi.fn(async () => ({
        user: workOSUser(),
        organizationId: 'organization_test_001',
        accessToken: accessToken(),
        refreshToken: 'refresh-token-never-leaves-sdk',
        authenticationMethod: 'SSO' as const,
        sealedSession: SEALED_SESSION,
      }));
  const authenticate = vi.fn(async () => session);
  const loadSealedSession = vi.fn(() => ({ authenticate }));
  const getLogoutUrl = vi.fn(
    ({ sessionId, returnTo }: { sessionId: string; returnTo?: string }) =>
      `https://auth.workos.test/logout?session_id=${encodeURIComponent(sessionId)}&return_to=${encodeURIComponent(returnTo ?? '')}`,
  );
  const revokeSession = options.revokeError
    ? vi.fn(async () => {
        throw options.revokeError;
      })
    : vi.fn(async () => undefined);
  const client: WorkOSClientLike = {
    userManagement: {
      getAuthorizationUrl,
      authenticateWithCode,
      loadSealedSession,
      getLogoutUrl,
      revokeSession,
    },
  };
  return {
    client,
    calls: {
      getAuthorizationUrl,
      authenticateWithCode,
      authenticate,
      loadSealedSession,
      getLogoutUrl,
      revokeSession,
    },
  };
}

function makeProvider(options: Parameters<typeof makeClient>[0] = {}) {
  const vault = new MemorySessionVault();
  const mock = makeClient(options);
  const resolveSecret: WorkOSHostedIdentitySecretResolver = vi.fn(async (reference) => {
    if (reference === 'secret-ref:workos-api-key') return API_KEY;
    if (reference === 'secret-ref:workos-cookie-password') return COOKIE_PASSWORD;
    return undefined;
  });
  const createClient = vi.fn(() => mock.client);
  const provider = createWorkOSHostedIdentityProvider({
    configuration: {
      clientId: 'client_test_001',
      apiKeyRef: 'secret-ref:workos-api-key',
      cookiePasswordRef: 'secret-ref:workos-cookie-password',
    },
    resolveSecret,
    sessionVault: vault,
    createClient,
    now: () => NOW_MS,
  });
  return { provider, vault, resolveSecret, createClient, ...mock };
}

describe('WorkOSHostedIdentityProvider', () => {
  it('resolves opaque secret refs only at use and delegates PKCE/state/nonce to AuthKit', async () => {
    const { provider, resolveSecret, createClient, calls } = makeProvider();

    const result = await provider.beginSignIn({
      redirectUri: 'https://app.papercusp.com/auth/callback',
      state: 'state_test_001',
      nonce: 'nonce_test_001',
      pkce: { challenge: 'challenge_test_001', method: 'S256' },
      intent: 'sign-in',
      organizationHint: {
        kind: 'external-organization-id',
        externalOrganizationId: 'organization_test_001',
      },
    });

    expect(result).toEqual({
      ok: true,
      value: { authorizationUrl: 'https://auth.workos.test/authorize' },
    });
    expect(resolveSecret).toHaveBeenCalledWith('secret-ref:workos-api-key', {
      providerId: 'workos',
      secret: 'api-key',
    });
    expect(createClient).toHaveBeenCalledWith({ apiKey: API_KEY, clientId: 'client_test_001' });
    expect(calls.getAuthorizationUrl).toHaveBeenCalledWith({
      clientId: 'client_test_001',
      provider: 'authkit',
      redirectUri: 'https://app.papercusp.com/auth/callback',
      state: 'state_test_001',
      claimNonce: 'nonce_test_001',
      codeChallenge: 'challenge_test_001',
      codeChallengeMethod: 'S256',
      screenHint: 'sign-in',
      organizationId: 'organization_test_001',
    });
    expect(JSON.stringify(provider)).not.toContain(API_KEY);
    expect(JSON.stringify(provider)).not.toContain(COOKIE_PASSWORD);
  });

  it('exchanges the callback, re-verifies the sealed session, and returns identity without authority', async () => {
    const { provider, vault, calls } = makeProvider();

    const result = await provider.exchangeCallback({
      code: 'authorization-code-test-value',
      redirectUri: 'https://app.papercusp.com/auth/callback',
      pkceCodeVerifier: 'pkce-verifier-test-value',
      expectedNonce: 'nonce_test_001',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.safeMessage);
    expect(calls.authenticateWithCode).toHaveBeenCalledWith({
      clientId: 'client_test_001',
      code: 'authorization-code-test-value',
      codeVerifier: 'pkce-verifier-test-value',
      session: { sealSession: true, cookiePassword: COOKIE_PASSWORD },
    });
    expect(calls.loadSealedSession).toHaveBeenCalledWith({
      sessionData: SEALED_SESSION,
      cookiePassword: COOKIE_PASSWORD,
    });
    expect(result.value).toMatchObject({
      externalSessionId: 'session_test_001',
      identity: {
        externalUserId: 'user_test_001',
        primaryEmail: 'verified@example.test',
        emailVerified: true,
      },
      externalOrganizationId: 'organization_test_001',
      issuedAtMs: NOW_MS - 60_000,
      authenticatedAtMs: NOW_MS - 30_000,
      expiresAtMs: NOW_MS + 3_600_000,
      authenticationMethods: ['pwd', 'mfa', 'sso'],
      mfaVerified: true,
    });
    expect(result.value).not.toHaveProperty('role');
    expect(result.value).not.toHaveProperty('permissions');
    expect(result.value).not.toHaveProperty('accessToken');
    expect(result.value).not.toHaveProperty('sealedSession');
    expect(vault.records.get('session_test_001')).toEqual({
      externalSessionId: 'session_test_001',
      sealedSession: SEALED_SESSION,
      expiresAtMs: NOW_MS + 3_600_000,
    });
  });

  it('accepts WorkOS sealed sessions that omit nonce after the route-bound PKCE exchange', async () => {
    const absentNonce = makeProvider({
      authenticated: authenticatedSession({ accessToken: accessToken({ nonce: undefined }) }),
    });

    await expect(
      absentNonce.provider.exchangeCallback({
        code: 'authorization-code-test-value',
        redirectUri: 'https://app.papercusp.com/auth/callback',
        pkceCodeVerifier: 'pkce-verifier-test-value',
        expectedNonce: 'nonce_test_001',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { externalSessionId: 'session_test_001' },
    });
    expect(absentNonce.vault.records.has('session_test_001')).toBe(true);
  });

  it('fails closed on nonce mismatch and unverified email without persisting a session', async () => {
    const nonceMismatch = makeProvider({
      authenticated: authenticatedSession({ accessToken: accessToken({ nonce: 'wrong-nonce' }) }),
    });
    await expect(
      nonceMismatch.provider.exchangeCallback({
        code: 'authorization-code-test-value',
        redirectUri: 'https://app.papercusp.com/auth/callback',
        pkceCodeVerifier: 'pkce-verifier-test-value',
        expectedNonce: 'nonce_test_001',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_callback' } });
    expect(nonceMismatch.vault.records.size).toBe(0);

    const unverified = makeProvider({
      authenticated: authenticatedSession({
        user: { ...workOSUser(), emailVerified: false },
      }),
    });
    await expect(
      unverified.provider.exchangeCallback({
        code: 'authorization-code-test-value',
        redirectUri: 'https://app.papercusp.com/auth/callback',
        pkceCodeVerifier: 'pkce-verifier-test-value',
        expectedNonce: 'nonce_test_001',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'identity_not_verified' } });
    expect(unverified.vault.records.size).toBe(0);
  });

  it('validates only a vault-held sealed session and expires it locally', async () => {
    const active = makeProvider();
    await active.provider.exchangeCallback({
      code: 'authorization-code-test-value',
      redirectUri: 'https://app.papercusp.com/auth/callback',
      pkceCodeVerifier: 'pkce-verifier-test-value',
      expectedNonce: 'nonce_test_001',
    });
    await expect(
      active.provider.validateSession({ externalSessionId: 'session_test_001' }),
    ).resolves.toMatchObject({ ok: true, value: { externalSessionId: 'session_test_001' } });
    await expect(
      active.provider.validateSession({ externalSessionId: 'session_unknown' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_session' } });

    active.vault.records.set('session_expired', {
      externalSessionId: 'session_expired',
      sealedSession: SEALED_SESSION,
      expiresAtMs: NOW_MS,
    });
    await expect(
      active.provider.validateSession({ externalSessionId: 'session_expired' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'session_expired' } });
    expect(active.vault.records.has('session_expired')).toBe(false);
  });

  it('maps SDK errors to correlation-only, secret-safe failures', async () => {
    const { provider } = makeProvider({
      authenticateWithCodeError: {
        status: 429,
        code: 'rate_limit_exceeded',
        requestID: 'request_test_001',
        retryAfter: 2,
        message: 'raw provider error contained authorization-code-test-value',
        rawData: { access_token: 'provider-token-that-must-not-escape' },
      },
    });

    const result = await provider.exchangeCallback({
      code: 'authorization-code-test-value',
      redirectUri: 'https://app.papercusp.com/auth/callback',
      pkceCodeVerifier: 'pkce-verifier-test-value',
      expectedNonce: 'nonce_test_001',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'rate_limited',
        safeMessage: 'Hosted identity is temporarily rate limited.',
        retryable: true,
        providerCode: 'rate_limit_exceeded',
        requestId: 'request_test_001',
        retryAfterMs: 2_000,
      },
    });
    expect(JSON.stringify(result)).not.toContain('authorization-code-test-value');
    expect(JSON.stringify(result)).not.toContain('provider-token-that-must-not-escape');
  });

  it('builds logout URLs and deletes the local sealed session even when upstream revocation fails', async () => {
    const { provider, vault, calls } = makeProvider({
      revokeError: { status: 503, requestID: 'request_test_002' },
    });
    vault.records.set('session_test_001', {
      externalSessionId: 'session_test_001',
      sealedSession: SEALED_SESSION,
      expiresAtMs: NOW_MS + 3_600_000,
    });

    const logout = await provider.beginLogout({
      externalSessionId: 'session_test_001',
      postLogoutRedirectUri: 'https://app.papercusp.com/signed-out',
    });
    expect(logout).toMatchObject({ ok: true });
    expect(calls.getLogoutUrl).toHaveBeenCalledWith({
      sessionId: 'session_test_001',
      returnTo: 'https://app.papercusp.com/signed-out',
    });

    await expect(
      provider.revokeSession({
        externalSessionId: 'session_test_001',
        reason: 'user_logout',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_unavailable', retryable: true },
    });
    expect(vault.records.has('session_test_001')).toBe(false);
    expect(vault.deletes).toContain('session_test_001');
  });

  it('returns a generic configuration error without exposing missing refs', async () => {
    const vault = new MemorySessionVault();
    const client = makeClient();
    const createClient = vi.fn(() => client.client);
    const provider = createWorkOSHostedIdentityProvider({
      configuration: {
        clientId: 'client_test_001',
        apiKeyRef: 'secret-ref:missing-provider-key',
        cookiePasswordRef: 'secret-ref:missing-cookie-password',
      },
      resolveSecret: async () => undefined,
      sessionVault: vault,
      createClient,
    });

    const result = await provider.beginSignIn({
      redirectUri: 'https://app.papercusp.com/auth/callback',
      state: 'state_test_001',
      nonce: 'nonce_test_001',
      pkce: { challenge: 'challenge_test_001', method: 'S256' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'configuration_error', safeMessage: 'Hosted identity is not configured.' },
    });
    expect(JSON.stringify(result)).not.toContain('missing-provider-key');
    expect(createClient).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  createFakeHostedIdentityProvider,
  FAKE_HOSTED_IDENTITY_NOW_MS,
  FAKE_HOSTED_IDENTITY_SESSION,
} from './fake-provider';
import {
  hostedIdentityProviderFailure,
  type HostedIdentityProvider,
  type HostedIdentityProviderError,
  type HostedSignInInput,
} from './provider';

const SIGN_IN_INPUT: HostedSignInInput = {
  redirectUri: 'https://app.papercusp.com/auth/callback',
  state: 'state_test_001',
  nonce: 'nonce_test_001',
  pkce: { challenge: 'challenge_test_001', method: 'S256' },
  intent: 'sign-in',
  organizationHint: {
    kind: 'external-organization-id',
    externalOrganizationId: 'organization_test_001',
  },
};

describe('HostedIdentityProvider contract fake', () => {
  it('implements the provider seam and deterministically records sign-in initiation', async () => {
    const provider: HostedIdentityProvider = createFakeHostedIdentityProvider();

    const first = await provider.beginSignIn(SIGN_IN_INPUT);
    const second = await provider.beginSignIn(SIGN_IN_INPUT);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.safeMessage);

    const url = new URL(first.value.authorizationUrl);
    expect(url.origin).toBe('https://identity.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: SIGN_IN_INPUT.redirectUri,
      state: SIGN_IN_INPUT.state,
      nonce: SIGN_IN_INPUT.nonce,
      code_challenge: SIGN_IN_INPUT.pkce.challenge,
      code_challenge_method: 'S256',
      screen_hint: 'sign-in',
      organization_id: 'organization_test_001',
    });
  });

  it('normalizes a callback into verified, non-authorizing identity/session facts', async () => {
    const provider = createFakeHostedIdentityProvider();

    const result = await provider.exchangeCallback({
      code: 'authorization_code_test_001',
      redirectUri: SIGN_IN_INPUT.redirectUri,
      pkceCodeVerifier: 'verifier_test_001',
      expectedNonce: SIGN_IN_INPUT.nonce,
    });

    expect(result).toEqual({ ok: true, value: FAKE_HOSTED_IDENTITY_SESSION });
    if (!result.ok) throw new Error(result.error.safeMessage);
    expect(result.value.identity.emailVerified).toBe(true);
    expect(result.value).not.toHaveProperty('capabilities');
    expect(result.value).not.toHaveProperty('roles');
    expect(result.value).not.toHaveProperty('accessToken');
    expect(result.value).not.toHaveProperty('refreshToken');
    expect(result.value.identity).not.toHaveProperty('password');
  });

  it('validates the seeded session and fails closed for unknown sessions', async () => {
    const provider = createFakeHostedIdentityProvider();

    await expect(
      provider.validateSession({ externalSessionId: FAKE_HOSTED_IDENTITY_SESSION.externalSessionId }),
    ).resolves.toEqual({ ok: true, value: FAKE_HOSTED_IDENTITY_SESSION });
    await expect(
      provider.validateSession({ externalSessionId: 'session_unknown' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_session',
        safeMessage: 'The hosted identity session is not valid.',
        retryable: false,
      },
    });
  });

  it('makes revocation observable to subsequent validation', async () => {
    const provider = createFakeHostedIdentityProvider();

    await expect(
      provider.revokeSession({
        externalSessionId: FAKE_HOSTED_IDENTITY_SESSION.externalSessionId,
        reason: 'user_logout',
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        externalSessionId: FAKE_HOSTED_IDENTITY_SESSION.externalSessionId,
        revokedAtMs: FAKE_HOSTED_IDENTITY_NOW_MS,
      },
    });

    await expect(
      provider.validateSession({ externalSessionId: FAKE_HOSTED_IDENTITY_SESSION.externalSessionId }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'session_revoked' } });
  });

  it('deterministically constructs the upstream logout initiation', async () => {
    const provider = createFakeHostedIdentityProvider();
    const result = await provider.beginLogout({
      externalSessionId: FAKE_HOSTED_IDENTITY_SESSION.externalSessionId,
      postLogoutRedirectUri: 'https://app.papercusp.com/signed-out',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.safeMessage);
    const url = new URL(result.value.logoutUrl ?? '');
    expect(url.origin).toBe('https://identity.test');
    expect(url.searchParams.get('session_id')).toBe(FAKE_HOSTED_IDENTITY_SESSION.externalSessionId);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://app.papercusp.com/signed-out',
    );
  });

  it('supports secret-safe scripted provider failures for consumer tests', async () => {
    const error: HostedIdentityProviderError = {
      code: 'provider_unavailable',
      safeMessage: 'Hosted identity is temporarily unavailable.',
      retryable: true,
      requestId: 'request_test_001',
      retryAfterMs: 1_000,
    };
    const provider = createFakeHostedIdentityProvider({
      script: { exchangeCallback: hostedIdentityProviderFailure(error) },
    });

    await expect(
      provider.exchangeCallback({
        code: 'authorization_code_test_001',
        redirectUri: SIGN_IN_INPUT.redirectUri,
        pkceCodeVerifier: 'verifier_test_001',
        expectedNonce: SIGN_IN_INPUT.nonce,
      }),
    ).resolves.toEqual({ ok: false, error });
  });
});

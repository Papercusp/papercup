import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_TOKEN_TTL_SECONDS,
  appAuthSecretEnvVar,
  appServiceAuthHeader,
  hasAppAuthSecret,
  mintAppServiceToken,
  readAppAuthSecret,
} from './app-auth';

const requireCjs = createRequire(import.meta.url);
const { jwtVerify } = requireCjs('jose') as typeof import('jose');

const SECRET = 'test-shared-secret-value';
const originalEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
});

/**
 * The apps' verification, reproduced EXACTLY as apps/sidecar/src/auth.ts does
 * it in both the email and calendar repos. Asserting against a re-implementation
 * of the real verifier is the point of these tests: a token that merely signs
 * cleanly proves nothing about whether the app would accept it.
 */
async function verifyAsApp(token: string, audience: string, secret = SECRET) {
  const verified = await jwtVerify(token, new TextEncoder().encode(secret), { audience });
  return String(verified.payload.sub ?? '').trim();
}

describe('app service auth (P-004)', () => {
  it('derives the secret env var each app reads', () => {
    expect(appAuthSecretEnvVar('email')).toBe('EMAIL_AUTH_SECRET');
    expect(appAuthSecretEnvVar('calendar')).toBe('CALENDAR_AUTH_SECRET');
  });

  it('mints a token the EMAIL app accepts, carrying the mapped owner as sub', async () => {
    const token = await mintAppServiceToken('email', 'owner-42', { secret: SECRET });
    expect(await verifyAsApp(token, 'papercusp-email')).toBe('owner-42');
  });

  it('mints a token the CALENDAR app accepts', async () => {
    const token = await mintAppServiceToken('calendar', 'owner-7', { secret: SECRET });
    expect(await verifyAsApp(token, 'papercusp-calendar')).toBe('owner-7');
  });

  // Audience is what keeps one app's token from being replayed against another.
  // Both apps pass `audience` to jwtVerify, so a cross-app token must be REJECTED.
  it('does not let an email token authenticate against calendar', async () => {
    const token = await mintAppServiceToken('email', 'owner-42', { secret: SECRET });
    await expect(verifyAsApp(token, 'papercusp-calendar')).rejects.toThrow();
  });

  it('is rejected under a different signing secret', async () => {
    const token = await mintAppServiceToken('email', 'owner-42', { secret: SECRET });
    await expect(verifyAsApp(token, 'papercusp-email', 'a-different-secret')).rejects.toThrow();
  });

  it('is short-lived by default and expires', async () => {
    const token = await mintAppServiceToken('email', 'owner-42', { secret: SECRET });
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { exp: number; iat: number; iss: string };
    expect(claims.exp - claims.iat).toBe(APP_TOKEN_TTL_SECONDS);
    expect(claims.iss).toBe('papercusp-platform');

    // An already-expired token must not verify — proves exp is ENFORCED by the
    // app's verifier, not merely present in the payload.
    const stale = await mintAppServiceToken('email', 'owner-42', { secret: SECRET, ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(verifyAsApp(stale, 'papercusp-email')).rejects.toThrow();
  }, 10_000);

  it('reads the secret from the app-specific env var', () => {
    setEnv('EMAIL_AUTH_SECRET', SECRET);
    // The runner may inherit the other app's secret; this assertion must test
    // the mapping, not depend on which credentials the host injected.
    setEnv('CALENDAR_AUTH_SECRET', undefined);
    expect(readAppAuthSecret('email')).toBe(SECRET);
    expect(hasAppAuthSecret('email')).toBe(true);
    expect(hasAppAuthSecret('calendar')).toBe(false);
  });

  // No default, no placeholder: an unconfigured secret must fail HERE, naming
  // the variable, rather than producing a token the app rejects with its own
  // generic error in a different process's logs.
  it('throws naming the env var when the secret is missing', () => {
    setEnv('EMAIL_AUTH_SECRET', undefined);
    expect(() => readAppAuthSecret('email')).toThrow('app_auth_secret_missing:email');
    expect(() => readAppAuthSecret('email')).toThrow('EMAIL_AUTH_SECRET');
  });

  it('treats a whitespace-only secret as missing', () => {
    setEnv('EMAIL_AUTH_SECRET', '   ');
    expect(hasAppAuthSecret('email')).toBe(false);
    expect(() => readAppAuthSecret('email')).toThrow('app_auth_secret_missing:email');
  });

  it('never puts the secret in the error message', () => {
    setEnv('EMAIL_AUTH_SECRET', undefined);
    try {
      readAppAuthSecret('email');
      throw new Error('expected a throw');
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it('refuses a blank subject rather than minting an unusable token', async () => {
    await expect(mintAppServiceToken('email', '   ', { secret: SECRET }))
      .rejects.toThrow('app_service_token_subject_required:email');
  });

  it('refuses a non-positive ttl', async () => {
    await expect(mintAppServiceToken('email', 'owner-42', { secret: SECRET, ttlSeconds: 0 }))
      .rejects.toThrow('app_service_token_ttl_invalid');
  });

  it('builds the Authorization header the app parses', async () => {
    const header = await appServiceAuthHeader('email', 'owner-42', { secret: SECRET });
    expect(header.startsWith('Bearer ')).toBe(true);
    expect(await verifyAsApp(header.slice('Bearer '.length), 'papercusp-email')).toBe('owner-42');
  });
});

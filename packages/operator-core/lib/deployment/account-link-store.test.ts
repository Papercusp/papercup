/**
 * account-link-store — the experimental one-click OAuth account link (accounts-pool-tab
 * P-002). PURE/mocked: the linkId HMAC round-trip, the authorize-URL shape, and the
 * complete path with an injected exchange — asserting the credential is written +
 * registered and the TOKEN NEVER appears in the result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  signLinkId,
  verifyLinkId,
  startAccountLink,
  completeAccountLink,
  __resetForTest,
} from './account-link-store';

afterEach(() => {
  __resetForTest();
  vi.clearAllMocks();
});

describe('linkId sign/verify', () => {
  it('round-trips claims and rejects tamper / expiry / malformed', () => {
    const now = 1_000;
    const linkId = signLinkId({ accountId: 'acme', label: 'Acme', verifier: 'v-123', exp: now + 1000 });
    const ok = verifyLinkId(linkId, now);
    expect(ok).toEqual({ ok: true, claims: { accountId: 'acme', label: 'Acme', verifier: 'v-123', exp: now + 1000 } });

    // Tampered signature.
    expect(verifyLinkId(linkId.slice(0, -2) + 'xx', now).ok).toBe(false);
    // Tampered body (flip a char) → bad-signature.
    const [body, sig] = linkId.split('.');
    expect(verifyLinkId(`${body}A.${sig}`, now).ok).toBe(false);
    // Expired.
    expect(verifyLinkId(linkId, now + 5000)).toEqual({ ok: false, error: 'expired' });
    // Malformed.
    expect(verifyLinkId('not-a-token', now)).toEqual({ ok: false, error: 'malformed' });
    expect(verifyLinkId('', now)).toEqual({ ok: false, error: 'malformed' });
  });
});

describe('startAccountLink', () => {
  it('builds a claude.ai PKCE authorize URL + a linkId carrying the verifier', () => {
    const r = startAccountLink({ accountId: 'acme', label: 'Acme', now: () => 1_000, genVerifier: () => 'verifier-xyz' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = new URL(r.authorizeUrl);
    expect(u.host).toBe('claude.ai');
    expect(u.pathname).toBe('/oauth/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    // The VERIFIER itself must never appear in the authorize URL (only the challenge).
    expect(r.authorizeUrl).not.toContain('verifier-xyz');
    // The linkId carries it (for the server-side exchange).
    const v = verifyLinkId(r.linkId, 1_000);
    expect(v.ok && v.claims.verifier).toBe('verifier-xyz');
    expect(v.ok && v.claims.accountId).toBe('acme');
  });

  it('rejects a bad account id', () => {
    expect(startAccountLink({ accountId: 'bad id!' })).toEqual({ ok: false, error: expect.stringContaining('accountId') });
    expect(startAccountLink({ accountId: '' }).ok).toBe(false);
  });
});

describe('completeAccountLink', () => {
  const validLink = (over: Partial<{ exp: number }> = {}) =>
    signLinkId({ accountId: 'acme', label: 'Acme', verifier: 'verifier-xyz', exp: (over.exp ?? 5_000) });

  it('exchanges → writes credential → registers, and NEVER returns the token', async () => {
    const exchangeCode = vi.fn(async (code: string, verifier: string) => {
      expect(code).toBe('the-code');
      expect(verifier).toBe('verifier-xyz');
      return { accessToken: 'sk-ant-SECRET', refreshToken: 'rt-SECRET', expiresAt: 9_999, scopes: ['user:inference'] };
    });
    const writeCredential = vi.fn(async () => 'file:/p/deploy-credentials/acme.credentials.json');
    const register = vi.fn(async () => {});
    const readAccount = vi.fn(async () => ({
      id: 'acme', label: 'Acme', credentialRef: 'file:/p/deploy-credentials/acme.credentials.json',
      boundTo: [], available: true, sustainedlyLimited: false,
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0 } as never, liveBuckets: [],
    }));

    const res = await completeAccountLink(
      { linkId: validLink(), code: 'the-code' },
      { exchangeCode, writeCredential, register, readAccount, notify: () => {}, now: () => 1_000 },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account?.id).toBe('acme');
    // The credential bundle carried the token to the writer…
    expect(writeCredential).toHaveBeenCalledWith('acme', { claudeAiOauth: { accessToken: 'sk-ant-SECRET', refreshToken: 'rt-SECRET', expiresAt: 9_999, scopes: ['user:inference'] } });
    expect(register).toHaveBeenCalledWith('acme', 'file:/p/deploy-credentials/acme.credentials.json', 'Acme', undefined);
    // …but the RESULT must never contain the access/refresh token (the security invariant).
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('sk-ant-SECRET');
    expect(serialized).not.toContain('rt-SECRET');
    expect(serialized).not.toContain('verifier-xyz');
  });

  it('rejects an invalid/expired linkId (no exchange, no write)', async () => {
    const exchangeCode = vi.fn();
    const writeCredential = vi.fn();
    const res = await completeAccountLink(
      { linkId: validLink({ exp: 500 }), code: 'x' },
      { exchangeCode, writeCredential, now: () => 1_000 },
    );
    expect(res.ok).toBe(false);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(writeCredential).not.toHaveBeenCalled();
  });

  it('surfaces an exchange failure as ok:false (no write/register)', async () => {
    const writeCredential = vi.fn();
    const register = vi.fn();
    const res = await completeAccountLink(
      { linkId: validLink(), code: 'the-code' },
      {
        exchangeCode: async () => {
          throw new Error('claude oauth: invalid_grant');
        },
        writeCredential,
        register,
        now: () => 1_000,
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('exchange failed');
    expect(writeCredential).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('requires a non-empty code', async () => {
    const res = await completeAccountLink({ linkId: validLink(), code: '  ' }, { now: () => 1_000 });
    expect(res.ok).toBe(false);
  });
});

/**
 * claude-account-oauth.test.ts — PKCE/authorize-URL generation + token exchange (mocked fetch).
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  buildClaudeAuthorize,
  exchangeClaudeCode,
  writeCredentialBundle,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
} from './claude-account-oauth';

describe('buildClaudeAuthorize', () => {
  it('produces a valid PKCE authorize URL + a verifier + state', () => {
    const a = buildClaudeAuthorize();
    const u = new URL(a.authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(u.searchParams.get('code')).toBe('true');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBe(a.state);
    expect(u.searchParams.get('scope')).toContain('user:inference');
    expect(a.codeVerifier.length).toBeGreaterThan(20);
  });

  it('generates a fresh verifier/state each call', () => {
    const a = buildClaudeAuthorize();
    const b = buildClaudeAuthorize();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('exchangeClaudeCode', () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

  it('POSTs the PKCE exchange + maps the bundle', async () => {
    const fetchImpl = vi.fn(async (_url, init) =>
      okResponse({
        access_token: 'acc-tok',
        refresh_token: 'ref-tok',
        expires_in: 3600,
        scope: 'user:inference user:sessions:claude_code',
        subscription_type: 'max',
      }),
    ) as unknown as typeof fetch;

    const bundle = await exchangeClaudeCode({ rawCode: 'thecode#thestate', codeVerifier: 'verifier-x', expectedState: 'thestate', fetchImpl });

    // verify the request shape
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toMatchObject({
      grant_type: 'authorization_code',
      code: 'thecode',
      state: 'thestate',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code_verifier: 'verifier-x',
    });
    // verify the bundle
    expect(bundle.claudeAiOauth.accessToken).toBe('acc-tok');
    expect(bundle.claudeAiOauth.refreshToken).toBe('ref-tok');
    expect(bundle.claudeAiOauth.subscriptionType).toBe('max');
    expect(bundle.claudeAiOauth.scopes).toContain('user:inference');
    expect(bundle.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
  });

  it('accepts a bare code (no #state)', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ access_token: 'a', refresh_token: 'r', expires_in: 10 })) as unknown as typeof fetch;
    const b = await exchangeClaudeCode({ rawCode: 'barecode', codeVerifier: 'v', fetchImpl });
    expect(b.claudeAiOauth.accessToken).toBe('a');
  });

  it('rejects a state mismatch (CSRF guard)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      exchangeClaudeCode({ rawCode: 'code#WRONG', codeVerifier: 'v', expectedState: 'RIGHT', fetchImpl }),
    ).rejects.toThrow(/state mismatch/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('throws on a non-OK token response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' }) as Response) as unknown as typeof fetch;
    await expect(exchangeClaudeCode({ rawCode: 'c', codeVerifier: 'v', fetchImpl })).rejects.toThrow(/HTTP 400/);
  });
});

describe('writeCredentialBundle', () => {
  it('writes the bundle at 0600 + round-trips', async () => {
    const path = join(tmpdir(), `cred-${randomBytes(4).toString('hex')}`, 'acct.credentials.json');
    const bundle = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: ['user:inference'], subscriptionType: 'max' } };
    await writeCredentialBundle(path, bundle);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(bundle);
    rmSync(join(path, '..'), { recursive: true, force: true });
  });
});

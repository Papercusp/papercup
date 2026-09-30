import { describe, expect, it, vi } from 'vitest';
import { appKeyRefusalCode, mcpAuthChallenge, type McpAuthChallengeDependencies } from './mcp-auth-challenge';

const APP_KEY = 'pcapp_abc_secret';

function deps(over: Partial<McpAuthChallengeDependencies> = {}): McpAuthChallengeDependencies {
  return {
    isLocal: () => false,
    isAppKeyShaped: (token) => typeof token === 'string' && token.startsWith('pcapp_'),
    verifyAppKey: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

function post(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
}

function resourceMetadataOf(res: Response): string | null {
  return /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1] ?? null;
}

describe('mcpAuthChallenge (P-006)', () => {
  it('answers an outside request with no credential with 401 and the protected-resource metadata URL', async () => {
    // A tunnel reaches the listener over plain http; @hono/node-server builds the URL from the
    // public Host, and the tunnel states the scheme in X-Forwarded-Proto.
    const res = await mcpAuthChallenge(post('http://ws.example.org/api/mcp', { 'x-forwarded-proto': 'https' }), deps());
    expect(res?.status).toBe(401);
    expect(res!.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(resourceMetadataOf(res!)).toBe('https://ws.example.org/.well-known/oauth-protected-resource/api/mcp');
    expect(res!.headers.get('www-authenticate')).not.toContain('error=');
    expect(await res!.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('uses the public origin the client addressed', async () => {
    const res = await mcpAuthChallenge(post('https://ws.example.org/api/mcp'), deps());
    expect(resourceMetadataOf(res!)).toBe('https://ws.example.org/.well-known/oauth-protected-resource/api/mcp');
  });

  it('passes a local caller with no credential through (the desktop and psu sessions)', async () => {
    expect(await mcpAuthChallenge(post('http://127.0.0.1:3070/api/mcp'), deps({ isLocal: () => true }))).toBeNull();
  });

  it('refuses an app key that does not verify with invalid_token, even from a local caller', async () => {
    const verifyAppKey = vi.fn(async () => ({ ok: false }));
    const res = await mcpAuthChallenge(
      post('https://ws.example.org/api/mcp', { authorization: `Bearer ${APP_KEY}` }),
      deps({ isLocal: () => true, verifyAppKey }),
    );
    expect(verifyAppKey).toHaveBeenCalledWith(APP_KEY);
    expect(res?.status).toBe(401);
    expect(res!.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(resourceMetadataOf(res!)).toBe('https://ws.example.org/.well-known/oauth-protected-resource/api/mcp');
  });

  it.each([
    ['revoked', 'connected_app_invalid_key:revoked'],
    ['remote_access_off', 'connected_app_invalid_key:remote_access_off'],
    ['paused', 'connected_app_invalid_key:paused'],
  ])('names the refusal (%s) so the app learns why its key stopped working (P-010 R-40/R-41)', async (reason, code) => {
    const res = await mcpAuthChallenge(
      post('https://ws.example.org/api/mcp', { authorization: `Bearer ${APP_KEY}` }),
      deps({ verifyAppKey: vi.fn(async () => ({ ok: false, reason })) }),
    );
    expect(res?.status).toBe(401);
    expect(res!.headers.get('www-authenticate')).toContain(`error_description="the access token is not valid (${code})"`);
    expect(await res!.json()).toEqual({
      error: 'invalid_token',
      error_description: `the access token is not valid (${code})`,
      code,
    });
  });

  it('never lets a reason break the header quoting, and names an unexplained refusal "invalid"', async () => {
    expect(appKeyRefusalCode('x" , evil="1')).toBe('connected_app_invalid_key:xevil1');
    expect(appKeyRefusalCode(undefined)).toBe('connected_app_invalid_key:invalid');
    const res = await mcpAuthChallenge(
      post('https://ws.example.org/api/mcp', { authorization: `Bearer ${APP_KEY}` }),
      deps({ verifyAppKey: vi.fn(async () => ({ ok: false })) }),
    );
    expect((await res!.json()).code).toBe('connected_app_invalid_key:invalid');
  });

  it('passes a valid app key through to the host, which resolves it', async () => {
    const res = await mcpAuthChallenge(post('https://ws.example.org/api/mcp', { authorization: `Bearer ${APP_KEY}` }), deps());
    expect(res).toBeNull();
  });

  it('does not answer for the store: a verification failure falls through to the host refusal', async () => {
    const verifyAppKey = vi.fn(async () => {
      throw new Error('db down');
    });
    const res = await mcpAuthChallenge(
      post('https://ws.example.org/api/mcp', { authorization: `Bearer ${APP_KEY}` }),
      deps({ verifyAppKey }),
    );
    expect(res).toBeNull();
  });

  it('leaves every other credential to the host: a non-app bearer and a signed spawn URL', async () => {
    const verifyAppKey = vi.fn(async () => ({ ok: false }));
    const d = deps({ verifyAppKey });
    expect(await mcpAuthChallenge(post('https://ws.example.org/api/mcp', { authorization: 'Bearer eyJhbGciOi.device.jwt' }), d)).toBeNull();
    expect(await mcpAuthChallenge(post('https://ws.example.org/api/mcp?role=x&sig=abc&exp=1'), d)).toBeNull();
    expect(verifyAppKey).not.toHaveBeenCalled();
  });

  it('does not treat workspace= alone as a credential', async () => {
    const res = await mcpAuthChallenge(post('https://ws.example.org/api/mcp?workspace=w1'), deps());
    expect(res?.status).toBe(401);
  });
});

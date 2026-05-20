/**
 * bundle-client — HTTP client for /api/agent-bundle and /api/agent-tokens/
 * power-user/refresh. Verified contract:
 *
 *   - Access token always in `Authorization: Bearer`, never in URL.
 *   - Refresh URL is derived from the bundle URL (same origin).
 *   - Non-2xx surfaces as HttpError with the correct status — so the
 *     refresh loop can recognise a 401 and stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBundle,
  refreshAccessToken,
  refreshUrlFor,
  isHttpStatus,
  type AgentBundle,
} from '../src/bundle-client.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeBundleResponse(): AgentBundle {
  return {
    persona: '# p\n',
    toolsmd: '# t\n',
    skills: [],
    hooks: [],
    mcp_url: 'http://op/api/mcp?power_user=1',
    workspace: { id: 'ws', name: 'WS' },
    user: { id: 'u', username: 'u', displayName: 'U' },
    expires_at: new Date().toISOString(),
  };
}

describe('fetchBundle', () => {
  it('GETs with Authorization: Bearer and parses the body', async () => {
    const fixture = makeBundleResponse();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const bundle = await fetchBundle('http://op/api/agent-bundle', 'access-1');
    expect(bundle).toEqual(fixture);

    const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('http://op/api/agent-bundle');
    expect(url).not.toContain('access-1');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(init.method).toBe('GET');
  });

  it('throws HttpError(401) on revoked / unknown token', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid or expired access token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(fetchBundle('http://op/api/agent-bundle', 'bad')).rejects.toMatchObject({
      status: 401,
    });
    try {
      await fetchBundle('http://op/api/agent-bundle', 'bad');
    } catch (e) {
      expect(isHttpStatus(e, 401)).toBe(true);
      expect(isHttpStatus(e, 500)).toBe(false);
    }
  });

  it('surfaces a sensible message even when error body is not JSON', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('not json', { status: 500 }),
    );
    await expect(
      fetchBundle('http://op/api/agent-bundle', 'tok'),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('refreshUrlFor', () => {
  it('preserves origin, fixes path', () => {
    expect(refreshUrlFor('http://op.local/api/agent-bundle')).toBe(
      'http://op.local/api/agent-tokens/power-user/refresh',
    );
    expect(refreshUrlFor('https://op.example.com:9443/api/agent-bundle')).toBe(
      'https://op.example.com:9443/api/agent-tokens/power-user/refresh',
    );
  });
});

describe('refreshAccessToken', () => {
  it('POSTs with refresh token in Authorization header and parses the result', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await refreshAccessToken(
      'http://op/api/agent-tokens/power-user/refresh',
      'refresh-tok',
    );
    expect(r.access_token).toBe('new-access');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://op/api/agent-tokens/power-user/refresh');
    expect(url).not.toContain('refresh-tok');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer refresh-tok');
  });

  it('throws HttpError(401) when refresh token is rejected', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'revoked' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      refreshAccessToken('http://op/api/agent-tokens/power-user/refresh', 'bad'),
    ).rejects.toMatchObject({ status: 401 });
  });
});
